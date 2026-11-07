// 节点尺寸与高度管理：从主文件 createPanel 闭包里拆出来的 12 个函数。
// 每个节点一份（createPanel 里调用），state / node 从 store 取，6 个 DOM 从 refs 取；
// render 必须走 store.hooks.render()，不能提前解构 —— hooks 是在 createPanel 后半段才 bind 的。
import { app } from "../../scripts/app.js";
import { inspectorNodeTargetHeight } from "./dictionary_tools.js";
import { setTitle } from "./bpi_shared.js";
import { COLLAPSED_NODE_MIN_HEIGHT, FILL_HEIGHT_MIN_GROWTH } from "./bpi_store.js";

export function createNodeSize({ store, refs, persistPreferences }) {
  const { state, node } = store;
  const { panel, englishSection, englishEditor, englishTokenView, fillSwitch, fillSwitchRow } = refs;

  const autoFitGreenArea = (target, minimum) => {
    if (!target || target.classList.contains("bpi-hidden")) return;
    // 适应高度模式下高度交给 flex；这里再写死 height 会把刚放开的上限又按回去
    if (state.fillHeight) {
      target.style.height = "";
      target.style.overflowY = "auto";
      return;
    }
    const maximum = 360;
    target.style.height = "auto";
    const height = Math.max(minimum, Math.min(maximum, Math.ceil(target.scrollHeight + 2)));
    target.style.height = `${height}px`;
    target.style.overflowY = target.scrollHeight > height + 1 ? "auto" : "hidden";
  };
  const hasNodeSize = () => Number.isFinite(Number(node.size?.[0])) && Number.isFinite(Number(node.size?.[1]));
  const resizeCornerHit = (elementValue, event) => {
    const bounds = elementValue.getBoundingClientRect();
    return bounds.right - event.clientX <= 24 && bounds.bottom - event.clientY <= 24;
  };
  const resolveDeepestWidget = (widget) => {
    if (typeof widget?.resolveDeepest !== "function") return widget ?? null;
    try {
      return widget.resolveDeepest()?.widget ?? widget;
    } catch {
      return widget;
    }
  };
  const applyEnglishEditorHeight = (height) => {
    const value = Math.max(84, Math.min(420, Math.round(Number(height) || 0)));
    englishEditor.style.height = `${value}px`;
    return value;
  };
  const startManualResize = (kind, target, event) => {
    if (event.button !== 0 || !resizeCornerHit(target, event)) return;
    state.manualResize = {
      kind,
      target,
      startHeight: target.offsetHeight,
      startNodeHeight: Number(node.size?.[1]) || 0,
    };
  };
  const finishManualResize = () => {
    const resize = state.manualResize;
    if (!resize) return;
    state.manualResize = null;
    requestAnimationFrame(() => {
      if (!resize.target?.isConnected) return;
      if (resize.kind === "english") {
        const height = applyEnglishEditorHeight(resize.target.offsetHeight);
        const delta = height - resize.startHeight;
        state.preferences = { ...state.preferences, englishInputHeight: height };
        persistPreferences();
        if (hasNodeSize() && Math.abs(delta) > 0.5) {
          node.setSize?.([node.size[0], Math.max(COLLAPSED_NODE_MIN_HEIGHT, resize.startNodeHeight + delta)]);
        }
      }
      node.graph?.change?.();
      node.graph?.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
    });
  };
  // 这两行是原块里的副作用，必须留在工厂内、且排在 finishManualResize 定义之后
  state.windowPointerUp = finishManualResize;
  window.addEventListener("pointerup", state.windowPointerUp, true);
  const measureCollapsedWidgetHeight = () => {
    const styles = getComputedStyle(panel);
    const pixels = (name) => Number.parseFloat(styles.getPropertyValue(name)) || 0;
    // 底部快捷输入区是后加的，这里用选择器取高度，避免引用尚未初始化的常量
    const quickHeight = panel.querySelector(".bpi-quick-section")?.offsetHeight ?? 0;
    const height = englishSection.offsetHeight
      + quickHeight
      + pixels("padding-top")
      + pixels("padding-bottom")
      + pixels("border-top-width")
      + pixels("border-bottom-width")
      + pixels("row-gap");
    return Math.max(280, Math.min(620, Math.ceil(height + 1)));
  };
  const requestNodeResize = () => {
    if (state.resizeFrame !== null) cancelAnimationFrame(state.resizeFrame);
    state.resizeFrame = requestAnimationFrame(() => {
      state.resizeFrame = null;
      const width = Math.max(node.size?.[0] ?? 0, 590);
      // 适应高度模式：高度归用户，只同步宽度。这里绝不能按内容重算——
      // 英文区一变高就会推高自动高度、再推高节点、英文区又更高，越滚越大。
      if (state.fillHeight) {
        if (Math.abs((node.size?.[0] ?? 0) - width) > 0.5) {
          node.setSize?.([width, Number(node.size?.[1]) || COLLAPSED_NODE_MIN_HEIGHT]);
          node.graph?.change?.();
        }
        node.graph?.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
        return;
      }
      state.collapsedWidgetHeight = measureCollapsedWidgetHeight();
      panel.style.setProperty("--bpi-collapsed-height", `${state.collapsedWidgetHeight}px`);
      // 稳定基线 = 标题栏 + 原生 text 控件的真实内容高度。
      // 绝不能读 inspectorWidget().y（= bilingual_inspector.y）——那是 ComfyUI arrange
      // 从 text.computedHeight 派生的，而 text.computedHeight 在「setSize 变高 → 文本框
      // 可用空间变大 → scrollHeight 变大 → computedHeight 再涨」的反馈里只增不减
      // （实测每写一次值节点 +10px、永不回缩）。这里临时把 text 控件设成 auto 量
      // scrollHeight，得到与 setSize 无关的真实内容高，再恢复，从源头断开反馈环。
      const textWidget = node.widgets?.find((widget) => widget.name === "text");
      let baseHeight = state.nodeBaseHeight ?? 96;
      if (textWidget?.element) {
        const element = textWidget.element;
        const previousHeight = element.style.height;
        element.style.height = "auto";
        const natural = element.scrollHeight;
        element.style.height = previousHeight;
        const top = Number.isFinite(textWidget.y) && textWidget.y >= 0 ? textWidget.y : 26;
        const margin = Math.max(0, Number(textWidget.margin) || 0);
        if (Number.isFinite(natural) && natural > 0) baseHeight = top + natural + margin * 2;
        state.nodeBaseHeight = baseHeight;
      }
      const targetHeight = inspectorNodeTargetHeight({
        baseHeight,
        targetWidgetHeight: state.collapsedWidgetHeight,
        fallbackBaseHeight: state.nodeBaseHeight ?? 96,
        minimumHeight: COLLAPSED_NODE_MIN_HEIGHT,
      });
      // 高度只补不缩：用户把节点拉大之后，任何一次 render 都不该把它拽回自动高度，
      // 否则「拉大 → 改一个字 → 被打回原形」，拉大等于白拉。宽度仍按最小可用宽度收敛。
      const currentHeight = Number(node.size?.[1]) || 0;
      const nextHeight = Math.max(targetHeight, currentHeight);
      const sizeChanged = Math.abs((node.size?.[0] ?? 0) - width) > 0.5
        || Math.abs(currentHeight - nextHeight) > 0.5;
      if (sizeChanged) {
        node.setSize?.([width, nextHeight]);
        node.graph?.change?.();
      }
      node.graph?.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
    });
  };

  // 量出英文标签区「没被 360 压住时」的真实高度：临时解除上限读 scrollHeight 再恢复
  const measureNaturalEnglishHeight = () => {
    const previousHeight = englishTokenView.style.height;
    const previousMax = englishTokenView.style.maxHeight;
    englishTokenView.style.height = "auto";
    englishTokenView.style.maxHeight = "none";
    const natural = englishTokenView.scrollHeight;
    englishTokenView.style.height = previousHeight;
    englishTokenView.style.maxHeight = previousMax;
    return natural;
  };

  // 打开开关时把节点撑高一次，撑的量 = 被压掉的内容高度，但至少给一个看得出变化的量
  const growNodeForFill = () => {
    if (!hasNodeSize()) return;
    const natural = measureNaturalEnglishHeight();
    const extra = Math.max(FILL_HEIGHT_MIN_GROWTH, Math.ceil(natural - englishTokenView.offsetHeight));
    const height = Math.min((Number(node.size?.[1]) || COLLAPSED_NODE_MIN_HEIGHT) + extra, 2400);
    node.setSize?.([Math.max(node.size?.[0] ?? 0, 590), height]);
    node.graph?.change?.();
  };

  const setFillHeight = (next) => {
    const fill = Boolean(next);
    if (fill === state.fillHeight) return;
    state.fillHeight = fill;
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    node.properties.bpiFillHeight = fill;
    panel.classList.toggle("bpi-fill", fill);
    fillSwitch.checked = fill;
    setTitle(fillSwitchRow, fill
      ? "Back to the automatic height; the prompt area stops following the node"
      : "Let the prompt area grow with the node instead of being capped");
    if (fill) {
      // 先放开限制再撑高，撑完重排一次让英文区吃到新空间
      growNodeForFill();
      requestNodeResize();
    } else {
      state.collapsedWidgetHeight = measureCollapsedWidgetHeight();
      panel.style.setProperty("--bpi-collapsed-height", `${state.collapsedWidgetHeight}px`);
      if (hasNodeSize()) {
        const baseHeight = state.nodeBaseHeight ?? 96;
        node.setSize?.([Math.max(node.size?.[0] ?? 0, 590), Math.max(inspectorNodeTargetHeight({
          baseHeight,
          targetWidgetHeight: state.collapsedWidgetHeight,
          fallbackBaseHeight: state.nodeBaseHeight ?? 96,
          minimumHeight: COLLAPSED_NODE_MIN_HEIGHT,
        }), COLLAPSED_NODE_MIN_HEIGHT)]);
        node.graph?.change?.();
      }
    }
    store.hooks.render();
  };

  return {
    applyEnglishEditorHeight, autoFitGreenArea, finishManualResize, growNodeForFill,
    hasNodeSize, measureCollapsedWidgetHeight, measureNaturalEnglishHeight, requestNodeResize,
    resizeCornerHit, resolveDeepestWidget, setFillHeight, startManualResize,
  };
}
