import { app } from "../../scripts/app.js";
import {
  analyzePromptSyntax,
  buildDictionaryIndex,
  detectInputMode,
  movePromptToken,
  normalizeKey,
  parsePrompt,
  removePromptToken,
  replacePromptTokenWeight,
  restorePromptToken,
  validateTranslationResult,
} from "./parser.js";
import {
  clearButtonAction,
  clearButtonLabel,
  createClearTextHistoryEntry,
  inspectorNodeTargetHeight,
  preservedSearchScroll,
  rankDictionaryMatches,
  rankDictionaryTags,
  recordRecent,
  suggestedTags,
  toggleFavorite,
} from "./dictionary_tools.js";
import { groupAnimaTokensForDisplay, sortAnimaPrompt } from "./anima_sorter.js";
import { panelSyncHub } from "./panel_sync.js";
import { installBpiWheelGuard } from "./wheel_guard.js";
import {
  button,
  deletePersonalTag,
  element,
  injectBpiStyles,
  loadDictionary,
  loadPreferences,
  lookupLargeDictionary,
  openManagerPanel,
  openTagDialog,
  runInspectorAssistant,
  savePreferences,
  saveTag,
  searchLargeDictionary,
} from "./bpi_shared.js";

const NODE_NAME = "BilingualPromptInspector";
const EXTENSION_VERSION = "v1.2.0";
const PROJECT_URL = "https://github.com/mengshengzhijie/ComfyUI-Bilingual-Prompt-Inspector";
const COLLAPSED_WIDGET_FALLBACK_HEIGHT = 390;
const COLLAPSED_NODE_MIN_HEIGHT = 360;

function openProjectAbout() {
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal bpi-about-modal");
  modal.append(
    element("h3", "", "关于插件"),
    element("div", "bpi-about-name", `双语提示词管理器 ${EXTENSION_VERSION}`),
    element("div", "bpi-config-note", "面向 Anima / Danbooru 提示词整理、翻译与管理的 ComfyUI 社区工具。"),
    element("div", "bpi-config-note", "基于 Qiongyi44 的双语提示词检查器二次开发，现由本人独立维护。"),
  );
  const actions = element("div", "bpi-modal-actions");
  const projectLink = element("a", "bpi-button bpi-primary", "访问插件仓库 ↗");
  projectLink.href = PROJECT_URL;
  projectLink.target = "_blank";
  projectLink.rel = "noopener noreferrer";
  projectLink.referrerPolicy = "no-referrer";
  projectLink.addEventListener("mousedown", (event) => event.stopPropagation());
  projectLink.addEventListener("click", (event) => event.stopPropagation());
  const close = () => shade.remove();
  actions.append(projectLink, button("关闭", close));
  modal.appendChild(actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
}

function sourceLabel(source, status) {
  if (status === "machine") return "检查器助手";
  const labels = {
    starter: "内置词库",
    builtin: "内置词库",
    user: "个人词库",
    "prompt-assistant": "历史个人词库",
    "bpi-assistant": "检查器助手",
    session: "仅本次修改",
    "danbooru-large": "Danbooru 大型词库",
    syntax: "语法保护",
    unknown: "未知来源",
  };
  return labels[source] ?? source ?? "未知来源";
}

function animaPunctuationError(value) {
  const text = String(value ?? "");
  if (/[\u3400-\u9fff]/.test(text)) return "结果仍包含中文";
  const allowed = new Set(",.():@_-'<>%+/&".split(""));
  const invalid = [...new Set([...text].filter((character) =>
    !/[A-Za-z0-9\s]/.test(character) && !allowed.has(character)
  ))];
  return invalid.length ? `包含不符合 Anima 规则的字符：${invalid.join(" ")}` : "";
}

function createPanel(node, textWidget) {
  const panel = element("div", "bpi-panel");
  const englishSection = element("section", "bpi-english-section");
  const englishHead = element("div", "bpi-english-head");
  const englishTitle = element("span", "", "英文提示词（实际输出）");
  const englishHint = element("span", "bpi-english-hint", "空内容时直接编辑");
  const editEnglishButton = element("button", "bpi-button bpi-mini", "完成编辑");
  const clearEnglishButton = element("button", "bpi-button bpi-mini bpi-danger", "清空");
  editEnglishButton.type = "button";
  clearEnglishButton.type = "button";
  englishHead.append(englishTitle, englishHint, editEnglishButton, clearEnglishButton);
  const englishTokenView = element("div", "bpi-english-token-view bpi-hidden");
  englishTokenView.tabIndex = 0;
  englishTokenView.setAttribute("role", "textbox");
  englishTokenView.setAttribute("aria-label", "英文提示词标签视图");
  englishTokenView.setAttribute("aria-readonly", "true");
  const englishEditor = element("textarea", "bpi-english-editor");
  englishEditor.placeholder = "输入英文提示词；完成编辑后将显示为可选择和删除的标签。";
  const englishHiddenBar = element("div", "bpi-hidden-bar bpi-hidden");
  englishHiddenBar.title = "已隐藏的标签不会进入实际输出文本";
  englishSection.append(englishHead, englishTokenView, englishHiddenBar, englishEditor);
  const mirrorSection = element("section", "bpi-mirror-section");
  const mirrorHead = element("div", "bpi-section-head");
  const mirrorTitle = element("span", "", "中文同步编辑（逐标签组合）");
  const mirrorHint = element("span", "bpi-section-hint", "点击联动｜选中后按 Delete 删除");
  const mirrorActions = element("div", "bpi-mirror-actions");
  const editChineseButton = element("button", "bpi-button bpi-mini", "编辑文本");
  const translateChineseButton = element("button", "bpi-button bpi-mini", "仅翻译");
  const translateOptimizeButton = element("button", "bpi-button bpi-mini bpi-primary", "翻译并优化");
  const optimizeChineseButton = element("button", "bpi-button bpi-mini", "优化为 Anima");
  const expandChineseButton = element("button", "bpi-button bpi-mini", "展开编辑");
  const syncTextButton = element("button", "bpi-button bpi-mini", "同步到英文输出");
  const sortPromptButton = element("button", "bpi-button bpi-mini", "按官方顺序整理");
  const assistantSettingsButton = element("button", "bpi-button bpi-mini", "助手设置");
  const tagManagerButton = element("button", "bpi-button bpi-mini", "标签管理");
  for (const control of [editChineseButton, expandChineseButton, translateChineseButton, translateOptimizeButton, optimizeChineseButton, syncTextButton, sortPromptButton, assistantSettingsButton]) control.type = "button";
  mirrorActions.append(editChineseButton, expandChineseButton, translateChineseButton, translateOptimizeButton, optimizeChineseButton, syncTextButton, sortPromptButton, tagManagerButton, assistantSettingsButton);
  mirrorHead.append(mirrorTitle, mirrorHint, mirrorActions);
  const chineseMirror = element("div", "bpi-chinese-mirror");
  chineseMirror.tabIndex = 0;
  chineseMirror.setAttribute("role", "textbox");
  chineseMirror.setAttribute("aria-label", "逐标签中文同步视图");
  chineseMirror.setAttribute("aria-readonly", "true");
  const chineseEditor = element("textarea", "bpi-chinese-editor bpi-hidden");
  chineseEditor.placeholder = "可输入中文、英文或中英混合文本；使用“仅翻译”或“翻译并优化”处理，确认后再单独同步到英文输出。";
  mirrorSection.append(mirrorHead, chineseMirror, chineseEditor);
  const detailsBody = element("div", "bpi-details-body");
  const detailsHiddenBar = element("div", "bpi-hidden-bar bpi-hidden");
  const toolbar = element("div", "bpi-toolbar");
  const leftTools = element("div", "bpi-toolbar-group");
  const rightTools = element("div", "bpi-toolbar-group");
  const searchLine = element("div", "bpi-search-line");
  const searchLabel = element("strong", "bpi-search-label", "词库搜索");
  const search = element("input", "bpi-search");
  search.type = "search";
  search.placeholder = "输入中文、英文、别名或概念；点击结果插入英文";
  const results = element("div", "bpi-results");
  const summary = element("div", "bpi-summary");
  const counts = element("span");
  const modeInfo = element("span", "bpi-mode-info");
  const status = element("span", "bpi-status");
  const issuesPanel = element("div", "bpi-issues");
  const filtersBar = element("div", "bpi-filters");
  const table = element("div", "bpi-table");
  const head = element("div", "bpi-head");
  head.append(element("div", "", "英文原文（实际输出）"), element("div", "", "中文解释（仅供阅读）"));
  table.appendChild(head);
  const aboutFooter = element("div", "bpi-about-footer");
  const aboutButton = element("button", "bpi-about-button", "关于插件");
  aboutButton.type = "button";
  aboutButton.title = "查看插件版本与项目仓库";
  aboutButton.addEventListener("mousedown", (event) => event.stopPropagation());
  aboutButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectAbout();
  });
  aboutFooter.append(element("span", "", `Bilingual Prompt Inspector ${EXTENSION_VERSION}`), aboutButton);

  const modeSelect = element("select", "bpi-mode");
  for (const [value, label] of [["auto", "自动识别"], ["tags", "标签模式"], ["natural", "自然语言"]]) {
    const option = element("option", "", label);
    option.value = value;
    modeSelect.appendChild(option);
  }

  const state = {
    data: { tags: [], builtin: [], user: [], packs: [] },
    index: new Map(),
    tokens: [],
    machine: panelSyncHub.machineTranslations,
    translating: new Set(),
    pinned: null,
    lastText: null,
    renderTimer: null,
    modePreference: "auto",
    modeInfo: { mode: "tags", reason: "空输入", confidence: "high" },
    issues: [],
    localOverrides: new Map(),
    editing: null,
    preferences: loadPreferences(),
    tableFilter: "all",
    filterButtons: new Map(),
    searchMatches: [],
    searchIndex: -1,
    largeCache: new Map(),
    largeMisses: new Set(),
    largePending: new Set(),
    largeLookupTimer: null,
    largeLookupGeneration: 0,
    largeSearchMatches: [],
    largeSearchQuery: "",
    largeSearchLoading: false,
    largeSearchTimer: null,
    largeSearchGeneration: 0,
    largeSearchOffset: 0,
    largeSearchHasMore: false,
    largeSearchExpandedTerms: [],
    searchVisibleLimit: 40,
    lastRenderedSearchQuery: "",
    categoryView: false,
    chineseEditing: false,
    englishEditing: !String(textWidget.value ?? "").trim(),
    englishEditingExplicit: false,
    englishEditorDirty: false,
    englishClearState: "idle",
    clearedEnglishEntry: null,
    assistantBusy: false,
    stagedText: null,
    editorInitialized: false,
    undoStack: [],
    redoStack: [],
    boundTextarea: null,
    textareaListeners: null,
    nodeBaseHeight: null,
    collapsedWidgetHeight: COLLAPSED_WIDGET_FALLBACK_HEIGHT,
    resizeFrame: null,
    manualResize: null,
    windowPointerUp: null,
    syncSource: Symbol(`bpi-node-${node.id ?? "unknown"}`),
  };

  const setStatus = (message, kind = "") => {
    status.textContent = message;
    status.dataset.kind = kind;
  };

  const persistPreferences = () => {
    savePreferences(state.preferences);
    panelSyncHub.notify("preferences", state.syncSource);
  };
  const autoFitGreenArea = (target, minimum) => {
    if (!target || target.classList.contains("bpi-hidden")) return;
    const preferred = target === chineseEditor ? state.preferences.chineseEditorHeight : 0;
    const maximum = target === chineseEditor ? 600 : 360;
    target.style.height = "auto";
    const height = Math.max(minimum, preferred, Math.min(maximum, Math.ceil(target.scrollHeight + 2)));
    target.style.height = `${height}px`;
    target.style.overflowY = target.scrollHeight > height + 1 ? "auto" : "hidden";
  };
  const autoFitActiveGreenArea = () => requestAnimationFrame(() => {
    autoFitGreenArea(state.chineseEditing ? chineseEditor : chineseMirror, state.chineseEditing ? 110 : 92);
  });
  const hasNodeSize = () => Number.isFinite(Number(node.size?.[0])) && Number.isFinite(Number(node.size?.[1]));
  const inspectorWidget = () => node.widgets?.find((widget) => widget.name === "bilingual_inspector");
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
      } else if (resize.kind === "chinese") {
        const height = Math.max(110, Math.min(600, Math.round(resize.target.offsetHeight)));
        const delta = height - resize.startHeight;
        resize.target.style.height = `${height}px`;
        state.preferences = { ...state.preferences, chineseEditorHeight: height };
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
  state.windowPointerUp = finishManualResize;
  window.addEventListener("pointerup", state.windowPointerUp, true);
  const measureCollapsedWidgetHeight = () => {
    const styles = getComputedStyle(panel);
    const pixels = (name) => Number.parseFloat(styles.getPropertyValue(name)) || 0;
    const height = mirrorSection.offsetHeight
      + englishSection.offsetHeight
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
      state.collapsedWidgetHeight = measureCollapsedWidgetHeight();
      panel.style.setProperty("--bpi-collapsed-height", `${state.collapsedWidgetHeight}px`);
      const width = Math.max(node.size?.[0] ?? 0, 590);
      const widget = inspectorWidget();
      const computedWidgetHeight = Number(widget?.computedHeight);
      const panelHeight = Number(panel.offsetHeight);
      const currentWidgetHeight = Number.isFinite(computedWidgetHeight) && computedWidgetHeight > 0
        ? computedWidgetHeight
        : Number.isFinite(panelHeight) && panelHeight > 0 ? panelHeight : undefined;
      const targetHeight = inspectorNodeTargetHeight({
        widgetY: widget?.y,
        widgetMargin: widget?.margin ?? 10,
        nodeHeight: node.size?.[1],
        currentWidgetHeight,
        targetWidgetHeight: state.collapsedWidgetHeight,
        fallbackBaseHeight: state.nodeBaseHeight ?? 70,
        minimumHeight: COLLAPSED_NODE_MIN_HEIGHT,
      });
      state.nodeBaseHeight = Math.max(0, targetHeight - targetWidgetHeight);
      const sizeChanged = Math.abs((node.size?.[0] ?? 0) - width) > 0.5
        || Math.abs((node.size?.[1] ?? 0) - targetHeight) > 0.5;
      if (sizeChanged) {
        node.setSize?.([width, targetHeight]);
        node.graph?.change?.();
      }
      node.graph?.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
    });
  };
  const isFavorite = (english) => state.preferences.favorites.includes(normalizeKey(english));
  const changeFavorite = (english) => {
    state.preferences = toggleFavorite(state.preferences, english);
    persistPreferences();
  };
  const rememberRecent = (english) => {
    state.preferences = recordRecent(state.preferences, english);
    persistPreferences();
  };
  const setMachineTranslation = (key, value) => {
    state.machine.set(key, value);
    panelSyncHub.notify("machine", state.syncSource);
  };
  const deleteMachineTranslation = (key) => {
    const changed = state.machine.delete(key);
    if (changed) panelSyncHub.notify("machine", state.syncSource);
    return changed;
  };
  const clearMachineTranslations = () => {
    if (!state.machine.size) return;
    state.machine.clear();
    panelSyncHub.notify("machine", state.syncSource);
  };
  const builtinTagFor = (english) => state.data.builtin.find((tag) => normalizeKey(tag.english) === normalizeKey(english));
  const largeDictionaryReady = () => Boolean(state.data.large_dictionary?.available && state.data.large_dictionary?.enabled);
  const rebuildDictionaryIndex = () => {
    const index = buildDictionaryIndex([...state.largeCache.values()]);
    for (const tag of state.data.tags ?? []) index.set(normalizeKey(tag.english), tag);
    state.index = index;
  };

  const copyText = async (value, message = "已复制") => {
    try {
      await navigator.clipboard.writeText(String(value ?? ""));
      setStatus(message, "ok");
    } catch {
      setStatus("浏览器未允许写入剪贴板", "error");
    }
  };

  const findTextarea = () => {
    const resolved = resolveDeepestWidget(textWidget);
    const isEnglishTextarea = (candidate) => candidate?.tagName === "TEXTAREA"
      && candidate !== chineseEditor
      && !candidate.classList.contains("bpi-chinese-editor")
      && !panel.contains(candidate);
    for (const widget of [resolved, textWidget]) {
      for (const candidate of [widget?.inputEl, widget?.element]) {
        if (isEnglishTextarea(candidate)) return candidate;
        const nested = candidate?.querySelector?.("textarea");
        if (isEnglishTextarea(nested)) return nested;
      }
    }
    const nodeContainer = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!nodeContainer) return null;
    const textareaWidgets = (node.widgets ?? []).filter((widget) => {
      if (widget?.hidden || widget?.type === "hidden") return false;
      const target = resolveDeepestWidget(widget);
      return target?.type === "customtext"
        || target?.type === "string"
        || target?.type === "STRING" && target?.options?.multiline
        || target?.inputEl?.tagName === "TEXTAREA"
        || target?.element?.tagName === "TEXTAREA";
    });
    const targetIndex = textareaWidgets.findIndex((widget) => widget === textWidget || resolveDeepestWidget(widget) === resolved);
    const primeTextareas = [...nodeContainer.querySelectorAll("textarea.p-textarea")].filter(isEnglishTextarea);
    const textareas = primeTextareas.length
      ? primeTextareas
      : [...nodeContainer.querySelectorAll("textarea")].filter(isEnglishTextarea);
    if (targetIndex >= 0 && targetIndex < textareas.length) return textareas[targetIndex];
    return textareas.length === 1 ? textareas[0] : null;
  };

  const updateEnglishClearButton = () => {
    clearEnglishButton.textContent = clearButtonLabel(state.englishClearState);
    clearEnglishButton.disabled = state.englishClearState === "idle" && !String(textWidget.value ?? "");
  };
  const resetEnglishClearState = () => {
    state.englishClearState = "idle";
    state.clearedEnglishEntry = null;
    updateEnglishClearButton();
  };
  const updateText = (nextText, cursorPosition = null, { preserveClearState = false } = {}) => {
    if (!preserveClearState && state.englishClearState !== "idle") resetEnglishClearState();
    textWidget.value = nextText;
    textWidget.callback?.(nextText);
    node.graph?.change?.();
    app.graph?.setDirtyCanvas?.(true, true);
    const textarea = findTextarea();
    if (textarea) {
      textarea.value = nextText;
    }
    englishEditor.value = nextText;
    if (state.englishEditing && cursorPosition !== null) {
      const cursor = Math.max(0, Math.min(nextText.length, cursorPosition));
      englishEditor.focus({ preventScroll: true });
      englishEditor.setSelectionRange(cursor, cursor);
    }
    scheduleRender(true);
  };

  englishEditor.value = String(textWidget.value ?? "");
  if (state.preferences.englishInputHeight) applyEnglishEditorHeight(state.preferences.englishInputHeight);
  if (state.preferences.chineseEditorHeight) chineseEditor.style.height = `${state.preferences.chineseEditorHeight}px`;

  const setEnglishEditing = (editing, explicit = true) => {
    const requested = Boolean(editing);
    if (requested) {
      state.englishEditing = true;
      state.englishEditingExplicit = explicit;
      state.englishEditorDirty = false;
      englishEditor.value = String(textWidget.value ?? "");
      englishEditor.classList.remove("bpi-hidden");
      englishTokenView.classList.add("bpi-hidden");
      editEnglishButton.textContent = "完成编辑";
      englishHint.textContent = "输入期间保持文本模式；完成后解析为标签";
      requestAnimationFrame(() => {
        englishEditor.focus();
        englishEditor.setSelectionRange(englishEditor.value.length, englishEditor.value.length);
      });
      return;
    }
    const nextText = englishEditor.value;
    if (nextText !== String(textWidget.value ?? "")) updateText(nextText);
    if (!nextText.trim()) {
      state.englishEditing = true;
      state.englishEditingExplicit = false;
      englishHint.textContent = "内容为空，请直接输入英文提示词";
      return;
    }
    state.englishEditing = false;
    state.englishEditingExplicit = false;
    state.englishEditorDirty = false;
    englishEditor.classList.add("bpi-hidden");
    englishTokenView.classList.remove("bpi-hidden");
    editEnglishButton.textContent = "编辑文本";
    englishHint.textContent = "点击标签联动；选中后按 Delete 删除";
    scheduleRender(true);
    requestAnimationFrame(() => englishTokenView.focus({ preventScroll: true }));
  };

  const containsChinese = (value) => /[\u3400-\u9fff]/.test(String(value ?? ""));
  const updateStageControls = () => {
    const value = chineseEditor.value.trim();
    const syncable = Boolean(value) && !containsChinese(value);
    syncTextButton.disabled = state.assistantBusy || !state.chineseEditing || !syncable;
    syncTextButton.title = syncable
      ? "预览后把当前英文结果写入上方实际输出"
      : "只有绿色编辑区中的英文结果可以同步到实际输出";
  };
  const setStagedResult = (text, label, requireAnima = false) => {
    const value = String(text ?? "").trim();
    state.chineseEditing = true;
    state.editorInitialized = true;
    state.stagedText = { text: value, label, requireAnima };
    chineseEditor.value = value;
    chineseMirror.classList.add("bpi-hidden");
    chineseEditor.classList.remove("bpi-hidden");
    editChineseButton.textContent = "返回联动";
    mirrorTitle.textContent = `文本处理结果：${label}`;
    mirrorHint.textContent = containsChinese(value)
      ? "中文结果仅供阅读；如需生图，请继续翻译或优化"
      : "结果尚未写入模型；确认后点击“同步到英文输出”";
    updateStageControls();
    autoFitActiveGreenArea();
  };

  const applyFullText = (nextText, label) => {
    const before = String(textWidget.value ?? "");
    const after = String(nextText ?? "").trim();
    if (!after) {
      setStatus("结果为空，未覆盖英文提示词", "error");
      return false;
    }
    if (before === after) {
      if (label === "官方顺序整理") {
        state.categoryView = true;
        render();
        mirrorHint.textContent = "分类表格视图｜点击标签联动；分类名称不会写入提示词";
      }
      setStatus("内容没有变化", "ok");
      return false;
    }
    state.undoStack.push({
      before,
      after,
      beforeStart: 0,
      beforeEnd: before.length,
      afterCursor: after.length,
      label,
      beforeCategoryView: state.categoryView,
      afterCategoryView: label === "官方顺序整理",
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    state.categoryView = label === "官方顺序整理";
    state.chineseEditing = false;
    state.editorInitialized = false;
    state.stagedText = null;
    chineseEditor.classList.add("bpi-hidden");
    chineseMirror.classList.remove("bpi-hidden");
    editChineseButton.textContent = "编辑文本";
    mirrorTitle.textContent = "中文同步编辑（逐标签组合）";
    mirrorHint.textContent = state.categoryView
      ? "分类表格视图｜点击标签联动；分类名称不会写入提示词"
      : "点击联动｜选中后按 Delete 删除";
    state.englishEditing = false;
    state.englishEditingExplicit = false;
    state.englishEditorDirty = false;
    englishEditor.value = after;
    englishEditor.classList.add("bpi-hidden");
    englishTokenView.classList.remove("bpi-hidden");
    editEnglishButton.textContent = "编辑文本";
    englishHint.textContent = "点击标签联动；选中后按 Delete 删除";
    updateStageControls();
    updateText(after);
    setStatus(`已应用${label}；按 Ctrl+Z 可撤销`, "ok");
    return true;
  };

  const clearEnglishText = () => {
    const currentText = String(textWidget.value ?? "");
    const action = clearButtonAction(state.englishClearState, Boolean(currentText));
    if (action === "empty") {
      setStatus("英文实际输出已经为空", "ok");
      return;
    }
    if (action === "confirm") {
      state.englishClearState = "confirm";
      updateEnglishClearButton();
      setStatus("再次点击“确认清空”才会清空英文实际输出", "busy");
      return;
    }
    if (action === "undo") {
      const entry = state.clearedEnglishEntry;
      if (entry && state.undoStack.at(-1) === entry && undoStructuredEdit()) {
        setEnglishEditing(false);
        setStatus("已撤销英文清空", "ok");
      } else {
        resetEnglishClearState();
        setStatus("英文内容已发生变化，无法撤销本次清空", "error");
      }
      return;
    }
    const entry = createClearTextHistoryEntry(currentText, "清空英文提示词", state.categoryView);
    if (!entry) return;
    state.undoStack.push(entry);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    state.categoryView = false;
    state.chineseEditing = false;
    state.editorInitialized = false;
    state.stagedText = null;
    chineseEditor.classList.add("bpi-hidden");
    chineseMirror.classList.remove("bpi-hidden");
    state.englishEditing = true;
    state.englishEditingExplicit = true;
    state.englishEditorDirty = false;
    englishEditor.value = "";
    englishEditor.classList.remove("bpi-hidden");
    englishTokenView.classList.add("bpi-hidden");
    editEnglishButton.textContent = "完成编辑";
    state.englishClearState = "cleared";
    state.clearedEnglishEntry = entry;
    updateEnglishClearButton();
    updateText("", 0, { preserveClearState: true });
    setStatus("已清空英文实际输出；点击“撤销”可立即恢复", "ok");
    requestAnimationFrame(() => englishEditor.focus({ preventScroll: true }));
  };

  const openTextPreview = (title, proposed, detailNode, label) => {
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal bpi-assistant-settings");
    modal.appendChild(element("h3", "", title));
    modal.appendChild(element("div", "bpi-config-note", "当前英文提示词"));
    const before = element("textarea", "bpi-preview-text");
    before.readOnly = true;
    before.value = String(textWidget.value ?? "");
    modal.appendChild(before);
    modal.appendChild(element("div", "bpi-config-note", "准备应用的新英文提示词"));
    const after = element("textarea", "bpi-preview-text");
    after.readOnly = true;
    after.value = String(proposed ?? "").trim();
    modal.appendChild(after);
    if (detailNode) modal.appendChild(detailNode);
    const actions = element("div", "bpi-modal-actions");
    const close = () => shade.remove();
    actions.append(button("取消", close), button("确认写入英文", () => {
      if (applyFullText(after.value, label)) close();
    }, "bpi-primary"));
    modal.appendChild(actions);
    shade.appendChild(modal);
    document.body.appendChild(shade);
    shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
    modal.addEventListener("mousedown", (event) => event.stopPropagation());
  };

  const openExpandedChineseEditor = () => {
    if (!state.chineseEditing) setChineseEditing(true);
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal bpi-assistant-settings");
    modal.appendChild(element("h3", "", "展开编辑中文／混合文本"));
    const editor = element("textarea", "bpi-preview-text");
    editor.style.minHeight = "360px";
    editor.style.resize = "vertical";
    editor.value = chineseEditor.value;
    modal.appendChild(editor);
    const actions = element("div", "bpi-modal-actions");
    const close = () => shade.remove();
    actions.append(button("取消", close), button("应用到编辑区", () => {
      chineseEditor.value = editor.value;
      chineseEditor.dispatchEvent(new Event("input", { bubbles: true }));
      close();
      chineseEditor.focus({ preventScroll: true });
    }, "bpi-primary"));
    modal.appendChild(actions);
    shade.appendChild(modal);
    document.body.appendChild(shade);
    shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
    modal.addEventListener("mousedown", (event) => event.stopPropagation());
    setTimeout(() => editor.focus(), 0);
  };

  const revealLinkedToken = (token) => {
    if (!token) return;
    table.querySelector(`.bpi-row[data-token-id="${token.id}"]`)?.scrollIntoView?.({ block: "nearest" });
    chineseMirror.querySelector(`.bpi-mirror-token[data-token-id="${token.id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    englishTokenView.querySelector(`.bpi-english-token[data-token-id="${token.id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  const activateToken = (token) => {
    if (!token) return;
    state.pinned = token.id;
    render();
    requestAnimationFrame(() => {
      revealLinkedToken(token);
    });
  };

  const deleteTokenOccurrence = (token) => {
    if (!["tags", "mixed"].includes(state.modeInfo.mode) || token.segmentKind === "natural") {
      setStatus("自然语言片段仅支持整段编辑；标签可继续逐项删除", "error");
      return;
    }
    const before = String(textWidget.value ?? "");
    const result = removePromptToken(before, token);
    if (!result.changed) return;
    state.undoStack.push({
      before,
      after: result.text,
      beforeStart: token.start,
      beforeEnd: token.end,
      afterCursor: result.cursor,
      label: `删除“${token.term}”`,
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    updateText(result.text, result.cursor);
    setStatus(`已删除“${token.term}”；按 Ctrl+Z 可撤销`, "ok");
  };

  const applyTokenWeight = (token, weight) => {
    const before = String(textWidget.value ?? "");
    const result = replacePromptTokenWeight(before, token, weight);
    if (!result.changed) {
      setStatus(weight === null ? "该标签当前没有显式权重" : "权重没有变化或数值无效", "error");
      return false;
    }
    const action = weight === null
      ? `清除“${token.term}”的权重`
      : `将“${token.term}”权重设为 ${Number(weight)}`;
    state.undoStack.push({
      before,
      after: result.text,
      beforeStart: token.start,
      beforeEnd: token.end,
      afterCursor: result.cursor,
      label: action,
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    updateText(result.text, result.cursor);
    setStatus(`已${action}；按 Ctrl+Z 可撤销`, "ok");
    return true;
  };

  const canReorderTokens = () =>
    ["tags", "mixed"].includes(state.modeInfo.mode) && state.tokens.length > 1;

  const moveTokenTo = (token, targetIndex) => {
    if (!token || !canReorderTokens()) return false;
    const before = String(textWidget.value ?? "");
    const result = movePromptToken(before, state.tokens, token, targetIndex);
    if (!result.changed) return false;
    state.undoStack.push({
      before,
      after: result.text,
      beforeStart: token.start,
      beforeEnd: token.end,
      afterCursor: result.cursor,
      label: `移动“${token.term}”`,
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    updateText(result.text, result.cursor);
    setStatus(`已移动“${token.term}”；按 Ctrl+Z 可撤销`, "ok");
    return true;
  };

  // ---- Hidden tags ---------------------------------------------------------
  // A hidden tag is removed from the actual output text (the model never sees
  // it) but remembered on the node itself — properties.bpiHiddenTags survives
  // workflow save/load — together with the tag that used to sit in front of
  // it, so one click puts it back at its original position.  Both directions
  // run through the shared undo stack, and every entry snapshots the hidden
  // list so Ctrl+Z rolls text and list back together.
  const getHiddenTags = () => {
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    if (!Array.isArray(node.properties.bpiHiddenTags)) node.properties.bpiHiddenTags = [];
    return node.properties.bpiHiddenTags;
  };
  const setHiddenTags = (nextList) => {
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    node.properties.bpiHiddenTags = Array.isArray(nextList) ? nextList : [];
  };

  const canHideTokens = () => ["tags", "mixed"].includes(state.modeInfo.mode);

  const pushHistoryWithHidden = (entry) => {
    state.undoStack.push(entry);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
  };

  const hideToken = (token) => {
    if (!token || !canHideTokens()) return false;
    const before = String(textWidget.value ?? "");
    const result = removePromptToken(before, token);
    if (!result.changed) return false;
    const index = state.tokens.findIndex((item) =>
      item.start === token.start && item.end === token.end && item.raw === token.raw);
    const afterToken = index > 0 ? state.tokens[index - 1] : null;
    const hidden = getHiddenTags();
    const entry = {
      before,
      after: result.text,
      beforeStart: token.start,
      beforeEnd: token.end,
      afterCursor: result.cursor,
      label: `隐藏“${token.term}”`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: hidden.concat([{
        raw: token.raw,
        chinese: token.chinese ?? "",
        after: afterToken ? afterToken.raw : null,
      }]),
    };
    pushHistoryWithHidden(entry);
    setHiddenTags(entry.hiddenAfter);
    state.pinned = null;
    updateText(result.text, result.cursor);
    setStatus(`已隐藏“${token.term}”（不会进入实际输出）；在已隐藏区可随时恢复，按 Ctrl+Z 撤销`, "ok");
    return true;
  };

  const restoreHiddenTag = (index) => {
    const hidden = getHiddenTags();
    const item = hidden[index];
    if (!item) return false;
    const before = String(textWidget.value ?? "");
    const result = restorePromptToken(before, state.tokens, item.raw, item.after);
    if (!result.changed) return false;
    const entry = {
      before,
      after: result.text,
      beforeStart: 0,
      beforeEnd: before.length,
      afterCursor: result.cursor,
      label: `恢复“${item.raw}”`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: hidden.filter((_, i) => i !== index),
    };
    pushHistoryWithHidden(entry);
    setHiddenTags(entry.hiddenAfter);
    updateText(result.text, result.cursor);
    setStatus(`已恢复“${item.raw}”到原位置；按 Ctrl+Z 可撤销`, "ok");
    return true;
  };

  const restoreAllHiddenTags = () => {
    const hidden = getHiddenTags();
    if (!hidden.length) return false;
    const before = String(textWidget.value ?? "");
    let text = before;
    let tokens = state.tokens;
    for (const item of hidden) {
      const step = restorePromptToken(text, tokens, item.raw, item.after);
      if (!step.changed) continue;
      text = step.text;
      tokens = parsePrompt(text, state.index, state.machine, { mode: state.modePreference });
    }
    if (text === before) return false;
    const entry = {
      before,
      after: text,
      beforeStart: 0,
      beforeEnd: before.length,
      afterCursor: text.length,
      label: `恢复全部隐藏标签（${hidden.length} 个）`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: [],
    };
    pushHistoryWithHidden(entry);
    setHiddenTags([]);
    state.pinned = null;
    updateText(text, text.length);
    setStatus(`已恢复 ${hidden.length} 个隐藏标签；按 Ctrl+Z 可撤销`, "ok");
    return true;
  };

  let chipClickSuppressed = false;

  // Drag-to-reorder on the English token chips: pointerdown arms a possible
  // drag, moving past a small threshold activates it (so plain clicks and
  // double-clicks keep working), and releasing applies a structured move
  // through the shared undo stack.
  const attachChipDrag = (chip, token) => {
    chip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !canReorderTokens()) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let targetIndex = null;
      let hoverChip = null;
      const clearHover = () => {
        if (hoverChip) hoverChip.classList.remove("bpi-drop-before", "bpi-drop-after");
        hoverChip = null;
      };
      const onMove = (moveEvent) => {
        if (!chip.isConnected) {
          finish();
          return;
        }
        if (!active) {
          if (Math.abs(moveEvent.clientX - startX) < 4 && Math.abs(moveEvent.clientY - startY) < 4) return;
          active = true;
          chipClickSuppressed = true;
          chip.classList.add("bpi-dragging");
        }
        moveEvent.preventDefault();
        clearHover();
        targetIndex = null;
        const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const hitChip = hit?.closest?.(".bpi-english-token");
        const list = [...englishTokenView.querySelectorAll(".bpi-english-token")];
        if (hitChip && hitChip !== chip) {
          const index = list.indexOf(hitChip);
          if (index >= 0) {
            const rect = hitChip.getBoundingClientRect();
            const before = moveEvent.clientX < rect.left + rect.width / 2;
            targetIndex = before ? index : index + 1;
            hoverChip = hitChip;
            hoverChip.classList.add(before ? "bpi-drop-before" : "bpi-drop-after");
          }
        } else if (!hitChip) {
          let last = -1;
          for (const [index, other] of list.entries()) {
            if (other === chip) continue;
            const rect = other.getBoundingClientRect();
            if (rect.bottom <= moveEvent.clientY) last = Math.max(last, index);
            else if (moveEvent.clientY >= rect.top && moveEvent.clientX >= rect.right) last = Math.max(last, index);
          }
          targetIndex = last + 1;
        }
      };
      const finish = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        chip.classList.remove("bpi-dragging");
        clearHover();
        if (active) {
          setTimeout(() => { chipClickSuppressed = false; }, 0);
          if (targetIndex !== null && chip.isConnected) {
            moveTokenTo(token, targetIndex);
            requestAnimationFrame(() => englishTokenView.focus({ preventScroll: true }));
          }
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", finish);
      document.addEventListener("pointercancel", finish);
    });
  };

  // Alt+ArrowUp / Alt+ArrowDown nudge the pinned token one slot.  Returns
  // true when the key was consumed.
  const handleTokenReorderShortcut = (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
    const token = state.tokens.find((item) => item.id === state.pinned);
    if (!token) return false;
    const index = state.tokens.indexOf(token);
    if (index < 0) return false;
    event.preventDefault();
    event.stopPropagation();
    const upward = event.key === "ArrowUp";
    const moved = moveTokenTo(token, upward ? index - 1 : index + 2);
    if (!moved) setStatus(upward ? `“${token.term}”已经在最前面了` : `“${token.term}”已经在最后面了`, "");
    return true;
  };

  const openWeightEditor = (token) => {
    if (!token || token.syntax !== "tag" || token.segmentKind === "natural" ||
        !["tags", "mixed"].includes(state.modeInfo.mode)) {
      setStatus("只有标签支持单独设置权重；自然语言请使用文本编辑", "error");
      return;
    }
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal");
    modal.appendChild(element("h3", "", "修改标签权重"));
    modal.appendChild(element("div", "bpi-config-note", `标签：${token.term}｜Anima 格式：(标签:权重)`));
    const form = element("div", "bpi-form");
    const input = element("input", "");
    input.type = "number";
    input.min = "0";
    input.max = "3";
    input.step = "0.05";
    input.value = token.weight === null ? "1" : String(token.weight);
    form.append(element("label", "", "权重"), input);
    modal.appendChild(form);

    const presets = element("div", "bpi-weight-presets");
    for (const value of [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5]) {
      presets.appendChild(button(String(value), () => {
        input.value = String(value);
        input.focus();
      }, "bpi-mini"));
    }
    modal.appendChild(presets);

    const close = () => shade.remove();
    const apply = () => {
      const numeric = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(numeric) || numeric < 0 || numeric > 3) {
        setStatus("权重必须是 0 到 3 之间的数字", "error");
        input.focus();
        return;
      }
      if (applyTokenWeight(token, numeric)) close();
    };
    const actions = element("div", "bpi-modal-actions");
    if (token.weight !== null) {
      actions.appendChild(button("清除权重", () => {
        if (applyTokenWeight(token, null)) close();
      }, "bpi-danger"));
    }
    actions.append(button("取消", close), button("应用权重", apply, "bpi-primary"));
    modal.appendChild(actions);
    shade.appendChild(modal);
    document.body.appendChild(shade);
    shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
    modal.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        apply();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  };

  const undoStructuredEdit = () => {
    const entry = state.undoStack.at(-1);
    if (!entry || String(textWidget.value ?? "") !== entry.after) return false;
    state.undoStack.pop();
    state.redoStack.push(entry);
    state.pinned = null;
    if (typeof entry.beforeCategoryView === "boolean") state.categoryView = entry.beforeCategoryView;
    if (Array.isArray(entry.hiddenBefore)) setHiddenTags(entry.hiddenBefore);
    updateText(entry.before, entry.beforeStart);
    setStatus(`已撤销：${entry.label}`, "ok");
    return true;
  };

  const redoStructuredEdit = () => {
    const entry = state.redoStack.at(-1);
    if (!entry || String(textWidget.value ?? "") !== entry.before) return false;
    state.redoStack.pop();
    state.undoStack.push(entry);
    state.pinned = null;
    if (typeof entry.afterCategoryView === "boolean") state.categoryView = entry.afterCategoryView;
    if (Array.isArray(entry.hiddenAfter)) setHiddenTags(entry.hiddenAfter);
    updateText(entry.after, entry.afterCursor);
    setStatus(`已重做：${entry.label}`, "ok");
    return true;
  };

  const handleHistoryShortcut = (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const redo = key === "y" || (key === "z" && event.shiftKey);
    const handled = redo ? redoStructuredEdit() : key === "z" ? undoStructuredEdit() : false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const bindTextareaEvents = () => {
    const textarea = findTextarea();
    if (!textarea) return;
    if (state.boundTextarea && state.textareaListeners) {
      for (const [name, listener] of state.textareaListeners) state.boundTextarea.removeEventListener(name, listener);
      state.boundTextarea.classList.remove("bpi-english-resizable", "bpi-english-linked");
    }
    state.boundTextarea = textarea;
    state.textareaListeners = [];
  };

  const insertEnglish = (english, keepSearch = false) => {
    const current = String(textWidget.value ?? "");
    const start = state.englishEditing ? (englishEditor.selectionStart ?? current.length) : current.length;
    const end = state.englishEditing ? (englishEditor.selectionEnd ?? start) : start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const needsPrefix = before.trim() && !/[\s,\n]$/.test(before);
    const needsSuffix = after.trim() && !/^[\s,\n]/.test(after);
    const insertion = `${needsPrefix ? ", " : ""}${english}${needsSuffix ? ", " : ""}`;
    const nextText = before + insertion + after;
    updateText(nextText, state.englishEditing ? start + insertion.length : null);
    rememberRecent(english);
    if (!keepSearch) search.value = "";
    renderSearch();
  };

  const queueLargeLookup = (tokens) => {
    if (!largeDictionaryReady() || !["tags", "mixed"].includes(state.modeInfo.mode)) return;
    const candidates = [];
    const seen = new Set();
    for (const token of tokens ?? []) {
      if (token.segmentKind === "natural" || token.status !== "unknown" || token.syntax !== "tag" || /[\u3400-\u9fff]/.test(token.term)) continue;
      if (!token.key || seen.has(token.key) || state.largeCache.has(token.key) || state.largeMisses.has(token.key) || state.largePending.has(token.key)) continue;
      seen.add(token.key);
      candidates.push({ key: token.key, term: token.term });
    }
    if (!candidates.length) return;
    clearTimeout(state.largeLookupTimer);
    state.largeLookupTimer = setTimeout(async () => {
      const batch = candidates.slice(0, 200);
      const generation = state.largeLookupGeneration;
      for (const item of batch) state.largePending.add(item.key);
      try {
        const matches = await lookupLargeDictionary(batch.map((item) => item.term));
        if (generation !== state.largeLookupGeneration) return;
        const found = new Set();
        for (const tag of matches) {
          const key = normalizeKey(tag.english);
          found.add(key);
          state.largeCache.set(key, tag);
          state.largeMisses.delete(key);
        }
        for (const item of batch) if (!found.has(item.key)) state.largeMisses.add(item.key);
        rebuildDictionaryIndex();
        render();
      } catch (error) {
        console.warn("[BilingualPromptInspector] 大型词库批量识别失败", error);
        setStatus(error.message, "error");
      } finally {
        for (const item of batch) state.largePending.delete(item.key);
      }
    }, 300);
  };

  const resetLargeRuntimeCache = () => {
    clearTimeout(state.largeLookupTimer);
    clearTimeout(state.largeSearchTimer);
    state.largeLookupGeneration += 1;
    state.largeSearchGeneration += 1;
    state.largeCache.clear();
    state.largeMisses.clear();
    state.largePending.clear();
    state.largeSearchMatches = [];
    state.largeSearchQuery = "";
    state.largeSearchLoading = false;
    state.largeSearchOffset = 0;
    state.largeSearchHasMore = false;
    state.largeSearchExpandedTerms = [];
    state.searchVisibleLimit = 40;
  };

  const refreshDictionary = async (notifyPeers = true) => {
    setStatus("正在读取词库…", "busy");
    try {
      state.data = await loadDictionary(true);
      resetLargeRuntimeCache();
      rebuildDictionaryIndex();
      const large = state.data.large_dictionary;
      const largeText = large?.available
        ? `｜大型库 ${large.count} 项（${large.enabled ? "按需启用" : "已停用"}）`
        : "｜大型库未安装";
      setStatus(`常用词库 ${state.data.tags.length} 项${largeText}`, "ok");
      render();
      renderSearch();
      if (notifyPeers) panelSyncHub.notify("dictionary", state.syncSource);
    } catch (error) {
      setStatus(error.message, "error");
      state.data = { tags: [], builtin: [], user: [], packs: [], large_dictionary: null };
      resetLargeRuntimeCache();
      state.index = new Map();
      render();
    }
  };

  const saveMachineTranslation = (token) => {
    openTagDialog({
      english: token.term,
      chinese: token.chinese,
      category: "待整理",
      models: ["general", "anima"],
      source: "bpi-assistant",
      verified: true,
    }, async () => {
      deleteMachineTranslation(token.key);
      await refreshDictionary();
    });
  };

  const beginInlineEdit = (token) => {
    state.editing = {
      id: token.id,
      key: token.key,
      value: ["未收录", "自然语言片段（待翻译或确认）"].includes(token.chinese) ? "" : token.chinese,
    };
    render();
  };

  const applyInlineEdit = async (token, value, persist) => {
    const chinese = String(value ?? "").trim();
    if (!chinese) {
      setStatus("中文解释不能为空", "error");
      return;
    }
    if (!persist) {
      state.localOverrides.set(token.key, { text: chinese, source: "session" });
      state.editing = null;
      setStatus(`已临时修改“${token.term}”，不会写入词库`, "ok");
      render();
      return;
    }
    try {
      const entry = token.entry ?? {};
      await saveTag({
        english: token.term,
        chinese,
        aliases: entry.aliases ?? [],
        category: entry.category ?? "自定义",
        models: entry.models ?? ["general", "anima"],
        recommended_weight: entry.recommended_weight ?? "",
        notes: entry.notes ?? "",
        source: "user",
        verified: true,
      });
      state.localOverrides.delete(token.key);
      deleteMachineTranslation(token.key);
      state.editing = null;
      await refreshDictionary();
      setStatus(`已将“${token.term}”保存到个人词库`, "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  };

  const translateToken = async (token) => {
    if (!token?.key || state.translating.has(token.key)) return;
    state.translating.add(token.key);
    setStatus(`正在翻译：${token.term}`, "busy");
    render();
    try {
      const naturalLanguage = token.segmentKind === "natural" || ["natural", "instruction"].includes(token.inputMode);
      const translated = await runInspectorAssistant(
        "translate",
        token.term,
        naturalLanguage ? "这是自然语言片段，请保持为自然语言译文，不要拆成标签列表。" : "",
      );
      const validation = validateTranslationResult(token.term, translated, { naturalLanguage });
      if (!validation.ok) {
        console.warn("[BilingualPromptInspector] 已拒绝异常机器译文", {
          source: token.term,
          translated,
          reason: validation.reason,
        });
        setStatus(`已拒绝异常译文：${validation.reason}`, "error");
        return false;
      }
      setMachineTranslation(token.key, {
        english: token.term,
        text: validation.text,
        source: "bpi-assistant",
        createdAt: Date.now(),
      });
      setStatus(`已翻译“${token.term}”，确认后可保存`, "ok");
      return true;
    } catch (error) {
      setStatus(error.message, "error");
      return false;
    } finally {
      state.translating.delete(token.key);
      render();
    }
  };

  const chineseDraftFromTokens = () => state.tokens.map((token) => {
    if (token.syntax === "special" || token.syntax === "operator") return token.raw;
    const label = token.status === "unknown" ? token.term : token.chinese;
    return token.weight === null ? label : `(${label}:${token.weight})`;
  }).join("，");

  const setChineseEditing = (editing) => {
    state.chineseEditing = Boolean(editing);
    chineseMirror.classList.toggle("bpi-hidden", state.chineseEditing);
    chineseEditor.classList.toggle("bpi-hidden", !state.chineseEditing);
    editChineseButton.textContent = state.chineseEditing ? "返回联动" : "编辑文本";
    mirrorTitle.textContent = state.chineseEditing ? "文本编辑与处理（支持中英混合）" : "中文同步编辑（逐标签组合）";
    mirrorHint.textContent = state.chineseEditing
      ? "处理结果留在此处；点击同步才写入上方英文"
      : state.categoryView
        ? "分类表格视图｜点击标签联动；分类名称不会写入提示词"
        : "点击联动｜选中后按 Delete 删除";
    if (state.chineseEditing) {
      if (!state.editorInitialized) {
        chineseEditor.value = chineseDraftFromTokens();
        state.editorInitialized = true;
        state.stagedText = null;
      }
      requestAnimationFrame(() => {
        autoFitGreenArea(chineseEditor, 110);
        chineseEditor.focus();
        chineseEditor.setSelectionRange(chineseEditor.value.length, chineseEditor.value.length);
      });
    } else {
      autoFitActiveGreenArea();
    }
    updateStageControls();
    if (hasNodeSize()) requestNodeResize();
  };

  const setAssistantBusy = (busy) => {
    state.assistantBusy = Boolean(busy);
    translateChineseButton.disabled = state.assistantBusy;
    translateOptimizeButton.disabled = state.assistantBusy;
    optimizeChineseButton.disabled = state.assistantBusy;
    sortPromptButton.disabled = state.assistantBusy;
    updateStageControls();
  };

  const runTextAssistant = async (action) => {
    if (state.assistantBusy) return;
    if (!state.chineseEditing) setChineseEditing(true);
    const source = chineseEditor.value.trim();
    if (!source) {
      setStatus("请先在绿色文本编辑框输入内容", "error");
      return;
    }
    if (action === "optimize" && containsChinese(source)) {
      setStatus("“优化为 Anima”只处理英文；中文或混合内容请使用“翻译并优化”", "error");
      return;
    }
    setAssistantBusy(true);
    const labels = {
      translate: "仅翻译",
      translate_optimize: "翻译并优化",
      optimize: "优化为 Anima",
    };
    const label = labels[action];
    setStatus(`正在执行${label}…`, "busy");
    try {
      const output = await runInspectorAssistant(action, source);
      setStagedResult(output, label, action !== "translate");
      setStatus(`${label}已完成；结果尚未同步到上方英文输出`, "ok");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setAssistantBusy(false);
    }
  };

  const syncEditedText = () => {
    const proposed = chineseEditor.value.trim();
    if (!proposed) {
      setStatus("绿色文本编辑框为空", "error");
      return;
    }
    if (containsChinese(proposed)) {
      setStatus("当前结果包含中文，不能同步到英文模型输入", "error");
      return;
    }
    if (state.stagedText?.requireAnima) {
      const punctuationError = animaPunctuationError(proposed);
      if (punctuationError) {
        setStatus(`${punctuationError}，请修改后再同步`, "error");
        return;
      }
    }
    const label = state.stagedText?.label ? `${state.stagedText.label}同步` : "文本同步";
    openTextPreview("同步到英文输出", proposed, null, label);
  };

  const ensureLargeEntriesFor = async (tokens) => {
    if (!largeDictionaryReady()) return;
    const pending = [];
    const seen = new Set();
    for (const token of tokens) {
      if (token.syntax !== "tag" || token.entry || !token.key || seen.has(token.key) || /[\u3400-\u9fff]/.test(token.term)) continue;
      seen.add(token.key);
      pending.push(token.term);
    }
    if (!pending.length) return;
    const matches = await lookupLargeDictionary(pending.slice(0, 200));
    for (const tag of matches) state.largeCache.set(normalizeKey(tag.english), tag);
    rebuildDictionaryIndex();
  };

  const sortByAnimaOrder = async () => {
    if (state.assistantBusy) return;
    const source = String(textWidget.value ?? "").trim();
    if (!source) {
      setStatus("英文提示词为空，无法整理", "error");
      return;
    }
    setAssistantBusy(true);
    setStatus("正在识别标签分类…", "busy");
    try {
      let tokens = parsePrompt(source, state.index, state.machine, { mode: "auto" });
      await ensureLargeEntriesFor(tokens);
      tokens = parsePrompt(source, state.index, state.machine, { mode: "auto" });
      const result = sortAnimaPrompt(tokens, { groupLines: true });
      if (result.text === source) {
        state.categoryView = true;
        render();
        mirrorHint.textContent = "分类表格视图｜点击标签联动；分类名称不会写入提示词";
        setStatus(`已经符合 Anima 顺序${result.uncertain.length ? `｜待确认分类 ${result.uncertain.length} 项` : ""}`, "ok");
        return;
      }
      const groups = element("div", "bpi-sort-groups");
      for (const group of result.groups) {
        const row = element("div", "bpi-sort-group");
        row.append(element("strong", "", group.label), element("span", "", group.tokens.map((token) => token.raw.trim()).join("，")));
        groups.appendChild(row);
      }
      groups.prepend(element("div", "bpi-config-note", `已重新定位 ${result.moved} 项｜待确认分类 ${result.uncertain.length} 项。排序只移动标签，不改写内容。`));
      openTextPreview("Anima 官方顺序整理预览", result.text, groups, "官方顺序整理");
      setStatus("排序完成，请在预览窗口确认", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setAssistantBusy(false);
    }
  };

  const renderEnglishTokenView = (text) => {
    const hasText = Boolean(text.trim());
    updateEnglishClearButton();
    if (!hasText && !state.englishEditing) {
      state.englishEditing = true;
      state.englishEditingExplicit = false;
    }
    englishEditor.classList.toggle("bpi-hidden", !state.englishEditing);
    englishTokenView.classList.toggle("bpi-hidden", state.englishEditing);
    editEnglishButton.textContent = state.englishEditing ? "完成编辑" : "编辑文本";
    englishHint.textContent = state.englishEditing
      ? (hasText ? "输入期间保持文本模式；完成后解析为标签" : "内容为空，请直接输入英文提示词")
      : "点击标签联动；选中后按 Delete 删除";
    if (state.englishEditing) {
      if (document.activeElement !== englishEditor && !state.englishEditorDirty) englishEditor.value = text;
      return;
    }

    englishTokenView.replaceChildren();
    if (!state.tokens.length) {
      englishTokenView.appendChild(element("span", "bpi-mirror-empty", "完成英文编辑后会在这里显示可联动标签。"));
      return;
    }
    for (const [index, token] of state.tokens.entries()) {
      const classes = ["bpi-mirror-token", "bpi-english-token", `bpi-${token.status}`];
      if (state.pinned === token.id) classes.push("bpi-linked");
      const label = token.raw.trim() || token.term;
      const chip = element("span", classes.join(" "), label);
      chip.dataset.tokenId = String(token.id);
      chip.title = token.segmentKind === "natural"
        ? `${token.term} ↔ ${token.chinese}｜自然语言仅支持整段编辑；可整段拖动排序`
        : `${token.term} ↔ ${token.chinese}｜单击联动；双击修改权重；选中后按 Delete 删除；可拖动排序或 Alt+↑/↓ 微调`;
      attachChipDrag(chip, token);
      if (canHideTokens()) {
        const hideCorner = element("span", "bpi-chip-hide");
        hideCorner.appendChild(buildEyeIcon());
        hideCorner.title = `隐藏“${token.raw}”：不进入实际输出，可在已隐藏区恢复`;
        hideCorner.addEventListener("pointerdown", (event) => event.stopPropagation());
        hideCorner.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideToken(token);
        });
        chip.appendChild(hideCorner);
      }
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        if (chipClickSuppressed) return;
        activateToken(token);
        englishTokenView.focus({ preventScroll: true });
      });
      chip.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (chipClickSuppressed) return;
        window.getSelection()?.removeAllRanges();
        activateToken(token);
        englishTokenView.focus({ preventScroll: true });
        openWeightEditor(token);
      });
      if (state.pinned === token.id && ["tags", "mixed"].includes(state.modeInfo.mode) && token.segmentKind !== "natural") {
        const remove = element("span", "bpi-mirror-delete", "×");
        remove.title = `删除 ${token.term}`;
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          deleteTokenOccurrence(token);
        });
        chip.appendChild(remove);
      }
      englishTokenView.appendChild(chip);
      const next = state.tokens[index + 1];
      if (next) {
        const sourceGap = text.slice(token.end, next.start);
        englishTokenView.appendChild(element("span", "bpi-mirror-separator", /[\r\n]/.test(sourceGap) ? "\n" : ", "));
      }
    }
    requestAnimationFrame(() => autoFitGreenArea(englishTokenView, 92));
  };

  const renderChineseMirror = (text) => {
    if (!state.chineseEditing) {
      mirrorHint.textContent = state.categoryView
        ? "分类表格视图｜点击标签联动；分类名称不会写入提示词"
        : "点击联动｜选中后按 Delete 删除";
    }
    chineseMirror.replaceChildren();
    if (!state.tokens.length) {
      chineseMirror.appendChild(element("span", "bpi-mirror-empty", "英文提示词的逐标签中文组合会显示在这里。"));
      autoFitActiveGreenArea();
      return;
    }
    const tokenChip = (token) => {
      const classes = ["bpi-mirror-token", `bpi-${token.status}`];
      if (state.pinned === token.id) classes.push("bpi-linked");
      const label = token.status === "unknown"
        ? `⚠ 未收录：${token.term}`
        : `${token.chinese}${token.weight === null ? "" : `（权重 ${token.weight}）`}`;
      const chip = element("span", classes.join(" "), label);
      chip.dataset.tokenId = String(token.id);
      chip.title = token.segmentKind === "natural"
        ? `${token.raw} ↔ ${token.chinese}｜自然语言仅支持整段编辑或翻译`
        : token.status === "unknown"
          ? `未知英文标签：${token.term}｜单击定位；双击修改权重`
          : `${token.raw} ↔ ${token.chinese}｜单击定位；双击修改权重；选中后按 Delete 删除`;
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        if (token.status === "unknown") state.tableFilter = "unknown";
        activateToken(token);
        chineseMirror.focus({ preventScroll: true });
        if (token.status === "unknown") {
          requestAnimationFrame(() => detailsBody.querySelector(`.bpi-row[data-token-id="${token.id}"]`)?.scrollIntoView?.({ block: "nearest" }));
        }
      });
      chip.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
        activateToken(token);
        chineseMirror.focus({ preventScroll: true });
        openWeightEditor(token);
      });
      if (state.pinned === token.id && ["tags", "mixed"].includes(state.modeInfo.mode) && token.segmentKind !== "natural") {
        const remove = element("span", "bpi-mirror-delete", "×");
        remove.title = `删除 ${token.term}`;
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          deleteTokenOccurrence(token);
        });
        chip.appendChild(remove);
      }
      return chip;
    };
    if (state.categoryView) {
      const categoryTable = element("div", "bpi-category-table");
      for (const group of groupAnimaTokensForDisplay(state.tokens)) {
        const row = element("div", "bpi-category-row");
        const name = element("div", "bpi-category-name", group.label);
        const content = element("div", "bpi-category-content");
        for (const [index, token] of group.tokens.entries()) {
          content.appendChild(tokenChip(token));
          if (index < group.tokens.length - 1) content.appendChild(element("span", "bpi-mirror-separator", "，"));
        }
        row.append(name, content);
        categoryTable.appendChild(row);
      }
      chineseMirror.appendChild(categoryTable);
    } else {
      for (const [index, token] of state.tokens.entries()) {
        chineseMirror.appendChild(tokenChip(token));
        const next = state.tokens[index + 1];
        if (next) {
          const sourceGap = text.slice(token.end, next.start);
          chineseMirror.appendChild(element("span", "bpi-mirror-separator", /[\r\n]/.test(sourceGap) ? "\n" : "，"));
        }
      }
    }
    autoFitActiveGreenArea();
  };

  // Drag handle for the details table rows: grab the ⠿ grip to drag a token
  // to a new position.  A drop indicator line shows the insertion point and
  // the table auto-scrolls near its edges while dragging.
  const buildRowDragHandle = (row, token) => {
    const handle = element("span", "bpi-drag-handle", "⠿");
    handle.title = "拖动调整标签顺序；也可选中后按 Alt+↑/↓ 微调；Ctrl+Z 可撤销";
    handle.addEventListener("click", (event) => event.stopPropagation());
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let targetIndex = null;
      let indicator = null;
      const orderedRows = () => [...table.querySelectorAll(".bpi-row[data-token-id]")];
      const finish = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        row.classList.remove("bpi-dragging");
        if (indicator) {
          indicator.remove();
          indicator = null;
        }
        if (active && targetIndex !== null && row.isConnected) {
          moveTokenTo(token, targetIndex);
        }
      };
      const onMove = (moveEvent) => {
        if (!row.isConnected) {
          finish();
          return;
        }
        if (!active) {
          if (Math.abs(moveEvent.clientX - startX) < 3 && Math.abs(moveEvent.clientY - startY) < 3) return;
          active = true;
          row.classList.add("bpi-dragging");
          indicator = element("div", "bpi-drop-indicator");
          table.appendChild(indicator);
        }
        moveEvent.preventDefault();
        const tableRect = table.getBoundingClientRect();
        if (moveEvent.clientY < tableRect.top + 28) table.scrollTop -= 9;
        else if (moveEvent.clientY > tableRect.bottom - 28) table.scrollTop += 9;
        const rows = orderedRows();
        let anchorRow = null;
        for (const candidate of rows) {
          const rect = candidate.getBoundingClientRect();
          if (moveEvent.clientY < rect.top + rect.height / 2) {
            anchorRow = candidate;
            break;
          }
        }
        if (anchorRow) {
          const tokenId = Number(anchorRow.dataset.tokenId);
          const index = state.tokens.findIndex((item) => item.id === tokenId);
          targetIndex = index >= 0 ? index : state.tokens.length;
        } else {
          targetIndex = state.tokens.length;
        }
        let y;
        if (anchorRow) {
          y = anchorRow.getBoundingClientRect().top - tableRect.top + table.scrollTop;
        } else {
          const lastRow = rows[rows.length - 1];
          y = (lastRow ? lastRow.getBoundingClientRect().bottom - tableRect.top : 0) + table.scrollTop;
        }
        indicator.style.top = `${Math.max(0, y - 1)}px`;
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", finish);
      document.addEventListener("pointercancel", finish);
    });
    return handle;
  };

  // Eye icon used by both hide affordances (table row button and chip corner).
  const buildEyeIcon = () => {
    const icon = element("span", "bpi-eye-icon");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
      '<path d="M12 5C6.5 5 2.5 10.5 2 12c.5 1.5 4.5 7 10 7s9.5-5.5 10-7c-.5-1.5-4.5-7-10-7z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
    return icon;
  };

  // Details-table row button: hide this tag from the actual output while
  // keeping it in the hidden list so it can be restored with one click.
  const buildRowHideButton = (token) => {
    const hide = element("span", "bpi-hide-btn");
    hide.appendChild(buildEyeIcon());
    hide.title = `隐藏“${token.raw}”：从实际输出中移除，但留在此列表，可随时恢复到原位置`;
    hide.addEventListener("click", (event) => {
      event.stopPropagation();
      hideToken(token);
    });
    return hide;
  };

  // The "hidden" bar: every hidden tag keeps a greyed chip here so it never
  // disappears for good — clicking restores it next to its old neighbour.
  const renderHiddenBar = (container) => {
    if (!container) return;
    const hidden = getHiddenTags();
    container.replaceChildren();
    if (!hidden.length) {
      container.classList.add("bpi-hidden");
      return;
    }
    container.classList.remove("bpi-hidden");
    const label = element("span", "bpi-hidden-label", `已隐藏 (${hidden.length})`);
    label.title = "这些标签不会进入实际输出文本；点击标签恢复到原位置";
    container.appendChild(label);
    for (const [index, item] of hidden.entries()) {
      const chip = element("span", "bpi-hidden-chip");
      chip.title = `点击恢复“${item.raw}”到原位置`;
      chip.appendChild(element("span", "bpi-hidden-en", item.raw));
      if (item.chinese) chip.appendChild(element("span", "bpi-hidden-zh", item.chinese));
      chip.appendChild(element("span", "bpi-hidden-restore", "↩"));
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        restoreHiddenTag(index);
      });
      container.appendChild(chip);
    }
    const restoreAll = button("全部恢复", () => restoreAllHiddenTags(), "bpi-mini bpi-hidden-all");
    restoreAll.title = `恢复全部 ${hidden.length} 个隐藏标签到各自原位置`;
    container.appendChild(restoreAll);
  };

  const render = () => {
    const text = String(textWidget.value ?? "");
    state.lastText = text;
    state.modeInfo = detectInputMode(text, state.modePreference);
    state.tokens = parsePrompt(text, state.index, state.machine, { mode: state.modePreference }).map((token) => {
      const override = state.localOverrides.get(token.key);
      if (!override) return token;
      return {
        ...token,
        chinese: override.text,
        source: override.source,
        status: "session",
        confidence: "medium",
        confidenceLabel: "中可信·仅本次",
      };
    });
    queueLargeLookup(state.tokens);
    state.issues = analyzePromptSyntax(text, state.tokens, state.modeInfo);
    if (state.pinned !== null && !state.tokens.some((token) => token.id === state.pinned)) state.pinned = null;
    renderEnglishTokenView(text);
    renderChineseMirror(text);
    if (hasNodeSize()) requestNodeResize();
    const personalKeys = new Set(state.data.user.map((tag) => normalizeKey(tag.english)));
    const visibleTokens = state.tokens.filter((token) => {
      if (state.tableFilter === "unknown") return token.status === "unknown";
      if (state.tableFilter === "machine") return token.status === "machine";
      if (state.tableFilter === "personal") return personalKeys.has(token.key);
      if (state.tableFilter === "favorites") return isFavorite(token.term);
      return true;
    });
    const errorsByKey = new Map();
    for (const item of state.issues) {
      for (const key of item.tokenKeys ?? []) {
        const current = errorsByKey.get(key);
        if (current !== "error") errorsByKey.set(key, item.severity);
      }
    }
    issuesPanel.replaceChildren();
    for (const item of state.issues.slice(0, 12)) {
      const issueRow = element("div", "bpi-issue", item.message);
      issueRow.dataset.severity = item.severity;
      issuesPanel.appendChild(issueRow);
    }
    issuesPanel.classList.toggle("bpi-visible", state.issues.length > 0);
    while (table.children.length > 1) table.lastChild.remove();
    if (!state.tokens.length) {
      table.appendChild(element("div", "bpi-empty", "在上方英文文本框输入提示词，这里会显示逐标签中英对应关系。"));
    } else if (!visibleTokens.length) {
      table.appendChild(element("div", "bpi-empty", "当前筛选条件下没有匹配项目。"));
    } else {
      for (const token of visibleTokens) {
        const row = element("div", `bpi-row bpi-${token.status}`);
        const rowSeverity = errorsByKey.get(token.key);
        if (rowSeverity === "error") row.classList.add("bpi-has-error");
        else if (rowSeverity === "warning") row.classList.add("bpi-has-warning");
        row.dataset.tokenId = String(token.id);
        if (state.pinned === token.id) row.classList.add("bpi-pinned");
        const englishCell = element("div", "bpi-cell bpi-en");
        if (state.tableFilter === "all" && canReorderTokens()) {
          englishCell.appendChild(buildRowDragHandle(row, token));
        }
        if (canHideTokens()) {
          englishCell.appendChild(buildRowHideButton(token));
        }
        const chineseCell = element("div", "bpi-cell bpi-zh");
        const englishText = element("span", "", token.raw);
        englishText.title = `查询词：${token.term}${token.weight === null ? "" : `｜权重：${token.weight}`}`;
        englishText.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          setEnglishEditing(true);
          requestAnimationFrame(() => {
            englishEditor.focus({ preventScroll: true });
            englishEditor.setSelectionRange(token.start, token.end, "forward");
          });
          setStatus(`已定位：${token.term}`, "ok");
        });
        englishCell.appendChild(englishText);
        const isEditing = state.editing?.id === token.id && state.editing?.key === token.key;
        if (isEditing) {
          const editor = element("input", "bpi-inline-editor");
          editor.value = state.editing.value;
          editor.placeholder = "输入中文解释";
          editor.addEventListener("input", () => { state.editing.value = editor.value; });
          editor.addEventListener("click", (event) => event.stopPropagation());
          editor.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyInlineEdit(token, editor.value, false);
            } else if (event.key === "Escape") {
              state.editing = null;
              render();
            }
          });
          chineseCell.appendChild(editor);
          const editActions = element("span", "bpi-inline-actions");
          editActions.append(
            button("仅本次", () => applyInlineEdit(token, editor.value, false), "bpi-mini"),
            button("保存词库", () => applyInlineEdit(token, editor.value, true), "bpi-mini"),
            button("取消", () => { state.editing = null; render(); }, "bpi-mini"),
          );
          chineseCell.appendChild(editActions);
          row.append(englishCell, chineseCell);
          table.appendChild(row);
          setTimeout(() => { editor.focus(); editor.select(); }, 0);
          continue;
        }
        const chineseText = element("span", "", token.chinese);
        chineseText.title = "双击修改中文解释";
        chineseText.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          if (token.syntax === "tag" && token.status !== "special") beginInlineEdit(token);
        });
        chineseCell.appendChild(chineseText);

        const badgeLabels = {
          unknown: "未收录",
          machine: "机器译",
          unverified: "待确认",
          special: "语法",
        };
        if (badgeLabels[token.status]) chineseCell.appendChild(element("span", "bpi-badge", badgeLabels[token.status]));
        if (token.weight !== null) chineseCell.appendChild(element("span", "bpi-badge", `权重 ${token.weight}`));
        const origin = token.entry?.pack_name ?? sourceLabel(token.source, token.status);
        const sourceBadge = element("span", "bpi-badge bpi-source", origin);
        sourceBadge.title = token.status === "machine"
          ? "由双语检查器当前配置的助手生成，尚未写入个人词库"
          : `解释来源：${origin}`;
        chineseCell.appendChild(sourceBadge);
        const confidenceBadge = element("span", `bpi-badge bpi-confidence-${token.confidence}`, token.confidenceLabel);
        confidenceBadge.title = token.status === "machine"
          ? "机器翻译尚未经过人工确认"
          : token.status === "unknown" ? "当前词库无法判断" : "根据词库来源和确认状态估算";
        chineseCell.appendChild(confidenceBadge);

        const actions = element("span", "bpi-inline-actions");
        if (token.status === "unknown" && !/[\u3400-\u9fff]/.test(token.term)) {
          const searchButton = element("button", "bpi-mini", "搜索候选");
          searchButton.addEventListener("click", (event) => {
            event.stopPropagation();
            openManagerPanel("tag-manager", node.id);
            search.value = token.term;
            renderSearch();
            search.focus({ preventScroll: true });
            results.scrollIntoView?.({ block: "nearest" });
          });
          const addButton = element("button", "bpi-mini", "手动添加");
          addButton.addEventListener("click", (event) => {
            event.stopPropagation();
            openTagDialog({
              english: token.term,
              chinese: "",
              category: "待整理",
              models: ["general", "anima"],
              source: "user",
              verified: true,
            }, refreshDictionary);
          });
          const translating = state.translating.has(token.key);
          const translateButton = element("button", "bpi-mini", translating ? "翻译中" : "翻译");
          translateButton.disabled = translating;
          translateButton.addEventListener("click", (event) => {
            event.stopPropagation();
            translateToken(token);
          });
          actions.append(searchButton, addButton, translateButton);
        } else if (token.status === "unknown" && /[\u3400-\u9fff]/.test(token.term)) {
          const hint = element("span", "bpi-badge", "使用上方“编辑文本”处理");
          hint.title = "点击“编辑文本”，再使用检查器自己的“仅翻译”或“翻译并优化”";
          actions.appendChild(hint);
        } else if (token.status === "machine") {
          const saveButton = element("button", "bpi-mini", "确认并保存");
          saveButton.addEventListener("click", (event) => {
            event.stopPropagation();
            saveMachineTranslation(token);
          });
          const retryButton = element("button", "bpi-mini", "重新翻译");
          retryButton.addEventListener("click", async (event) => {
            event.stopPropagation();
            deleteMachineTranslation(token.key);
            render();
            await translateToken({ ...token, status: "unknown" });
          });
          actions.append(saveButton, retryButton);
        }
        if (token.syntax === "tag" && token.status !== "special") {
          const editButton = element("button", "bpi-mini", "修改中文");
          editButton.addEventListener("click", (event) => {
            event.stopPropagation();
            beginInlineEdit(token);
          });
          actions.appendChild(editButton);
        }
        if (token.key) {
          const favoriteButton = element("button", `bpi-mini bpi-star${isFavorite(token.term) ? " bpi-starred" : ""}`, isFavorite(token.term) ? "★" : "☆");
          favoriteButton.title = isFavorite(token.term) ? "取消收藏" : "收藏";
          favoriteButton.addEventListener("click", (event) => {
            event.stopPropagation();
            changeFavorite(token.term);
            render();
            renderSearch();
          });
          const copyButton = element("button", "bpi-mini", "复制");
          copyButton.title = "复制英文与中文对照";
          copyButton.addEventListener("click", (event) => {
            event.stopPropagation();
            copyText(`${token.raw}\t${token.chinese}`, `已复制“${token.term}”的中英对照`);
          });
          actions.append(favoriteButton, copyButton);
        }
        if (personalKeys.has(token.key)) {
          const hasBuiltin = Boolean(builtinTagFor(token.term));
          const restoreButton = element("button", "bpi-mini", hasBuiltin ? "恢复内置" : "删除个人");
          restoreButton.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (!window.confirm(`${hasBuiltin ? "删除个人覆盖并恢复内置解释" : "删除个人标签"}“${token.term}”？`)) return;
            try {
              await deletePersonalTag(token.term);
              await refreshDictionary();
              setStatus(hasBuiltin ? "已恢复内置解释" : "已删除个人标签", "ok");
            } catch (error) { setStatus(error.message, "error"); }
          });
          actions.appendChild(restoreButton);
        }
        if (actions.children.length) chineseCell.appendChild(actions);
        row.append(englishCell, chineseCell);
        row.addEventListener("click", () => {
          activateToken(token);
        });
        table.appendChild(row);
      }
    }
    const known = state.tokens.filter((token) => ["verified", "unverified", "special", "session"].includes(token.status)).length;
    const unknown = state.tokens.filter((token) => token.status === "unknown").length;
    const machine = state.tokens.filter((token) => token.status === "machine").length;
    const warningCount = state.issues.filter((item) => item.severity !== "info").length;
    counts.textContent = `项目 ${state.tokens.length}｜已识别 ${known}｜未知 ${unknown}${machine ? `｜待确认 ${machine}` : ""}${warningCount ? `｜问题 ${warningCount}` : ""}`;
    const modeLabels = { tags: "标签", mixed: "标签 + 自然语言", natural: "自然语言", instruction: "附带指令" };
    modeInfo.textContent = `模式：${modeLabels[state.modeInfo.mode]}（${state.modeInfo.reason}）`;
    for (const [filter, control] of state.filterButtons) control.classList.toggle("bpi-filter-active", filter === state.tableFilter);
    renderHiddenBar(detailsHiddenBar);
    renderHiddenBar(englishHiddenBar);
  };

  const scheduleRender = (immediate = false) => {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(render, immediate ? 0 : 180);
  };

  const requestLargeSearchPage = (rawQuery, append = false) => {
    if (!largeDictionaryReady() || state.largeSearchLoading) return;
    clearTimeout(state.largeSearchTimer);
    state.largeSearchLoading = true;
    const generation = state.largeSearchGeneration;
    const offset = append ? state.largeSearchOffset : 0;
    state.largeSearchTimer = setTimeout(async () => {
      try {
        const page = await searchLargeDictionary(rawQuery, 40, offset);
        if (generation !== state.largeSearchGeneration || search.value.trim() !== rawQuery) return;
        const byKey = new Map((append ? state.largeSearchMatches : []).map((tag) => [normalizeKey(tag.english), tag]));
        for (const tag of page.items ?? []) {
          byKey.set(normalizeKey(tag.english), tag);
          state.largeCache.set(normalizeKey(tag.english), tag);
        }
        state.largeSearchMatches = [...byKey.values()];
        state.largeSearchOffset = Number(page.next_offset ?? (offset + (page.items?.length ?? 0)));
        state.largeSearchHasMore = Boolean(page.has_more);
        state.largeSearchExpandedTerms = page.expanded_terms ?? [];
        rebuildDictionaryIndex();
      } catch (error) {
        if (generation === state.largeSearchGeneration) setStatus(error.message, "error");
        state.largeSearchHasMore = false;
      } finally {
        if (generation === state.largeSearchGeneration) {
          state.largeSearchLoading = false;
          renderSearch();
        }
      }
    }, append ? 0 : 260);
  };

  const renderSearch = () => {
    const rawQuery = search.value.trim();
    const previousScrollTop = preservedSearchScroll(
      state.lastRenderedSearchQuery,
      rawQuery,
      results.scrollTop,
    );
    state.lastRenderedSearchQuery = rawQuery;
    results.replaceChildren();
    const restoreScroll = () => {
      if (state.lastRenderedSearchQuery !== rawQuery || previousScrollTop <= 0) return;
      results.scrollTop = previousScrollTop;
      requestAnimationFrame(() => {
        if (state.lastRenderedSearchQuery === rawQuery) results.scrollTop = previousScrollTop;
      });
    };
    if (!rawQuery) {
      clearTimeout(state.largeSearchTimer);
      state.largeSearchGeneration += 1;
      state.largeSearchQuery = "";
      state.largeSearchMatches = [];
      state.largeSearchLoading = false;
      state.largeSearchOffset = 0;
      state.largeSearchHasMore = false;
      state.largeSearchExpandedTerms = [];
      state.searchVisibleLimit = 40;
    } else if (rawQuery !== state.largeSearchQuery) {
      clearTimeout(state.largeSearchTimer);
      state.largeSearchLoading = false;
      state.largeSearchQuery = rawQuery;
      state.largeSearchMatches = [];
      state.largeSearchOffset = 0;
      state.largeSearchHasMore = largeDictionaryReady();
      state.largeSearchExpandedTerms = [];
      state.searchVisibleLimit = 40;
      state.largeSearchGeneration += 1;
      if (largeDictionaryReady()) requestLargeSearchPage(rawQuery, false);
    }
    const localKeys = new Set((state.data.tags ?? []).map((tag) => normalizeKey(tag.english)));
    const searchable = [
      ...(state.data.tags ?? []),
      ...state.largeSearchMatches.filter((tag) => !localKeys.has(normalizeKey(tag.english))),
    ];
    const ranked = rawQuery
      ? rankDictionaryMatches(
          searchable,
          rawQuery,
          state.preferences,
          Math.max(1, searchable.length),
          state.data.search_concepts,
        )
      : suggestedTags(state.data.tags, state.preferences, 30).map((tag) => ({ tag, reason: "收藏或最近使用" }));
    const visibleMatches = ranked.slice(0, state.searchVisibleLimit);
    const matches = visibleMatches.map((item) => item.tag);
    state.searchMatches = matches;
    if (!matches.length) {
      state.searchIndex = -1;
      if (rawQuery) {
        results.appendChild(element("div", "bpi-empty", state.largeSearchLoading ? "正在查询词库…" : "当前启用的词库中没有找到匹配标签，可手动添加到个人词库。"));
        results.classList.add("bpi-visible");
      } else {
        results.classList.remove("bpi-visible");
      }
      restoreScroll();
      return;
    }
    if (state.searchIndex < 0 || state.searchIndex >= matches.length) state.searchIndex = 0;
    for (const [index, match] of visibleMatches.entries()) {
      const tag = match.tag;
      const result = element("div", "bpi-result");
      if (index === state.searchIndex) result.classList.add("bpi-result-selected");
      const meta = element("span", "bpi-category");
      const format = tag.pack_id === "danbooru_large"
        ? (/[_()]/.test(tag.english) ? "Danbooru 原始格式" : "大型词库")
        : "";
      const usage = Number(tag.post_count) > 0 ? ` · 使用量 ${Number(tag.post_count).toLocaleString()}` : "";
      meta.appendChild(element("span", "", `${tag.category} · ${tag.pack_name ?? sourceLabel(tag.source)}${format ? ` · ${format}` : ""}${usage}`));
      meta.appendChild(element("span", "bpi-search-reason", match.reason));
      const star = element("span", `bpi-result-star${isFavorite(tag.english) ? " bpi-starred" : ""}`, isFavorite(tag.english) ? "★" : "☆");
      star.title = isFavorite(tag.english) ? "取消收藏" : "收藏标签";
      star.addEventListener("click", (event) => {
        event.stopPropagation();
        changeFavorite(tag.english);
        renderSearch();
        render();
      });
      meta.appendChild(star);
      result.append(element("span", "bpi-result-en", tag.english), element("span", "bpi-result-zh", tag.chinese), meta);
      result.title = `点击插入英文标签${tag.aliases?.length ? `｜别名：${tag.aliases.join("、")}` : ""}`;
      result.addEventListener("mouseenter", () => { state.searchIndex = index; });
      result.addEventListener("click", (event) => {
        event.stopPropagation();
        insertEnglish(tag.english);
      });
      results.appendChild(result);
    }
    const moreKnown = ranked.length > state.searchVisibleLimit;
    if (rawQuery && (moreKnown || state.largeSearchHasMore)) {
      const moreButton = button(state.largeSearchLoading ? "正在搜索更多…" : "搜索更多", () => {
        if (state.largeSearchLoading) return;
        state.searchVisibleLimit += 40;
        if (state.largeSearchHasMore) requestLargeSearchPage(rawQuery, true);
        renderSearch();
      }, "bpi-search-more");
      moreButton.disabled = state.largeSearchLoading;
      results.appendChild(moreButton);
      results.appendChild(element("div", "bpi-searching", `当前显示 ${matches.length} 项，可能还有更多`));
    } else if (rawQuery && !state.largeSearchLoading) {
      results.appendChild(element("div", "bpi-searching", `已显示全部 ${matches.length} 项，没有更多结果`));
    }
    if (state.largeSearchLoading) results.appendChild(element("div", "bpi-searching", "正在补充查询大型词库…"));
    results.classList.add("bpi-visible");
    restoreScroll();
  };

  const translateAllUnknown = async (control) => {
    const seen = new Set();
    const unknown = state.tokens.filter((token) => {
      if (token.status !== "unknown" || /[\u3400-\u9fff]/.test(token.term) || seen.has(token.key)) return false;
      seen.add(token.key);
      return true;
    }).slice(0, 30);
    if (!unknown.length) {
      setStatus("当前没有未知标签", "ok");
      return;
    }
    control.disabled = true;
    let completed = 0;
    try {
      for (let index = 0; index < unknown.length; index += 1) {
        setStatus(`翻译未知标签 ${index + 1}/${unknown.length}：${unknown[index].term}`, "busy");
        if (await translateToken(unknown[index])) completed += 1;
      }
      const rejected = unknown.length - completed;
      setStatus(`翻译完成 ${completed} 项${rejected ? `，拒绝异常结果 ${rejected} 项` : ""}`, rejected ? "error" : "ok");
    } finally {
      control.disabled = false;
    }
  };

  const translateAllButton = button("翻译全部未知", () => translateAllUnknown(translateAllButton));
  for (const [filter, label] of [["all", "全部"], ["unknown", "未知"], ["machine", "机器译"], ["personal", "个人词库"], ["favorites", "收藏"]]) {
    const control = button(label, () => {
      state.tableFilter = filter;
      render();
    });
    state.filterButtons.set(filter, control);
    filtersBar.appendChild(control);
  }
  leftTools.append(
    button("添加标签", () => openTagDialog({}, refreshDictionary), "bpi-primary"),
    translateAllButton,
    button("清除临时机器译", () => {
      clearMachineTranslations();
      state.translating.clear();
      setStatus("已清除尚未保存的机器译文", "ok");
      render();
    }),
  );
  rightTools.append(
    button("管理面板", () => openManagerPanel("tags"), "bpi-primary"),
    button("刷新词库", refreshDictionary),
  );
  toolbar.append(leftTools, rightTools);
  searchLine.append(modeSelect, searchLabel, search);
  summary.append(counts, modeInfo, status);
  detailsBody.append(toolbar, searchLine, results, summary, filtersBar, issuesPanel, table, detailsHiddenBar);
  panel.append(englishSection, mirrorSection, aboutFooter);
  panel.addEventListener("mousedown", (event) => event.stopPropagation());
  panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  const handleTokenViewKeydown = (event) => {
    handleHistoryShortcut(event);
    if (event.defaultPrevented) return;
    if (handleTokenReorderShortcut(event)) return;
    if (!["Backspace", "Delete"].includes(event.key)) return;
    const token = state.tokens.find((item) => item.id === state.pinned);
    if (!token) return;
    event.preventDefault();
    event.stopPropagation();
    deleteTokenOccurrence(token);
  };
  englishTokenView.addEventListener("keydown", handleTokenViewKeydown);
  chineseMirror.addEventListener("keydown", (event) => {
    handleHistoryShortcut(event);
    if (event.defaultPrevented) return;
    if (handleTokenReorderShortcut(event)) return;
    if (!["Backspace", "Delete"].includes(event.key)) return;
    const token = state.tokens.find((item) => item.id === state.pinned);
    if (!token) return;
    event.preventDefault();
    event.stopPropagation();
    deleteTokenOccurrence(token);
  });
  chineseMirror.title = "点击标签可与上方英文和下方明细联动";
  englishTokenView.title = "点击英文标签可与中文和下方明细联动";
  englishEditor.title = "输入期间保持文本编辑；失去焦点或点击完成编辑后切换为标签视图";
  chineseEditor.title = "输入中文、英文或中英混合内容；可拖动右下角改变高度并自动保存";
  englishTokenView.addEventListener("click", (event) => {
    if (event.target !== englishTokenView) return;
    state.pinned = null;
    render();
  });
  chineseMirror.addEventListener("click", (event) => {
    if (event.target !== chineseMirror) return;
    state.pinned = null;
    render();
  });
  const bindMirrorAction = (control, action) => control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  editChineseButton.title = "在标签联动视图与中英文文本编辑框之间切换";
  expandChineseButton.title = "在更大的弹窗中编辑中文或中英混合内容";
  translateChineseButton.title = "自动检测语言并忠实翻译；不优化、不自动同步";
  translateOptimizeButton.title = "自动翻译后优化成符合 Anima 格式的英文提示词";
  optimizeChineseButton.title = "只优化已有英文，不承担翻译";
  sortPromptButton.title = "按 Anima 推荐分类稳定排序，每个非空分类单独一行；自然语言和 BREAK/AND 保持完整";
  assistantSettingsButton.title = "在侧边栏管理面板中配置纯词库、百度翻译、Ollama 或 OpenAI 兼容 API 与自定义规则";
  bindMirrorAction(editChineseButton, () => setChineseEditing(!state.chineseEditing));
  bindMirrorAction(expandChineseButton, openExpandedChineseEditor);
  bindMirrorAction(translateChineseButton, () => runTextAssistant("translate"));
  bindMirrorAction(translateOptimizeButton, () => runTextAssistant("translate_optimize"));
  bindMirrorAction(optimizeChineseButton, () => runTextAssistant("optimize"));
  bindMirrorAction(syncTextButton, syncEditedText);
  bindMirrorAction(sortPromptButton, sortByAnimaOrder);
  bindMirrorAction(assistantSettingsButton, () => openManagerPanel("assistant"));
  bindMirrorAction(tagManagerButton, () => openManagerPanel("tag-manager", node.id));
  tagManagerButton.title = "在侧边栏管理面板中打开本节点的标签翻译与词库搜索";
  editEnglishButton.title = "在英文文本编辑框和可联动标签视图之间切换";
  clearEnglishButton.title = "需要再次确认才会清空英文实际输出；清空后可点同一按钮撤销，也可按 Ctrl+Z";
  editEnglishButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  editEnglishButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setEnglishEditing(!state.englishEditing);
  });
  clearEnglishButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  clearEnglishButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearEnglishText();
  });
  englishEditor.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    startManualResize("english", englishEditor, event);
  });
  englishEditor.addEventListener("input", () => {
    state.englishEditorDirty = true;
    updateText(englishEditor.value);
  });
  englishEditor.addEventListener("keydown", (event) => {
    handleHistoryShortcut(event);
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      setEnglishEditing(false);
    }
  });
  englishEditor.addEventListener("blur", () => {
    setTimeout(() => {
      if (state.englishEditing && document.activeElement !== englishEditor) setEnglishEditing(false);
    }, 0);
  });
  chineseEditor.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    startManualResize("chinese", chineseEditor, event);
  });
  chineseEditor.addEventListener("input", () => {
    state.stagedText = {
      text: chineseEditor.value,
      label: "手动编辑",
      requireAnima: state.stagedText?.requireAnima === true,
    };
    mirrorTitle.textContent = "文本编辑与处理（支持中英混合）";
    mirrorHint.textContent = containsChinese(chineseEditor.value)
      ? "检测到中文或混合内容，可使用“仅翻译”或“翻译并优化”"
      : "英文内容可直接同步，或继续优化为 Anima";
    autoFitGreenArea(chineseEditor, 110);
    updateStageControls();
  });
  chineseEditor.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runTextAssistant("translate");
    }
  });
  search.addEventListener("input", renderSearch);
  search.addEventListener("focus", renderSearch);
  modeSelect.addEventListener("change", () => {
    state.modePreference = modeSelect.value;
    state.editing = null;
    render();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && state.searchMatches.length) {
      event.preventDefault();
      state.searchIndex = (state.searchIndex + 1) % state.searchMatches.length;
      renderSearch();
      results.children[state.searchIndex]?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (event.key === "ArrowUp" && state.searchMatches.length) {
      event.preventDefault();
      state.searchIndex = (state.searchIndex - 1 + state.searchMatches.length) % state.searchMatches.length;
      renderSearch();
      results.children[state.searchIndex]?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && state.searchMatches[state.searchIndex]) {
      event.preventDefault();
      insertEnglish(state.searchMatches[state.searchIndex].english, event.ctrlKey);
      return;
    }
    if (event.key === "Escape") {
      search.value = "";
      state.searchMatches = [];
      state.searchIndex = -1;
      renderSearch();
    }
  });

  const originalCallback = textWidget.callback;
  textWidget.callback = function (value) {
    const result = originalCallback?.apply(this, arguments);
    const nextText = String(value ?? "");
    if (state.englishClearState === "confirm" || (state.englishClearState === "cleared" && nextText)) {
      resetEnglishClearState();
    }
    if (state.englishEditing) {
      if (document.activeElement !== englishEditor && !state.englishEditingExplicit && nextText.trim()) {
        state.englishEditing = false;
        state.englishEditorDirty = false;
        englishEditor.value = nextText;
      }
    } else if (!nextText.trim()) {
      state.englishEditing = true;
      state.englishEditingExplicit = false;
      state.englishEditorDirty = false;
      englishEditor.value = nextText;
    }
    if (!state.chineseEditing) {
      state.editorInitialized = false;
      state.stagedText = null;
      updateStageControls();
    }
    scheduleRender();
    return result;
  };

  const syncFromPeer = async (kind, source) => {
    if (source === state.syncSource) return;
    if (kind === "preferences") {
      const sharedPreferences = loadPreferences();
      state.preferences = {
        ...state.preferences,
        favorites: sharedPreferences.favorites,
        recent: sharedPreferences.recent,
      };
      render();
      renderSearch();
    } else if (kind === "machine") {
      render();
    } else if (kind === "dictionary") {
      await refreshDictionary(false);
    }
  };
  const unsubscribePanelSync = panelSyncHub.subscribe(syncFromPeer);

  updateStageControls();
  refreshDictionary(false);
  setTimeout(() => {
    bindTextareaEvents();
    render();
  }, 0);
  return {
    panel,
    detailsBody,
    getMinHeight() {
      return state.collapsedWidgetHeight;
    },
    getMaxHeight() {
      return state.collapsedWidgetHeight;
    },
    refreshAfterConfigure() {
      // Workflow files keep the hidden-tag list in node.properties; make sure
      // the bar is drawn even when the text itself did not change.
      getHiddenTags();
      scheduleRender(true);
    },
    syncInitialLayout() {
      requestNodeResize();
    },
    checkForTextChange() {
      const current = String(textWidget.value ?? "");
      if (current !== state.lastText) scheduleRender();
      bindTextareaEvents();
    },
    destroy() {
      unsubscribePanelSync();
      detailsBody.remove();
      clearTimeout(state.renderTimer);
      clearTimeout(state.largeLookupTimer);
      clearTimeout(state.largeSearchTimer);
      if (state.resizeFrame !== null) cancelAnimationFrame(state.resizeFrame);
      if (state.boundTextarea && state.textareaListeners) {
        for (const [name, listener] of state.textareaListeners) state.boundTextarea.removeEventListener(name, listener);
        state.boundTextarea.classList.remove("bpi-english-resizable", "bpi-english-linked");
      }
      if (state.windowPointerUp) window.removeEventListener("pointerup", state.windowPointerUp, true);
    },
  };
}

injectBpiStyles();
installBpiWheelGuard();

app.registerExtension({
  name: "ComfyUI.BilingualPromptInspector",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      const textWidget = this.widgets?.find((widget) => widget.name === "text");
      if (!textWidget) return;
      textWidget.label = "英文提示词（实际输出）";

      const inspector = createPanel(this, textWidget);
      this._bilingualPromptInspector = inspector;
      try {
        this.addDOMWidget("bilingual_inspector", "bilingual-inspector", inspector.panel, {
          getMinHeight: () => inspector.getMinHeight(),
          getMaxHeight: () => inspector.getMaxHeight(),
          hideOnZoom: false,
          serialize: false,
        });
      } catch (error) {
        console.error("[BilingualPromptInspector] 无法创建界面", error);
        inspector.destroy();
        return;
      }
      const width = Math.max(this.size?.[0] ?? 0, 590);
      const height = Math.max(this.size?.[1] ?? 0, COLLAPSED_NODE_MIN_HEIGHT);
      this.setSize?.([width, height]);
      requestAnimationFrame(() => inspector.syncInitialLayout());
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      originalConfigure?.apply(this, arguments);
      this._bilingualPromptInspector?.refreshAfterConfigure?.();
    };

    const originalDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      originalDrawForeground?.apply(this, arguments);
      // 右侧属性面板在自身画布上重绘本节点控件时会把 widget.width 固定成面板宽度，
      // 画布上的 DOM 控件随之缩小且不再恢复；清掉该值让画布回退到节点宽度。
      for (const widget of this.widgets ?? []) {
        if (widget.element && widget.width != null) delete widget.width;
      }
      this._bilingualPromptInspector?.checkForTextChange();
    };

    const originalRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._bilingualPromptInspector?.destroy();
      originalRemoved?.apply(this, arguments);
    };
  },
});
