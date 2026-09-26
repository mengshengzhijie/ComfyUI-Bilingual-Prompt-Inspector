import { app } from "../../scripts/app.js";
import { normalizePreferences } from "./dictionary_tools.js";
import {
  LANGUAGE_CHANGED_EVENT,
  applyLanguageToDom,
  getLanguageMode,
  loadStoredLanguage,
  markText,
  registerLocaleReader,
  setLanguageMode,
  setPlaceholder,
  setText,
  setTitle,
  t,
} from "./i18n.js";

const API_ROOT = "/bpi";
const PREFERENCES_KEY = "bpi.dictionary.preferences.v1";
const MANAGER_TAB_ID = "bpi-manager";
const MANAGER_OPEN_EVENT = "bpi:open-manager";
// 后端把上游传来的提示词推给前端时使用的事件名
const UPSTREAM_ARRIVED_EVENT = "bpi/upstream-arrived";

let sessionTokenPromise = null;
let dictionaryPromise = null;

// 插件语言：ComfyUI 自带的 locale 只翻译 nodeDefs，面板文案得自己来。
// 「跟随 ComfyUI」读 ComfyUI 的 Comfy.Locale 设置，中文系语言走中文，其余走英文。
registerLocaleReader(() => app?.ui?.settings?.getSettingValue?.("Comfy.Locale"));
loadStoredLanguage();

async function getSessionToken(force = false) {
  if (!sessionTokenPromise || force) {
    sessionTokenPromise = fetch(`${API_ROOT}/session`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        const token = result?.data?.token;
        if (!response.ok || !result.success || !token) throw new Error(result.error || "Local session initialization failed");
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

async function postUpstreamAction(action, nodeId, text = null) {
  const payload = { node_id: String(nodeId ?? "") };
  if (typeof text === "string") payload.text = text;
  const response = await bpiFetch(`${API_ROOT}/upstream/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) throw new Error(result?.error || `Resume failed (${response.status})`);
  return result;
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
    console.warn("[BilingualPromptInspector] Failed to save favorites and recent items", error);
  }
}

function loadDictionary(force = false) {
  if (!dictionaryPromise || force) {
    dictionaryPromise = bpiFetch(`${API_ROOT}/dictionary`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || "Dictionary load failed");
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
  if (text !== undefined) {
    item.textContent = t(text);
    markText(item, text);
  }
  return item;
}

function button(label, action, className = "") {
  const item = element("button", `bpi-button ${className}`.trim(), t(label));
  markText(item, label); // 记住英文原文，切换语言时可整树重刷
  item.type = "button";
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action(event);
  });
  return item;
}

// 输入框旁边的「?」：鼠标悬停或键盘聚焦时弹出说明气泡。
// 气泡内容直接写进 DOM，走 t() 翻译；\n 会被 CSS 的 pre-line 渲染成换行。
function helpMark(helpText) {
  const mark = element("span", "bpi-help", "?");
  mark.tabIndex = 0;
  mark.appendChild(element("span", "bpi-help-pop", helpText));
  return mark;
}

function field(form, labelText, name, value = "", placeholder = "") {
  const label = element("label", "", labelText);
  label.htmlFor = `bpi-field-${name}`;
  const input = element("input");
  input.id = label.htmlFor;
  input.name = name;
  input.value = value ?? "";
  setPlaceholder(input, placeholder);
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
    throw new Error("Assistant returned no valid result");
  }
  if (!response.ok || !result.success) {
    const error = new Error(result.error || "Assistant processing failed");
    error.status = response.status; // 429 = 插件自己的限流计数器，前端据此等待重试
    throw error;
  }
  const output = result.data?.text;
  if (!output || typeof output !== "string") throw new Error("Assistant returned no text");
  return output.trim();
}

async function getAssistantConfig() {
  const response = await bpiFetch(`${API_ROOT}/assistant/config`);
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Failed to load assistant settings");
  return result.data;
}

async function saveAssistantConfig(payload) {
  const response = await bpiFetch(`${API_ROOT}/assistant/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Failed to save assistant settings");
  return result.data;
}

async function testAssistantConnection() {
  const response = await bpiFetch(`${API_ROOT}/assistant/test`, { method: "POST" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Connection test failed");
  return result.data;
}

async function saveTag(tag) {
  const response = await bpiFetch(`${API_ROOT}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tag),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Tag save failed");
  return result;
}

async function deletePersonalTag(english) {
  const response = await bpiFetch(`${API_ROOT}/tags/${encodeURIComponent(english)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Personal tag deletion failed");
  return result;
}

async function importTags(tags, mode = "skip") {
  const response = await bpiFetch(`${API_ROOT}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags, mode }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Dictionary import failed");
  return result.data;
}

async function bulkUpdateTags(english, updates) {
  const response = await bpiFetch(`${API_ROOT}/tags/bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ english, updates }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Bulk update failed");
  return result.data;
}

async function setPackEnabled(packId, enabled) {
  const response = await bpiFetch(`${API_ROOT}/packs/${encodeURIComponent(packId)}/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Dictionary pack toggle failed");
  return result.data;
}

async function lookupLargeDictionary(terms) {
  const response = await bpiFetch(`${API_ROOT}/large/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Large dictionary lookup failed");
  return result.data ?? [];
}

async function searchLargeDictionary(query, limit = 40, offset = 0) {
  const parameters = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  const response = await bpiFetch(`${API_ROOT}/large/search?${parameters}`);
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Large dictionary search failed");
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
  if (!response.ok || !result.success) throw new Error(result.error || "Large dictionary toggle failed");
  return result.data;
}

async function importCommunityPack(payload, overwrite = false) {
  const response = await bpiFetch(`${API_ROOT}/packs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, overwrite }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Community pack import failed");
  return result.data;
}

async function deleteCommunityPack(packId) {
  const response = await bpiFetch(`${API_ROOT}/packs/${encodeURIComponent(packId)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Community pack deletion failed");
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
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Dictionary pack export failed");
  return payload;
}

async function exportPersonalDictionary() {
  const response = await bpiFetch(`${API_ROOT}/export`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Export failed");
  return payload;
}

async function listSavedPrompts() {
  const response = await bpiFetch(`${API_ROOT}/saved-prompts`);
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Saved prompts load failed");
  return payload.data ?? [];
}

async function createSavedPrompt({ name, text, note, imageFile }) {
  const form = new FormData();
  form.append("name", name ?? "");
  form.append("text", text ?? "");
  if (typeof note === "string" && note) form.append("note", note);
  if (imageFile) form.append("image", imageFile);
  const response = await bpiFetch(`${API_ROOT}/saved-prompts`, { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Saved prompt creation failed");
  return payload.data;
}

async function deleteSavedPrompt(promptId) {
  const response = await bpiFetch(`${API_ROOT}/saved-prompts/${encodeURIComponent(promptId)}`, { method: "DELETE" });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Saved prompt deletion failed");
  return payload.data;
}

async function exportSavedPrompts() {
  const response = await bpiFetch(`${API_ROOT}/saved-prompts/export`);
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Saved prompts export failed");
  return payload.data;
}

async function importSavedPrompts(bundle) {
  const response = await bpiFetch(`${API_ROOT}/saved-prompts/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bundle),
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Saved prompts import failed");
  return payload.data;
}

function savedPromptImageUrl(promptId) {
  return `${API_ROOT}/saved-prompts/${encodeURIComponent(promptId)}/image`;
}

// 保存当前提示词的弹窗：文本自动带好，图片可拖、可选、可粘贴，不想要就空着。
function openSavePromptDialog({ name = "", text = "", note = "" } = {}, onSaved) {
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  const title = element("h3", "", "Save Current Prompt");
  const form = element("form", "bpi-form");
  const nameInput = field(form, "Name", "name", (name || text.trim().slice(0, 24)).slice(0, 80), "Defaults to the start of the prompt");
  const textLabel = element("label", "", "Prompt");
  textLabel.htmlFor = "bpi-save-prompt-text";
  const textPreview = element("textarea", "");
  textPreview.id = "bpi-save-prompt-text";
  textPreview.readOnly = true;
  textPreview.value = text;
  form.append(textLabel, textPreview);
  const imageLabel = element("label", "", "Reference Image");
  const drop = element("div", "bpi-save-drop");
  const previewImage = element("img", "bpi-save-preview");
  const dropText = element("div", "", "Drop an image here, or click to select");
  const fileInfo = element("div", "bpi-save-file", "Optional; PNG / JPG / WebP, max 5 MB");
  drop.append(previewImage, dropText, fileInfo);
  const picker = element("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/webp";
  picker.hidden = true;
  form.append(imageLabel, drop);
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  error.style.gridColumn = "1 / -1";
  form.appendChild(error);

  let imageFile = null;
  const setImage = (file) => {
    imageFile = file;
    previewImage.src = URL.createObjectURL(file);
    previewImage.style.display = "block";
    setText(fileInfo, `“${file.name || "image"}” · ${Math.max(1, Math.round(file.size / 1024))} KB`);
  };
  drop.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    if (picker.files?.[0]) setImage(picker.files[0]);
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("bpi-dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("bpi-dragover"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("bpi-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) setImage(file);
  });
  const onPaste = (event) => {
    const file = event.clipboardData?.files?.[0];
    if (!file) return;
    event.preventDefault();
    setImage(file);
  };
  window.addEventListener("paste", onPaste);
  const close = () => {
    window.removeEventListener("paste", onPaste);
    shade.remove();
  };

  const actions = element("div", "bpi-modal-actions");
  const saveButton = button("Save", async () => {
    if (!text.trim()) {
      setText(error, "Prompt is empty, cannot save");
      return;
    }
    saveButton.disabled = true;
    try {
      const entry = await createSavedPrompt({ name: nameInput.value, text, note, imageFile });
      window.dispatchEvent(new CustomEvent("bpi:saved-prompts-changed", { detail: entry }));
      onSaved?.(entry);
      close();
    } catch (failure) {
      error.textContent = failure.message;
      saveButton.disabled = false;
    }
  }, "bpi-primary");
  actions.append(button("Cancel", close), saveButton);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveButton.click();
  });
  modal.append(title, form, picker, actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => {
    if (event.target === shade) close();
  });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
  requestAnimationFrame(() => nameInput.focus());
  return { close };
}

function openTagDialog(initial, onSaved) {
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  const title = element("h3", "", initial?.english ? "Add or Edit Personal Tag" : "Add Personal Tag");
  const form = element("form", "bpi-form");
  const english = field(form, "English Tag", "english", initial?.english, "e.g.: looking at viewer");
  const chinese = field(form, "Chinese Name", "chinese", initial?.chinese, "e.g.: looking at viewer");
  const aliases = field(form, "Chinese Aliases", "aliases", initial?.aliases?.join("，"), "Comma-separated");
  const category = field(form, "Category", "category", initial?.category ?? "Custom", "e.g.: pose, camera, style");
  const models = field(form, "Models", "models", initial?.models?.join("，") ?? "general, anima", "Comma-separated");
  const weight = field(form, "Recommended Weight", "recommended_weight", initial?.recommended_weight ?? "", "Optional");
  const notes = field(form, "Notes", "notes", initial?.notes, "Optional");
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  error.style.gridColumn = "1 / -1";
  form.appendChild(error);
  const actions = element("div", "bpi-modal-actions");
  const close = () => shade.remove();
  actions.append(
    button("Cancel", close),
    button("Save to Personal Dictionary", () => form.requestSubmit(), "bpi-primary"),
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
    console.warn("[BilingualPromptInspector] Current ComfyUI frontend does not support sidebar panel");
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
    :root{--bpi-surface:rgba(255,255,255,.92);--bpi-surface-2:#f5f5f5;--bpi-surface-3:#eaeaea;--bpi-surface-table:#f0f0f0;--bpi-surface-modal:#fff;--bpi-text:#333;--bpi-text-muted:#666;--bpi-text-faint:#999;--bpi-border:#ccc;--bpi-border-2:#bbb;--bpi-border-3:#e0e0e0;--bpi-button-bg:#e8e8e8;--bpi-button-text:#333;--bpi-input-bg:#fff;--bpi-input-text:#333;--bpi-head-bg:#e8e8e8;--bpi-editor-bg:#fff}
    .dark-theme{--bpi-surface:rgba(10,12,18,.72);--bpi-surface-2:#171b22;--bpi-surface-3:#14181f;--bpi-surface-table:#11151b;--bpi-surface-modal:#20252d;--bpi-text:#e6edf7;--bpi-text-muted:#aab5c5;--bpi-text-faint:#7f8a9a;--bpi-border:#3a4250;--bpi-border-2:#4c5668;--bpi-border-3:#29313d;--bpi-button-bg:#2c3340;--bpi-button-text:#e8edf5;--bpi-input-bg:#171b22;--bpi-input-text:#eef3fb;--bpi-head-bg:#252c36;--bpi-editor-bg:#111923}
    [data-bpi-theme="dark"]{--bpi-surface:rgba(10,12,18,.72);--bpi-surface-2:#171b22;--bpi-surface-3:#14181f;--bpi-surface-table:#11151b;--bpi-surface-modal:#20252d;--bpi-text:#e6edf7;--bpi-text-muted:#aab5c5;--bpi-text-faint:#7f8a9a;--bpi-border:#3a4250;--bpi-border-2:#4c5668;--bpi-border-3:#29313d;--bpi-button-bg:#2c3340;--bpi-button-text:#e8edf5;--bpi-input-bg:#171b22;--bpi-input-text:#eef3fb;--bpi-head-bg:#252c36;--bpi-editor-bg:#111923}
    [data-bpi-theme="light"]{--bpi-surface:rgba(255,255,255,.92);--bpi-surface-2:#f5f5f5;--bpi-surface-3:#eaeaea;--bpi-surface-table:#f0f0f0;--bpi-surface-modal:#fff;--bpi-text:#333;--bpi-text-muted:#666;--bpi-text-faint:#999;--bpi-border:#ccc;--bpi-border-2:#bbb;--bpi-border-3:#e0e0e0;--bpi-button-bg:#e8e8e8;--bpi-button-text:#333;--bpi-input-bg:#fff;--bpi-input-text:#333;--bpi-head-bg:#e8e8e8;--bpi-editor-bg:#fff}
    .bpi-panel{box-sizing:border-box;width:100%;height:100%;min-height:var(--bpi-collapsed-height,390px);max-height:var(--bpi-collapsed-height,390px);padding:8px;display:flex;flex-direction:column;gap:7px;color:var(--bpi-text);font:12px/1.4 Arial,sans-serif;background:var(--bpi-surface);border:1px solid var(--bpi-border);border-radius:8px;overflow-y:auto;scrollbar-gutter:stable}
    .bpi-english-section{flex:none;border:1px solid #3e7197;border-radius:7px;background:var(--bpi-surface);overflow:hidden}.bpi-english-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:var(--bpi-head-bg);color:#cbe8ff;font-weight:700;flex-wrap:wrap}.bpi-english-hint{margin-left:auto;color:#91b4cf;font-size:10px;font-weight:400}.bpi-english-token-view{box-sizing:border-box;width:100%;height:auto;min-height:92px;max-height:360px;overflow:auto;scrollbar-gutter:stable;padding:8px 9px;outline:none;color:var(--bpi-text);font:12px/1.85 Consolas,monospace;white-space:normal}.bpi-english-token-view:focus{box-shadow:inset 0 0 0 1px #5aa6d8}.bpi-english-editor{box-sizing:border-box;width:100%;height:120px;min-height:92px;max-height:420px;overflow-y:auto;resize:vertical;border:0;border-top:1px solid #3e7197;background:var(--bpi-editor-bg);color:var(--bpi-text);padding:9px;outline:none;font:12px/1.55 Consolas,monospace}.bpi-english-editor:focus{box-shadow:inset 0 0 0 1px #5aa6d8}.bpi-english-token{font-family:Consolas,monospace;color:var(--bpi-text)}.bpi-english-token.bpi-linked{background:#147fc3;border-color:#76c9ff;color:#fff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}
    .bpi-mirror-section{flex:none;border:1px solid #488739;border-radius:7px;background:var(--bpi-surface);overflow:visible}.bpi-section-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:var(--bpi-head-bg);color:#cbe9c8;font-weight:700;flex-wrap:wrap}.bpi-section-hint{margin-left:auto;color:#91ad93;font-size:10px;font-weight:400}.bpi-mirror-actions{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bpi-chinese-mirror{box-sizing:border-box;width:100%;height:auto;min-height:92px;max-height:360px;overflow:auto;resize:none;scrollbar-gutter:stable;padding:8px 9px;outline:none;color:var(--bpi-text);line-height:1.85;cursor:text;white-space:normal}.bpi-chinese-mirror:focus{box-shadow:inset 0 0 0 1px #70b35f}.bpi-category-table{display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);border:1px solid #315f3a;border-radius:6px;overflow:hidden;background:var(--bpi-surface-3)}.bpi-category-row{display:contents}.bpi-category-name,.bpi-category-content{padding:6px 8px;border-top:1px solid #31513a}.bpi-category-row:first-child .bpi-category-name,.bpi-category-row:first-child .bpi-category-content{border-top:0}.bpi-category-name{background:var(--bpi-head-bg);border-right:1px solid #31513a;color:#9ee8a7;font-weight:700}.bpi-category-content{min-width:0}.bpi-chinese-editor{box-sizing:border-box;width:100%;height:auto;min-height:110px;max-height:600px;overflow-y:auto;resize:vertical;border:0;border-top:1px solid #3b693c;background:var(--bpi-editor-bg);color:var(--bpi-text);padding:9px;outline:none;font:12px/1.65 Arial,sans-serif}.bpi-chinese-editor:focus{box-shadow:inset 0 0 0 1px #70b35f}.bpi-hidden{display:none!important}.bpi-mirror-empty{color:var(--bpi-text-muted)}.bpi-mirror-token{display:inline-flex;align-items:center;border:1px solid transparent;border-radius:5px;padding:0 3px;margin:1px 0;cursor:pointer;transition:background .12s,border-color .12s,color .12s}.bpi-mirror-token:hover{background:#345a3b;border-color:#5c8d63;color:#fff}.bpi-mirror-token.bpi-linked{background:#315f83;border-color:#76a9ff;color:#fff}
    .bpi-mirror-token.bpi-linked,.bpi-english-token.bpi-linked{background:#147fc3;border-color:#76c9ff;color:#fff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}.bpi-english-token-view .bpi-mirror-separator{color:#7194ad}
    .bpi-toolbar,.bpi-search-line,.bpi-summary{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .bpi-toolbar{justify-content:space-between}.bpi-toolbar-group{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
    .bpi-button{border:1px solid var(--bpi-border-2);border-radius:5px;padding:4px 8px;background:var(--bpi-button-bg);color:var(--bpi-button-text);cursor:pointer;font-size:11px;line-height:1.25}
    .bpi-button:hover{background:var(--bpi-border-3);border-color:#6c83a8}.bpi-button:disabled{opacity:.45;cursor:default}.bpi-button.bpi-primary{background:#285f8e;border-color:#3f83ba}.bpi-button.bpi-danger{background:#65313b;border-color:#8d4653}
    .bpi-search{flex:1;min-width:140px;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:5px 7px;outline:none}.bpi-search:focus{border-color:#4ca7e8}.bpi-searching{padding:5px 8px;color:var(--bpi-text-muted);font-size:10px}
    .bpi-mode{border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:5px 6px;font-size:11px;outline:none}.bpi-mode:focus{border-color:#4ca7e8}.bpi-mode-info{color:#87bfea}
    .bpi-summary{color:var(--bpi-text-muted);font-size:11px;min-height:17px}.bpi-status{margin-left:auto}.bpi-status[data-kind="error"]{color:#ff8b93}.bpi-status[data-kind="ok"]{color:#7fdda2}.bpi-status[data-kind="busy"]{color:#ffd27a}
    .bpi-issues{display:none;max-height:105px;overflow:auto;border:1px solid #5b4a36;border-radius:6px;background:rgba(55,39,25,.55);padding:4px 6px}.bpi-issues.bpi-visible{display:block}.bpi-issue{padding:2px 4px;color:#e6c792}.bpi-issue[data-severity="error"]{color:#ff9299}.bpi-issue[data-severity="info"]{color:#86c8eb}.bpi-issue::before{content:"⚠ ";}.bpi-issue[data-severity="error"]::before{content:"⛔ ";}.bpi-issue[data-severity="info"]::before{content:"ℹ ";}
    .bpi-search-label{color:var(--bpi-text-muted);font-size:10px;white-space:nowrap}.bpi-results{display:none;max-height:220px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-2)}.bpi-results.bpi-visible{display:block}.bpi-result{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(150px,auto);gap:7px;padding:5px 7px;border-bottom:1px solid var(--bpi-border-3);cursor:pointer}.bpi-result:last-child{border-bottom:0}.bpi-result:hover{background:var(--bpi-surface-3)}.bpi-result-en{color:var(--bpi-text)}.bpi-result-zh{color:#9ed0ff}.bpi-category{color:var(--bpi-text-muted);font-size:10px;white-space:normal}.bpi-search-reason{display:block;color:#77b6df;margin-top:2px}.bpi-search-more{display:block;margin:7px auto}.bpi-results>.bpi-searching{text-align:center}
    .bpi-table{position:relative;height:300px;min-height:180px;max-height:360px;flex:1 1 300px;overflow-x:hidden;overflow-y:scroll;scrollbar-gutter:stable;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-table)}.bpi-split-handle{position:absolute;top:0;bottom:0;left:var(--bpi-split,40%);width:9px;margin-left:-4px;cursor:col-resize;z-index:4}.bpi-split-handle:hover{background:rgba(76,167,232,.35)}.bpi-head,.bpi-row{display:grid;grid-template-columns:var(--bpi-split,minmax(0,2fr)) minmax(0,1fr);gap:1px}.bpi-head{position:sticky;top:0;z-index:2;background:var(--bpi-head-bg);color:var(--bpi-text-muted);font-weight:700}.bpi-head>div,.bpi-cell{padding:6px 8px}.bpi-head>div+div,.bpi-cell+.bpi-cell{border-left:1px solid var(--bpi-border-2)}
    .bpi-row{border-top:1px solid var(--bpi-border-3);cursor:pointer}.bpi-row:hover,.bpi-row.bpi-pinned{background:#314b68}.bpi-row:hover .bpi-cell,.bpi-row.bpi-pinned .bpi-cell{color:#fff}.bpi-row.bpi-unknown{background:rgba(112,70,28,.18)}.bpi-row.bpi-machine{background:rgba(85,62,131,.22)}.bpi-row.bpi-has-warning{box-shadow:inset 3px 0 #d39845}.bpi-row.bpi-has-error{box-shadow:inset 3px 0 #e35b66}
    .bpi-cell{min-width:0;word-break:break-word;display:flex;align-items:flex-start;gap:5px}.bpi-en{color:var(--bpi-text);font-family:Consolas,monospace}.bpi-zh{color:#9ed0ff}.bpi-row:hover .bpi-en,.bpi-row:hover .bpi-zh,.bpi-row.bpi-pinned .bpi-en,.bpi-row.bpi-pinned .bpi-zh{color:#fff;text-shadow:0 0 7px rgba(109,190,255,.6)}
    .bpi-badge{flex:none;border:1px solid var(--bpi-border-2);border-radius:8px;padding:0 5px;color:var(--bpi-text-muted);font-size:9px;line-height:15px}.bpi-source{border-color:#3e6f67;color:#86d5c4}.bpi-confidence-high{border-color:#3f785c;color:#85d5a6}.bpi-confidence-medium{border-color:#8a7538;color:#e2ca78}.bpi-confidence-low,.bpi-confidence-none{border-color:#7a4c55;color:#ee9ca8}.bpi-unknown .bpi-badge{color:#ffc277;border-color:#85602f}.bpi-machine .bpi-badge{color:#cbb1ff;border-color:#6b5594}.bpi-inline-actions{display:flex;gap:3px;margin-left:auto;flex-wrap:wrap}.bpi-mini{border:1px solid var(--bpi-border-2);border-radius:4px;background:var(--bpi-button-bg);color:var(--bpi-button-text);padding:1px 5px;cursor:pointer;font-size:9px}.bpi-mini:hover{background:#3c4b60}.bpi-inline-editor{min-width:90px;flex:1;border:1px solid #4ca7e8;border-radius:4px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:3px 5px}.bpi-empty{padding:24px;text-align:center;color:var(--bpi-text-faint)}
    .bpi-filters{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.bpi-batch-bar{flex:none;gap:8px;padding:6px 8px;margin-bottom:6px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3)}.bpi-filter-active{background:#365f84;border-color:#5792c4;color:#fff}.bpi-star{color:#8f9aaa}.bpi-star.bpi-starred{color:#ffd45f;border-color:#8f772f}.bpi-result.bpi-result-selected{background:#314b68;outline:1px solid #5688b5}.bpi-result-star{font-size:14px;color:#8995a8;align-self:center}.bpi-result-star.bpi-starred{color:#ffd45f}
    .bpi-quick-section{flex:none;border:1px solid #6b5594;border-radius:7px;background:var(--bpi-surface);overflow:hidden}.bpi-quick-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:var(--bpi-head-bg);color:#d9ccff;font-weight:700;flex-wrap:wrap}.bpi-quick-hint{margin-left:auto;color:#a795c6;font-size:10px;font-weight:400}.bpi-quick-row{display:flex;gap:6px;align-items:flex-start;padding:6px 8px}.bpi-quick-input{flex:1;min-width:0;box-sizing:border-box;height:44px;min-height:44px;max-height:140px;overflow-y:auto;resize:vertical;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:5px 7px;outline:none;font:12px/1.55 Arial,sans-serif}.bpi-quick-input:focus{box-shadow:inset 0 0 0 1px #a98be0}.bpi-quick-row .bpi-button{flex:none}
    .bpi-drag-handle{flex:none;cursor:grab;color:#7194ad;font-size:11px;line-height:1;user-select:none;padding:1px 2px;border-radius:3px}.bpi-drag-handle:hover{color:#a9c8e4;background:#2b3a4d}.bpi-drag-handle:active{cursor:grabbing}
    .bpi-row.bpi-dragging,.bpi-english-token.bpi-dragging{opacity:.45}.bpi-english-token.bpi-dragging{cursor:grabbing}
    .bpi-drop-indicator{position:absolute;left:3px;right:3px;height:0;border-top:2px solid #76c9ff;box-shadow:0 0 5px rgba(118,201,255,.55);z-index:3;pointer-events:none}
    .bpi-break-row{display:flex;align-items:center;gap:8px;border-top:1px solid var(--bpi-border-3);background:#0f6e56;color:#bff0dd;padding:6px 10px;cursor:default}
    .bpi-break-row.bpi-dragging{opacity:.45}
    .bpi-break-row .bpi-drag-handle{color:#bff0dd}.bpi-break-row .bpi-drag-handle:hover{color:#fff;background:#0a5240}
    .bpi-break-row-label{flex:1;font-size:12px;font-weight:500;letter-spacing:.5px}
    .bpi-mirror-token{user-select:none}.bpi-english-token.bpi-drop-before,.bpi-mirror-token.bpi-drop-before{box-shadow:-2px 0 0 0 #76c9ff,0 0 5px rgba(118,201,255,.4)}.bpi-english-token.bpi-drop-after,.bpi-mirror-token.bpi-drop-after{box-shadow:2px 0 0 0 #76c9ff,0 0 5px rgba(118,201,255,.4)}
    .bpi-english-token{position:relative}.bpi-hide-btn{flex:none;cursor:pointer;color:#7194ad;font-size:11px;line-height:1;user-select:none;padding:1px 2px;border-radius:3px;display:inline-flex;align-items:center}.bpi-hide-btn:hover{color:#9ed0ff;background:#2b3a4d}.bpi-eye-icon{display:inline-flex;align-items:center}
    .bpi-chip-hide{position:absolute;top:-5px;right:-5px;display:none;cursor:pointer;padding:1px 2px;border-radius:999px;background:#1d2937;border:1px solid #4c5668;color:#9ed0ff;line-height:1;z-index:2}.bpi-english-token:hover .bpi-chip-hide{display:inline-flex}.bpi-chip-hide:hover{background:#285f8e;border-color:#76c9ff;color:#fff}
.bpi-token-line{display:flex;flex-wrap:wrap;align-items:flex-end;gap:2px 0}
    .bpi-token-card{display:inline-flex;flex-direction:column;align-items:flex-start;max-width:100%;border:1px solid var(--bpi-border-3);border-radius:5px;background:var(--bpi-surface-3);padding:1px 5px;margin:2px 3px 2px 0;vertical-align:top;cursor:pointer}
    .bpi-token-card:hover{border-color:var(--bpi-border-secondary)}
    .bpi-token-card.bpi-dragging{opacity:.45;cursor:grabbing}
    .bpi-token-card .bpi-english-token{margin:0;padding:0}
    .bpi-token-card.bpi-card-linked{background:#147fc3;border-color:#76c9ff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}
    .bpi-token-card.bpi-card-linked .bpi-token-card-zh{color:#fff}
    .bpi-token-card.bpi-card-linked .bpi-english-token{background:transparent;border-color:transparent;box-shadow:none;color:#fff}
    .bpi-token-card-zh{min-height:15px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bpi-text-muted);font:11px/1.35 Arial,sans-serif}
    .bpi-category-content{display:flex;flex-wrap:wrap;gap:2px 3px}
.bpi-break-chip{position:relative;display:inline-flex;align-items:center;gap:3px;border:1px dashed #6c83a8;border-radius:5px;background:#1d2937;color:#9ed0ff;padding:0 5px;margin:1px 0;cursor:grab;user-select:none;font-family:Consolas,monospace}
.bpi-break-chip:hover{background:#285f8e;border-color:#76c9ff;color:#fff}
.bpi-break-chip.bpi-dragging{opacity:.45;cursor:grabbing}
.bpi-break-chip.bpi-drop-target{background:#285f8e;border-color:#76c9ff;color:#fff}
.bpi-break-x{display:none;cursor:pointer;color:#9ed0ff;line-height:1}
.bpi-break-chip:hover .bpi-break-x{display:inline-flex}
.bpi-break-x:hover{color:#fff}
.bpi-source-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:5px 7px;margin-bottom:7px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3)}
.bpi-source-bar.bpi-source-waiting{border-color:#8a5f16;background:rgba(70,52,25,.5)}
.bpi-source-label{color:#87bfea;font-size:11px}
.bpi-source-state{color:var(--bpi-text-muted);font-size:11px}
.bpi-source-state.bpi-source-waiting-text{color:#ffd27a}
.bpi-source-toggle{display:inline-flex;gap:5px;align-items:center;font-size:11px;color:var(--bpi-text);cursor:pointer;user-select:none}
.bpi-source-toggle input{margin:0;accent-color:#3f83ba}
.bpi-source-select{border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:3px 5px;font-size:11px}
.bpi-source-select:disabled{opacity:.45}
.bpi-save-drop{position:relative;display:flex;flex-direction:column;gap:5px;align-items:center;justify-content:center;min-height:86px;border:1px dashed var(--bpi-border-2);border-radius:7px;background:var(--bpi-surface-3);color:var(--bpi-text-faint);font-size:11px;text-align:center;cursor:pointer}
.bpi-save-drop.bpi-dragover{border-color:#4ca7e8;color:#9ed0ff}
.bpi-save-preview{display:none;max-width:100%;max-height:150px;border-radius:5px;border:1px solid var(--bpi-border-2)}
.bpi-save-file{color:var(--bpi-text-muted);font-size:10px}
.bpi-fav-card{display:flex;gap:10px;border:1px solid var(--bpi-border);border-radius:7px;background:var(--bpi-surface-2);padding:8px}
.bpi-fav-thumb{width:104px;height:64px;border-radius:5px;background:var(--bpi-surface-3) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--bpi-text-faint);font-size:10px;flex:none;overflow:hidden}
.bpi-fav-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.bpi-fav-name{font-size:12px;color:var(--bpi-text);font-weight:500}
.bpi-fav-name .bpi-fav-date{color:var(--bpi-text-muted);font-weight:400;font-size:10px;margin-left:6px}
.bpi-fav-text{color:var(--bpi-text-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:Consolas,monospace}
.bpi-fav-meta{color:var(--bpi-text-faint);font-size:10px}
.bpi-fav-actions{display:flex;gap:5px;margin-top:2px}
    .bpi-hidden-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 2px;border-top:1px solid var(--bpi-border-3)}.bpi-hidden-bar.bpi-hidden{display:none}.bpi-hidden-label{flex:none;color:var(--bpi-text-muted);font-size:11px}
    .bpi-hidden-chip{display:inline-flex;align-items:center;gap:5px;max-width:280px;overflow:hidden;border:1px dashed var(--bpi-border-2);border-radius:999px;padding:2px 8px;background:var(--bpi-surface-3);color:var(--bpi-text-muted);cursor:pointer;font-size:11px}.bpi-hidden-chip:hover{background:#31404f;border-color:#76c9ff;color:#d7e6f7}.bpi-hidden-en{text-decoration:line-through;white-space:nowrap}.bpi-hidden-zh{color:var(--bpi-text-muted);font-size:10px}.bpi-hidden-restore{color:#76c9ff;font-size:12px}
    .bpi-hidden-all{margin-left:auto}
    .bpi-modal-shade{position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center}.bpi-modal{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;background:var(--bpi-surface-modal);color:var(--bpi-text);border:1px solid var(--bpi-border-2);border-radius:10px;padding:16px;box-shadow:0 18px 55px rgba(0,0,0,.55)}.bpi-modal h3{margin:0 0 12px;font-size:16px}.bpi-form{display:grid;grid-template-columns:92px minmax(0,1fr);gap:9px;align-items:center}.bpi-form label{color:var(--bpi-text-muted)}.bpi-form input,.bpi-form select,.bpi-form textarea{box-sizing:border-box;width:100%;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:6px 7px}.bpi-form textarea{min-height:112px;resize:vertical;font:11px/1.45 Arial,sans-serif}.bpi-form input:focus,.bpi-form select:focus,.bpi-form textarea:focus{outline:none;border-color:#4ca7e8}.bpi-modal-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:14px;flex-wrap:wrap}.bpi-weight-presets{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}.bpi-about-modal{width:min(460px,calc(100vw - 32px))}.bpi-about-name{margin-bottom:7px;color:var(--bpi-text);font-weight:700}.bpi-config-note{color:var(--bpi-text-muted);font-size:10px;word-break:break-all}
.bpi-help{position:relative;display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;margin-left:5px;border:1px solid var(--bpi-border);border-radius:50%;color:var(--bpi-text-muted);font:10px/1 Arial,sans-serif;vertical-align:middle;cursor:help;user-select:none}
.bpi-help:hover,.bpi-help:focus{color:var(--bpi-text);border-color:var(--bpi-border-2)}
.bpi-help-pop{position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);z-index:80;display:none;box-sizing:border-box;width:290px;max-width:70vw;padding:7px 9px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-modal);color:var(--bpi-text-muted);font:11px/1.65 Arial,sans-serif;white-space:pre-line;text-align:left;cursor:default}
.bpi-help:hover .bpi-help-pop,.bpi-help:focus .bpi-help-pop{display:block}.bpi-preview-text{box-sizing:border-box;width:100%;min-height:130px;max-height:300px;resize:vertical;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3);color:var(--bpi-text);padding:8px;font:12px/1.5 monospace}.bpi-sort-groups{max-height:230px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3);padding:6px;margin:8px 0}.bpi-sort-group{display:grid;grid-template-columns:145px minmax(0,1fr);gap:7px;padding:4px;border-top:1px solid var(--bpi-border-3)}.bpi-sort-group:first-child{border-top:0}.bpi-sort-group strong{color:#9fd3ff}
    .bpi-about-footer{flex:none;min-height:20px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:1px 4px 0;color:var(--bpi-text-faint);font-size:9px}.bpi-about-button{border:0;background:transparent;color:var(--bpi-text-muted);padding:1px 3px;cursor:pointer;font-size:9px}.bpi-about-button:hover{color:#b8dcfa;text-decoration:underline}
    .bpi-pack-section{border:1px solid var(--bpi-border-2);border-radius:7px;background:var(--bpi-surface-3);padding:7px;margin-bottom:8px}.bpi-pack-toolbar{display:flex;gap:6px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:6px}.bpi-pack-toolbar strong{color:var(--bpi-text)}.bpi-pack-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:5px;max-height:166px;overflow:auto}.bpi-pack-card{border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-2);padding:6px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px;align-items:start}.bpi-pack-card.bpi-pack-disabled{opacity:.58}.bpi-pack-name{font-weight:700;color:var(--bpi-text)}.bpi-pack-meta{font-size:10px;color:var(--bpi-text-muted);margin-top:2px;word-break:break-word}.bpi-pack-controls{display:flex;gap:3px;flex-wrap:wrap;justify-content:flex-end}.bpi-switch{margin-top:3px}.bpi-pack-personal{border-color:#397062}.bpi-community-form{display:grid;grid-template-columns:105px minmax(0,1fr);gap:8px;align-items:center}.bpi-community-form input{border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:6px}.bpi-community-preview{max-height:150px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:5px;padding:5px;margin-top:8px;color:var(--bpi-text-muted)}
    .bpi-import-conflicts{max-height:240px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:6px;margin-top:10px}.bpi-import-conflict{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:6px;border-top:1px solid var(--bpi-border-3)}.bpi-import-conflict:first-child{border-top:0}.bpi-import-stat{display:flex;gap:12px;flex-wrap:wrap;color:var(--bpi-text)}.bpi-danger-text{color:#ff9ba3}
    .bpm-panel{box-sizing:border-box;width:100%;height:100%;min-height:280px;display:flex;flex-direction:column;gap:7px;padding:8px;color:var(--bpi-text);font:12px/1.4 Arial,sans-serif;overflow:hidden}
    .bpm-head{flex:none;display:flex;align-items:center;gap:7px;flex-wrap:wrap}.bpm-head strong{color:var(--bpi-text)}.bpm-head .bpi-status{margin-left:auto}
    .bpm-tabs{flex:none;display:flex;gap:4px}.bpm-tab{flex:1;border:1px solid var(--bpi-border-2);border-radius:5px;padding:4px 6px;background:var(--bpi-button-bg);color:var(--bpi-button-text);cursor:pointer;font-size:11px;line-height:1.25}.bpm-tab:hover{background:var(--bpi-border-3)}.bpm-tab.bpm-tab-active{background:#285f8e;border-color:#3f83ba;color:#fff}
    .bpm-section{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px}.bpm-section[hidden]{display:none}
    .bpm-toolbar{flex:none;display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bpm-toolbar .bpi-search{min-width:120px}.bpm-toolbar .bpi-mode{flex:1;min-width:90px}
    .bpm-summary{flex:none;color:var(--bpi-text-muted);font-size:11px;min-height:15px;word-break:break-all}
    .bpm-rows{flex:1;min-height:120px;overflow-y:auto;scrollbar-gutter:stable;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-table)}.bpm-tagmanager-host{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:7px;padding-right:2px}.bpm-tagmanager-host .bpi-details-body{display:flex;flex-direction:column;gap:7px}.bpm-tagmanager-host .bpi-table{height:auto;min-height:220px;max-height:none;flex:0 1 auto}
    .bpm-row{border-top:1px solid var(--bpi-border-3);padding:6px 8px;display:flex;flex-direction:column;gap:3px}.bpm-row:first-child{border-top:0}.bpm-row:hover{background:var(--bpi-surface-3)}
    .bpm-row-top{display:flex;align-items:flex-start;gap:5px}.bpm-row-top input[type="checkbox"]{margin-top:2px}.bpm-row-en{color:var(--bpi-text);font-family:Consolas,monospace;word-break:break-word;min-width:0;flex:1}
    .bpm-row-zh{color:#9ed0ff;word-break:break-word}
    .bpm-row-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:var(--bpi-text-muted);font-size:10px}
    .bpm-actions{display:flex;gap:4px;flex-wrap:wrap}
    .bpm-footer{flex:none;display:flex;gap:4px;align-items:center;justify-content:space-between;flex-wrap:wrap}.bpm-footer .bpi-toolbar-group{justify-content:flex-start}
    .bpm-section .bpi-pack-list{flex:1;min-height:0;max-height:none;grid-template-columns:1fr}
    .bpm-section .bpi-form{grid-template-columns:78px minmax(0,1fr)}.bpm-section .bpi-form textarea{min-height:84px}
    .bpm-assistant-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
    .bpm-loading{padding:24px;text-align:center;color:var(--bpi-text-faint)}
  `;
  document.head.appendChild(style);
}

function applyBpiAppearance(appearance) {
  const value = String(appearance || "auto").toLowerCase();
  if (value === "dark" || value === "light") {
    document.documentElement.setAttribute("data-bpi-theme", value);
  } else {
    document.documentElement.removeAttribute("data-bpi-theme");
  }
}

export {
  API_ROOT,
  LANGUAGE_CHANGED_EVENT,
  MANAGER_TAB_ID,
  MANAGER_OPEN_EVENT,
  UPSTREAM_ARRIVED_EVENT,
  applyBpiAppearance,
  applyLanguageToDom,
  button,
  createSavedPrompt,
  deleteCommunityPack,
  deletePersonalTag,
  deleteSavedPrompt,
  downloadJson,
  element,
  exportDictionaryPack,
  exportPersonalDictionary,
  exportSavedPrompts,
  field,
  getAssistantConfig,
  helpMark,
  getLanguageMode,
  importCommunityPack,
  importSavedPrompts,
  importTags,
  bulkUpdateTags,
  injectBpiStyles,
  listSavedPrompts,
  loadDictionary,
  loadPreferences,
  lookupLargeDictionary,
  openManagerPanel,
  openSavePromptDialog,
  openTagDialog,
  postUpstreamAction,
  savedPromptImageUrl,
  runInspectorAssistant,
  saveAssistantConfig,
  savePreferences,
  saveTag,
  searchLargeDictionary,
  setLanguageMode,
  setLargeDictionaryEnabled,
  setPackEnabled,
  setPlaceholder,
  setText,
  setTitle,
  t,
  testAssistantConnection,
};
