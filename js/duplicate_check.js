import { app } from "../../scripts/app.js";
import { checkDuplicateTags, t } from "./bpi_shared.js";

const NODE_NAME = "DuplicateChecker";
const STYLE_ID = "bpi-duplicate-check-style";
const PILL_HEIGHT = 26;
const REFRESH_DELAY = 250;
// 半透明橙：叠在画布上，亮色深色主题都能用，也不用去猜当前主题
const AMBER_TINT = "rgba(214,158,46,0.14)";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ".bpi-dup-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;line-height:1.5;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".bpi-dup-pill .bpi-dup-dot{width:7px;height:7px;border-radius:50%;flex:none}",
    ".bpi-dup-pill .bpi-dup-text{overflow:hidden;text-overflow:ellipsis}",
    ".bpi-dup-pill.bpi-dup-warn{background:rgba(214,158,46,.18);color:#8a5a00}",
    ".bpi-dup-pill.bpi-dup-warn .bpi-dup-dot{background:#8a5a00}",
    ".bpi-dup-pill.bpi-dup-idle{background:rgba(128,128,128,.14);opacity:.75}",
    ".dark-theme .bpi-dup-pill.bpi-dup-warn{color:#e8b85c}",
    ".dark-theme .bpi-dup-pill.bpi-dup-warn .bpi-dup-dot{background:#e8b85c}",
  ].join("");
  document.head.appendChild(style);
}

function upstreamWidget(node) {
  const linkId = node?.inputs?.[0]?.link;
  if (linkId == null) return null;
  const graph = app.graph;
  const links = graph?.links;
  const info = Array.isArray(links) ? links[linkId] : links?.[linkId];
  if (!info) return null;
  const origin = (graph?._nodes ?? []).find((item) => String(item.id) === String(info.origin_id));
  // 上游节点的文本 widget 是画布上唯一能读到的值；读不到就只靠执行结果更新。
  // 缓存 widget 本身，这样每帧只要读一次 value，不用再遍历整张图。
  return (
    (origin?.widgets ?? []).find((item) => item.name === "text" && typeof item.value === "string") ??
    null
  );
}

function setPill(node, text, tone, terms = []) {
  const state = node._duplicateCheck;
  if (!state) return;
  state.pill.className = `bpi-dup-pill ${tone === "warn" ? "bpi-dup-warn" : "bpi-dup-idle"}`;
  state.textNode.textContent = text;
  state.dot.style.display = tone === "warn" ? "" : "none";
  state.pill.title = terms.length ? terms.join("、") : "";
}

function applyResult(node, count, terms = []) {
  const state = node._duplicateCheck;
  if (!state) return;
  state.count = count;
  if (!state.connected) {
    setPill(node, t("Waiting for prompt"), "idle");
  } else if (count > 0) {
    setPill(node, t(`Duplicates ${count}`), "warn", terms);
  } else {
    setPill(node, t("No duplicates"), "idle");
  }
  node.bgcolor = state.connected && count > 0 ? AMBER_TINT : undefined;
  node.setDirtyCanvas?.(true, true);
}

async function runCheck(node, text) {
  const state = node._duplicateCheck;
  if (!state) return;
  const ticket = (state.ticket = (state.ticket ?? 0) + 1);
  try {
    const data = await checkDuplicateTags(text);
    if (state.ticket !== ticket) return;
    applyResult(node, data?.count ?? 0, (data?.terms ?? []).map((item) => item.term));
  } catch {
    // 查询失败就保持上一次的状态，别把节点闪成「无重复」误导人
  }
}

function scheduleCheck(node, text) {
  const state = node._duplicateCheck;
  if (!state || text === state.checkedText) return;
  state.checkedText = text;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => runCheck(node, text), REFRESH_DELAY);
}

function syncConnection(node) {
  const state = node._duplicateCheck;
  if (!state) return;
  state.connected = node.inputs?.[0]?.link != null;
  state.source = state.connected ? upstreamWidget(node) : null;
  if (!state.connected) {
    state.checkedText = null;
    applyResult(node, 0, []);
    return;
  }
  const text = state.source?.value;
  if (typeof text !== "string") {
    applyResult(node, 0, []);
    return;
  }
  scheduleCheck(node, text);
}

app.registerExtension({
  name: "ComfyUI.BilingualPromptInspector.DuplicateCheck",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      injectStyles();
      // widget.label / input.label 都是直接赋值，不走翻译层，所以这里直接写中文
      const toggle = this.widgets?.find((widget) => widget.name === "keep_first");
      if (toggle) toggle.label = "只保留第一个";
      if (this.inputs?.[0]) this.inputs[0].label = "提示词";
      const pill = document.createElement("div");
      pill.className = "bpi-dup-pill bpi-dup-idle";
      const dot = document.createElement("span");
      dot.className = "bpi-dup-dot";
      const textNode = document.createElement("span");
      textNode.className = "bpi-dup-text";
      pill.append(dot, textNode);
      this._duplicateCheck = { pill, dot, textNode, count: 0, connected: false };
      try {
        this.addDOMWidget("bpi_duplicate_status", "bpi-duplicate-status", pill, {
          getMinHeight: () => PILL_HEIGHT,
          getMaxHeight: () => PILL_HEIGHT,
          hideOnZoom: false,
          serialize: false,
        });
      } catch (error) {
        console.error("[DuplicateChecker] Failed to create status pill", error);
        this._duplicateCheck = null;
        return;
      }
      setPill(this, t("Waiting for prompt"), "idle");
      requestAnimationFrame(() => {
        // 胶囊：一行状态加一个开关。等 DOM 布局算完再压尺寸，免得把开关挤没了
        this.setSize?.([236, Math.min(this.size?.[1] ?? 88, 96)]);
        syncConnection(this);
      });
    };

    const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      originalConnectionsChange?.apply(this, arguments);
      syncConnection(this);
    };

    // canvas 模式靠每帧比对上游文本来保持实时；Nodes 2.0 不跑这里，
    // 那种情况下由连线变化与执行结果兜底。
    const originalDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      originalDrawForeground?.apply(this, arguments);
      const state = this._duplicateCheck;
      if (!state?.connected) return;
      const text = state.source?.value;
      if (typeof text === "string") scheduleCheck(this, text);
    };

    const originalExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      originalExecuted?.apply(this, arguments);
      const state = this._duplicateCheck;
      if (!state) return;
      state.connected = true;
      state.checkedText = null;
      // 后端 ui 的值会被 execution.py 展开成列表，所以这里取第一个元素
      const counts = message?.duplicate_count;
      const count = Number(Array.isArray(counts) ? counts[0] : counts);
      applyResult(this, Number.isFinite(count) ? count : 0, message?.duplicate_terms ?? []);
    };

    const originalRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      clearTimeout(this._duplicateCheck?.timer);
      this._duplicateCheck = null;
      originalRemoved?.apply(this, arguments);
    };
  },
});
