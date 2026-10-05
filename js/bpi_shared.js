import { app } from "../../scripts/app.js";
import { normalizePreferences } from "./dictionary_tools.js";
import { matchModelNames } from "./model_suggest.js";
import { ANIMA_SLOTS } from "./anima_sorter.js";
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
// 一条收藏最多记多少个「适合模型」，和后端 MAX_MODELS 对齐
const MAX_SAVED_MODELS = 20;
const PREFERENCES_KEY = "bpi.dictionary.preferences.v1";
const MANAGER_TAB_ID = "bpi-manager";
const MANAGER_OPEN_EVENT = "bpi:open-manager";
// 后端把上游传来的提示词推给前端时使用的事件名
const UPSTREAM_ARRIVED_EVENT = "bpi/upstream-arrived";
// 按词库配色时，「没命中任何词库」也当成一个来源，与后端 token_color_store.UNINDEXED_PACK_ID 对齐
const UNINDEXED_PACK_ID = "unindexed";
// 骰子：点一下从 random_pool 里随机抽一个颜色
const DICE_ICON = '<svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">'
  + '<rect x="1" y="1" width="12" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.2"/>'
  + '<circle cx="4.5" cy="4.5" r="1.15" fill="currentColor"/><circle cx="9.5" cy="4.5" r="1.15" fill="currentColor"/>'
  + '<circle cx="7" cy="7" r="1.15" fill="currentColor"/>'
  + '<circle cx="4.5" cy="9.5" r="1.15" fill="currentColor"/><circle cx="9.5" cy="9.5" r="1.15" fill="currentColor"/></svg>';

let sessionTokenPromise = null;
let dictionaryPromise = null;
let modelNamesPromise = null;

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

async function checkDuplicateTags(text) {
  const response = await bpiFetch(`${API_ROOT}/duplicate-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: String(text ?? "") }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) throw new Error(result?.error || `Duplicate check failed (${response.status})`);
  return result.data;
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

// 读 data/token_colors.json；用户可以不改源码只改这个文件管理节点标签卡的颜色池。
// 文件不在或格式不对时后端回退内置默认，这里只管透传。
let tokenColorsPromise = null;
function loadTokenColors(force = false) {
  if (!tokenColorsPromise || force) {
    tokenColorsPromise = bpiFetch(`${API_ROOT}/token-colors`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || "Failed to load token colors");
        return result.data;
      })
      .catch((error) => {
        tokenColorsPromise = null;
        throw error;
      });
  }
  return tokenColorsPromise;
}

// 只传要更新的那一类；没传的那类后端保持原样
async function saveTokenColors({ pack_colors: packColors, anima_colors: animaColors } = {}) {
  const response = await bpiFetch(`${API_ROOT}/token-colors/colors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pack_colors: packColors, anima_colors: animaColors }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Failed to save colors");
  // 缓存失效：保存完节点那边要重新拉一次才能看到新配色
  tokenColorsPromise = null;
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

async function listModelNames(force = false) {
  if (!modelNamesPromise || force) {
    modelNamesPromise = bpiFetch(`${API_ROOT}/model-names`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || payload.success === false) throw new Error(payload.error || "Model names load failed");
        return payload.data ?? [];
      })
      .catch((error) => {
        modelNamesPromise = null;
        throw error;
      });
  }
  return modelNamesPromise;
}

async function createSavedPrompt({ name, text, note, models, imageFile }) {
  const form = new FormData();
  form.append("name", name ?? "");
  form.append("text", text ?? "");
  if (typeof note === "string" && note) form.append("note", note);
  for (const model of Array.isArray(models) ? models : []) form.append("models", model);
  if (imageFile) form.append("image", imageFile);
  const response = await bpiFetch(`${API_ROOT}/saved-prompts`, { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Saved prompt creation failed");
  return payload.data;
}

async function updateSavedPrompt({ id, name, text, note, models, imageFile }) {
  const form = new FormData();
  form.append("name", name ?? "");
  form.append("text", text ?? "");
  if (typeof note === "string" && note) form.append("note", note);
  for (const model of Array.isArray(models) ? models : []) form.append("models", model);
  // 不选新图就不带 image 字段，后端据此保留原图
  if (imageFile) form.append("image", imageFile);
  const response = await bpiFetch(`${API_ROOT}/saved-prompts/${encodeURIComponent(id)}`, { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error || "Saved prompt update failed");
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

// 「适合模型」：已选的排成一排可删的标签，输入框按关键词补全本机 models 目录里的模型名。
// 列表里没有的名字照样能回车加进去（比如还没下载的模型），所以输入永远不会被拦。
function buildModelPicker({ initial = [], onError } = {}) {
  const root = element("div", "bpi-autocomplete");
  const chips = element("div", "bpi-chip-row");
  const input = element("input");
  input.id = "bpi-field-models";
  input.autocomplete = "off";
  setPlaceholder(input, "Type keywords");
  const menu = element("div", "bpi-ac-menu");
  menu.hidden = true;

  const values = Array.isArray(initial) ? initial.slice(0, MAX_SAVED_MODELS) : [];
  let catalog = null;
  let suggestions = [];
  let active = -1;

  const renderChips = () => {
    chips.replaceChildren();
    for (const name of values) {
      const chip = element("span", "bpi-chip");
      const label = element("span", "bpi-chip-label");
      label.textContent = name; // 模型名是用户数据，不能进翻译层
      const remove = element("button", "bpi-chip-x", "×");
      remove.type = "button";
      setTitle(remove, "Remove");
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        values.splice(values.indexOf(name), 1);
        renderChips();
      });
      chip.append(label, remove);
      chips.appendChild(chip);
    }
    chips.appendChild(input);
  };

  const closeMenu = () => {
    menu.hidden = true;
    active = -1;
  };

  const renderMenu = () => {
    menu.replaceChildren();
    if (!suggestions.length) {
      closeMenu();
      return;
    }
    suggestions.forEach((entry, index) => {
      const row = element("div", `bpi-ac-item${index === active ? " bpi-ac-active" : ""}`);
      const label = element("span", "bpi-ac-name");
      label.textContent = entry.name;
      const kind = element("span", "bpi-ac-kind");
      kind.textContent = entry.kind;
      row.append(label, kind);
      // 用 mousedown：等到 click 时输入框已经失焦、菜单早被关掉了
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        addModel(entry.name);
      });
      menu.appendChild(row);
    });
    menu.hidden = false;
  };

  const update = () => {
    if (!catalog) {
      suggestions = [];
      renderMenu();
      return;
    }
    suggestions = matchModelNames(catalog, input.value)
      .filter((entry) => !values.some((name) => name.toLowerCase() === entry.name.toLowerCase()));
    active = suggestions.length ? 0 : -1;
    renderMenu();
  };

  const addModel = (raw) => {
    const label = String(raw ?? "").trim();
    if (!label) return;
    if (values.length >= MAX_SAVED_MODELS) {
      onError?.("Model limit reached");
      return;
    }
    if (!values.some((name) => name.toLowerCase() === label.toLowerCase())) values.push(label);
    input.value = "";
    renderChips();
    update();
    input.focus();
  };

  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!suggestions.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + suggestions.length) % suggestions.length;
      renderMenu();
      return;
    }
    if (event.key === "Enter") {
      // 必须拦下来，否则回车会顺带提交整个表单、直接触发保存
      event.preventDefault();
      event.stopPropagation();
      addModel(active >= 0 && suggestions[active] ? suggestions[active].name : input.value);
      return;
    }
    if (event.key === "Escape" && !menu.hidden) {
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (event.key === "Backspace" && !input.value && values.length) {
      values.pop();
      renderChips();
      update();
    }
  });

  // Nodes 2.0 会在捕获阶段拦掉侧边栏的 pointer 事件，所以点空白关闭也挂 document + 捕获
  const onOutside = (event) => {
    if (!root.contains(event.target)) closeMenu();
  };
  document.addEventListener("mousedown", onOutside, true);
  const destroy = () => document.removeEventListener("mousedown", onOutside, true);

  renderChips();
  // 弹窗一打开就去取，等用户开始打字时基本已经就绪
  listModelNames().then((items) => {
    catalog = items;
    update();
  }).catch(() => {
    catalog = [];
  });

  root.append(chips, menu);
  return { root, destroy, models: () => values.slice() };
}

// 保存 / 编辑收藏的弹窗：文本自动带好，图片可拖、可选、可粘贴，不想要就空着。
// 传了 editing（整条收藏）就是编辑：提示词文本放开手改，不选新图则保留原图。
function openSavePromptDialog({ name = "", text = "", note = null, models = [], editing = null } = {}, onSaved) {
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  const title = element("h3", "", editing ? "Edit Favorite" : "Save Current Prompt");
  const form = element("form", "bpi-form");
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  error.style.gridColumn = "1 / -1";
  const nameInput = field(form, "Name", "name", (name || text.trim().slice(0, 24)).slice(0, 80), "Defaults to the start of the prompt");
  const noteInput = field(form, "Note", "note", note ?? "", "Optional");
  const modelPicker = buildModelPicker({ initial: models, onError: (message) => setText(error, message) });
  const modelsLabel = element("label", "", "Models");
  modelsLabel.htmlFor = "bpi-field-models";
  const modelsHint = element("div", "bpi-form-hint", "Press Enter to add; ↑↓ to choose");
  modelsHint.style.gridColumn = "1 / -1";
  form.append(modelsLabel, modelPicker.root, modelsHint);
  const textLabel = element("label", "", "Prompt");
  textLabel.htmlFor = "bpi-save-prompt-text";
  const textPreview = element("textarea", "");
  textPreview.id = "bpi-save-prompt-text";
  textPreview.readOnly = !editing; // 新建时文本来自节点，不该手改；编辑时放开
  textPreview.value = text;
  form.append(textLabel, textPreview);
  const imageLabel = element("label", "", "Reference Image");
  const drop = element("div", "bpi-save-drop");
  const previewImage = element("img", "bpi-save-preview");
  const dropText = element("div", "", "Drop an image here, or click to select");
  const fileInfo = element("div", "bpi-save-file", editing
    ? "Keep the current image, or pick a new one to replace it"
    : "Optional; PNG / JPG / WebP, max 5 MB");
  if (editing?.image) {
    previewImage.src = savedPromptImageUrl(editing.id);
    previewImage.style.display = "block";
  }
  drop.append(previewImage, dropText, fileInfo);
  const picker = element("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/webp";
  picker.hidden = true;
  form.append(imageLabel, drop);
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
    modelPicker.destroy();
    shade.remove();
  };

  const actions = element("div", "bpi-modal-actions");
  const saveButton = button("Save", async () => {
    const promptText = editing ? textPreview.value : text;
    if (!promptText.trim()) {
      setText(error, "Prompt is empty, cannot save");
      return;
    }
    saveButton.disabled = true;
    try {
      const entry = editing
        ? await updateSavedPrompt({
          id: editing.id,
          name: nameInput.value,
          text: promptText,
          note: noteInput.value.trim() || null,
          models: modelPicker.models(),
          imageFile,
        })
        : await createSavedPrompt({
          name: nameInput.value,
          text: promptText,
          note: noteInput.value.trim() || null,
          models: modelPicker.models(),
          imageFile,
        });
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

// 分类候选：只收词库里真实出现过的 category，用得多的排前面。
// 不预置任何「应该有但还没用过」的分类；中英文混着也不翻译，原样列出。
function tagCategoryCounts(data) {
  const counts = new Map();
  for (const tag of data?.tags ?? []) {
    const name = String(tag?.category ?? "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"));
}

// 「分类」输入框：下拉列出已有分类，边打字边收窄，第一项恒为「自定义」。
// 青绿色的「自定义」标识只表示「这个值不是词库里的现成分类」—— 选了自定义才会挂上，
// 手打的值一旦命中某个候选就自动摘掉；编辑历史标签时带进来的陌生值也当场算自定义。
function buildCategoryPicker({ initial = "", categories = [] } = {}) {
  const root = element("div", "bpi-autocomplete");
  const wrap = element("div", "bpi-input-wrap");
  const input = element("input");
  input.id = "bpi-field-category";
  input.name = "category";
  input.autocomplete = "off";
  input.value = initial ?? "";
  setPlaceholder(input, "Type to filter; ↑↓ to choose");
  const badge = element("span", "bpi-custom-badge", "Custom");
  badge.hidden = true;
  const menu = element("div", "bpi-ac-menu");
  menu.hidden = true;
  wrap.append(input, badge);
  root.append(wrap, menu);

  let catalog = categories;
  let rows = [];
  let active = -1;
  let custom = false;

  const setCustom = (flag) => {
    custom = flag;
    badge.hidden = !flag;
  };
  const closeMenu = () => {
    menu.hidden = true;
    active = -1;
  };
  const renderMenu = () => {
    menu.replaceChildren();
    if (!rows.length) {
      closeMenu();
      return;
    }
    rows.forEach((row, index) => {
      const item = element("div", `bpi-ac-item${index === active ? " bpi-ac-active" : ""}${row.custom ? " bpi-ac-custom" : ""}`);
      // 分类名是词库数据，不进翻译层
      const name = element("span", "bpi-ac-name");
      name.textContent = row.custom ? t("Custom") : row.name;
      const hint = element("span", "bpi-ac-kind");
      hint.textContent = row.custom ? (input.value.trim() || t("Manual input")) : t(`${row.count} items`);
      item.append(name, hint);
      // 用 mousedown：等到 click 时输入框已经失焦、菜单早被关掉了
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        commit(row);
      });
      menu.appendChild(item);
    });
    menu.hidden = false;
  };
  const update = ({ reveal = true } = {}) => {
    const needle = input.value.trim().toLowerCase();
    const matches = catalog.filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
    rows = [{ custom: true }, ...matches];
    if (!reveal) {
      menu.hidden = true;
      return;
    }
    // 打出来的字正好等于某个候选时，默认就落在它身上，省一次↓
    const exact = rows.findIndex((row) => !row.custom && row.name === input.value.trim());
    active = exact > 0 ? exact : 0;
    renderMenu();
  };
  const commit = (row) => {
    if (!row) return;
    if (row.custom) {
      setCustom(true);
    } else {
      input.value = row.name;
      setCustom(false);
    }
    closeMenu();
    input.focus();
  };

  input.addEventListener("input", () => {
    if (custom && catalog.some((entry) => entry.name === input.value.trim())) setCustom(false);
    update();
  });
  input.addEventListener("focus", () => update());
  input.addEventListener("click", () => {
    if (menu.hidden) update();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (menu.hidden) {
        update(); // 关着的时候先把列表开出来
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + rows.length) % rows.length;
      renderMenu();
      return;
    }
    if (event.key === "Enter") {
      // 菜单开着才拦回车；关着的时候回车照旧提交整个表单
      if (menu.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      commit(rows[Math.max(0, active)]);
      return;
    }
    if (event.key === "Escape" && !menu.hidden) {
      event.stopPropagation();
      closeMenu();
    }
  });

  // Nodes 2.0 会在捕获阶段拦掉指针事件，所以点空白关闭也挂 document + 捕获
  const onOutside = (event) => {
    if (!root.contains(event.target)) closeMenu();
  };
  document.addEventListener("mousedown", onOutside, true);

  return {
    root,
    destroy: () => document.removeEventListener("mousedown", onOutside, true),
    value: () => input.value.trim(),
    // 候选是异步取来的，取到之后不能把用户的菜单硬弹开
    setCategories: (list) => {
      catalog = list;
      const current = input.value.trim();
      if (current && !catalog.some((entry) => entry.name === current)) setCustom(true);
      // 菜单本来开着就重画，没开就别突然弹出来打断用户
      update({ reveal: !menu.hidden });
    },
  };
}

// 「标签字段」那一整套：独立的「新增／编辑个人标签」弹窗和节点里双击标签卡后的
// 「编辑」页签共用同一份，免得两边各抄一遍字段。
// withTarget = false 时不给「保存到哪个词库」的下拉：双击进来的一定是标签
// （自然语言片段进不了这个入口），恒存个人词库，让选项出现反而是噪音。
// readonlyEnglish：英文只显示、不给输入框。改它并不会改提示词，后端按英文做主键，
// 只会另存一条新词条、旧的还留着——要改提示词里的文字得走节点的「编辑」页。
function buildTagFields(parent, initial = {}, { withTarget = true, readonlyEnglish = false } = {}) {
  const englishValue = String(initial?.english ?? "");
  let english;
  if (readonlyEnglish) {
    const label = element("label", "", "English Tag");
    const text = element("span", "bpi-field-static", englishValue);
    parent.append(label, text);
    // 兼容下面按 input 用法读写的地方：只提供 value / focus 两个口子
    english = { value: englishValue, focus: () => {} };
  } else {
    english = field(parent, "English Tag", "english", initial?.english, "e.g.: looking at viewer");
  }
  const chinese = field(parent, "Chinese Name", "chinese", initial?.chinese, "e.g.: looking at viewer");
  const aliases = field(parent, "Chinese Aliases", "aliases", initial?.aliases?.join("，"), "Comma-separated");
  const categoryLabel = element("label", "", "Category");
  categoryLabel.htmlFor = "bpi-field-category";
  // 分类留空也行：后端会把空值落成「自定义」，所以新建时不要预先塞值、免得一开窗就挂着标识
  const categoryPicker = buildCategoryPicker({ initial: initial?.category ?? "" });
  parent.append(categoryLabel, categoryPicker.root);
  // 候选按词库实际用词实时汇总；取不到就退化成普通手输，这行本来也能打字
  loadDictionary()
    .then((data) => categoryPicker.setCategories(tagCategoryCounts(data)))
    .catch(() => {});
  const models = field(parent, "Models", "models", initial?.models?.join("，") ?? "general, anima", "Comma-separated");
  const weight = field(parent, "Recommended Weight", "recommended_weight", initial?.recommended_weight ?? "", "Optional");
  const notes = field(parent, "Notes", "notes", initial?.notes, "Optional");
  let dictionary = null;
  if (withTarget) {
    const dictionaryLabel = element("label", "", "Save to Dictionary");
    dictionaryLabel.htmlFor = "bpi-field-dictionary";
    dictionary = element("select", "bpi-mode");
    dictionary.id = dictionaryLabel.htmlFor;
    dictionary.name = "dictionary";
    for (const [value, label] of [["personal", "Personal dictionary"], ["natural", "Natural Language Dictionary"]]) {
      const option = element("option", "", label);
      option.value = value;
      dictionary.appendChild(option);
    }
    dictionary.value = initial?.natural ? "natural" : "personal";
    parent.append(dictionaryLabel, dictionary);
  }
  return {
    destroy: () => categoryPicker.destroy(),
    focus: () => (initial?.english ? chinese : english).focus(),
    collect: () => ({
      english: english.value,
      chinese: chinese.value,
      aliases: aliases.value,
      category: categoryPicker.value(),
      models: models.value,
      recommended_weight: weight.value,
      notes: notes.value,
      natural: dictionary ? dictionary.value === "natural" : Boolean(initial?.natural),
      source: initial?.source === "bpi-assistant" ? initial.source : "user",
      verified: initial?.verified ?? true,
    }),
  };
}

function openTagDialog(initial, onSaved) {
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal");
  const title = element("h3", "", initial?.english ? "Add or Edit Personal Tag" : "Add Personal Tag");
  const form = element("form", "bpi-form");
  const fields = buildTagFields(form, initial);
  const error = element("div", "bpi-status");
  error.dataset.kind = "error";
  error.style.gridColumn = "1 / -1";
  form.appendChild(error);
  const actions = element("div", "bpi-modal-actions");
  const close = () => {
    fields.destroy();
    shade.remove();
  };
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
      await saveTag(fields.collect());
      close();
      await onSaved();
    } catch (saveError) {
      error.textContent = saveError.message;
    }
  });
  setTimeout(() => fields.focus(), 0);
}

// 颜色区能配色的「来源」：内置 / 社区词库包 + 大词库 + 两个本机词库 + 未收录。
// 后三者不在 packs 里（个人词库和自然语言词库共用 user_tags.json，未收录压根没有词条），得手工补。
function colorTargets(data) {
  const userTags = data?.user ?? [];
  const items = (count) => t(`${count ?? 0} items`);
  const targets = (data?.packs ?? []).map((pack) => ({ id: pack.id, name: pack.name, meta: items(pack.count) }));
  const large = data?.large_dictionary;
  if (large?.available) {
    targets.push({ id: "danbooru_large", name: large.name, meta: items(large.count) });
  }
  targets.push({ id: "personal", name: t("Personal dictionary"), meta: items(userTags.filter((tag) => !tag.natural).length) });
  targets.push({ id: "natural", name: t("Natural Language Dictionary"), meta: items(userTags.filter((tag) => tag.natural).length) });
  targets.push({ id: UNINDEXED_PACK_ID, name: t("Not indexed"), meta: t("Tags matching no dictionary") });
  return targets;
}

// #RGB / #RRGGBB 统一成小写 6 位；认不出来返回空串（= 不着色）
function normalizeHexColor(value) {
  const text = String(value ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(text)) return "#" + text.slice(1).split("").map((char) => char + char).join("").toLowerCase();
  return "";
}

// 按 Anima 配色时的分类名：跟 anima_sorter.js 的 ANIMA_SLOTS 一一对应。
// 网格卡片窄，用短名，ANIMA_SLOTS 里的英文全称放 meta。
const ANIMA_SHORT_LABELS = {
  quality: "Quality",
  people: "People count",
  character: "Character",
  copyright: "Copyright",
  artist: "Artist",
  appearance: "Appearance",
  action: "Expression",
  camera: "Camera",
  style: "Style",
  environment: "Scene",
  natural: "Natural language",
  uncertain: "Uncertain",
};

function animaColorTargets() {
  return ANIMA_SLOTS.map((slot) => ({
    id: slot.id,
    name: t(ANIMA_SHORT_LABELS[slot.id] ?? slot.label),
    meta: slot.label,
  }));
}

// 一块配色网格：按词库一块、按 Anima 一块，共用这套卡片。改动后由 onCommit 落盘。
function buildColorGrid({ targets, initial, presets, dicePool, error, onCommit }) {
  const grid = element("div", "bpi-color-grid");
  const picked = new Map();
  const setters = [];
  for (const target of targets) {
    picked.set(target.id, initial?.[target.id] || "");
    const card = element("div", "bpi-color-card");
    const chip = element("span", "bpi-color-chip");
    const head = element("div", "bpi-color-card-head");
    head.append(chip, element("span", "", target.name));
    const swatchRow = element("div", "bpi-color-swatches");
    const swatches = [];
    for (const hex of presets) {
      const dot = element("i");
      dot.style.background = hex;
      dot.dataset.color = hex;
      setTitle(dot, hex);
      swatchRow.appendChild(dot);
      swatches.push(dot);
    }
    const input = element("input");
    setPlaceholder(input, "#6b9b78");
    const dice = element("button", "bpi-color-dice");
    dice.type = "button";
    dice.innerHTML = DICE_ICON;
    setTitle(dice, "Random color");
    const row = element("div", "bpi-color-row");
    row.append(input, dice, button("None", () => {
      apply("");
      onCommit();
    }));

    function apply(value) {
      const color = normalizeHexColor(value);
      picked.set(target.id, color);
      chip.style.background = color || "transparent";
      for (const dot of swatches) dot.classList.toggle("bpi-swatch-on", Boolean(color) && dot.dataset.color === color);
      input.value = color;
      error.textContent = "";
    }
    swatchRow.addEventListener("click", (event) => {
      const hex = event.target?.dataset?.color;
      if (!hex) return;
      apply(hex);
      onCommit();
    });
    dice.addEventListener("click", () => {
      apply(dicePool[Math.floor(Math.random() * dicePool.length)]);
      onCommit();
    });
    input.addEventListener("change", () => {
      const value = input.value.trim();
      if (!value) {
        apply("");
        onCommit();
        return;
      }
      if (!normalizeHexColor(value)) {
        error.textContent = t("Invalid color; use #RGB or #RRGGBB");
        return;
      }
      apply(value);
      onCommit();
    });
    apply(picked.get(target.id));
    setters.push(apply);

    card.append(head, element("div", "bpi-color-meta", target.meta), swatchRow, row);
    grid.appendChild(card);
  }
  return {
    root: grid,
    values() {
      const payload = {};
      for (const [id, color] of picked) {
        if (color) payload[id] = color;
      }
      return payload;
    },
    reset() {
      for (const set of setters) set("");
    },
  };
}

// 颜色面板：节点过滤栏点「颜色」就在过滤栏下面就地展开，不做弹窗。
// 跟左边那排筛选按钮一个操作逻辑：点一下立刻生效；按词库 / 按 Anima 才展开对应的配色网格。
function buildColorPanel({ data, colors, mode, onChange }) {
  const root = element("div", "bpi-color-panel");
  const modes = [
    ["default", t("Default"), ["var(--bpi-border-2)"]],
    ["status", t("By inclusion"), ["#c08a4a", "#8a6bb0"]],
    ["random", t("Random"), ["#5b8a72", "#8a5b7a", "#5b6e8a"]],
    ["by_pack", t("By dictionary"), ["#6b9b78", "#6b7b9b", "#9b6b8b"]],
    ["by_anima", t("By Anima"), ["#9b8b6b", "#9b6b8b", "#6b9b9b"]],
  ];
  // 旧存档里可能有不在选项里的值，回落到默认，别让按钮组一个都不亮
  let currentMode = modes.some(([value]) => value === mode) ? mode : "default";
  let live = colors;
  const error = element("div", "bpi-color-error");
  const presets = (colors?.presets ?? []).length ? colors.presets : ["#6b9b78"];
  const dicePool = (colors?.random_pool ?? []).length ? colors.random_pool : presets;

  const modeRow = element("div", "bpi-color-modes");
  const modeButtons = new Map();
  for (const [value, label, dots] of modes) {
    const item = element("button", "bpi-color-mode");
    item.type = "button";
    for (const dot of dots) {
      const mark = element("i", "bpi-color-mode-dot");
      mark.style.background = dot;
      item.appendChild(mark);
    }
    item.appendChild(element("span", "", label));
    // 模式本身不落盘，只有配色才写文件
    item.addEventListener("click", () => setMode(value));
    modeButtons.set(value, item);
    modeRow.appendChild(item);
  }

  async function commit() {
    try {
      live = await saveTokenColors({ pack_colors: packGrid.values(), anima_colors: animaGrid.values() });
      error.textContent = "";
    } catch (saveError) {
      error.textContent = saveError.message;
      return;
    }
    onChange(currentMode, live);
  }

  const gridOptions = { presets, dicePool, error, onCommit: commit };
  const packGrid = buildColorGrid({ ...gridOptions, targets: colorTargets(data), initial: colors?.pack_colors });
  const animaGrid = buildColorGrid({ ...gridOptions, targets: animaColorTargets(), initial: colors?.anima_colors });

  const gridActions = (reset) => {
    const actions = element("div", "bpi-color-panel-actions");
    actions.appendChild(button("Restore defaults", () => {
      reset();
      commit();
    }));
    return actions;
  };
  const packWrap = element("div");
  packWrap.append(
    element("div", "bpi-color-note", t("Pick a color for each dictionary; uncolored ones keep the default.")),
    packGrid.root,
    gridActions(() => packGrid.reset()),
  );
  const animaWrap = element("div");
  animaWrap.append(
    element("div", "bpi-color-note", t("Pick a color for each Anima category; unset ones keep the default.")),
    animaGrid.root,
    gridActions(() => animaGrid.reset()),
  );

  const setMode = (value, notify = true) => {
    currentMode = value;
    for (const [id, item] of modeButtons) item.classList.toggle("bpi-color-mode-active", id === value);
    packWrap.hidden = value !== "by_pack";
    animaWrap.hidden = value !== "by_anima";
    error.textContent = "";
    if (notify) onChange(value, live);
  };

  root.append(modeRow, packWrap, animaWrap, error);
  // 首次只是把当前模式点亮、决定网格显不显示，不该顺带触发一次重绘和同步
  setMode(currentMode, false);
  return root;
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
    :root{--bpm-accent:#45926f;--bpm-accent-hover:#3a7d5e;--bpm-accent-border:#35755a;--bpi-custom-bg:#e6f6f1;--bpi-custom-border:#7fc9b0;--bpi-custom-text:#0f6e56;--bpi-surface:rgba(255,255,255,.92);--bpi-surface-2:#f5f5f5;--bpi-surface-3:#eaeaea;--bpi-surface-table:#f0f0f0;--bpi-surface-modal:#fff;--bpi-text:#333;--bpi-text-muted:#666;--bpi-text-faint:#999;--bpi-border:#ccc;--bpi-border-2:#bbb;--bpi-border-3:#e0e0e0;--bpi-button-bg:#e8e8e8;--bpi-button-text:#333;--bpi-input-bg:#fff;--bpi-input-text:#333;--bpi-head-bg:#e8e8e8;--bpi-danger-bg:#c0392b;--bpi-danger-bg-hover:#a53023;--bpi-danger-border:#a53023;--bpi-danger-text:#fff;--bpi-break-bg:#e6f6f1;--bpi-break-bg-hover:#0f6e56;--bpi-break-border:#7fc9b0;--bpi-break-text:#0f6e56;--bpi-primary-bg:#2b6cb0;--bpi-primary-bg-hover:#245a94;--bpi-primary-border:#1e4f85;--bpi-primary-text:#fff;--bpi-en-head-text:#17557f;--bpi-en-hint-text:#5b7f9e;--bpi-zh-head-text:#1f5c22;--bpi-zh-hint-text:#5b7d5e;--bpi-cat-name-text:#1e5a28;--bpi-info-text:#1f5f96;--bpi-link-text:#1a5f96;--bpi-zh-text:#18508a;--bpi-status-error:#b3261e;--bpi-status-ok:#1a7f45;--bpi-status-busy:#8a5a00;--bpi-badge-warn:#8a5a00;--bpi-badge-source:#0f6e56;--bpi-badge-suspected:#1c5f80;--bpi-badge-machine:#5b3fa8;--bpi-star-on:#a8750a;--bpi-star-off:#6b7280;--bpi-quick-head-text:#4a3a7a;--bpi-quick-hint-text:#6b5a8f;--bpi-handle-text:#4a6a85;--bpi-handle-hover:#1f5f96;--bpi-mini-hover-bg:#d8dee7;--bpi-handle-hover-bg:#e2e8ef;--bpi-chip-hide-bg:#eef1f5;--bpi-waiting-bg:#fdf1dc;--bpi-waiting-border:#d9a95a;--bpi-hidden-chip-hover-bg:#e8eef5;--bpi-issues-bg:#fdf6e8;--bpi-issues-border:#d9b98a;--bpi-issue-text:#7a5410;--bpi-row-hover-overlay:rgba(47,108,176,.06);--bpi-row-pinned-overlay:#cfe3f7;--bpi-row-hover-ring:rgba(47,108,176,.55);--bpi-row-pinned-ring:#1a5f96;--bpi-row-hover-text:#1f1f1f;--bpi-row-hover-shadow:none;--bpi-row-selected-bg:#dcebf8;--bpi-editor-bg:#fff}
    .dark-theme{--bpi-custom-bg:#17342c;--bpi-custom-border:#3f8f77;--bpi-custom-text:#7fdcbd;--bpi-surface:rgba(10,12,18,.72);--bpi-surface-2:#171b22;--bpi-surface-3:#14181f;--bpi-surface-table:#11151b;--bpi-surface-modal:#20252d;--bpi-text:#e6edf7;--bpi-text-muted:#aab5c5;--bpi-text-faint:#7f8a9a;--bpi-border:#3a4250;--bpi-border-2:#4c5668;--bpi-border-3:#29313d;--bpi-button-bg:#2c3340;--bpi-button-text:#e8edf5;--bpi-input-bg:#171b22;--bpi-input-text:#eef3fb;--bpi-head-bg:#252c36;--bpi-danger-bg:#65313b;--bpi-danger-bg-hover:#7d3d49;--bpi-danger-border:#8d4653;--bpi-danger-text:#ffd9de;--bpi-break-bg:#17342c;--bpi-break-bg-hover:#0f6e56;--bpi-break-border:#3f8f77;--bpi-break-text:#7fdcbd;--bpi-primary-bg:#285f8e;--bpi-primary-bg-hover:#346f9f;--bpi-primary-border:#3f83ba;--bpi-primary-text:#eaf3fb;--bpi-en-head-text:#cbe8ff;--bpi-en-hint-text:#91b4cf;--bpi-zh-head-text:#cbe9c8;--bpi-zh-hint-text:#91ad93;--bpi-cat-name-text:#9ee8a7;--bpi-info-text:#87bfea;--bpi-link-text:#76c9ff;--bpi-zh-text:#9ed0ff;--bpi-status-error:#ff8b93;--bpi-status-ok:#7fdda2;--bpi-status-busy:#ffd27a;--bpi-badge-warn:#e2ca78;--bpi-badge-source:#86d5c4;--bpi-badge-suspected:#7fc4e0;--bpi-badge-machine:#cbb1ff;--bpi-star-on:#ffd45f;--bpi-star-off:#8f9aaa;--bpi-quick-head-text:#d9ccff;--bpi-quick-hint-text:#a795c6;--bpi-handle-text:#7194ad;--bpi-handle-hover:#a9c8e4;--bpi-mini-hover-bg:#3c4b60;--bpi-handle-hover-bg:#2b3a4d;--bpi-chip-hide-bg:#1d2937;--bpi-waiting-bg:rgba(70,52,25,.5);--bpi-waiting-border:#8a5f16;--bpi-hidden-chip-hover-bg:#31404f;--bpi-issues-bg:rgba(55,39,25,.55);--bpi-issues-border:#5b4a36;--bpi-issue-text:#e6c792;--bpi-row-hover-overlay:rgba(76,167,232,.34);--bpi-row-pinned-overlay:#314b68;--bpi-row-hover-ring:rgba(76,167,232,.7);--bpi-row-pinned-ring:#76c9ff;--bpi-row-hover-text:#fff;--bpi-row-hover-shadow:0 0 7px rgba(109,190,255,.6);--bpi-row-selected-bg:#314b68;--bpi-editor-bg:#111923}
    [data-bpi-theme="dark"]{--bpi-custom-bg:#17342c;--bpi-custom-border:#3f8f77;--bpi-custom-text:#7fdcbd;--bpi-surface:rgba(10,12,18,.72);--bpi-surface-2:#171b22;--bpi-surface-3:#14181f;--bpi-surface-table:#11151b;--bpi-surface-modal:#20252d;--bpi-text:#e6edf7;--bpi-text-muted:#aab5c5;--bpi-text-faint:#7f8a9a;--bpi-border:#3a4250;--bpi-border-2:#4c5668;--bpi-border-3:#29313d;--bpi-button-bg:#2c3340;--bpi-button-text:#e8edf5;--bpi-input-bg:#171b22;--bpi-input-text:#eef3fb;--bpi-head-bg:#252c36;--bpi-danger-bg:#65313b;--bpi-danger-bg-hover:#7d3d49;--bpi-danger-border:#8d4653;--bpi-danger-text:#ffd9de;--bpi-break-bg:#17342c;--bpi-break-bg-hover:#0f6e56;--bpi-break-border:#3f8f77;--bpi-break-text:#7fdcbd;--bpi-primary-bg:#285f8e;--bpi-primary-bg-hover:#346f9f;--bpi-primary-border:#3f83ba;--bpi-primary-text:#eaf3fb;--bpi-en-head-text:#cbe8ff;--bpi-en-hint-text:#91b4cf;--bpi-zh-head-text:#cbe9c8;--bpi-zh-hint-text:#91ad93;--bpi-cat-name-text:#9ee8a7;--bpi-info-text:#87bfea;--bpi-link-text:#76c9ff;--bpi-zh-text:#9ed0ff;--bpi-status-error:#ff8b93;--bpi-status-ok:#7fdda2;--bpi-status-busy:#ffd27a;--bpi-badge-warn:#e2ca78;--bpi-badge-source:#86d5c4;--bpi-badge-suspected:#7fc4e0;--bpi-badge-machine:#cbb1ff;--bpi-star-on:#ffd45f;--bpi-star-off:#8f9aaa;--bpi-quick-head-text:#d9ccff;--bpi-quick-hint-text:#a795c6;--bpi-handle-text:#7194ad;--bpi-handle-hover:#a9c8e4;--bpi-mini-hover-bg:#3c4b60;--bpi-handle-hover-bg:#2b3a4d;--bpi-chip-hide-bg:#1d2937;--bpi-waiting-bg:rgba(70,52,25,.5);--bpi-waiting-border:#8a5f16;--bpi-hidden-chip-hover-bg:#31404f;--bpi-issues-bg:rgba(55,39,25,.55);--bpi-issues-border:#5b4a36;--bpi-issue-text:#e6c792;--bpi-row-hover-overlay:rgba(76,167,232,.34);--bpi-row-pinned-overlay:#314b68;--bpi-row-hover-ring:rgba(76,167,232,.7);--bpi-row-pinned-ring:#76c9ff;--bpi-row-hover-text:#fff;--bpi-row-hover-shadow:0 0 7px rgba(109,190,255,.6);--bpi-row-selected-bg:#314b68;--bpi-editor-bg:#111923}
    [data-bpi-theme="light"]{--bpi-custom-bg:#e6f6f1;--bpi-custom-border:#7fc9b0;--bpi-custom-text:#0f6e56;--bpi-surface:rgba(255,255,255,.92);--bpi-surface-2:#f5f5f5;--bpi-surface-3:#eaeaea;--bpi-surface-table:#f0f0f0;--bpi-surface-modal:#fff;--bpi-text:#333;--bpi-text-muted:#666;--bpi-text-faint:#999;--bpi-border:#ccc;--bpi-border-2:#bbb;--bpi-border-3:#e0e0e0;--bpi-button-bg:#e8e8e8;--bpi-button-text:#333;--bpi-input-bg:#fff;--bpi-input-text:#333;--bpi-head-bg:#e8e8e8;--bpi-danger-bg:#c0392b;--bpi-danger-bg-hover:#a53023;--bpi-danger-border:#a53023;--bpi-danger-text:#fff;--bpi-break-bg:#e6f6f1;--bpi-break-bg-hover:#0f6e56;--bpi-break-border:#7fc9b0;--bpi-break-text:#0f6e56;--bpi-primary-bg:#2b6cb0;--bpi-primary-bg-hover:#245a94;--bpi-primary-border:#1e4f85;--bpi-primary-text:#fff;--bpi-en-head-text:#17557f;--bpi-en-hint-text:#5b7f9e;--bpi-zh-head-text:#1f5c22;--bpi-zh-hint-text:#5b7d5e;--bpi-cat-name-text:#1e5a28;--bpi-info-text:#1f5f96;--bpi-link-text:#1a5f96;--bpi-zh-text:#18508a;--bpi-status-error:#b3261e;--bpi-status-ok:#1a7f45;--bpi-status-busy:#8a5a00;--bpi-badge-warn:#8a5a00;--bpi-badge-source:#0f6e56;--bpi-badge-suspected:#1c5f80;--bpi-badge-machine:#5b3fa8;--bpi-star-on:#a8750a;--bpi-star-off:#6b7280;--bpi-quick-head-text:#4a3a7a;--bpi-quick-hint-text:#6b5a8f;--bpi-handle-text:#4a6a85;--bpi-handle-hover:#1f5f96;--bpi-mini-hover-bg:#d8dee7;--bpi-handle-hover-bg:#e2e8ef;--bpi-chip-hide-bg:#eef1f5;--bpi-waiting-bg:#fdf1dc;--bpi-waiting-border:#d9a95a;--bpi-hidden-chip-hover-bg:#e8eef5;--bpi-issues-bg:#fdf6e8;--bpi-issues-border:#d9b98a;--bpi-issue-text:#7a5410;--bpi-row-hover-overlay:rgba(47,108,176,.06);--bpi-row-pinned-overlay:#cfe3f7;--bpi-row-hover-ring:rgba(47,108,176,.55);--bpi-row-pinned-ring:#1a5f96;--bpi-row-hover-text:#1f1f1f;--bpi-row-hover-shadow:none;--bpi-row-selected-bg:#dcebf8;--bpi-editor-bg:#fff}
    .bpi-panel{box-sizing:border-box;width:100%;height:100%;min-height:var(--bpi-collapsed-height,390px);max-height:var(--bpi-collapsed-height,390px);padding:8px;display:flex;flex-direction:column;gap:7px;color:var(--bpi-text);font:12px/1.4 Arial,sans-serif;background:var(--bpi-surface);border:1px solid var(--bpi-border);border-radius:8px;overflow-y:auto;scrollbar-gutter:stable}
    .bpi-english-section{flex:none;border:1px solid #3e7197;border-radius:7px;background:var(--bpi-surface);overflow:hidden}.bpi-english-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:var(--bpi-head-bg);color:var(--bpi-en-head-text);font-weight:700;flex-wrap:wrap}.bpi-english-hint{margin-left:auto;color:var(--bpi-en-hint-text);font-size:10px;font-weight:400}.bpi-english-token-view{box-sizing:border-box;width:100%;height:auto;min-height:92px;max-height:360px;overflow:auto;scrollbar-gutter:stable;padding:8px 9px;outline:none;color:var(--bpi-text);font:12px/1.85 Consolas,monospace;white-space:normal}.bpi-english-token-view:focus{box-shadow:inset 0 0 0 1px #5aa6d8}.bpi-english-editor{box-sizing:border-box;width:100%;height:120px;min-height:92px;max-height:420px;overflow-y:auto;resize:vertical;border:0;border-top:1px solid #3e7197;background:var(--bpi-editor-bg);color:var(--bpi-text);padding:9px;outline:none;font:12px/1.55 Consolas,monospace}.bpi-english-editor:focus{box-shadow:inset 0 0 0 1px #5aa6d8}.bpi-english-token{font-family:Consolas,monospace;color:var(--bpi-text)}.bpi-english-token.bpi-linked{background:#147fc3;border-color:#76c9ff;color:#fff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}
    .bpi-mirror-section{flex:none;border:1px solid #488739;border-radius:7px;background:var(--bpi-surface);overflow:visible}.bpi-section-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:var(--bpi-head-bg);color:var(--bpi-zh-head-text);font-weight:700;flex-wrap:wrap}.bpi-section-hint{margin-left:auto;color:var(--bpi-zh-hint-text);font-size:10px;font-weight:400}.bpi-mirror-actions{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bpi-chinese-mirror{box-sizing:border-box;width:100%;height:auto;min-height:92px;max-height:360px;overflow:auto;resize:none;scrollbar-gutter:stable;padding:8px 9px;outline:none;color:var(--bpi-text);line-height:1.85;cursor:text;white-space:normal}.bpi-chinese-mirror:focus{box-shadow:inset 0 0 0 1px #70b35f}.bpi-category-table{display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);border:1px solid #315f3a;border-radius:6px;overflow:hidden;background:var(--bpi-surface-3)}.bpi-category-row{display:contents}.bpi-category-name,.bpi-category-content{padding:6px 8px;border-top:1px solid #31513a}.bpi-category-row:first-child .bpi-category-name,.bpi-category-row:first-child .bpi-category-content{border-top:0}.bpi-category-name{background:var(--bpi-head-bg);border-right:1px solid #31513a;color:var(--bpi-cat-name-text);font-weight:700}.bpi-category-content{min-width:0}.bpi-chinese-editor{box-sizing:border-box;width:100%;height:auto;min-height:110px;max-height:600px;overflow-y:auto;resize:vertical;border:0;border-top:1px solid #3b693c;background:var(--bpi-editor-bg);color:var(--bpi-text);padding:9px;outline:none;font:12px/1.65 Arial,sans-serif}.bpi-chinese-editor:focus{box-shadow:inset 0 0 0 1px #70b35f}.bpi-hidden{display:none!important}.bpi-mirror-empty{color:var(--bpi-text-muted)}.bpi-mirror-token{display:inline-flex;align-items:center;border:1px solid transparent;border-radius:5px;padding:0 3px;margin:1px 0;cursor:pointer;transition:background .12s,border-color .12s,color .12s}.bpi-mirror-token:hover{background:#345a3b;border-color:#5c8d63;color:#fff}.bpi-mirror-token.bpi-linked{background:#315f83;border-color:#76a9ff;color:#fff}
    .bpi-mirror-token.bpi-linked,.bpi-english-token.bpi-linked{background:#147fc3;border-color:#76c9ff;color:#fff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}.bpi-english-token-view .bpi-mirror-separator{color:#7194ad}
    .bpi-toolbar,.bpi-search-line,.bpi-summary{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .bpi-toolbar{justify-content:space-between}.bpi-toolbar-group{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
    .bpi-button{border:1px solid var(--bpi-border-2);border-radius:5px;padding:4px 8px;background:var(--bpi-button-bg);color:var(--bpi-button-text);cursor:pointer;font-size:11px;line-height:1.25}
    .bpi-button:hover{background:var(--bpi-border-3);border-color:#6c83a8}.bpi-button:disabled{opacity:.45;cursor:default}.bpi-button.bpi-primary,.bpi-mini.bpi-primary{background:var(--bpi-primary-bg);border-color:var(--bpi-primary-border);color:var(--bpi-primary-text)}.bpi-button.bpi-primary:hover,.bpi-mini.bpi-primary:hover{background:var(--bpi-primary-bg-hover);border-color:var(--bpi-primary-border);color:var(--bpi-primary-text)}.bpi-button.bpi-danger{background:var(--bpi-danger-bg);border-color:var(--bpi-danger-border);color:var(--bpi-danger-text)}.bpi-button.bpi-danger:hover,.bpi-mini.bpi-danger:hover{background:var(--bpi-danger-bg-hover);border-color:var(--bpi-danger-border);color:var(--bpi-danger-text)}.bpi-mini.bpi-danger{background:var(--bpi-danger-bg);border-color:var(--bpi-danger-border);color:var(--bpi-danger-text)}
    .bpi-search{flex:1;min-width:140px;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:5px 7px;outline:none}.bpi-search:focus{border-color:#4ca7e8}.bpi-searching{padding:5px 8px;color:var(--bpi-text-muted);font-size:10px}
    .bpi-mode{border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:5px 6px;font-size:11px;outline:none}.bpi-mode:focus{border-color:#4ca7e8}.bpi-mode-info{color:var(--bpi-info-text)}
    .bpi-summary{color:var(--bpi-text-muted);font-size:11px;min-height:17px}.bpi-status{margin-left:auto}.bpi-status[data-kind="error"]{color:var(--bpi-status-error)}.bpi-status[data-kind="ok"]{color:var(--bpi-status-ok)}.bpi-status[data-kind="busy"]{color:var(--bpi-status-busy)}
    .bpi-issues{display:none;max-height:105px;overflow:auto;border:1px solid var(--bpi-issues-border);border-radius:6px;background:var(--bpi-issues-bg);padding:4px 6px}.bpi-issues.bpi-visible{display:block}.bpi-issue{padding:2px 4px;color:var(--bpi-issue-text)}.bpi-issue[data-severity="error"]{color:var(--bpi-status-error)}.bpi-issue[data-severity="info"]{color:var(--bpi-info-text)}.bpi-issue::before{content:"⚠ ";}.bpi-issue[data-severity="error"]::before{content:"⛔ ";}.bpi-issue[data-severity="info"]::before{content:"ℹ ";}
    .bpi-search-label{color:var(--bpi-text-muted);font-size:10px;white-space:nowrap}.bpi-results{display:none;max-height:220px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-2)}.bpi-results.bpi-visible{display:block}.bpi-result{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(150px,auto);gap:7px;padding:5px 7px;border-bottom:1px solid var(--bpi-border-3);cursor:pointer}.bpi-result:last-child{border-bottom:0}.bpi-result:hover{background:var(--bpi-surface-3)}.bpi-result-en{color:var(--bpi-text)}.bpi-result-zh{color:var(--bpi-zh-text)}.bpi-category{color:var(--bpi-text-muted);font-size:10px;white-space:normal}.bpi-search-reason{display:block;color:var(--bpi-info-text);margin-top:2px}.bpi-search-more{display:block;margin:7px auto}.bpi-results>.bpi-searching{text-align:center}
    .bpi-table{position:relative;height:300px;min-height:180px;max-height:360px;flex:1 1 300px;overflow-x:hidden;overflow-y:scroll;scrollbar-gutter:stable;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-table)}.bpi-split-handle{position:absolute;top:0;bottom:0;left:var(--bpi-split,40%);width:9px;margin-left:-4px;cursor:col-resize;z-index:4}.bpi-split-handle:hover{background:rgba(76,167,232,.35)}.bpi-head,.bpi-row{display:grid;grid-template-columns:var(--bpi-split,minmax(0,2fr)) minmax(0,1fr);gap:1px}.bpi-head{position:sticky;top:0;z-index:2;background:var(--bpi-head-bg);color:var(--bpi-text-muted);font-weight:700}.bpi-head>div,.bpi-cell{padding:6px 8px}.bpi-head>div+div,.bpi-cell+.bpi-cell{border-left:1px solid var(--bpi-border-2)}
    .bpi-row{border-top:1px solid var(--bpi-border-3);cursor:pointer}.bpi-row:hover{background-image:linear-gradient(var(--bpi-row-hover-overlay),var(--bpi-row-hover-overlay));outline:1px dashed var(--bpi-row-hover-ring);outline-offset:-1px}.bpi-row.bpi-pinned{background-image:linear-gradient(var(--bpi-row-pinned-overlay),var(--bpi-row-pinned-overlay));outline:1px solid var(--bpi-row-pinned-ring);outline-offset:-1px;font-weight:500}.bpi-row:hover .bpi-cell,.bpi-row.bpi-pinned .bpi-cell{color:var(--bpi-row-hover-text)}.bpi-row.bpi-unknown{background-color:rgba(112,70,28,.18)}.bpi-row.bpi-machine{background-color:rgba(85,62,131,.22)}.bpi-row.bpi-suspected-natural{background-color:rgba(58,132,160,.20)}.bpi-row.bpi-has-warning{box-shadow:inset 3px 0 #d39845}.bpi-row.bpi-has-error{box-shadow:inset 3px 0 #e35b66}
    .bpi-cell{min-width:0;word-break:break-word;display:flex;align-items:flex-start;gap:5px}.bpi-en{color:var(--bpi-text);font-family:Consolas,monospace}.bpi-zh{color:var(--bpi-zh-text)}.bpi-row:hover .bpi-en,.bpi-row:hover .bpi-zh,.bpi-row.bpi-pinned .bpi-en,.bpi-row.bpi-pinned .bpi-zh{color:var(--bpi-row-hover-text);text-shadow:var(--bpi-row-hover-shadow)}
    .bpi-badge{flex:none;border:1px solid var(--bpi-border-2);border-radius:8px;padding:0 5px;color:var(--bpi-text-muted);font-size:9px;line-height:15px}.bpi-source{border-color:#3e6f67;color:var(--bpi-badge-source)}.bpi-suspected{border-color:#3a84a0;color:var(--bpi-badge-suspected)}.bpi-confidence-high{border-color:#3f785c;color:var(--bpi-status-ok)}.bpi-confidence-medium{border-color:#8a7538;color:var(--bpi-badge-warn)}.bpi-confidence-low,.bpi-confidence-none{border-color:#7a4c55;color:var(--bpi-status-error)}.bpi-unknown .bpi-badge{color:var(--bpi-badge-warn);border-color:#85602f}.bpi-machine .bpi-badge{color:var(--bpi-badge-machine);border-color:#6b5594}.bpi-inline-actions{display:flex;gap:3px;margin-left:auto;flex-wrap:wrap}.bpi-mini{border:1px solid var(--bpi-border-2);border-radius:4px;background:var(--bpi-button-bg);color:var(--bpi-button-text);padding:1px 5px;cursor:pointer;font-size:9px}.bpi-mini:hover{background:var(--bpi-mini-hover-bg)}.bpi-inline-editor{min-width:90px;flex:1;border:1px solid #4ca7e8;border-radius:4px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:3px 5px}.bpi-empty{padding:24px;text-align:center;color:var(--bpi-text-faint)}
    .bpi-filters{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.bpi-batch-bar{flex:none;gap:8px;padding:6px 8px;margin-bottom:6px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3)}.bpi-filter-active{background:#365f84;border-color:#5792c4;color:#fff}.bpi-star{color:var(--bpi-star-off)}.bpi-star.bpi-starred{color:var(--bpi-star-on);border-color:#8f772f}.bpi-result.bpi-result-selected{background:var(--bpi-row-selected-bg);outline:1px solid var(--bpi-link-text)}.bpi-result-star{font-size:14px;color:var(--bpi-star-off);align-self:center}.bpi-result-star.bpi-starred{color:var(--bpi-star-on)}
    .bpi-quick-section{flex:none;border:1px solid #6b5594;border-radius:7px;background:var(--bpi-surface);overflow:hidden}.bpi-quick-head{display:flex;align-items:center;gap:7px;padding:5px 8px;background:var(--bpi-head-bg);color:var(--bpi-quick-head-text);font-weight:700;flex-wrap:wrap}.bpi-quick-hint{margin-left:auto;color:var(--bpi-quick-hint-text);font-size:10px;font-weight:400}.bpi-quick-target{padding:0 8px 6px;font-size:11px;color:var(--bpi-text-muted)}.bpi-quick-target-linked{color:var(--bpi-link-text)}.bpi-quick-row{display:flex;gap:6px;align-items:flex-start;padding:6px 8px}.bpi-quick-input{flex:1;min-width:0;box-sizing:border-box;height:44px;min-height:44px;max-height:140px;overflow-y:auto;resize:vertical;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:5px 7px;outline:none;font:12px/1.55 Arial,sans-serif}.bpi-quick-input:focus{box-shadow:inset 0 0 0 1px #a98be0}.bpi-quick-row .bpi-button{flex:none}
    .bpi-drag-handle{flex:none;cursor:grab;color:var(--bpi-handle-text);font-size:11px;line-height:1;user-select:none;padding:1px 2px;border-radius:3px}.bpi-drag-handle:hover{color:var(--bpi-handle-hover);background:var(--bpi-handle-hover-bg)}.bpi-drag-handle:active{cursor:grabbing}
    .bpi-row.bpi-dragging,.bpi-english-token.bpi-dragging{opacity:.45}.bpi-english-token.bpi-dragging{cursor:grabbing}
    .bpi-drop-indicator{position:absolute;left:3px;right:3px;height:0;border-top:2px solid #76c9ff;box-shadow:0 0 5px rgba(118,201,255,.55);z-index:3;pointer-events:none}
    .bpi-break-row{display:flex;align-items:center;gap:8px;border-top:1px solid var(--bpi-border-3);background:var(--bpi-break-bg);color:var(--bpi-break-text);padding:6px 10px;cursor:default}
    .bpi-row.bpi-break-row:hover{background-color:var(--bpi-break-bg-hover);background-image:none;outline:0;color:#fff}
    .bpi-break-row.bpi-dragging{opacity:.45}
    .bpi-break-row .bpi-drag-handle{color:var(--bpi-break-text)}.bpi-break-row .bpi-drag-handle:hover{color:#fff;background:var(--bpi-break-bg-hover)}
    .bpi-break-row-label{flex:1;font-size:12px;font-weight:500;letter-spacing:.5px}
    .bpi-mirror-token{user-select:none}.bpi-english-token.bpi-drop-before,.bpi-mirror-token.bpi-drop-before{box-shadow:-2px 0 0 0 #76c9ff,0 0 5px rgba(118,201,255,.4)}.bpi-english-token.bpi-drop-after,.bpi-mirror-token.bpi-drop-after{box-shadow:2px 0 0 0 #76c9ff,0 0 5px rgba(118,201,255,.4)}
    .bpi-english-token{position:relative}.bpi-hide-btn{flex:none;cursor:pointer;color:var(--bpi-handle-text);font-size:11px;line-height:1;user-select:none;padding:1px 2px;border-radius:3px;display:inline-flex;align-items:center}.bpi-hide-btn:hover{color:var(--bpi-link-text);background:var(--bpi-handle-hover-bg)}.bpi-eye-icon{display:inline-flex;align-items:center}
.bpi-card-hidden{opacity:.55;filter:grayscale(.7)}
.bpi-card-hidden:hover{opacity:.75}
.bpi-card-hidden .bpi-english-token{text-decoration:line-through}
.bpi-card-hidden .bpi-token-card-zh{color:var(--bpi-text-faint)}
.bpi-card-hidden .bpi-chip-hide{display:inline-flex}
.bpi-chip-hidden-mark{color:var(--bpi-badge-warn)}
.bpi-row-hidden{opacity:.6}
.bpi-row-hidden:hover{opacity:.8}
.bpi-hidden-term{text-decoration:line-through;color:var(--bpi-text-faint)}
.bpi-hide-btn-off{color:var(--bpi-badge-warn)}
.bpi-eye-off{color:var(--bpi-badge-warn)}
    .bpi-chip-hide{position:absolute;top:-5px;right:-5px;display:none;cursor:pointer;padding:1px 2px;border-radius:999px;background:var(--bpi-chip-hide-bg);border:1px solid var(--bpi-border-2);color:var(--bpi-link-text);line-height:1;z-index:2}.bpi-english-token:hover .bpi-chip-hide{display:inline-flex}.bpi-chip-hide:hover{background:var(--bpi-primary-bg);border-color:var(--bpi-primary-border);color:#fff}
.bpi-token-line{display:flex;flex-wrap:wrap;align-items:flex-end;gap:2px 0}
    .bpi-token-card{display:inline-flex;flex-direction:column;align-items:flex-start;max-width:100%;border:1px solid var(--bpi-border-3);border-radius:5px;background:var(--bpi-surface-3);padding:1px 5px;margin:2px 3px 2px 0;vertical-align:top;cursor:pointer}
    .bpi-token-card:hover{border-color:var(--bpi-border-2)}
    .bpi-token-card.bpi-dragging{opacity:.45;cursor:grabbing}
    .bpi-token-card .bpi-english-token{margin:0;padding:0}
    .bpi-token-card.bpi-card-linked{background:#147fc3;border-color:#76c9ff;box-shadow:0 0 0 1px rgba(118,201,255,.32)}
    .bpi-token-card.bpi-card-linked .bpi-token-card-zh{color:#fff}
    .bpi-token-card.bpi-card-linked .bpi-english-token{background:transparent;border-color:transparent;box-shadow:none;color:#fff}
    .bpi-token-card-zh{min-height:15px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bpi-text-muted);font:11px/1.35 Arial,sans-serif}
    .bpi-category-content{display:flex;flex-wrap:wrap;gap:2px 3px}
.bpi-break-chip{position:relative;display:inline-flex;align-items:center;gap:3px;border:1px dashed var(--bpi-break-border);border-radius:5px;background:var(--bpi-break-bg);color:var(--bpi-break-text);padding:0 5px;margin:1px 0;cursor:grab;user-select:none;font-family:Consolas,monospace}
.bpi-break-chip:hover,.bpi-break-chip.bpi-drop-target{background:var(--bpi-break-bg-hover);border-color:var(--bpi-break-text);color:#fff}
.bpi-break-chip.bpi-dragging{opacity:.45;cursor:grabbing}
.bpi-break-x{display:none;cursor:pointer;line-height:1}
.bpi-break-chip:hover .bpi-break-x{display:inline-flex}
.bpi-break-x:hover{color:#fff}
.bpi-source-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:5px 7px;margin-bottom:7px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3)}
.bpi-source-bar.bpi-source-waiting{border-color:var(--bpi-waiting-border);background:var(--bpi-waiting-bg)}
.bpi-source-label{color:var(--bpi-info-text);font-size:11px}
.bpi-source-state{color:var(--bpi-text-muted);font-size:11px}
.bpi-source-state.bpi-source-waiting-text{color:var(--bpi-badge-warn)}
.bpi-source-toggle{display:inline-flex;gap:5px;align-items:center;font-size:11px;color:var(--bpi-text);cursor:pointer;user-select:none}
.bpi-source-toggle input{margin:0;accent-color:#3f83ba}
.bpi-source-select{border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:3px 5px;font-size:11px}
.bpi-source-select:disabled{opacity:.45}
.bpi-save-drop{position:relative;display:flex;flex-direction:column;gap:5px;align-items:center;justify-content:center;min-height:86px;border:1px dashed var(--bpi-border-2);border-radius:7px;background:var(--bpi-surface-3);color:var(--bpi-text-faint);font-size:11px;text-align:center;cursor:pointer}
.bpi-save-drop.bpi-dragover{border-color:#4ca7e8;color:var(--bpi-link-text)}
    .bpi-autocomplete{position:relative}
    .bpi-chip-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center;box-sizing:border-box;width:100%;min-height:30px;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);padding:5px 6px}
    .bpi-form .bpi-chip-row input{flex:1;min-width:90px;width:auto;border:0;outline:none;background:transparent;color:var(--bpi-input-text);padding:2px 0;font:12px Arial,sans-serif}
    .bpi-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 5px 2px 8px;border:1px solid var(--bpi-border-2);border-radius:11px;background:var(--bpi-surface-3);color:var(--bpi-text);font:11px Arial,sans-serif}
    .bpi-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
    .bpi-chip-x{border:0;background:transparent;color:var(--bpi-text-muted);cursor:pointer;font:12px Arial,sans-serif;line-height:1;padding:0 1px}
    .bpi-chip-x:hover{color:var(--bpi-status-error)}
    .bpi-ac-menu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:95;max-height:188px;overflow:auto;padding:3px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-modal);box-shadow:0 6px 16px rgba(0,0,0,.25)}
    .bpi-ac-menu[hidden]{display:none}
    .bpi-ac-item{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:4px;color:var(--bpi-text);font:12px Arial,sans-serif;cursor:pointer}
    .bpi-ac-item:hover,.bpi-ac-item.bpi-ac-active{background:var(--bpi-surface-3)}
    .bpi-ac-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bpi-ac-kind{margin-left:auto;flex:none;color:var(--bpi-text-faint);font-size:10px}
    .bpi-ac-custom{color:var(--bpi-custom-text);border-bottom:1px solid var(--bpi-border-3);border-radius:4px 4px 0 0}
    .bpi-input-wrap{display:flex;align-items:center;gap:5px;box-sizing:border-box;width:100%;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);padding:5px 6px}
    .bpi-input-wrap:focus-within{border-color:#4ca7e8}
    .bpi-form .bpi-input-wrap input{flex:1;min-width:0;width:auto;border:0;outline:none;background:transparent;color:var(--bpi-input-text);padding:0;font:12px Arial,sans-serif}
    .bpi-custom-badge{flex:none;border:1px solid var(--bpi-custom-border);border-radius:8px;background:var(--bpi-custom-bg);color:var(--bpi-custom-text);font-size:10px;line-height:15px;padding:0 5px}
    .bpi-form-hint{color:var(--bpi-text-faint);font-size:10px}
    .bpi-model-tags{display:flex;flex-wrap:wrap;gap:4px}
    .bpi-model-tag{padding:1px 7px;border:1px solid var(--bpi-border-2);border-radius:10px;background:var(--bpi-surface-3);color:var(--bpi-text-muted);font-size:10px}
.bpi-save-preview{display:none;max-width:100%;max-height:150px;border-radius:5px;border:1px solid var(--bpi-border-2)}
.bpi-save-file{color:var(--bpi-text-muted);font-size:10px}
.bpi-fav-card{display:flex;gap:10px;border:1px solid var(--bpi-border);border-radius:7px;background:var(--bpi-surface-2);padding:8px}
.bpi-fav-thumb{width:104px;height:64px;border-radius:5px;background:var(--bpi-surface-3) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--bpi-text-faint);font-size:10px;flex:none;overflow:hidden}
.bpi-fav-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.bpi-fav-name{font-size:12px;color:var(--bpi-text);font-weight:500}
.bpi-fav-name .bpi-fav-date{color:var(--bpi-text-muted);font-weight:400;font-size:10px;margin-left:6px}
.bpi-fav-text{color:var(--bpi-text-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:Consolas,monospace}
.bpi-fav-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;color:var(--bpi-text-faint);font-size:10px}
.bpi-fav-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
    .bpi-hidden-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 2px;border-top:1px solid var(--bpi-border-3)}.bpi-hidden-bar.bpi-hidden{display:none}.bpi-hidden-label{flex:none;color:var(--bpi-text-muted);font-size:11px}
    .bpi-hidden-chip{display:inline-flex;align-items:center;gap:5px;max-width:280px;overflow:hidden;border:1px dashed var(--bpi-border-2);border-radius:999px;padding:2px 8px;background:var(--bpi-surface-3);color:var(--bpi-text-muted);cursor:pointer;font-size:11px}.bpi-hidden-chip:hover{background:var(--bpi-hidden-chip-hover-bg);border-color:var(--bpi-link-text);color:var(--bpi-row-hover-text)}.bpi-hidden-en{text-decoration:line-through;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.bpi-hidden-zh{color:var(--bpi-text-muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.bpi-hidden-restore{color:var(--bpi-link-text);font-size:12px}
    .bpi-hidden-all{margin-left:auto}
    .bpi-modal-shade{position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center}.bpi-modal{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;background:var(--bpi-surface-modal);color:var(--bpi-text);border:1px solid var(--bpi-border-2);border-radius:10px;padding:16px;box-shadow:0 18px 55px rgba(0,0,0,.55)}.bpi-modal h3{margin:0 0 12px;font-size:16px}.bpi-form{display:grid;grid-template-columns:92px minmax(0,1fr);gap:9px;align-items:center}.bpi-form label{color:var(--bpi-text-muted)}.bpi-form input,.bpi-form select,.bpi-form textarea{box-sizing:border-box;width:100%;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:6px 7px}.bpi-form textarea{min-height:112px;resize:vertical;font:11px/1.45 Arial,sans-serif}.bpi-form input:focus,.bpi-form select:focus,.bpi-form textarea:focus{outline:none;border-color:#4ca7e8}.bpi-modal-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:14px;flex-wrap:wrap}.bpi-weight-presets{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
.bpi-editor-tabs{display:flex;gap:0;border-bottom:1px solid var(--bpi-border);margin-bottom:12px}
.bpi-editor-tab{background:none;border:none;border-bottom:2px solid transparent;padding:5px 12px;color:var(--bpi-text-muted);font:12px Arial,sans-serif;cursor:pointer}
.bpi-editor-tab:hover{color:var(--bpi-text)}
.bpi-editor-tab.bpi-editor-tab-active{color:var(--bpi-link-text);border-bottom-color:var(--bpi-link-text)}
.bpi-editor-panel{display:block}
.bpi-editor-divider{height:1px;background:var(--bpi-border-3);margin:12px 0}
.bpi-form .bpi-field-static{box-sizing:border-box;padding:6px 0;color:var(--bpi-text);font-family:Consolas,monospace;word-break:break-all}
.bpi-raw-editor{box-sizing:border-box;width:100%;min-height:72px;max-height:220px;resize:vertical;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:5px 7px;outline:none;font:12px/1.55 Consolas,monospace}
.bpi-raw-editor:focus{border-color:#4ca7e8}
.bpi-token-card.bpi-card-multi{outline:1px dashed var(--bpi-link-text);outline-offset:1px}
.bpi-row.bpi-row-multi{outline:1px dashed var(--bpi-link-text);outline-offset:-1px}
.bpi-color-presets{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.bpi-color-swatch{width:26px;height:26px;border-radius:4px;border:1px solid var(--bpi-border);cursor:pointer;display:inline-block}
.bpi-color-swatch:hover{border-color:var(--bpi-border-2)}
.bpi-color-swatch.bpi-color-swatch-active{border-color:var(--bpi-link-text);box-shadow:0 0 0 1px var(--bpi-link-text)}
.bpi-color-swatch-none.bpi-color-swatch-active{border-style:solid;color:var(--bpi-text)}
.bpi-color-custom{display:flex;align-items:center;gap:6px}
.bpi-color-custom input{width:150px}
.bpi-color-swatch-none{display:inline-flex;align-items:center;justify-content:center;background:var(--bpi-surface-3);border-style:dashed;border-color:var(--bpi-border-2);color:var(--bpi-text-muted);font:11px Arial,sans-serif}
    .bpi-color-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:6px}
    .bpi-color-card{border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-2);padding:7px}
    .bpi-color-card-head{display:flex;align-items:center;gap:6px;font-weight:700;color:var(--bpi-text);word-break:break-word}
    .bpi-color-chip{width:13px;height:13px;border-radius:3px;border:1px solid var(--bpi-border-2);background:transparent;flex:none}
    .bpi-color-meta{font-size:10px;color:var(--bpi-text-muted);margin-top:2px}
    .bpi-color-swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:6px}
    .bpi-color-swatches i{height:20px;border-radius:4px;border:1px solid var(--bpi-border);cursor:pointer;display:block}
    .bpi-color-swatches i.bpi-swatch-on{border-color:var(--bpi-link-text);box-shadow:0 0 0 1px var(--bpi-link-text)}
    .bpi-color-row{display:flex;align-items:center;gap:5px;margin-top:6px}
    .bpi-color-row input{width:92px;border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:3px 5px;font-size:11px}
    .bpi-color-dice{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--bpi-border-2);border-radius:5px;background:transparent;color:var(--bpi-text-muted);cursor:pointer;padding:0;flex:none}
    .bpi-color-dice:hover{color:var(--bpi-text)}
    .bpi-color-error{color:var(--bpi-status-error);font-size:11px;margin-top:6px}
    .bpi-color-panel{border:1px solid var(--bpi-border-2);border-radius:7px;background:var(--bpi-surface-3);padding:8px;margin:5px 0}
    .bpi-color-panel-actions{display:flex;justify-content:flex-end;margin-top:8px}
    .bpi-color-modes{display:flex;gap:6px;flex-wrap:wrap}
    .bpi-color-mode{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-2);color:var(--bpi-text);padding:5px 9px;cursor:pointer;font-size:12px;font-family:inherit}
    .bpi-color-mode:hover{border-color:var(--bpi-text-muted)}
    .bpi-color-mode-active{border-color:var(--bpi-link-text);box-shadow:0 0 0 1px var(--bpi-link-text)}
    .bpi-color-mode-dot{width:9px;height:9px;border-radius:50%;display:inline-block;border:1px solid var(--bpi-border)}
    .bpi-color-note{font-size:11px;color:var(--bpi-text-muted);margin:10px 0 6px}
    .bpi-color-open{border-color:var(--bpi-link-text);box-shadow:0 0 0 1px var(--bpi-link-text)}
.bpi-filter-sep{width:1px;height:18px;background:var(--bpi-border);margin:0 4px;align-self:center}
.bpi-dropdown-trigger{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-button-bg);color:var(--bpi-button-text);font:12px Arial,sans-serif;line-height:1.2;cursor:pointer;user-select:none}
.bpi-dropdown-trigger:hover{border-color:var(--bpi-text-faint)}
.bpi-dropdown-caret{font-size:9px;color:var(--bpi-text-muted);transition:transform .12s}
.bpi-about-modal{width:min(460px,calc(100vw - 32px))}.bpi-about-name{margin-bottom:7px;color:var(--bpi-text);font-weight:700}.bpi-config-note{color:var(--bpi-text-muted);font-size:10px;word-break:break-all}
.bpi-help{position:relative;display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;margin-left:5px;border:1px solid var(--bpi-border);border-radius:50%;color:var(--bpi-text-muted);font:10px/1 Arial,sans-serif;vertical-align:middle;cursor:help;user-select:none}
.bpi-help:hover,.bpi-help:focus{color:var(--bpi-text);border-color:var(--bpi-border-2)}
.bpi-help-pop{position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);z-index:80;display:none;box-sizing:border-box;width:290px;max-width:70vw;padding:7px 9px;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-modal);color:var(--bpi-text-muted);font:11px/1.65 Arial,sans-serif;white-space:pre-line;text-align:left;cursor:default}
.bpi-help:hover .bpi-help-pop,.bpi-help:focus .bpi-help-pop{display:block}.bpi-preview-text{box-sizing:border-box;width:100%;min-height:130px;max-height:300px;resize:vertical;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3);color:var(--bpi-text);padding:8px;font:12px/1.5 monospace}.bpi-sort-groups{max-height:230px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-3);padding:6px;margin:8px 0}.bpi-sort-group{display:grid;grid-template-columns:145px minmax(0,1fr);gap:7px;padding:4px;border-top:1px solid var(--bpi-border-3)}.bpi-sort-group:first-child{border-top:0}.bpi-sort-group strong{color:var(--bpi-zh-text)}
    .bpi-about-footer{flex:none;min-height:20px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:1px 4px 0;color:var(--bpi-text-faint);font-size:9px}.bpi-about-button{border:0;background:transparent;color:var(--bpi-text-muted);padding:1px 3px;cursor:pointer;font-size:9px}.bpi-about-button:hover{color:var(--bpi-link-text);text-decoration:underline}
    .bpi-pack-section{border:1px solid var(--bpi-border-2);border-radius:7px;background:var(--bpi-surface-3);padding:7px;margin-bottom:8px}.bpi-pack-toolbar{display:flex;gap:6px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:6px}.bpi-pack-toolbar strong{color:var(--bpi-text)}.bpi-pack-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:5px;max-height:166px;overflow:auto}.bpi-pack-card{border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-2);padding:6px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px;align-items:start}.bpi-pack-card.bpi-pack-disabled{opacity:.58}.bpi-pack-name{font-weight:700;color:var(--bpi-text)}.bpi-pack-meta{font-size:10px;color:var(--bpi-text-muted);margin-top:2px;word-break:break-word}.bpi-pack-controls{display:flex;gap:3px;flex-wrap:wrap;justify-content:flex-end}.bpi-switch{margin-top:3px}.bpi-pack-personal{border-color:#397062}.bpi-community-form{display:grid;grid-template-columns:105px minmax(0,1fr);gap:8px;align-items:center}.bpi-community-form input{border:1px solid var(--bpi-border-2);border-radius:5px;background:var(--bpi-input-bg);color:var(--bpi-input-text);padding:6px}.bpi-community-preview{max-height:150px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:5px;padding:5px;margin-top:8px;color:var(--bpi-text-muted)}
    .bpi-import-conflicts{max-height:240px;overflow:auto;border:1px solid var(--bpi-border-2);border-radius:6px;margin-top:10px}.bpi-import-conflict{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:6px;border-top:1px solid var(--bpi-border-3)}.bpi-import-conflict:first-child{border-top:0}.bpi-import-stat{display:flex;gap:12px;flex-wrap:wrap;color:var(--bpi-text)}.bpi-danger-text{color:var(--bpi-status-error)}
    .bpm-panel{box-sizing:border-box;width:100%;height:100%;min-height:280px;display:flex;flex-direction:column;gap:7px;padding:8px;color:var(--bpi-text);font:12px/1.4 Arial,sans-serif;overflow:hidden}
    .bpm-head{flex:none;display:flex;align-items:center;gap:7px;flex-wrap:wrap}.bpm-head strong{color:var(--bpi-text)}.bpm-head .bpi-status{margin-left:auto}
    .bpm-tabs{flex:none;display:flex;gap:4px}.bpm-tab{flex:1;border:1px solid var(--bpi-border-2);border-radius:5px;padding:4px 6px;background:var(--bpi-button-bg);color:var(--bpi-button-text);cursor:pointer;font-size:11px;line-height:1.25}.bpm-tab:hover{background:var(--bpi-border-3)}.bpm-tab.bpm-tab-active{background:var(--bpm-accent);border-color:var(--bpm-accent-border);color:#fff}
    .bpm-section{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px}.bpm-section[hidden]{display:none}
    .bpm-toolbar{flex:none;display:flex;gap:4px;align-items:center;flex-wrap:wrap}.bpm-toolbar .bpi-search{min-width:120px}.bpm-toolbar .bpi-mode{flex:1;min-width:90px}
    .bpm-summary{flex:none;color:var(--bpi-text-muted);font-size:11px;min-height:15px;word-break:break-all}
    .bpm-rows{flex:1;min-height:120px;overflow-y:auto;scrollbar-gutter:stable;border:1px solid var(--bpi-border-2);border-radius:6px;background:var(--bpi-surface-table)}.bpm-tagmanager-host{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:7px;padding-right:2px}.bpm-tagmanager-host .bpi-details-body{display:flex;flex-direction:column;gap:7px}.bpm-tagmanager-host .bpi-table{height:auto;min-height:220px;max-height:none;flex:0 1 auto}
    .bpm-row{border-top:1px solid var(--bpi-border-3);padding:6px 8px;display:flex;flex-direction:column;gap:3px}.bpm-row:first-child{border-top:0}.bpm-row:hover{background:var(--bpi-surface-3)}
    .bpm-row-top{display:flex;align-items:flex-start;gap:5px}.bpm-row-top input[type="checkbox"]{margin-top:2px}.bpm-row-en{color:var(--bpi-text);font-family:Consolas,monospace;word-break:break-word;min-width:0;flex:1}
    .bpm-row-zh{color:var(--bpi-zh-text);word-break:break-word}
    .bpm-row-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:var(--bpi-text-muted);font-size:10px}
    .bpm-actions{display:flex;gap:4px;flex-wrap:wrap}
    .bpm-footer{flex:none;display:flex;gap:4px;align-items:center;justify-content:space-between;flex-wrap:wrap}.bpm-footer .bpi-toolbar-group{justify-content:flex-start}
    .bpm-section .bpi-pack-list{flex:1;min-height:0;max-height:none;grid-template-columns:1fr}
    .bpm-section .bpi-form{grid-template-columns:78px minmax(0,1fr)}.bpm-section .bpi-form textarea{min-height:84px}
    .bpm-assistant-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
    .bpm-loading{padding:24px;text-align:center;color:var(--bpi-text-faint)}
    .bpm-panel .bpi-button.bpi-primary,.bpm-panel .bpi-mini.bpi-primary{background:var(--bpm-accent);border-color:var(--bpm-accent-border);color:#fff}
    .bpm-panel .bpi-button.bpi-primary:hover,.bpm-panel .bpi-mini.bpi-primary:hover{background:var(--bpm-accent-hover);border-color:var(--bpm-accent-border);color:#fff}
    .bpm-panel .bpi-filter-active{background:var(--bpm-accent);border-color:var(--bpm-accent-border);color:#fff}
    .bpi-modal .bpi-button.bpi-primary,.bpi-modal .bpi-mini.bpi-primary{background:var(--bpm-accent);border-color:var(--bpm-accent-border);color:#fff}
    .bpi-modal .bpi-button.bpi-primary:hover,.bpi-modal .bpi-mini.bpi-primary:hover{background:var(--bpm-accent-hover);border-color:var(--bpm-accent-border);color:#fff}
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
  UNINDEXED_PACK_ID,
  UPSTREAM_ARRIVED_EVENT,
  applyBpiAppearance,
  applyLanguageToDom,
  buildTagFields,
  button,
  checkDuplicateTags,
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
  loadTokenColors,
  getLanguageMode,
  importCommunityPack,
  importSavedPrompts,
  importTags,
  bulkUpdateTags,
  injectBpiStyles,
  listModelNames,
  listSavedPrompts,
  loadDictionary,
  loadPreferences,
  lookupLargeDictionary,
  buildColorPanel,
  openManagerPanel,
  openSavePromptDialog,
  openTagDialog,
  postUpstreamAction,
  savedPromptImageUrl,
  runInspectorAssistant,
  saveAssistantConfig,
  savePreferences,
  saveTag,
  saveTokenColors,
  searchLargeDictionary,
  setLanguageMode,
  setLargeDictionaryEnabled,
  setPackEnabled,
  setPlaceholder,
  setText,
  setTitle,
  t,
  testAssistantConnection,
  updateSavedPrompt,
};
