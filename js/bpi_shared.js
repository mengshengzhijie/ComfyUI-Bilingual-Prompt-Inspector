import { app } from "../../scripts/app.js";
import { normalizePreferences } from "./dictionary_tools.js";

const API_ROOT = "/bpi";
const PREFERENCES_KEY = "bpi.dictionary.preferences.v1";
const MANAGER_TAB_ID = "bpi-manager";
const MANAGER_OPEN_EVENT = "bpi:open-manager";

let sessionTokenPromise = null;
let dictionaryPromise = null;

async function getSessionToken(force = false) {
  if (!sessionTokenPromise || force) {
    sessionTokenPromise = fetch(`${API_ROOT}/session`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        const token = result?.data?.token;
        if (!response.ok || !result.success || !token) throw new Error(result.error || "本机会话初始化失败");
        return token;
      })
      .catch((error) => {
        sessionTokenPromise = null;
        throw error;
      });
  }
  return sessionTokenPromise;
}

async function bpiFetch(url, options = {}, retry = true) {
  const token = await getSessionToken();
  const headers = new Headers(options.headers ?? {});
  headers.set("X-BPI-Token", token);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 403 && retry) {
    await getSessionToken(true);
    return bpiFetch(url, options, false);
  }
  return response;
}

function loadPreferences() {
  try {
    return normalizePreferences(JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}"));
  } catch {
    return normalizePreferences({});
  }
}

function savePreferences(preferences) {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(normalizePreferences(preferences)));
  } catch (error) {
    console.warn("[BilingualPromptInspector] 无法保存收藏与最近使用", error);
  }
}

function loadDictionary(force = false) {
  if (!dictionaryPromise || force) {
    dictionaryPromise = bpiFetch(`${API_ROOT}/dictionary`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || "词库读取失败");
        return result.data;
      })
      .catch((error) => {
        dictionaryPromise = null;
        throw error;
      });
  }
  return dictionaryPromise;
}

function element(tagName, className, text) {
  const item = document.createElement(tagName);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function button(label, action, className = "") {
  const item = element("button", `bpi-button ${className}`.trim(), label);
  item.type = "button";
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action(event);
  });
  return item;
}

function field(form, labelText, name, value = "", placeholder = "") {
  const label = element("label", "", labelText);
  label.htmlFor = `bpi-field-${name}`;
  const input = element("input");
  input.id = label.htmlFor;
  input.name = name;
  input.value = value ?? "";
  input.placeholder = placeholder;
  form.append(label, input);
  return input;
}

async function runInspectorAssistant(action, text, instruction = "") {
  const response = await bpiFetch(`${API_ROOT}/assistant/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, text, instruction }),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("双语检查器助手没有返回有效结果");
  }
  if (!response.ok || !result.success) {
    throw new Error(result.error || "双语检查器助手处理失败");
  }
  const output = result.data?.text;
  if (!output || typeof output !== "string") throw new Error("双语检查器助手没有返回文本");
  return output.trim();
}

async function getAssistantConfig() {
  const response = await bpiFetch(`${API_ROOT}/assistant/config`);
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "助手设置读取失败");
  return result.data;
}

async function saveAssistantConfig(payload) {
  const response = await bpiFetch(`${API_ROOT}/assistant/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "助手设置保存失败");
  return result.data;
}

async function testAssistantConnection() {
  const response = await bpiFetch(`${API_ROOT}/assistant/test`, { method: "POST" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "连接测试失败");
  return result.data;
}

async function saveTag(tag) {
  const response = await bpiFetch(`${API_ROOT}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tag),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "标签保存失败");
  return result;
}

async function deletePersonalTag(english) {
  const response = await bpiFetch(`${API_ROOT}/tags/${encodeURIComponent(english)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "个人标签删除失败");
  return result;
}

async function importTags(tags, mode = "skip") {
  const response = await bpiFetch(`${API_ROOT}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags, mode }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "词库导入失败");
  return result.data;
}

async function bulkUpdateTags(english, updates) {
  const response = await bpiFetch(`${API_ROOT}/tags/bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ english, updates }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "批量修改失败");
  return result.data;
}

async function setPackEnabled(packId, enabled) {
  const response = await bpiFetch(`${API_ROOT}/packs/${encodeURIComponent(packId)}/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "词库包启停失败");
  return result.data;
}

async function lookupLargeDictionary(terms) {
  const response = await bpiFetch(`${API_ROOT}/large/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "大型词库识别失败");
  return result.data ?? [];
}

async function searchLargeDictionary(query, limit = 40, offset = 0) {
  const parameters = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  const response = await bpiFetch(`${API_ROOT}/large/search?${parameters}`);
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "大型词库搜索失败");
  if (Array.isArray(result.data)) {
    return { items: result.data, has_more: false, next_offset: offset + result.data.length, expanded_terms: [] };
  }
  return result.data ?? { items: [], has_more: false, next_offset: offset, expanded_terms: [] };
}

async function setLargeDictionaryEnabled(enabled) {
  const response = await bpiFetch(`${API_ROOT}/large/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "大型词库启停失败");
  return result.data;
}

async function importCommunityPack(payload, overwrite = false) {
  const response = await bpiFetch(`${API_ROOT}/packs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, overwrite }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "社区词库包导入失败");
  return result.data;
}

async function deleteCommunityPack(packId) {
  const response = await bpiFetch(`${API_ROOT}/packs/${encodeURIComponent(packId)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "社区词库包删除失败");
  return result.data;
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = element("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportDictionaryPack(packId) {
  const response = await bpiFetch(`${API_ROOT}/packs/${encodeURIComponent(packId)}/export`);
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "词库包导出失败");
  return payload;
}

async function exportPersonalDictionary() {
  const response = await bpiFetch(`${API_ROOT}/export`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "导出失败");
  return payload;
}

function openTagDialog(initial, onSaved) {
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  const title = element("h3", "", initial?.english ? "添加或修改个人标签" : "添加个人标签");
  const form = element("form", "bpi-form");
  const english = field(form, "英文标签", "english", initial?.english, "例如：looking at viewer");
  const chinese = field(form, "中文名称", "chinese", initial?.chinese, "例如：看向镜头");
  const aliases = field(form, "中文别名", "aliases", initial?.aliases?.join("，"), "用逗号分隔");
  const category = field(form, "分类", "category", initial?.category ?? "自定义", "例如：姿势、镜头、风格");
  const models = field(form, "适用模型", "models", initial?.models?.join("，") ?? "general, anima", "用逗号分隔");
  const weight = field(form, "推荐权重", "recommended_weight", initial?.recommended_weight ?? "", "可不填写");
  const notes = field(form, "说明", "notes", initial?.notes, "可不填写");
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  error.style.gridColumn = "1 / -1";
  form.appendChild(error);
  const actions = element("div", "bpi-modal-actions");
  const close = () => shade.remove();
  actions.append(
    button("取消", close),
    button("保存到个人词库", () => form.requestSubmit(), "bpi-primary"),
  );
  modal.append(title, form, actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => {
    if (event.target === shade) close();
  });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      await saveTag({
        english: english.value,
        chinese: chinese.value,
        aliases: aliases.value,
        category: category.value,
        models: models.value,
        recommended_weight: weight.value,
        notes: notes.value,
        source: initial?.source === "bpi-assistant" ? initial.source : "user",
        verified: initial?.verified ?? true,
      });
      close();
      await onSaved();
    } catch (saveError) {
      error.textContent = saveError.message;
    }
  });
  setTimeout(() => (initial?.english ? chinese : english).focus(), 0);
}

function openManagerPanel(section = "", nodeId = null) {
  const manager = app.extensionManager;
  if (!manager?.registerSidebarTab || !manager?.sidebarTab) {
    console.warn("[BilingualPromptInspector] 当前 ComfyUI 前端不支持侧边栏管理面板");
    return;
  }
  const sidebar = manager.sidebarTab;
  if (sidebar.activeSidebarTabId !== MANAGER_TAB_ID) sidebar.toggleSidebarTab(MANAGER_TAB_ID);
  if (section) window.dispatchEvent(new CustomEvent(MANAGER_OPEN_EVENT, { detail: { section, nodeId } }));
}

function injectBpiStyles() {
  if (document.getElementById("bpi-styles")) return;
  const style = document.createElement("style");
  style.id = "bpi-styles";
  style.textContent = `
    .bpi-panel{box-sizing:border-box;width:100%;height:100%;min-height:var(--bpi-collapsed-height,390px);max-height:var(--bpi-collapsed-height,390px);padding:8px;display:flex;flex-direction:column;gap:7px;color:var(--input-text,#ddd);font:12px/1.4 Arial,sans-serif;background:rgba(10,12,18,.72);border:1px solid #3a4250;border-radius:8px;overflow-y:auto;scrollbar-gutter:stable}
    .bpi-english-section{flex:none;border:1px solid #3e7197;border-radius:7px;background:rgba(18,29,43,.72);overflow:hidden}.bpi-english-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:rgba(38,65,88,.66);color:#cbe8ff;font-weight:700;flex-wrap:wrap}.bpi-english-hint{margin-left:auto;color:#91b4cf;font-size:10px;font-weight:400}.bpi-english-token-view{box-sizing:border-box;width:100%;height:auto;min-height:92px;max-height:360px;overflow:auto;scrollbar-gutter:stable;padding:8px 9px;outline:none;color:#d9edff;font:12px/1.85 Consolas,monospace;white-space:normal}.bpi-english-token-view:focus{box-shadow:inset 0 0 0 1px #5aa6d8}.bpi-english-editor{box-sizing:border-box;width:100%;height:120px;min-height:92px;max-height:420px;overflow-y:auto;resize:vertical;border:0;border-top:1px solid #3e7197;background:#111923;color:#edf7ff;padding:9px;outline:none;font:12px/1.55 Consolas,monospace}.bpi-english-editor:focus{box-shadow:inset 0 0 0 1px #5aa6d8}.bpi-english-token{font-family:Consolas,monospace;color:#e8f5ff}.bpi-english-token.bpi-linked{background:#147fc3;border-color:#76c9ff;color:#fff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}
    .bpi-mirror-section{flex:none;border:1px solid #488739;border-radius:7px;background:rgba(20,35,22,.64);overflow:visible}.bpi-section-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:rgba(40,68,42,.55);color:#cbe9c8;font-weight:700;flex-wrap:wrap}.bpi-section-hint{margin-left:auto;color:#91ad93;font-size:10px;font-weight:400}.bpi-mirror-actions{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bpi-chinese-mirror{box-sizing:border-box;width:100%;height:auto;min-height:92px;max-height:360px;overflow:auto;resize:none;scrollbar-gutter:stable;padding:8px 9px;outline:none;color:#d7f3d3;line-height:1.85;cursor:text;white-space:normal}.bpi-chinese-mirror:focus{box-shadow:inset 0 0 0 1px #70b35f}.bpi-category-table{display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);border:1px solid #315f3a;border-radius:6px;overflow:hidden;background:rgba(8,22,12,.45)}.bpi-category-row{display:contents}.bpi-category-name,.bpi-category-content{padding:6px 8px;border-top:1px solid #31513a}.bpi-category-row:first-child .bpi-category-name,.bpi-category-row:first-child .bpi-category-content{border-top:0}.bpi-category-name{background:rgba(52,91,57,.46);border-right:1px solid #31513a;color:#9ee8a7;font-weight:700}.bpi-category-content{min-width:0}.bpi-chinese-editor{box-sizing:border-box;width:100%;height:auto;min-height:110px;max-height:600px;overflow-y:auto;resize:vertical;border:0;border-top:1px solid #3b693c;background:#101b13;color:#e0f6dc;padding:9px;outline:none;font:12px/1.65 Arial,sans-serif}.bpi-chinese-editor:focus{box-shadow:inset 0 0 0 1px #70b35f}.bpi-hidden{display:none!important}.bpi-mirror-empty{color:#829486}.bpi-mirror-token{display:inline-flex;align-items:center;border:1px solid transparent;border-radius:5px;padding:0 3px;margin:1px 0;cursor:pointer;transition:background .12s,border-color .12s,color .12s}.bpi-mirror-token:hover{background:#345a3b;border-color:#5c8d63;color:#fff}.bpi-mirror-token.bpi-linked{background:#315f83;border-color:#76a9ff;color:#fff}
    .bpi-mirror-token.bpi-linked,.bpi-english-token.bpi-linked{background:#147fc3;border-color:#76c9ff;color:#fff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}.bpi-english-token-view .bpi-mirror-separator{color:#7194ad}
    .bpi-toolbar,.bpi-search-line,.bpi-summary{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .bpi-toolbar{justify-content:space-between}.bpi-toolbar-group{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
    .bpi-button{border:1px solid #4c5668;border-radius:5px;padding:4px 8px;background:#2c3340;color:#e8edf5;cursor:pointer;font-size:11px;line-height:1.25}
    .bpi-button:hover{background:#3a4658;border-color:#6c83a8}.bpi-button:disabled{opacity:.45;cursor:default}.bpi-button.bpi-primary{background:#285f8e;border-color:#3f83ba}.bpi-button.bpi-danger{background:#65313b;border-color:#8d4653}
    .bpi-search{flex:1;min-width:140px;border:1px solid #4b5567;border-radius:5px;background:#171b22;color:#eef3fb;padding:5px 7px;outline:none}.bpi-search:focus{border-color:#4ca7e8}.bpi-searching{padding:5px 8px;color:#9ab1ca;font-size:10px}
    .bpi-mode{border:1px solid #4b5567;border-radius:5px;background:#171b22;color:#eef3fb;padding:5px 6px;font-size:11px;outline:none}.bpi-mode:focus{border-color:#4ca7e8}.bpi-mode-info{color:#87bfea}
    .bpi-summary{color:#aab5c5;font-size:11px;min-height:17px}.bpi-status{margin-left:auto}.bpi-status[data-kind="error"]{color:#ff8b93}.bpi-status[data-kind="ok"]{color:#7fdda2}.bpi-status[data-kind="busy"]{color:#ffd27a}
    .bpi-issues{display:none;max-height:105px;overflow:auto;border:1px solid #5b4a36;border-radius:6px;background:rgba(55,39,25,.55);padding:4px 6px}.bpi-issues.bpi-visible{display:block}.bpi-issue{padding:2px 4px;color:#e6c792}.bpi-issue[data-severity="error"]{color:#ff9299}.bpi-issue[data-severity="info"]{color:#86c8eb}.bpi-issue::before{content:"⚠ ";}.bpi-issue[data-severity="error"]::before{content:"⛔ ";}.bpi-issue[data-severity="info"]::before{content:"ℹ ";}
    .bpi-search-label{color:#b9c7d8;font-size:10px;white-space:nowrap}.bpi-results{display:none;max-height:220px;overflow:auto;border:1px solid #414b5c;border-radius:6px;background:#171b22}.bpi-results.bpi-visible{display:block}.bpi-result{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(150px,auto);gap:7px;padding:5px 7px;border-bottom:1px solid #2d3541;cursor:pointer}.bpi-result:last-child{border-bottom:0}.bpi-result:hover{background:#29384a}.bpi-result-en{color:#e7f1ff}.bpi-result-zh{color:#9ed0ff}.bpi-category{color:#8794a8;font-size:10px;white-space:normal}.bpi-search-reason{display:block;color:#77b6df;margin-top:2px}.bpi-search-more{display:block;margin:7px auto}.bpi-results>.bpi-searching{text-align:center}
    .bpi-table{position:relative;height:300px;min-height:180px;max-height:360px;flex:1 1 300px;overflow-x:hidden;overflow-y:scroll;scrollbar-gutter:stable;border:1px solid #3c4553;border-radius:6px;background:#11151b}.bpi-head,.bpi-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1px}.bpi-head{position:sticky;top:0;z-index:2;background:#252c36;color:#b9c4d4;font-weight:700}.bpi-head>div,.bpi-cell{padding:6px 8px}.bpi-head>div+div,.bpi-cell+.bpi-cell{border-left:1px solid #3c4553}
    .bpi-row{border-top:1px solid #29313d;cursor:pointer}.bpi-row:hover,.bpi-row.bpi-pinned{background:#314b68}.bpi-row:hover .bpi-cell,.bpi-row.bpi-pinned .bpi-cell{color:#fff}.bpi-row.bpi-unknown{background:rgba(112,70,28,.18)}.bpi-row.bpi-machine{background:rgba(85,62,131,.22)}.bpi-row.bpi-has-warning{box-shadow:inset 3px 0 #d39845}.bpi-row.bpi-has-error{box-shadow:inset 3px 0 #e35b66}
    .bpi-cell{min-width:0;word-break:break-word;display:flex;align-items:flex-start;gap:5px}.bpi-en{color:#e6edf7;font-family:Consolas,monospace}.bpi-zh{color:#9ed0ff}.bpi-row:hover .bpi-en,.bpi-row:hover .bpi-zh,.bpi-row.bpi-pinned .bpi-en,.bpi-row.bpi-pinned .bpi-zh{color:#fff;text-shadow:0 0 7px rgba(109,190,255,.6)}
    .bpi-badge{flex:none;border:1px solid #526075;border-radius:8px;padding:0 5px;color:#aab6c9;font-size:9px;line-height:15px}.bpi-source{border-color:#3e6f67;color:#86d5c4}.bpi-confidence-high{border-color:#3f785c;color:#85d5a6}.bpi-confidence-medium{border-color:#8a7538;color:#e2ca78}.bpi-confidence-low,.bpi-confidence-none{border-color:#7a4c55;color:#ee9ca8}.bpi-unknown .bpi-badge{color:#ffc277;border-color:#85602f}.bpi-machine .bpi-badge{color:#cbb1ff;border-color:#6b5594}.bpi-inline-actions{display:flex;gap:3px;margin-left:auto;flex-wrap:wrap}.bpi-mini{border:1px solid #526075;border-radius:4px;background:#252e3b;color:#dbe7f6;padding:1px 5px;cursor:pointer;font-size:9px}.bpi-mini:hover{background:#3c4b60}.bpi-inline-editor{min-width:90px;flex:1;border:1px solid #4ca7e8;border-radius:4px;background:#141a22;color:#eaf3ff;padding:3px 5px}.bpi-empty{padding:24px;text-align:center;color:#7f8a9a}
    .bpi-filters{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bpi-filter-active{background:#365f84;border-color:#5792c4;color:#fff}.bpi-star{color:#8f9aaa}.bpi-star.bpi-starred{color:#ffd45f;border-color:#8f772f}.bpi-result.bpi-result-selected{background:#314b68;outline:1px solid #5688b5}.bpi-result-star{font-size:14px;color:#8995a8;align-self:center}.bpi-result-star.bpi-starred{color:#ffd45f}
    .bpi-drag-handle{flex:none;cursor:grab;color:#7194ad;font-size:11px;line-height:1;user-select:none;padding:1px 2px;border-radius:3px}.bpi-drag-handle:hover{color:#a9c8e4;background:#2b3a4d}.bpi-drag-handle:active{cursor:grabbing}
    .bpi-row.bpi-dragging,.bpi-english-token.bpi-dragging{opacity:.45}.bpi-english-token.bpi-dragging{cursor:grabbing}
    .bpi-drop-indicator{position:absolute;left:3px;right:3px;height:0;border-top:2px solid #76c9ff;box-shadow:0 0 5px rgba(118,201,255,.55);z-index:3;pointer-events:none}
    .bpi-mirror-token{user-select:none}.bpi-english-token.bpi-drop-before{box-shadow:-2px 0 0 0 #76c9ff,0 0 5px rgba(118,201,255,.4)}.bpi-english-token.bpi-drop-after{box-shadow:2px 0 0 0 #76c9ff,0 0 5px rgba(118,201,255,.4)}
    .bpi-english-token{position:relative}.bpi-hide-btn{flex:none;cursor:pointer;color:#7194ad;font-size:11px;line-height:1;user-select:none;padding:1px 2px;border-radius:3px;display:inline-flex;align-items:center}.bpi-hide-btn:hover{color:#9ed0ff;background:#2b3a4d}.bpi-eye-icon{display:inline-flex;align-items:center}
    .bpi-chip-hide{position:absolute;top:-5px;right:-5px;display:none;cursor:pointer;padding:1px 2px;border-radius:999px;background:#1d2937;border:1px solid #4c5668;color:#9ed0ff;line-height:1;z-index:2}.bpi-english-token:hover .bpi-chip-hide{display:inline-flex}.bpi-chip-hide:hover{background:#285f8e;border-color:#76c9ff;color:#fff}
    .bpi-hidden-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 2px;border-top:1px solid #29313d}.bpi-hidden-bar.bpi-hidden{display:none}.bpi-hidden-label{flex:none;color:#87a3bb;font-size:11px}
    .bpi-hidden-chip{display:inline-flex;align-items:center;gap:5px;max-width:280px;overflow:hidden;border:1px dashed #4c5668;border-radius:999px;padding:2px 8px;background:#20262f;color:#8b98a8;cursor:pointer;font-size:11px}.bpi-hidden-chip:hover{background:#31404f;border-color:#76c9ff;color:#d7e6f7}.bpi-hidden-en{text-decoration:line-through;white-space:nowrap}.bpi-hidden-zh{color:#7194ad;font-size:10px}.bpi-hidden-restore{color:#76c9ff;font-size:12px}
    .bpi-hidden-all{margin-left:auto}
    .bpi-modal-shade{position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center}.bpi-modal{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;background:#20252d;color:#edf2f9;border:1px solid #596577;border-radius:10px;padding:16px;box-shadow:0 18px 55px rgba(0,0,0,.55)}.bpi-modal h3{margin:0 0 12px;font-size:16px}.bpi-form{display:grid;grid-template-columns:92px minmax(0,1fr);gap:9px;align-items:center}.bpi-form label{color:#b7c1cf}.bpi-form input,.bpi-form select,.bpi-form textarea{box-sizing:border-box;width:100%;border:1px solid #4c586b;border-radius:5px;background:#14181f;color:#eef3fa;padding:6px 7px}.bpi-form textarea{min-height:112px;resize:vertical;font:11px/1.45 Arial,sans-serif}.bpi-form input:focus,.bpi-form select:focus,.bpi-form textarea:focus{outline:none;border-color:#4ca7e8}.bpi-modal-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:14px;flex-wrap:wrap}.bpi-weight-presets{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}.bpi-about-modal{width:min(460px,calc(100vw - 32px))}.bpi-about-name{margin-bottom:7px;color:#d7e9f8;font-weight:700}.bpi-config-note{color:#98a7b9;font-size:10px;word-break:break-all}.bpi-preview-text{box-sizing:border-box;width:100%;min-height:130px;max-height:300px;resize:vertical;border:1px solid #485467;border-radius:6px;background:#12171e;color:#e7eef8;padding:8px;font:12px/1.5 monospace}.bpi-sort-groups{max-height:230px;overflow:auto;border:1px solid #3e4958;border-radius:6px;background:#151a21;padding:6px;margin:8px 0}.bpi-sort-group{display:grid;grid-template-columns:145px minmax(0,1fr);gap:7px;padding:4px;border-top:1px solid #29313c}.bpi-sort-group:first-child{border-top:0}.bpi-sort-group strong{color:#9fd3ff}
    .bpi-about-footer{flex:none;min-height:20px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:1px 4px 0;color:#6f7a89;font-size:9px}.bpi-about-button{border:0;background:transparent;color:#8096ab;padding:1px 3px;cursor:pointer;font-size:9px}.bpi-about-button:hover{color:#b8dcfa;text-decoration:underline}
    .bpi-pack-section{border:1px solid #465163;border-radius:7px;background:#151a21;padding:7px;margin-bottom:8px}.bpi-pack-toolbar{display:flex;gap:6px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:6px}.bpi-pack-toolbar strong{color:#d7e2ef}.bpi-pack-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:5px;max-height:166px;overflow:auto}.bpi-pack-card{border:1px solid #394454;border-radius:6px;background:#202731;padding:6px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px;align-items:start}.bpi-pack-card.bpi-pack-disabled{opacity:.58}.bpi-pack-name{font-weight:700;color:#e3edf8}.bpi-pack-meta{font-size:10px;color:#9ba9ba;margin-top:2px;word-break:break-word}.bpi-pack-controls{display:flex;gap:3px;flex-wrap:wrap;justify-content:flex-end}.bpi-switch{margin-top:3px}.bpi-pack-personal{border-color:#397062}.bpi-community-form{display:grid;grid-template-columns:105px minmax(0,1fr);gap:8px;align-items:center}.bpi-community-form input{border:1px solid #4b5668;border-radius:5px;background:#141920;color:#edf3fb;padding:6px}.bpi-community-preview{max-height:150px;overflow:auto;border:1px solid #3d4757;border-radius:5px;padding:5px;margin-top:8px;color:#aeb9c8}
    .bpi-import-conflicts{max-height:240px;overflow:auto;border:1px solid #4b5567;border-radius:6px;margin-top:10px}.bpi-import-conflict{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:6px;border-top:1px solid #323b48}.bpi-import-conflict:first-child{border-top:0}.bpi-import-stat{display:flex;gap:12px;flex-wrap:wrap;color:#c8d2df}.bpi-danger-text{color:#ff9ba3}
    .bpm-panel{box-sizing:border-box;width:100%;height:100%;min-height:280px;display:flex;flex-direction:column;gap:7px;padding:8px;color:var(--input-text,#ddd);font:12px/1.4 Arial,sans-serif;overflow:hidden}
    .bpm-head{flex:none;display:flex;align-items:center;gap:7px;flex-wrap:wrap}.bpm-head strong{color:#cbe8ff}.bpm-head .bpi-status{margin-left:auto}
    .bpm-tabs{flex:none;display:flex;gap:4px}.bpm-tab{flex:1;border:1px solid #4c5668;border-radius:5px;padding:4px 6px;background:#2c3340;color:#e8edf5;cursor:pointer;font-size:11px;line-height:1.25}.bpm-tab:hover{background:#3a4658}.bpm-tab.bpm-tab-active{background:#285f8e;border-color:#3f83ba;color:#fff}
    .bpm-section{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px}.bpm-section[hidden]{display:none}
    .bpm-toolbar{flex:none;display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bpm-toolbar .bpi-search{min-width:120px}.bpm-toolbar .bpi-mode{flex:1;min-width:90px}
    .bpm-summary{flex:none;color:#aab5c5;font-size:11px;min-height:15px;word-break:break-all}
    .bpm-rows{flex:1;min-height:120px;overflow-y:auto;scrollbar-gutter:stable;border:1px solid #3c4553;border-radius:6px;background:#11151b}.bpm-tagmanager-host{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:7px;padding-right:2px}.bpm-tagmanager-host .bpi-details-body{display:flex;flex-direction:column;gap:7px}.bpm-tagmanager-host .bpi-table{height:auto;min-height:220px;max-height:none;flex:0 1 auto}
    .bpm-row{border-top:1px solid #29313d;padding:6px 8px;display:flex;flex-direction:column;gap:3px}.bpm-row:first-child{border-top:0}.bpm-row:hover{background:#29384a}
    .bpm-row-top{display:flex;align-items:flex-start;gap:5px}.bpm-row-top input[type="checkbox"]{margin-top:2px}.bpm-row-en{color:#e6edf7;font-family:Consolas,monospace;word-break:break-word;min-width:0;flex:1}
    .bpm-row-zh{color:#9ed0ff;word-break:break-word}
    .bpm-row-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:#8794a8;font-size:10px}
    .bpm-actions{display:flex;gap:4px;flex-wrap:wrap}
    .bpm-footer{flex:none;display:flex;gap:4px;align-items:center;justify-content:space-between;flex-wrap:wrap}.bpm-footer .bpi-toolbar-group{justify-content:flex-start}
    .bpm-section .bpi-pack-list{flex:1;min-height:0;max-height:none;grid-template-columns:1fr}
    .bpm-section .bpi-form{grid-template-columns:78px minmax(0,1fr)}.bpm-section .bpi-form textarea{min-height:84px}
    .bpm-assistant-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
    .bpm-loading{padding:24px;text-align:center;color:#7f8a9a}
  `;
  document.head.appendChild(style);
}

export {
  API_ROOT,
  MANAGER_TAB_ID,
  MANAGER_OPEN_EVENT,
  button,
  deleteCommunityPack,
  deletePersonalTag,
  downloadJson,
  element,
  exportDictionaryPack,
  exportPersonalDictionary,
  field,
  getAssistantConfig,
  importCommunityPack,
  importTags,
  bulkUpdateTags,
  injectBpiStyles,
  loadDictionary,
  loadPreferences,
  lookupLargeDictionary,
  openManagerPanel,
  openTagDialog,
  runInspectorAssistant,
  saveAssistantConfig,
  savePreferences,
  saveTag,
  searchLargeDictionary,
  setLargeDictionaryEnabled,
  setPackEnabled,
  testAssistantConnection,
};
