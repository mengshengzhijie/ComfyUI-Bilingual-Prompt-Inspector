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
  openSavePromptDialog,
  openTagDialog,
  postUpstreamAction,
  runInspectorAssistant,
  savePreferences,
  saveTag,
  searchLargeDictionary,
  setPlaceholder,
  setText,
  setTitle,
  t,
  UPSTREAM_ARRIVED_EVENT,
} from "./bpi_shared.js";

const NODE_NAME = "BilingualPromptInspector";
const EXTENSION_VERSION = "v1.2.0";
const PROJECT_URL = "https://github.com/mengshengzhijie/ComfyUI-Bilingual-Prompt-Inspector";
const COLLAPSED_WIDGET_FALLBACK_HEIGHT = 390;
const COLLAPSED_NODE_MIN_HEIGHT = 360;
const IMPORT_POLICIES = [
  { value: "changed", label: "Import: on content change" },
  { value: "always", label: "Import: every run" },
  { value: "once", label: "Import: first run only" },
];

function openProjectAbout() {
  const shade = element("div", "bpi-modal-shade");
  const modal = element("div", "bpi-modal bpi-about-modal");
  modal.append(
    element("h3", "", "About plugin"),
    element("div", "bpi-about-name", `Bilingual Prompt Manager ${EXTENSION_VERSION}`),
    element("div", "bpi-config-note", "A ComfyUI community tool for Anima / Danbooru prompt organization, translation, and management."),
    element("div", "bpi-config-note", "Based on Qiongyi44's bilingual prompt inspector; independently maintained."),
  );
  const actions = element("div", "bpi-modal-actions");
  const projectLink = element("a", "bpi-button bpi-primary", "Visit plugin repo ↗");
  projectLink.href = PROJECT_URL;
  projectLink.target = "_blank";
  projectLink.rel = "noopener noreferrer";
  projectLink.referrerPolicy = "no-referrer";
  projectLink.addEventListener("mousedown", (event) => event.stopPropagation());
  projectLink.addEventListener("click", (event) => event.stopPropagation());
  const close = () => shade.remove();
  actions.append(projectLink, button("Close", close));
  modal.appendChild(actions);
  shade.appendChild(modal);
  document.body.appendChild(shade);
  shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
  modal.addEventListener("mousedown", (event) => event.stopPropagation());
}

function sourceLabel(source, status) {
  if (status === "machine") return "Inspector assistant";
  const labels = {
    starter: "Built-in dictionary",
    builtin: "Built-in dictionary",
    user: "Personal dictionary",
    "prompt-assistant": "Legacy personal dictionary",
    "bpi-assistant": "Inspector assistant",
    session: "Session-only",
    "danbooru-large": "Danbooru Large dictionary",
    syntax: "Syntax-protected",
    unknown: "Unknown source",
  };
  return labels[source] ?? source ?? "Unknown source";
}

function animaPunctuationError(value) {
  const text = String(value ?? "");
  if (/[\u3400-\u9fff]/.test(text)) return "Result still contains Chinese";
  const allowed = new Set(",.():@_-'<>%+/&".split(""));
  const invalid = [...new Set([...text].filter((character) =>
    !/[A-Za-z0-9\s]/.test(character) && !allowed.has(character)
  ))];
  return invalid.length ? `Contains characters not allowed by Anima rules: ${invalid.join(" ")}` : "";
}

function createPanel(node, textWidget) {
  const panel = element("div", "bpi-panel");
  const englishSection = element("section", "bpi-english-section");
  const englishHead = element("div", "bpi-english-head");
  const englishTitle = element("span", "", "English prompt (actual output)");
  const englishHint = element("span", "bpi-english-hint", "Edit directly when empty");
  const editEnglishButton = element("button", "bpi-button bpi-mini", "Done");
  const clearEnglishButton = element("button", "bpi-button bpi-mini bpi-danger", "Clear");
  const favoriteButton = element("button", "bpi-button bpi-mini", "Favorite");
  editEnglishButton.type = "button";
  clearEnglishButton.type = "button";
  favoriteButton.type = "button";
  setTitle(favoriteButton, "Save the current English prompt to favorites in the user directory (a reference image can be attached)");
  englishHead.append(englishTitle, englishHint, editEnglishButton, clearEnglishButton, favoriteButton);
  const englishTokenView = element("div", "bpi-english-token-view bpi-hidden");
  englishTokenView.tabIndex = 0;
  englishTokenView.setAttribute("role", "textbox");
  englishTokenView.setAttribute("aria-label", "English prompt tag view");
  englishTokenView.setAttribute("aria-readonly", "true");
  const englishEditor = element("textarea", "bpi-english-editor");
  setPlaceholder(englishEditor, "Enter the English prompt; after editing, it will be shown as selectable, deletable tags.");
  const englishHiddenBar = element("div", "bpi-hidden-bar bpi-hidden");
  setTitle(englishHiddenBar, "Hidden tags will not enter the actual output");
  // 上游输入条：只在节点接到上游 prompt 连线时出现
  const sourceBar = element("div", "bpi-source-bar bpi-hidden");
  // 注意别叫 sourceLabel：模块顶层已有同名函数（标签来源文案），会把它遮蔽掉
  const sourceCaption = element("span", "bpi-source-label", "Upstream input");
  const sourceToggle = element("input");
  sourceToggle.type = "checkbox";
  setTitle(sourceToggle, "When on, intercepts upstream text and pauses for confirmation; when off, upstream text passes through unchanged");
  const sourceToggleLabel = element("label", "bpi-source-toggle");
  sourceToggleLabel.append(sourceToggle, element("span", "", "Intercept upstream text"));
  const sourceSelect = element("select", "bpi-source-select");
  setTitle(sourceSelect, "Determines when upstream text overwrites the node content");
  for (const item of IMPORT_POLICIES) {
    const option = element("option", "", item.label);
    option.value = item.value;
    sourceSelect.appendChild(option);
  }
  const sourceState = element("span", "bpi-source-state");
  const resumeButton = button("Resume", () => releaseUpstream(String(textWidget.value ?? "")), "bpi-primary");
  const cancelButton = button("Discard", () => cancelUpstreamWait());
  sourceBar.append(sourceCaption, sourceToggleLabel, sourceSelect, sourceState, resumeButton, cancelButton);
  englishSection.append(sourceBar, englishHead, englishTokenView, englishHiddenBar, englishEditor);
  const mirrorSection = element("section", "bpi-mirror-section");
  const mirrorHead = element("div", "bpi-section-head");
  const mirrorTitle = element("span", "", "Chinese sync editor (per-tag composition)");
  const mirrorHint = element("span", "bpi-section-hint", "Click to link | select then press Delete");
  const mirrorActions = element("div", "bpi-mirror-actions");
  const editChineseButton = element("button", "bpi-button bpi-mini", "Edit text");
  const translateChineseButton = element("button", "bpi-button bpi-mini", "Translate");
  const translateOptimizeButton = element("button", "bpi-button bpi-mini bpi-primary", "Translate & optimize");
  const optimizeChineseButton = element("button", "bpi-button bpi-mini", "Optimize to Anima");
  const expandChineseButton = element("button", "bpi-button bpi-mini", "Expand edit");
  const syncTextButton = element("button", "bpi-button bpi-mini", "Sync to English output");
  const sortPromptButton = element("button", "bpi-button bpi-mini", "Sort by Anima order");
  // 已注释：标签管理与助手设置入口已在侧边栏管理面板提供，节点内重复入口移除以简化界面。
  // 如需恢复，取消下面两行注释并在 mirrorActions.append 与 bindMirrorAction 处一并恢复。
  // const assistantSettingsButton = element("button", "bpi-button bpi-mini", "助手设置");
  // const tagManagerButton = element("button", "bpi-button bpi-mini", "标签管理");
  for (const control of [editChineseButton, expandChineseButton, translateChineseButton, translateOptimizeButton, optimizeChineseButton, syncTextButton, sortPromptButton]) control.type = "button";
  mirrorActions.append(editChineseButton, expandChineseButton, translateChineseButton, translateOptimizeButton, optimizeChineseButton, syncTextButton, sortPromptButton
    // tagManagerButton, assistantSettingsButton
  );
  mirrorHead.append(mirrorTitle, mirrorHint, mirrorActions);
  const chineseMirror = element("div", "bpi-chinese-mirror");
  chineseMirror.tabIndex = 0;
  chineseMirror.setAttribute("role", "textbox");
  chineseMirror.setAttribute("aria-label", "Per-tag Chinese sync view");
  chineseMirror.setAttribute("aria-readonly", "true");
  const chineseEditor = element("textarea", "bpi-chinese-editor bpi-hidden");
  setPlaceholder(chineseEditor, "Enter Chinese, English, or mixed text; use “Translate” or “Translate & optimize”, then sync to the English output separately after confirming.");
  mirrorSection.append(mirrorHead, chineseMirror, chineseEditor);
  const detailsBody = element("div", "bpi-details-body");
  const detailsHiddenBar = element("div", "bpi-hidden-bar bpi-hidden");
  const toolbar = element("div", "bpi-toolbar");
  const leftTools = element("div", "bpi-toolbar-group");
  const rightTools = element("div", "bpi-toolbar-group");
  const searchLine = element("div", "bpi-search-line");
  const searchLabel = element("strong", "bpi-search-label", "Dictionary search");
  const search = element("input", "bpi-search");
  search.type = "search";
  setPlaceholder(search, "Enter Chinese, English, alias, or concept; click a result to insert the English tag");
  const results = element("div", "bpi-results");
  const summary = element("div", "bpi-summary");
  const counts = element("span");
  const modeInfo = element("span", "bpi-mode-info");
  const status = element("span", "bpi-status");
  const issuesPanel = element("div", "bpi-issues");
  const filtersBar = element("div", "bpi-filters");
  const table = element("div", "bpi-table");
  const head = element("div", "bpi-head");
  head.append(element("div", "", "English original (actual output)"), element("div", "", "Chinese explanation (read-only)"));
  table.appendChild(head);
  const aboutFooter = element("div", "bpi-about-footer");
  const aboutButton = element("button", "bpi-about-button", "About plugin");
  aboutButton.type = "button";
  setTitle(aboutButton, "View plugin version and project repository");
  aboutButton.addEventListener("mousedown", (event) => event.stopPropagation());
  aboutButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectAbout();
  });
  aboutFooter.append(element("span", "", `Bilingual Prompt Inspector ${EXTENSION_VERSION}`), aboutButton);

  const modeSelect = element("select", "bpi-mode");
  for (const [value, label] of [["auto", "Auto-detect"], ["tags", "Tag mode"], ["natural", "Natural language"]]) {
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
    modeInfo: { mode: "tags", reason: "Empty input", confidence: "high" },
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
    // 上游输入：是否正在等待用户确认，以及上次渲染时的连线状态
    upstreamWaiting: false,
    upstreamConnectedCache: null,
    syncSource: Symbol(`bpi-node-${node.id ?? "unknown"}`),
  };

  const setStatus = (message, kind = "") => {
    setText(status, message);
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

  const copyText = async (value, message = "Copied") => {
    try {
      await navigator.clipboard.writeText(String(value ?? ""));
      setStatus(message, "ok");
    } catch {
      setStatus("Browser denied clipboard write", "error");
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
    setText(clearEnglishButton, clearButtonLabel(state.englishClearState));
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
      setText(editEnglishButton, "Done");
      setText(englishHint, "Text mode while typing; parsed into tags when done");
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
      setText(englishHint, "Content is empty; enter the English prompt directly");
      return;
    }
    state.englishEditing = false;
    state.englishEditingExplicit = false;
    state.englishEditorDirty = false;
    englishEditor.classList.add("bpi-hidden");
    englishTokenView.classList.remove("bpi-hidden");
    setText(editEnglishButton, "Edit text");
    setText(englishHint, "Click tags to link; select then press Delete");
    scheduleRender(true);
    requestAnimationFrame(() => englishTokenView.focus({ preventScroll: true }));
  };

  const containsChinese = (value) => /[\u3400-\u9fff]/.test(String(value ?? ""));
  const updateStageControls = () => {
    const value = chineseEditor.value.trim();
    const syncable = Boolean(value) && !containsChinese(value);
    syncTextButton.disabled = state.assistantBusy || !state.chineseEditing || !syncable;
    setTitle(syncTextButton, syncable
      ? "Write the current English result to the actual output above after preview"
      : "Only the English result in the green editing area can be synced to the actual output");
  };
  const setStagedResult = (text, label, requireAnima = false) => {
    const value = String(text ?? "").trim();
    state.chineseEditing = true;
    state.editorInitialized = true;
    state.stagedText = { text: value, label, requireAnima };
    chineseEditor.value = value;
    chineseMirror.classList.add("bpi-hidden");
    chineseEditor.classList.remove("bpi-hidden");
    setText(editChineseButton, "Back to link");
    setText(mirrorTitle, `Text processing result: ${label}`);
    setText(mirrorHint, containsChinese(value)
      ? "Chinese results are for reading only; to generate images, continue with translation or optimization"
      : "result not yet written to the model; after confirming, click “Sync to English output”");
    updateStageControls();
    autoFitActiveGreenArea();
  };

  const applyFullText = (nextText, label) => {
    const before = String(textWidget.value ?? "");
    const after = String(nextText ?? "").trim();
    if (!after) {
      setStatus("Result is empty; English prompt not overwritten", "error");
      return false;
    }
    if (before === after) {
      if (label === "Anima official sort") {
        state.categoryView = true;
        render();
        setText(mirrorHint, "Category table view | click tags to link; category names are not written to the prompt");
      }
      setStatus("No content change", "ok");
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
      afterCategoryView: label === "Anima official sort",
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    state.categoryView = label === "Anima official sort";
    state.chineseEditing = false;
    state.editorInitialized = false;
    state.stagedText = null;
    chineseEditor.classList.add("bpi-hidden");
    chineseMirror.classList.remove("bpi-hidden");
    setText(editChineseButton, "Edit text");
    setText(mirrorTitle, "Chinese sync editor (per-tag composition)");
    setText(mirrorHint, state.categoryView
      ? "Category table view | click tags to link; category names are not written to the prompt"
      : "Click to link | select then press Delete");
    state.englishEditing = false;
    state.englishEditingExplicit = false;
    state.englishEditorDirty = false;
    englishEditor.value = after;
    englishEditor.classList.add("bpi-hidden");
    englishTokenView.classList.remove("bpi-hidden");
    setText(editEnglishButton, "Edit text");
    setText(englishHint, "Click tags to link; select then press Delete");
    updateStageControls();
    updateText(after);
    setStatus(`applied ${label}; press Ctrl+Z to undo`, "ok");
    return true;
  };

  const clearEnglishText = () => {
    const currentText = String(textWidget.value ?? "");
    const action = clearButtonAction(state.englishClearState, Boolean(currentText));
    if (action === "empty") {
      setStatus("English actual output is already empty", "ok");
      return;
    }
    if (action === "confirm") {
      state.englishClearState = "confirm";
      updateEnglishClearButton();
      setStatus("Click “Confirm clear” again to clear the English actual output", "busy");
      return;
    }
    if (action === "undo") {
      const entry = state.clearedEnglishEntry;
      if (entry && state.undoStack.at(-1) === entry && undoStructuredEdit()) {
        setEnglishEditing(false);
        setStatus("English clear undone", "ok");
      } else {
        resetEnglishClearState();
        setStatus("English content has changed; cannot undo this clear", "error");
      }
      return;
    }
    const entry = createClearTextHistoryEntry(currentText, "Clear English prompt", state.categoryView);
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
    setText(editEnglishButton, "Done");
    state.englishClearState = "cleared";
    state.clearedEnglishEntry = entry;
    updateEnglishClearButton();
    updateText("", 0, { preserveClearState: true });
    setStatus("English actual output cleared; click “undo” to restore immediately", "ok");
    requestAnimationFrame(() => englishEditor.focus({ preventScroll: true }));
  };

  const openTextPreview = (title, proposed, detailNode, label) => {
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal bpi-assistant-settings");
    modal.appendChild(element("h3", "", title));
    modal.appendChild(element("div", "bpi-config-note", "Current English prompt"));
    const before = element("textarea", "bpi-preview-text");
    before.readOnly = true;
    before.value = String(textWidget.value ?? "");
    modal.appendChild(before);
    modal.appendChild(element("div", "bpi-config-note", "New English prompt to apply"));
    const after = element("textarea", "bpi-preview-text");
    after.readOnly = true;
    after.value = String(proposed ?? "").trim();
    modal.appendChild(after);
    if (detailNode) modal.appendChild(detailNode);
    const actions = element("div", "bpi-modal-actions");
    const close = () => shade.remove();
    actions.append(button("Cancel", close), button("Confirm write English", () => {
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
    modal.appendChild(element("h3", "", "Expand edit Chinese / mixed text"));
    const editor = element("textarea", "bpi-preview-text");
    editor.style.minHeight = "360px";
    editor.style.resize = "vertical";
    editor.value = chineseEditor.value;
    modal.appendChild(editor);
    const actions = element("div", "bpi-modal-actions");
    const close = () => shade.remove();
    actions.append(button("Cancel", close), button("Apply to editor", () => {
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
      setStatus("Natural-language segments only support whole-segment editing; tags can still be deleted individually", "error");
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
      label: `Delete “${token.term}”`,
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    updateText(result.text, result.cursor);
    setStatus(`deleted “${token.term}”; press Ctrl+Z to undo`, "ok");
  };

  const applyTokenWeight = (token, weight) => {
    const before = String(textWidget.value ?? "");
    const result = replacePromptTokenWeight(before, token, weight);
    if (!result.changed) {
      setStatus(weight === null ? "This tag has no explicit weight" : "Weight unchanged or value invalid", "error");
      return false;
    }
    const action = weight === null
      ? `Clear “${token.term}” weight`
      : `will set “${token.term}” weight to ${Number(weight)}`;
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
    setStatus(`${action}; press Ctrl+Z to undo`, "ok");
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
      label: `Move “${token.term}”`,
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    updateText(result.text, result.cursor);
    setStatus(`moved “${token.term}”; press Ctrl+Z to undo`, "ok");
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
      label: `Hide “${token.term}”`,
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
    setStatus(`hidden “${token.term}” (excluded from actual output); can be restored anytime in the hidden section; press Ctrl+Z to undo`, "ok");
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
      label: `restore “${item.raw}”`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: hidden.filter((_, i) => i !== index),
    };
    pushHistoryWithHidden(entry);
    setHiddenTags(entry.hiddenAfter);
    updateText(result.text, result.cursor);
    setStatus(`restored “${item.raw}” to its original position; press Ctrl+Z to undo`, "ok");
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
      label: `Restore all hidden tags (${hidden.length} )`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: [],
    };
    pushHistoryWithHidden(entry);
    setHiddenTags([]);
    state.pinned = null;
    updateText(text, text.length);
    setStatus(`restored ${hidden.length} hidden tags; press Ctrl+Z to undo`, "ok");
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
    if (!moved) setStatus(upward ? `“${token.term}” is already at the front` : `“${token.term}” is already at the back`, "");
    return true;
  };

  const openWeightEditor = (token) => {
    if (!token || token.syntax !== "tag" || token.segmentKind === "natural" ||
        !["tags", "mixed"].includes(state.modeInfo.mode)) {
      setStatus("Only tags support individual weights; use text editing for natural language", "error");
      return;
    }
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal");
    modal.appendChild(element("h3", "", "Edit tag weight"));
    modal.appendChild(element("div", "bpi-config-note", `tag: ${token.term}｜Anima format: (Tag:Weight)`));
    const form = element("div", "bpi-form");
    const input = element("input", "");
    input.type = "number";
    input.min = "0";
    input.max = "3";
    input.step = "0.05";
    input.value = token.weight === null ? "1" : String(token.weight);
    form.append(element("label", "", "Weight"), input);
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
        setStatus("Weight must be between 0 and 3", "error");
        input.focus();
        return;
      }
      if (applyTokenWeight(token, numeric)) close();
    };
    const actions = element("div", "bpi-modal-actions");
    if (token.weight !== null) {
      actions.appendChild(button("Clear weight", () => {
        if (applyTokenWeight(token, null)) close();
      }, "bpi-danger"));
    }
    actions.append(button("Cancel", close), button("Apply weight", apply, "bpi-primary"));
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
    setStatus(`Undone: ${entry.label}`, "ok");
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
    setStatus(`Redone: ${entry.label}`, "ok");
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
        console.warn("[BilingualPromptInspector] Large dictionary batch recognition failed", error);
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
    setStatus("Loading dictionary…", "busy");
    try {
      state.data = await loadDictionary(true);
      resetLargeRuntimeCache();
      rebuildDictionaryIndex();
      const large = state.data.large_dictionary;
      // 同上：分段翻译再拼，避免整句键漏掉大词库的几种形态
      const largeText = large?.available
        ? t(`Large ${large.count} (${large.enabled ? "on-demand" : "disabled"})`)
        : t("Large not installed");
      setStatus(`${t(`Common dictionary ${state.data.tags.length} items`)} | ${largeText}`, "ok");
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
      category: "Uncategorized",
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
      value: ["Not indexed", "Natural-language segment (pending translation or confirmation)"].includes(token.chinese) ? "" : token.chinese,
    };
    render();
  };

  const applyInlineEdit = async (token, value, persist) => {
    const chinese = String(value ?? "").trim();
    if (!chinese) {
      setStatus("Chinese explanation cannot be empty", "error");
      return;
    }
    if (!persist) {
      state.localOverrides.set(token.key, { text: chinese, source: "session" });
      state.editing = null;
      setStatus(`temporarily modified “${token.term}”; not saved to dictionary`, "ok");
      render();
      return;
    }
    try {
      const entry = token.entry ?? {};
      await saveTag({
        english: token.term,
        chinese,
        aliases: entry.aliases ?? [],
        category: entry.category ?? "Custom",
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
      setStatus(`saved “${token.term}” to personal dictionary`, "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  };

  const translateToken = async (token) => {
    if (!token?.key || state.translating.has(token.key)) return;
    state.translating.add(token.key);
    setStatus(`Translating: ${token.term}`, "busy");
    render();
    try {
      const naturalLanguage = token.segmentKind === "natural" || ["natural", "instruction"].includes(token.inputMode);
      const translated = await runInspectorAssistant(
        "translate",
        token.term,
        naturalLanguage ? "This is a natural-language segment; keep the translation as natural language, do not split into a tag list." : "",
      );
      const validation = validateTranslationResult(token.term, translated, { naturalLanguage });
      if (!validation.ok) {
        console.warn("[BilingualPromptInspector] Rejected abnormal machine translation", {
          source: token.term,
          translated,
          reason: validation.reason,
        });
        setStatus(`Rejected abnormal translation: ${validation.reason}`, "error");
        return false;
      }
      setMachineTranslation(token.key, {
        english: token.term,
        text: validation.text,
        source: "bpi-assistant",
        createdAt: Date.now(),
      });
      setStatus(`translated “${token.term}”; can save after confirming`, "ok");
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
    setText(editChineseButton, state.chineseEditing ? "Back to link" : "Edit text");
    setText(mirrorTitle, state.chineseEditing ? "Text editing & processing (mixed CN/EN supported)" : "Chinese sync editor (per-tag composition)");
    setText(mirrorHint, state.chineseEditing
      ? "Processing results stay here; click Sync to write to the English output above"
      : state.categoryView
        ? "Category table view | click tags to link; category names are not written to the prompt"
        : "Click to link | select then press Delete");
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
      setStatus("Please enter content in the green text editor first", "error");
      return;
    }
    if (action === "optimize" && containsChinese(source)) {
      setStatus("“Optimize to Anima” only processes English; for Chinese or mixed content, use “Translate & optimize”", "error");
      return;
    }
    setAssistantBusy(true);
    const labels = {
      translate: "Translate",
      translate_optimize: "Translate & optimize",
      optimize: "Optimize to Anima",
    };
    const label = labels[action];
    setStatus(`Running${label}…`, "busy");
    try {
      const output = await runInspectorAssistant(action, source);
      setStagedResult(output, label, action !== "translate");
      setStatus(`${label}completed; result not yet synced to the English output above`, "ok");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setAssistantBusy(false);
    }
  };

  const syncEditedText = () => {
    const proposed = chineseEditor.value.trim();
    if (!proposed) {
      setStatus("Green text editor is empty", "error");
      return;
    }
    if (containsChinese(proposed)) {
      setStatus("The current result contains Chinese and cannot be synced to the English model input", "error");
      return;
    }
    if (state.stagedText?.requireAnima) {
      const punctuationError = animaPunctuationError(proposed);
      if (punctuationError) {
        setStatus(`${punctuationError}; please fix before syncing`, "error");
        return;
      }
    }
    const label = state.stagedText?.label ? `${state.stagedText.label}Sync` : "Text sync";
    openTextPreview("Sync to English output", proposed, null, label);
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
      setStatus("English prompt is empty; cannot sort", "error");
      return;
    }
    setAssistantBusy(true);
    setStatus("Recognizing tag categories…", "busy");
    try {
      let tokens = parsePrompt(source, state.index, state.machine, { mode: "auto" });
      await ensureLargeEntriesFor(tokens);
      tokens = parsePrompt(source, state.index, state.machine, { mode: "auto" });
      const result = sortAnimaPrompt(tokens, { groupLines: true });
      if (result.text === source) {
        state.categoryView = true;
        render();
        setText(mirrorHint, "Category table view | click tags to link; category names are not written to the prompt");
        setStatus(`already matches Anima order${result.uncertain.length ? ` | pending ${result.uncertain.length} items` : ""}`, "ok");
        return;
      }
      const groups = element("div", "bpi-sort-groups");
      for (const group of result.groups) {
        const row = element("div", "bpi-sort-group");
        row.append(element("strong", "", group.label), element("span", "", group.tokens.map((token) => token.raw.trim()).join("，")));
        groups.appendChild(row);
      }
      groups.prepend(element("div", "bpi-config-note", `relocated ${result.moved}  | pending categories ${result.uncertain.length}  tags. Sorting only moves tags; content is not rewritten.`));
      openTextPreview("Anima official order preview", result.text, groups, "Anima official sort");
      setStatus("Sorting complete; please confirm in the preview window", "ok");
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
    setText(editEnglishButton, state.englishEditing ? "Done" : "Edit text");
    setText(englishHint, state.englishEditing
      ? (hasText ? "Text mode while typing; parsed into tags when done" : "Content is empty; enter the English prompt directly")
      : "Click tags to link; select then press Delete");
    if (state.englishEditing) {
      if (document.activeElement !== englishEditor && !state.englishEditorDirty) englishEditor.value = text;
      return;
    }

    englishTokenView.replaceChildren();
    if (!state.tokens.length) {
      englishTokenView.appendChild(element("span", "bpi-mirror-empty", "Linked tags will appear here after you finish editing English."));
      return;
    }
    for (const [index, token] of state.tokens.entries()) {
      const classes = ["bpi-mirror-token", "bpi-english-token", `bpi-${token.status}`];
      if (state.pinned === token.id) classes.push("bpi-linked");
      const label = token.raw.trim() || token.term;
      const chip = element("span", classes.join(" "), label);
      chip.dataset.tokenId = String(token.id);
      setTitle(chip, token.segmentKind === "natural"
        ? `“${token.term}” ↔ “${token.chinese}” | natural language supports only whole-segment editing; can drag to reorder the whole segment`
        : `“${token.term}” ↔ “${token.chinese}” | click to link; double-click to edit weight; select then press Delete; drag to reorder or Alt+↑/↓ to nudge`);
      attachChipDrag(chip, token);
      if (canHideTokens()) {
        const hideCorner = element("span", "bpi-chip-hide");
        hideCorner.appendChild(buildEyeIcon());
        setTitle(hideCorner, `Hide “${token.raw}”: excluded from actual output; can be restored in the hidden section`);
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
        setTitle(remove, `Delete “${token.term}”`);
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
      setText(mirrorHint, state.categoryView
        ? "Category table view | click tags to link; category names are not written to the prompt"
        : "Click to link | select then press Delete");
    }
    chineseMirror.replaceChildren();
    if (!state.tokens.length) {
      chineseMirror.appendChild(element("span", "bpi-mirror-empty", "Per-tag Chinese combinations for the English prompt will appear here."));
      autoFitActiveGreenArea();
      return;
    }
    const tokenChip = (token) => {
      const classes = ["bpi-mirror-token", `bpi-${token.status}`];
      if (state.pinned === token.id) classes.push("bpi-linked");
      const label = token.status === "unknown"
        ? `⚠ Not indexed: ${token.term}`
        : `${token.chinese}${token.weight === null ? "" : ` (weight ${token.weight}）`}`;
      const chip = element("span", classes.join(" "), label);
      chip.dataset.tokenId = String(token.id);
      setTitle(chip, token.segmentKind === "natural"
        ? `“${token.raw}” ↔ “${token.chinese}” | natural language supports only whole-segment editing or translation`
        : token.status === "unknown"
          ? `Unknown English tag: “${token.term}” | click to locate; double-click to edit weight`
          : `“${token.raw}” ↔ “${token.chinese}” | click to locate; double-click to edit weight; select then press Delete`);
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
        setTitle(remove, `Delete “${token.term}”`);
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
    setTitle(handle, "Drag to reorder tags; or select then press Alt+↑/↓ to nudge; Ctrl+Z to undo");
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
    setTitle(hide, `Hide “${token.raw}”: removed from actual output but kept in this list; can be restored to original position at any time`);
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
    const label = element("span", "bpi-hidden-label", `hidden (${hidden.length})`);
    setTitle(label, "These tags will not enter the actual output; click a tag to restore it to its original position");
    container.appendChild(label);
    for (const [index, item] of hidden.entries()) {
      const chip = element("span", "bpi-hidden-chip");
      setTitle(chip, `Click to restore “${item.raw}” to its original position`);
      chip.appendChild(element("span", "bpi-hidden-en", item.raw));
      if (item.chinese) chip.appendChild(element("span", "bpi-hidden-zh", item.chinese));
      chip.appendChild(element("span", "bpi-hidden-restore", "↩"));
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        restoreHiddenTag(index);
      });
      container.appendChild(chip);
    }
    const restoreAll = button("Restore all", () => restoreAllHiddenTags(), "bpi-mini bpi-hidden-all");
    setTitle(restoreAll, `Restore all ${hidden.length} hidden tags to their original positions`);
    container.appendChild(restoreAll);
  };

  const upstreamSettings = () => {
    const stored = node.properties?.bpiUpstream ?? {};
    return {
      takeOver: stored.takeOver !== false,
      importPolicy: IMPORT_POLICIES.some((item) => item.value === stored.importPolicy)
        ? stored.importPolicy
        : "changed",
      lastText: typeof stored.lastText === "string" ? stored.lastText : "",
    };
  };
  const saveUpstreamSettings = (patch) => {
    if (!node.properties) node.properties = {};
    node.properties.bpiUpstream = { ...upstreamSettings(), ...patch };
  };
  const upstreamConnected = () =>
    (node.inputs ?? []).some((input) => input.name === "prompt" && input.link != null);

  const renderSourceBar = () => {
    const connected = upstreamConnected();
    sourceBar.classList.toggle("bpi-hidden", !connected);
    if (!connected) {
      state.upstreamWaiting = false;
      return;
    }
    const settings = upstreamSettings();
    const waiting = state.upstreamWaiting && settings.takeOver;
    sourceToggle.checked = settings.takeOver;
    sourceSelect.value = settings.importPolicy;
    sourceSelect.disabled = !settings.takeOver || waiting;
    sourceToggle.disabled = waiting;
    setText(sourceState, waiting
      ? "Paused, waiting for confirmation…"
      : settings.takeOver
        ? "Intercept upstream text; output after confirmation"
        : "Direct passthrough: upstream output as-is, no import, no pause");
    sourceState.classList.toggle("bpi-source-waiting-text", waiting);
    sourceBar.classList.toggle("bpi-source-waiting", waiting);
    resumeButton.classList.toggle("bpi-hidden", !waiting);
    cancelButton.classList.toggle("bpi-hidden", !waiting);
  };

  const syncSourceBar = () => {
    const connected = upstreamConnected();
    if (connected === state.upstreamConnectedCache) return;
    state.upstreamConnectedCache = connected;
    renderSourceBar();
    if (hasNodeSize()) requestNodeResize();
  };

  const releaseUpstream = async (text) => {
    state.upstreamWaiting = false;
    try {
      await postUpstreamAction("resume", node.id, text);
    } catch (error) {
      setStatus(`Release failed: ${error.message}`, "error");
    }
    renderSourceBar();
  };

  const cancelUpstreamWait = async () => {
    state.upstreamWaiting = false;
    try {
      await postUpstreamAction("cancel", node.id);
      setStatus("Discarded this upstream input", "ok");
    } catch (error) {
      setStatus(`Discard failed: ${error.message}`, "error");
    }
    renderSourceBar();
  };

  // 后端把上游文本推过来：先按策略同步到节点（透传时也同步，保证节点显示
  // 的就是本次实际输出），接管模式再挂起等待确认，透传模式立即原样放行。
  const handleUpstreamText = async (text) => {
    const settings = upstreamSettings();
    const shouldImport =
      settings.importPolicy === "always" ||
      (settings.importPolicy === "once" && !settings.lastText) ||
      (settings.importPolicy === "changed" && text !== settings.lastText);
    if (shouldImport && text !== String(textWidget.value ?? "")) updateText(text);
    saveUpstreamSettings({ lastText: text });
    if (!settings.takeOver) {
      await releaseUpstream(text);
      return;
    }
    state.upstreamWaiting = true;
    renderSourceBar();
    try {
      await postUpstreamAction("ack", node.id);
    } catch (error) {
      state.upstreamWaiting = false;
      renderSourceBar();
      setStatus(`Cannot pause for confirmation: ${error.message}`, "error");
    }
  };

  const saveFavoriteFromNode = () => {
    const text = String(textWidget.value ?? "");
    if (!text.trim()) {
      setStatus("Prompt is empty; cannot favorite", "error");
      return;
    }
    openSavePromptDialog({ text, note: `Node #${node.id} · ${state.tokens.length}  tags` });
  };

  sourceToggle.addEventListener("change", () => {
    saveUpstreamSettings({ takeOver: sourceToggle.checked });
    renderSourceBar();
  });
  sourceSelect.addEventListener("change", () => {
    saveUpstreamSettings({ importPolicy: sourceSelect.value });
    renderSourceBar();
  });

  const render = () => {
    renderSourceBar();
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
        confidenceLabel: "Medium · session-only",
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
      table.appendChild(element("div", "bpi-empty", "Enter a prompt in the English text box above; per-tag bilingual mapping will appear here."));
    } else if (!visibleTokens.length) {
      table.appendChild(element("div", "bpi-empty", "No matching items under the current filter."));
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
        setTitle(englishText, `Query: “${token.term}”${token.weight === null ? "" : ` | weight: ${token.weight}`}`);
        englishText.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          setEnglishEditing(true);
          requestAnimationFrame(() => {
            englishEditor.focus({ preventScroll: true });
            englishEditor.setSelectionRange(token.start, token.end, "forward");
          });
          setStatus(`Located: ${token.term}`, "ok");
        });
        englishCell.appendChild(englishText);
        const isEditing = state.editing?.id === token.id && state.editing?.key === token.key;
        if (isEditing) {
          const editor = element("input", "bpi-inline-editor");
          editor.value = state.editing.value;
          setPlaceholder(editor, "Enter Chinese explanation");
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
            button("Session-only", () => applyInlineEdit(token, editor.value, false), "bpi-mini"),
            button("Save to dict", () => applyInlineEdit(token, editor.value, true), "bpi-mini"),
            button("Cancel", () => { state.editing = null; render(); }, "bpi-mini"),
          );
          chineseCell.appendChild(editActions);
          row.append(englishCell, chineseCell);
          table.appendChild(row);
          setTimeout(() => { editor.focus(); editor.select(); }, 0);
          continue;
        }
        const chineseText = element("span", "", token.chinese);
        setTitle(chineseText, "Double-click to edit Chinese explanation");
        chineseText.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          if (token.syntax === "tag" && token.status !== "special") beginInlineEdit(token);
        });
        chineseCell.appendChild(chineseText);

        const badgeLabels = {
          unknown: "Not indexed",
          machine: "Machine",
          unverified: "Pending",
          special: "Syntax",
        };
        if (badgeLabels[token.status]) chineseCell.appendChild(element("span", "bpi-badge", badgeLabels[token.status]));
        if (token.weight !== null) chineseCell.appendChild(element("span", "bpi-badge", `Weight ${token.weight}`));
        const origin = token.entry?.pack_name ?? sourceLabel(token.source, token.status);
        const sourceBadge = element("span", "bpi-badge bpi-source", origin);
        setTitle(sourceBadge, token.status === "machine"
          ? "Generated by the assistant currently configured in the bilingual inspector; not yet saved to the personal dictionary"
          : `Explanation source: “${origin}”`);
        chineseCell.appendChild(sourceBadge);
        const confidenceBadge = element("span", `bpi-badge bpi-confidence-${token.confidence}`, token.confidenceLabel);
        setTitle(confidenceBadge, token.status === "machine"
          ? "Machine translation not yet human-verified"
          : token.status === "unknown" ? "Dictionary cannot determine" : "Estimated from dictionary source and verification status");
        chineseCell.appendChild(confidenceBadge);

        const actions = element("span", "bpi-inline-actions");
        if (token.status === "unknown" && !/[\u3400-\u9fff]/.test(token.term)) {
          const searchButton = element("button", "bpi-mini", "Search candidates");
          searchButton.addEventListener("click", (event) => {
            event.stopPropagation();
            openManagerPanel("tag-manager", node.id);
            search.value = token.term;
            renderSearch();
            search.focus({ preventScroll: true });
            results.scrollIntoView?.({ block: "nearest" });
          });
          const addButton = element("button", "bpi-mini", "Add manually");
          addButton.addEventListener("click", (event) => {
            event.stopPropagation();
            openTagDialog({
              english: token.term,
              chinese: "",
              category: "Uncategorized",
              models: ["general", "anima"],
              source: "user",
              verified: true,
            }, refreshDictionary);
          });
          const translating = state.translating.has(token.key);
          const translateButton = element("button", "bpi-mini", translating ? "Translating" : "Translate");
          translateButton.disabled = translating;
          translateButton.addEventListener("click", (event) => {
            event.stopPropagation();
            translateToken(token);
          });
          actions.append(searchButton, addButton, translateButton);
        } else if (token.status === "unknown" && /[\u3400-\u9fff]/.test(token.term)) {
          const hint = element("span", "bpi-badge", "Use “Edit text” to process it");
          setTitle(hint, "Click “Edit text”, then use the inspector's own “Translate” or “Translate & optimize”");
          actions.appendChild(hint);
        } else if (token.status === "machine") {
          const saveButton = element("button", "bpi-mini", "Confirm & save");
          saveButton.addEventListener("click", (event) => {
            event.stopPropagation();
            saveMachineTranslation(token);
          });
          const retryButton = element("button", "bpi-mini", "Re-translate");
          retryButton.addEventListener("click", async (event) => {
            event.stopPropagation();
            deleteMachineTranslation(token.key);
            render();
            await translateToken({ ...token, status: "unknown" });
          });
          actions.append(saveButton, retryButton);
        }
        if (token.syntax === "tag" && token.status !== "special") {
          const editButton = element("button", "bpi-mini", "Edit Chinese");
          editButton.addEventListener("click", (event) => {
            event.stopPropagation();
            beginInlineEdit(token);
          });
          actions.appendChild(editButton);
        }
        if (token.key) {
          // 别叫 favoriteButton——外层「收藏」按钮已经是这个名字，遮蔽后很难查
          const starButton = element("button", `bpi-mini bpi-star${isFavorite(token.term) ? " bpi-starred" : ""}`, isFavorite(token.term) ? "★" : "☆");
          setTitle(starButton, isFavorite(token.term) ? "Unfavorite" : "Favorite");
          starButton.addEventListener("click", (event) => {
            event.stopPropagation();
            changeFavorite(token.term);
            render();
            renderSearch();
          });
          const copyButton = element("button", "bpi-mini", "Copy");
          setTitle(copyButton, "Copy English + Chinese mapping");
          copyButton.addEventListener("click", (event) => {
            event.stopPropagation();
            copyText(`${token.raw}\t${token.chinese}`, `Copied “${token.term}” CN/EN mapping`);
          });
          actions.append(starButton, copyButton);
        }
        if (personalKeys.has(token.key)) {
          const hasBuiltin = Boolean(builtinTagFor(token.term));
          const restoreButton = element("button", "bpi-mini", hasBuiltin ? "Restore built-in" : "Delete personal");
          restoreButton.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (!window.confirm(`${hasBuiltin ? "Delete personal override and restore built-in explanation" : "Delete personal tag"}“${token.term}”?`)) return;
            try {
              await deletePersonalTag(token.term);
              await refreshDictionary();
              setStatus(hasBuiltin ? "Built-in explanation restored" : "Personal tag deleted", "ok");
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
    setText(counts, `items ${state.tokens.length} | recognized ${known} | unknown ${unknown}${machine ? ` | pending ${machine}` : ""}${warningCount ? ` | issues ${warningCount}` : ""}`);
    const modeLabels = { tags: "Tag", mixed: "Tag + Natural language", natural: "Natural language", instruction: "Instruction" };
    setText(modeInfo, `Mode: “${modeLabels[state.modeInfo.mode]}”${state.modeInfo.reason ? ` | “${state.modeInfo.reason}”` : ""}`);
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
      : suggestedTags(state.data.tags, state.preferences, 30).map((tag) => ({ tag, reason: "favorited or recently used" }));
    const visibleMatches = ranked.slice(0, state.searchVisibleLimit);
    const matches = visibleMatches.map((item) => item.tag);
    state.searchMatches = matches;
    if (!matches.length) {
      state.searchIndex = -1;
      if (rawQuery) {
        results.appendChild(element("div", "bpi-empty", state.largeSearchLoading ? "Querying dictionary…" : "No matching tag found in the active dictionaries; you can manually add one to the personal dictionary."));
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
        ? (/[_()]/.test(tag.english) ? "Danbooru raw format" : "Large dictionary")
        : "";
      const usage = Number(tag.post_count) > 0 ? ` ·  · uses ${Number(tag.post_count).toLocaleString()}` : "";
      meta.appendChild(element("span", "", `${tag.category} · ${tag.pack_name ?? sourceLabel(tag.source)}${format ? ` · ${format}` : ""}${usage}`));
      meta.appendChild(element("span", "bpi-search-reason", match.reason));
      const star = element("span", `bpi-result-star${isFavorite(tag.english) ? " bpi-starred" : ""}`, isFavorite(tag.english) ? "★" : "☆");
      setTitle(star, isFavorite(tag.english) ? "Unfavorite" : "Favorite tag");
      star.addEventListener("click", (event) => {
        event.stopPropagation();
        changeFavorite(tag.english);
        renderSearch();
        render();
      });
      meta.appendChild(star);
      result.append(element("span", "bpi-result-en", tag.english), element("span", "bpi-result-zh", tag.chinese), meta);
      setTitle(result, `Click to insert the English tag${tag.aliases?.length ? ` | aliases: ${tag.aliases.join("、")}` : ""}`);
      result.addEventListener("mouseenter", () => { state.searchIndex = index; });
      result.addEventListener("click", (event) => {
        event.stopPropagation();
        insertEnglish(tag.english);
      });
      results.appendChild(result);
    }
    const moreKnown = ranked.length > state.searchVisibleLimit;
    if (rawQuery && (moreKnown || state.largeSearchHasMore)) {
      const moreButton = button(state.largeSearchLoading ? "Searching for more…" : "Search more", () => {
        if (state.largeSearchLoading) return;
        state.searchVisibleLimit += 40;
        if (state.largeSearchHasMore) requestLargeSearchPage(rawQuery, true);
        renderSearch();
      }, "bpi-search-more");
      moreButton.disabled = state.largeSearchLoading;
      results.appendChild(moreButton);
      results.appendChild(element("div", "bpi-searching", `Showing ${matches.length}  items; there may be more`));
    } else if (rawQuery && !state.largeSearchLoading) {
      results.appendChild(element("div", "bpi-searching", `showing all ${matches.length}  items; no more results`));
    }
    if (state.largeSearchLoading) results.appendChild(element("div", "bpi-searching", "Querying the large dictionary…"));
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
      setStatus("No unknown tags currently", "ok");
      return;
    }
    control.disabled = true;
    let completed = 0;
    try {
      for (let index = 0; index < unknown.length; index += 1) {
        setStatus(`Translating unknown tags ${index + 1}/${unknown.length}：${unknown[index].term}`, "busy");
        if (await translateToken(unknown[index])) completed += 1;
      }
      const rejected = unknown.length - completed;
      setStatus(`Translation complete ${completed} items${rejected ? `, rejected abnormal results ${rejected} items` : ""}`, rejected ? "error" : "ok");
    } finally {
      control.disabled = false;
    }
  };

  const translateAllButton = button("Translate all unknown", () => translateAllUnknown(translateAllButton));
  for (const [filter, label] of [["all", "All"], ["unknown", "Unknown"], ["machine", "Machine"], ["personal", "Personal dictionary"], ["favorites", "Favorite"]]) {
    const control = button(label, () => {
      state.tableFilter = filter;
      render();
    });
    state.filterButtons.set(filter, control);
    filtersBar.appendChild(control);
  }
  leftTools.append(
    button("Add tag", () => openTagDialog({}, refreshDictionary), "bpi-primary"),
    translateAllButton,
    button("Clear session machine translations", () => {
      clearMachineTranslations();
      state.translating.clear();
      setStatus("Cleared unsaved machine translations", "ok");
      render();
    }),
  );
  rightTools.append(
    button("Manager panel", () => openManagerPanel("tags"), "bpi-primary"),
    button("Refresh dictionary", refreshDictionary),
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
  setTitle(chineseMirror, "Click tags to link with the English view above and the detail table below");
  setTitle(englishTokenView, "Click English tags to link with the Chinese view and the detail table below");
  setTitle(englishEditor, "Stay in text editing while typing; switch to tag view on blur or after clicking Done");
  setTitle(chineseEditor, "Enter Chinese, English, or mixed text; drag the bottom-right corner to resize (auto-saved)");
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
  setTitle(editChineseButton, "Switch between the tag-linked view and the bilingual text editor");
  setTitle(expandChineseButton, "Edit Chinese or mixed content in a larger popup");
  setTitle(translateChineseButton, "Auto-detect language and translate faithfully; no optimization, no auto-sync");
  setTitle(translateOptimizeButton, "auto-translate then optimize to Anima -compliant English prompt");
  setTitle(optimizeChineseButton, "Only optimizes existing English; does not translate");
  setTitle(sortPromptButton, "press Anima stable sort by recommended categories, one row per non-empty category; natural language and BREAK/AND kept intact");
  // setTitle(assistantSettingsButton, "在侧边栏管理面板中配置纯词库、百度翻译、Ollama 或 OpenAI 兼容 API 与自定义规则");
  bindMirrorAction(editChineseButton, () => setChineseEditing(!state.chineseEditing));
  bindMirrorAction(expandChineseButton, openExpandedChineseEditor);
  bindMirrorAction(translateChineseButton, () => runTextAssistant("translate"));
  bindMirrorAction(translateOptimizeButton, () => runTextAssistant("translate_optimize"));
  bindMirrorAction(optimizeChineseButton, () => runTextAssistant("optimize"));
  bindMirrorAction(syncTextButton, syncEditedText);
  bindMirrorAction(sortPromptButton, sortByAnimaOrder);
  // bindMirrorAction(assistantSettingsButton, () => openManagerPanel("assistant"));
  // bindMirrorAction(tagManagerButton, () => openManagerPanel("tag-manager", node.id));
  // setTitle(tagManagerButton, "在侧边栏管理面板中打开本节点的标签翻译与词库搜索");
  setTitle(editEnglishButton, "Switch between the English text editor and the linked tag view");
  setTitle(clearEnglishButton, "Requires a second click to clear the actual English output; after clearing, click the same button or press Ctrl+Z to undo");
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
  favoriteButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  favoriteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    saveFavoriteFromNode();
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
      label: "Manual edit",
      requireAnima: state.stagedText?.requireAnima === true,
    };
    setText(mirrorTitle, "Text editing & processing (mixed CN/EN supported)");
    setText(mirrorHint, containsChinese(chineseEditor.value)
      ? "Chinese or mixed content detected; use “Translate” or “Translate & optimize”"
      : "English content can be synced directly, or optimized to Anima");
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
      syncSourceBar();
      bindTextareaEvents();
    },
    // 后端把上游文本送过来时由扩展层转发到这个节点
    handleUpstream(text) {
      handleUpstreamText(String(text ?? ""));
    },
    // 侧边栏收藏「载入到节点」用：直接改写当前文本
    setText(nextText) {
      if (typeof nextText === "string" && nextText !== String(textWidget.value ?? "")) updateText(nextText);
    },
    destroy() {
      unsubscribePanelSync();
      inspectorRegistry.delete(String(node.id ?? ""));
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

// 后端按 node_id 推事件，这里把节点实例登记下来，事件到达时直接转发。
const inspectorRegistry = new Map();
let upstreamListenerBound = false;
const bindUpstreamListener = () => {
  // 自定义 socket 事件只有先注册过才会被前端分发，晚一步注册就收不到，
  // 所以在 setup 与节点创建两个时机都试一次，注册本身幂等。
  if (upstreamListenerBound || !app.api?.addEventListener) return;
  upstreamListenerBound = true;
  app.api.addEventListener(UPSTREAM_ARRIVED_EVENT, (event) => {
    const detail = event?.detail ?? {};
    findInspectorByNodeId(detail.node_id)?.handleUpstream?.(detail.text ?? "");
  });
};
const findInspectorByNodeId = (nodeId) => {
  const known = inspectorRegistry.get(String(nodeId ?? ""));
  if (known) return known;
  const target = (app.graph?._nodes ?? []).find((node) => String(node.id) === String(nodeId));
  return target?._bilingualPromptInspector ?? null;
};

app.registerExtension({
  name: "ComfyUI.BilingualPromptInspector",
  async setup() {
    bindUpstreamListener();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      const textWidget = this.widgets?.find((widget) => widget.name === "text");
      if (!textWidget) return;
      textWidget.label = "English prompt (actual output)";

      bindUpstreamListener();
      const inspector = createPanel(this, textWidget);
      this._bilingualPromptInspector = inspector;
      inspectorRegistry.set(String(this.id ?? ""), inspector);
      try {
        this.addDOMWidget("bilingual_inspector", "bilingual-inspector", inspector.panel, {
          getMinHeight: () => inspector.getMinHeight(),
          getMaxHeight: () => inspector.getMaxHeight(),
          hideOnZoom: false,
          serialize: false,
        });
      } catch (error) {
        console.error("[BilingualPromptInspector] Failed to create UI", error);
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
