import { app } from "../../scripts/app.js";
import {
  analyzePromptSyntax,
  buildDictionaryIndex,
  detectInputMode,
  duplicateGroups,
  movePromptToken,
  normalizeKey,
  parsePrompt,
  removePromptToken,
  replacePromptTokenWeight,
  restorePromptToken,
  UNKNOWN_CHINESE,
  validateTranslationResult,
} from "./parser.js";
import {
  clearButtonAction,
  clearButtonLabel,
  createClearTextHistoryEntry,
  inspectorNodeTargetHeight,
  preservedSearchScroll,
  rankDictionaryMatches,
  recordRecent,
  suggestedTags,
  toggleFavorite,
} from "./dictionary_tools.js";
import { classifyAnimaToken, groupAnimaTokensForDisplay, sortAnimaPrompt } from "./anima_sorter.js";
import { createLineBreaks } from "./bpi_line_breaks.js";
import { createWeightEditor } from "./bpi_editor_modal.js";
import { createHiddenTags } from "./bpi_hidden.js";
import { createShortcuts } from "./bpi_shortcut.js";
import { createChipDrag } from "./bpi_chip_drag.js";
import { openLibraryItemDialog } from "./bpi_library.js";
import {
  bindStoreHooks, COLLAPSED_NODE_MIN_HEIGHT, createStore,
} from "./bpi_store.js";
import { createNodeSize } from "./bpi_node_size.js";
import { panelSyncHub } from "./panel_sync.js";
import { installBpiWheelGuard } from "./wheel_guard.js";
import { notify } from "./bpi_notify.js";
import { showToast } from "./bpi_toast.js";
import { dragPreviewTableEnabled } from "./bpi_drag_preview.js";
import { deleteAnimNodeEnabled, playDeleteAnim } from "./bpi_delete_anim.js";
import { INSERT_MS, playInsertAnim } from "./bpi_insert_anim.js";
import {
  button,
  deletePersonalTag,
  element,
  importTags,
  injectBpiStyles,
  loadDictionary,
  loadPreferences,
  loadTokenColors,
  buildColorPanel,
  lookupLargeDictionary,
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
  UNINDEXED_PACK_ID,
  UPSTREAM_ARRIVED_EVENT,
} from "./bpi_shared.js";

const NODE_NAME = "BilingualPromptInspector";
const EXTENSION_VERSION = "v2.2.4";
const PROJECT_URL = "https://github.com/mengshengzhijie/ComfyUI-Bilingual-Prompt-Inspector";
// 「适应高度」打开后面板能长到的上限。ComfyUI 按 min/max 分配空间，max 必须明显高于 min，
// 否则手动拉大节点多出来的高度全变成空白（distributeSpace 只会在 min..max 之间给）。
const EXPANDED_WIDGET_MAX_HEIGHT = 1600;
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
    // 版本号带点号会被拆成多个变量而匹配不到译表，所以名字和版本号分开翻译
    element("div", "bpi-about-name", `${t("Bilingual Prompt Manager")} ${EXTENSION_VERSION}`),
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

// ==== 面板骨架：DOM 与控件 ====
function createPanel(node, textWidget) {
  const panel = element("div", "bpi-panel");
  const englishSection = element("section", "bpi-english-section");
  const englishHead = element("div", "bpi-english-head");
  const englishTitle = element("span", "", "Prompt");
  const englishHint = element("span", "bpi-english-hint", "Edit directly when empty");
  const editEnglishButton = element("button", "bpi-button bpi-mini", "Done");
  const clearEnglishButton = element("button", "bpi-button bpi-mini bpi-danger", "Clear");
  const favoriteButton = element("button", "bpi-button bpi-mini", "Favorite");
  const insertBreakButton = element("button", "bpi-button bpi-mini", "Insert line break");
  // 中文不再单独占一块：每个英文标签下面直接跟一行中文，构成一张双语小卡。
  // 翻译类动作已移到侧边栏，节点里只保留「直接作用于英文提示词」的这两个。
  const optimizeButton = element("button", "bpi-button bpi-mini", "Optimize");
  const sortPromptButton = element("button", "bpi-button bpi-mini", "Sort by Anima order");
  // 「适应高度」：把面板高度从写死的上限里放出来，让提示词区跟着节点一起变高。
  // 做成滑动开关（和设置面板里同款，只是用主题色而不是危险色），放在明细表上方的筛选栏里。
  const fillSwitchRow = element("label", "bpi-switch-row bpi-switch-accent");
  const fillSwitch = element("input", "bpi-switch");
  fillSwitch.type = "checkbox";
  const fillTrack = element("span", "bpi-switch-track");
  fillTrack.appendChild(element("span", "bpi-switch-thumb"));
  fillSwitchRow.append(fillSwitch, fillTrack, element("span", "bpi-switch-text", "Fit height"));
  editEnglishButton.type = "button";
  clearEnglishButton.type = "button";
  favoriteButton.type = "button";
  insertBreakButton.type = "button";
  optimizeButton.type = "button";
  sortPromptButton.type = "button";
  setTitle(favoriteButton, "Save the current English prompt to favorites in the user directory (a reference image can be attached)");
  setTitle(insertBreakButton, "Insert a line break after the selected tag, or at the end when no tag is selected");
  englishHead.append(englishTitle, englishHint, editEnglishButton, clearEnglishButton, insertBreakButton, favoriteButton, optimizeButton, sortPromptButton);
  const englishTokenView = element("div", "bpi-english-token-view bpi-hidden");
  englishTokenView.tabIndex = 0;
  englishTokenView.setAttribute("role", "textbox");
  englishTokenView.setAttribute("aria-label", "English prompt tag view");
  englishTokenView.setAttribute("aria-readonly", "true");
  const englishEditor = element("textarea", "bpi-english-editor");
  setPlaceholder(englishEditor, "Enter the English prompt; after editing, it will be shown as selectable, deletable tags.");
  const englishHiddenBar = element("div", "bpi-hidden-bar bpi-hidden");
  setTitle(englishHiddenBar, "Hidden tags will not enter the actual output");
  // 重复标签栏：紧跟在已隐藏栏下面，每个重复标签一个胶囊
  const englishDupBar = element("div", "bpi-dup-bar bpi-hidden");
  setTitle(englishDupBar, "Tags repeated in this prompt; click a chip to step through its occurrences, double-click to delete the one you stepped to; click empty space here to clear the selection");
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
  // 放行时给后端的是"剔除隐藏标签后的文本"（effective_text 与 use_effective 两个
  // 隐藏 widget 只服务于无上游的直通路径；有上游时输出就是这里放行的文本）
  const resumeButton = button("Resume", () => {
    syncEffectiveOutput();
    releaseUpstream(effectiveWidget ? String(effectiveWidget.value ?? "") : String(textWidget.value ?? ""));
  }, "bpi-primary");
  const cancelButton = button("Discard", () => cancelUpstreamWait());
  sourceBar.append(sourceCaption, sourceToggleLabel, sourceSelect, sourceState, resumeButton, cancelButton);
  englishSection.append(sourceBar, englishHead, englishTokenView, englishHiddenBar, englishDupBar, englishEditor);
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
  // 机器翻译批量入库操作栏：只在表格里出现机器翻译词条时才显示（详见 renderMachineBatchBar）
  const machineBatchBar = element("div", "bpi-filters bpi-batch-bar bpi-hidden");
  const table = element("div", "bpi-table");
  // 明细表查找：只筛视图，不动提示词。视觉上跟表格扣成一块（上圆角、无下边框），
  // 好跟上面那个「搜词库插标签」的输入框区分开——那个改提示词，这个不改。
  const tableSearch = element("div", "bpi-table-search");
  const tableSearchIcon = element("span", "bpi-table-search-icon");
  tableSearchIcon.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="5" cy="5" r="3.3"/><path d="M7.5 7.5 10.6 10.6"/></svg>';
  const tableSearchInput = element("input", "bpi-search bpi-table-search-input");
  // 不用 type=search：Chrome 会再画一个原生清除按钮，跟我们自己的 × 重复
  tableSearchInput.type = "text";
  setPlaceholder(tableSearchInput, "Find in the current prompt");
  setTitle(tableSearchInput, "Filter the detail list by keyword; matches the English original or the Chinese explanation; the prompt itself never changes");
  const tableSearchCount = element("span", "bpi-table-search-count");
  const tableSearchClear = element("button", "bpi-table-search-clear", "×");
  tableSearchClear.type = "button";
  setTitle(tableSearchClear, "Clear search");
  tableSearch.append(tableSearchIcon, tableSearchInput, tableSearchCount, tableSearchClear);
  const head = element("div", "bpi-head");
  head.append(element("div", "", "English original (actual output)"), element("div", "", "Chinese explanation (read-only)"));
  // 表头分界处的抓手：拖动改左右两栏比例。比例写在表格的 --bpi-split 变量上，
  // 行和表头都吃这个变量，所以改一次整张表重排，不用重新渲染、也不丢滚动位置。
  const splitHandle = element("span", "bpi-split-handle");
  setTitle(splitHandle, "Drag to resize the two columns; double-click to reset to the default ratio");
  const applyTableSplit = (ratio) => {
    const value = Math.max(0.2, Math.min(0.8, Number(ratio) || 0));
    table.style.setProperty("--bpi-split", `${(value * 100).toFixed(1)}%`);
    return value;
  };
  splitHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    let ratio = null;
    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const rect = table.getBoundingClientRect();
      if (!rect.width) return;
      ratio = applyTableSplit((moveEvent.clientX - rect.left) / rect.width);
    };
    const finish = () => {
      unbindDragTrackers(onMove, finish);
      if (ratio === null) return;
      state.preferences = { ...state.preferences, tableSplit: ratio };
      persistPreferences();
    };
    // 必须走 document 捕获阶段：Nodes 2.0 的 Vue 祖先会在捕获阶段截停冒泡
    bindDragTrackers(onMove, finish);
  });
  splitHandle.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyTableSplit(0.4);
    state.preferences = { ...state.preferences, tableSplit: 0.4 };
    persistPreferences();
  });
  head.appendChild(splitHandle);
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
  aboutFooter.append(element("span", "", `${t("Bilingual Prompt Inspector")} ${EXTENSION_VERSION}`), aboutButton);

  const modeSelect = element("select", "bpi-mode");
  for (const [value, label] of [["auto", "Auto-detect"], ["tags", "Tag mode"], ["natural", "Natural language"]]) {
    const option = element("option", "", label);
    option.value = value;
    modeSelect.appendChild(option);
  }

// ==== 状态、尺寸与偏好 ====
  // 状态与偏好都放进显式 store（js/bpi_store.js）：以后拆功能模块从这里取，
  // 不必再往参数表里塞一长串闭包变量
  const store = createStore({ node, textWidget });
  const { state, storedMode, storedFillHeight } = store;

  // notifyOptions：给右上角弹窗的附加参数（group/hold），需要「连点就刷新并重计停留时间」时用
  const setStatus = (message, kind = "", notifyOptions = null) => {
    // 开了右上角弹窗就把提示交给弹窗，状态栏不再重复显示
    if (notify(message, kind, notifyOptions)) return;
    setText(status, message);
    status.dataset.kind = kind;
  };

  // 只写节点状态栏，不惊动右上角弹窗：批量翻译的逐条结果用它，
  // 否则每译完一条就会把「处理中」那张卡顶掉、下一次循环又新开一张，弹窗一条接一条冒出来
  const setStatusQuiet = (message, kind = "") => {
    setText(status, message);
    status.dataset.kind = kind;
  };

  const persistPreferences = () => {
    savePreferences(state.preferences);
    panelSyncHub.notify("preferences", state.syncSource);
  };
  const {
    applyEnglishEditorHeight, autoFitGreenArea, finishManualResize, growNodeForFill,
    hasNodeSize, measureCollapsedWidgetHeight, measureNaturalEnglishHeight, requestNodeResize,
    resizeCornerHit, resolveDeepestWidget, setFillHeight, startManualResize,
  } = createNodeSize({
    store,
    refs: { panel, englishSection, englishEditor, englishTokenView, fillSwitch, fillSwitchRow },
    persistPreferences,
  });
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

// ==== 文本入口与撤销栈 ====
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
  applyTableSplit(state.preferences.tableSplit ?? 0.4);

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
    setText(englishHint, "");
    scheduleRender(true);
    requestAnimationFrame(() => englishTokenView.focus({ preventScroll: true }));
  };

  const containsChinese = (value) => /[\u3400-\u9fff]/.test(String(value ?? ""));
  const applyFullText = (nextText, label) => {
    const before = String(textWidget.value ?? "");
    const after = String(nextText ?? "").trim();
    if (!after) {
      setStatus("Result is empty; English prompt not overwritten", "error");
      return false;
    }
    if (before === after) {
      if (label === "Anima official sort") {
        state.animaSortSnapshot = { before, after };
        state.categoryView = true;
        render();
        setText(englishHint, "Category table view | click tags to link; category names are not written to the prompt");
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
    setText(englishHint, state.categoryView
      ? "Category table view | click tags to link; category names are not written to the prompt"
      : "");
    state.englishEditing = false;
    state.englishEditingExplicit = false;
    state.englishEditorDirty = false;
    englishEditor.value = after;
    englishEditor.classList.add("bpi-hidden");
    englishTokenView.classList.remove("bpi-hidden");
    setText(editEnglishButton, "Edit text");
    setText(englishHint, "");
    updateText(after);
    // 排序落盘后记住排序前那一版，按钮才好变成「取消 Anima 顺序排序」
    if (label === "Anima official sort") state.animaSortSnapshot = { before, after };
    const appliedMsg = `applied “${label}”`;
    if (!showToast(appliedMsg, { type: "edit" })) setStatus(appliedMsg, "ok");
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
    actions.append(button("Cancel", close), button("Confirm write new prompt", () => {
      if (applyFullText(after.value, label)) close();
    }, "bpi-primary"));
    modal.appendChild(actions);
    shade.appendChild(modal);
    document.body.appendChild(shade);
    shade.addEventListener("mousedown", (event) => { if (event.target === shade) close(); });
    modal.addEventListener("mousedown", (event) => event.stopPropagation());
  };

  const revealLinkedToken = (token) => {
    if (!token) return;
    table.querySelector(`.bpi-row[data-token-id="${token.id}"]`)?.scrollIntoView?.({ block: "nearest" });
    englishTokenView.querySelector(`.bpi-english-token[data-token-id="${token.id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  // Ctrl / Cmd 点是加减选；普通点落在已多选的成员上就保留整组，只把「当前」挪过去
  // （双击编辑要靠这条保住整组，不然第一次 click 就把它打回单选了）
  const activateToken = (token, options = {}) => {
    if (!token) return;
    if (options.additive) {
      if (state.selected.has(token.id)) state.selected.delete(token.id);
      else state.selected.add(token.id);
      const first = state.tokens.find((item) => state.selected.has(item.id));
      state.pinned = first ? first.id : null;
    } else if (state.selected.has(token.id) && state.selected.size > 1) {
      state.pinned = token.id;
    } else {
      state.selected.clear();
      state.selected.add(token.id);
      state.pinned = token.id;
    }
    render();
    requestAnimationFrame(() => {
      revealLinkedToken(token);
    });
  };

  // 多选名单（按原文顺序）；单选时就是 pinned 那一个
  const selectedTokenList = () => state.tokens.filter((token) => state.selected.has(token.id));

  // 多选看着选中的范围 = 最前与最后之间的整段，和双击编辑的范围一致。
  // ctrl 点第 1、第 3 个时第 2 个虽然没被点到，但也在编辑范围里，要一起显示成选中
  const inSelectionSpan = (token) => {
    if (state.selected.size <= 1) return false;
    const list = selectedTokenList();
    if (!list.length) return false;
    const start = Math.min(...list.map((item) => item.start));
    const end = Math.max(...list.map((item) => item.end));
    return token.start >= start && token.end <= end;
  };

  // 双击编辑的范围：选中那几个 token 在原文里的整段，中间的标签一并进来
  const spanForEdit = (token) => {
    const list = selectedTokenList();
    if (!list.some((item) => item.id === token.id)) list.push(token);
    return {
      tokens: list.slice().sort((a, b) => a.start - b.start),
      start: Math.min(...list.map((item) => item.start)),
      end: Math.max(...list.map((item) => item.end)),
    };
  };

  // 真正删掉这一处：改文本、进撤销栈、重渲染。动画只在前面拦一下，删完仍然只有一条撤销记录
  const commitDeleteToken = (token) => {
    if (!["tags", "mixed"].includes(state.modeInfo.mode) || token.segmentKind === "natural") {
      setStatus("Natural-language segments only support whole-segment editing; tags can still be deleted individually", "error");
      return;
    }
    const before = String(textWidget.value ?? "");
    const result = removePromptToken(before, token);
    if (!result.changed) return;
    // 如果删的是个已隐藏的标签，把它的隐藏标记一起删掉，撤销时一起回来
    const hidden = getHiddenTags();
    const hiddenAfter = hidden.filter((item) => !hiddenEntryMatches(item, token));
    const entry = {
      before,
      after: result.text,
      beforeStart: token.start,
      beforeEnd: token.end,
      afterCursor: result.cursor,
      label: `删除「${token.term}」`,
    };
    if (hiddenAfter.length !== hidden.length) {
      entry.hiddenBefore = hidden.slice();
      entry.hiddenAfter = hiddenAfter;
    }
    state.undoStack.push(entry);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    if (entry.hiddenAfter) setHiddenTags(entry.hiddenAfter);
    state.pinned = null;
    updateText(result.text, result.cursor);
    // 右下角提示条关掉时退回状态栏（showToast 返回 false 表示没显示）
    const deletedMsg = `已删除「${token.term}」`;
    if (!showToast(deletedMsg, { type: "remove" })) setStatus(deletedMsg, "ok");
  };

  // 卡片擦掉/插入后其余标签是 flex 重排，会瞬间跳到新位置，看着硬。
  // 变化前后各拍一张「内容坐标」（相对标签区 + 滚动量，滚动过也不跑偏），
  // 再按旧位置→新位置补一段 FLIP 让位动画，和拖动预览那套手感一致。
  // 这里不能按 token.id 配对：id 是 parsePrompt 里按数组下标生成的，插一张或删一张
  // 后面全部错位。改成按 DOM 顺序对齐，变化点由调用方给（insertedAt / removedAt）。
  // 让位要连行尾的换行块（↵）一起算：它也是行里占位的一块，
  // 漏掉它就会出现「换行块先跳到新位置、标签还在半路上」的错觉
  const reflowItems = () => [...englishTokenView.querySelectorAll(".bpi-token-card, .bpi-break-chip")];

  const cardText = (item) => item.querySelector(".bpi-english-token")?.textContent.trim() ?? item.textContent.trim();

  const cardRects = () => {
    const viewBox = englishTokenView.getBoundingClientRect();
    return reflowItems().map((item) => {
      const box = item.getBoundingClientRect();
      return {
        text: cardText(item),
        x: box.left - viewBox.left + englishTokenView.scrollLeft,
        y: box.top - viewBox.top + englishTokenView.scrollTop,
      };
    });
  };

  // 新旧两份卡片按顺序比，第一个对不上的位置就是插入点 / 删除点
  const findInsertedAt = (before, cards) => {
    for (let i = 0; i < cards.length; i += 1) {
      if (!before[i] || before[i].text !== cardText(cards[i])) return i;
    }
    return cards.length - 1;
  };

  const findRemovedAt = (before, cards) => {
    for (let i = 0; i < before.length; i += 1) {
      const text = cards[i] ? cardText(cards[i]) : "";
      if (text !== before[i].text) return i;
    }
    return before.length - 1;
  };

  const REFLOW_MS = 320;

  const animateReflow = (before, { insertedAt = -1, removedAt = -1 } = {}) => {
    if (!before.length) return;
    const viewBox = englishTokenView.getBoundingClientRect();
    const moving = [];
    reflowItems().forEach((card, index) => {
      // 插入点那张是新卡，它自己会展开，不参与让位
      if (index === insertedAt) return;
      // 插入点之后整体后移一位、删除点之后整体前移一位，其余位置一一对应
      const oldIndex = insertedAt >= 0
        ? (index < insertedAt ? index : index - 1)
        : removedAt >= 0
          ? (index < removedAt ? index : index + 1)
          : index;
      const first = before[oldIndex];
      if (!first) return;
      const box = card.getBoundingClientRect();
      const dx = first.x - (box.left - viewBox.left + englishTokenView.scrollLeft);
      const dy = first.y - (box.top - viewBox.top + englishTokenView.scrollTop);
      if (!dx && !dy) return;
      card.style.transition = "none";
      card.style.transform = `translate(${dx}px,${dy}px)`;
      moving.push(card);
    });
    if (!moving.length) return;
    void englishTokenView.offsetWidth;
    for (const card of moving) card.style.transition = `transform ${REFLOW_MS}ms cubic-bezier(.2,.8,.2,1)`;
    requestAnimationFrame(() => {
      for (const card of moving) card.style.transform = "";
      // 落地后清掉内联 transition：留着会盖住删除动画自己要用的 clip-path 过渡，
      // 紧接着删第二张时那张卡的擦除会变成瞬移
      window.setTimeout(() => {
        for (const card of moving) if (card.isConnected) card.style.transition = "";
      }, REFLOW_MS + 60);
    });
  };

  // 正在播插入动画的卡片（按标签原文记，id 会随插入错位不能当 key）：动画中途被
  // 别的刷新重建 DOM 时，靠它把动画挂回新卡片，否则卡片会先完整出现一帧 = 「跳」
  const insertingTexts = new Set();

  // 添加标签：新卡片自己展开，其余卡片同时滑开让位。开关和删除共用一个；
  // 关掉、或正在文本框里编辑英文（那时没有卡片可播）就直接执行，和以前一样
  const withInsertAnim = (mutate) => {
    if (!deleteAnimNodeEnabled() || state.englishEditing) {
      mutate();
      return;
    }
    const before = cardRects();
    mutate();
    // 添加走的也是排队渲染，插队立刻刷一次才量得到新布局
    renderNow();
    const items = reflowItems();
    // 一次只加一个标签；张数对不上（比如批量）就不猜插入点，只当没变化
    const insertedAt = items.length === before.length + 1 ? findInsertedAt(before, items) : -1;
    const fresh = insertedAt >= 0 ? [items[insertedAt]] : [];
    for (const card of fresh) {
      const text = cardText(card);
      insertingTexts.add(text);
      window.setTimeout(() => insertingTexts.delete(text), INSERT_MS + 80);
    }
    animateReflow(before, { insertedAt });
    playInsertAnim(fresh);
  };

  // 删除入口统一走这里：开关打开且那张卡正在屏幕上，就先播消失动画，
  // 擦除结束再真正删、并把其余卡片的让位补成动画；开关关掉、或者卡片当前
  // 看不见（文本编辑态）就直接删，和以前一样
  const deleteTokenOccurrence = (token) => {
    const card = deleteAnimNodeEnabled()
      ? englishTokenView.querySelector(`.bpi-token-card .bpi-english-token[data-token-id="${token.id}"]`)?.closest(".bpi-token-card")
      : null;
    if (!card) {
      commitDeleteToken(token);
      return;
    }
    playDeleteAnim(card, () => {
      const before = cardRects();
      commitDeleteToken(token);
      // 删除走的是排队渲染（setTimeout 0），这里插队立刻刷一次，才量得到新位置
      renderNow();
      const items = reflowItems();
      const removedAt = items.length === before.length - 1 ? findRemovedAt(before, items) : -1;
      animateReflow(before, { removedAt });
    });
  };

  const applyTokenWeight = (token, weight) => {
    const before = String(textWidget.value ?? "");
    const result = replacePromptTokenWeight(before, token, weight);
    if (!result.changed) {
      setStatus(weight === null ? "This tag has no explicit weight" : "Weight unchanged or value invalid", "error");
      return false;
    }
    const action = weight === null
      ? `清除「${token.term}」的权重`
      : `把「${token.term}」的权重设为 ${Number(weight)}`;
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
    const appliedActionMsg = `已${action}`;
    if (!showToast(appliedActionMsg, { type: "edit" })) setStatus(appliedActionMsg, "ok");
    return true;
  };

  const canReorderTokens = () =>
    ["tags", "mixed"].includes(state.modeInfo.mode) && state.tokens.length > 1;

  const moveTokenTo = (token, targetIndex, options = {}) => {
    if (!token || !canReorderTokens()) return false;
    const before = String(textWidget.value ?? "");
    const result = movePromptToken(before, state.tokens, token, targetIndex, options);
    if (!result.changed) return false;
    state.undoStack.push({
      before,
      after: result.text,
      beforeStart: token.start,
      beforeEnd: token.end,
      afterCursor: result.cursor,
      label: `移动「${token.term}」`,
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.pinned = null;
    updateText(result.text, result.cursor);
    const movedMsg = `已移动「${token.term}」`;
    if (!showToast(movedMsg, { type: "move" })) setStatus(movedMsg, "ok");
    return true;
  };

  // 换行块的数据层在 bpi_line_breaks.js：只读写文本与撤销栈，不碰 DOM
  const {
    breakGapCount, gapSource, gapHasBreak, currentBreakGaps, rebuildTextWithBreaks,
    replacePromptText, applyBreakGaps, removeBreakAt, moveBreakTo, insertBreakFromToolbar,
  } = createLineBreaks({ store });
  insertBreakButton.addEventListener("click", () => insertBreakFromToolbar());

  // 隐藏标签 / 唯一开关 / 输出管道都在 bpi_hidden.js：那里只改数据与 effective_text，
  // 界面渲染仍旧回调主文件的 buildTokenCard
  const {
    canHideTokens, dupFocusToken, effectiveWidget, getHiddenTags, getUniqueKeys, hiddenEntryMatches, hiddenIndexOf, hideToken, isTokenHidden, isTokenSuppressed,
    isUniqueKey, pushHistoryWithHidden, restoreAllHiddenTags, restoreHiddenTag, setHiddenTags, setUniqueKeys, syncEffectiveOutput, unhideToken, useEffectiveWidget,
  } = createHiddenTags({
    store,
    // buildTokenCard 定义在文件后半段，包一层等运行时再取，避免 TDZ
    buildTokenCard: (...args) => buildTokenCard(...args),
  });
  // 拖动超过阈值时压掉紧随其后的 click：拖拽层要用对象包一层，
  // 拆出去之后两边共享的是同一个引用，不是各拿一份拷贝
  const clickGuard = { suppressed: false };
  // 上一次点的是哪张卡、什么时候点的：双击靠这两个自己判断（见 buildTokenCard）
  let lastCardClickAt = 0;
  let lastCardClickId = null;

  // Drag trackers must listen in the CAPTURE phase on document.
  // Nodes 2.0 (Vue Nodes) renders nodes as DOM and installs @pointermove.stop
  // style handlers on ancestor elements; when an ancestor stops propagation
  // during the capture phase the event never reaches the target and never
  // bubbles back, so bubble-phase listeners on document would never fire and
  // the drag would silently die.  document capture always runs first.
  // 拖拽层在 bpi_chip_drag.js：这里只算落点下标，文本改动仍由 parser 负责
  const { attachChipDrag, createDragPreview, bindDragTrackers, unbindDragTrackers } = createChipDrag({ store, englishTokenView, clickGuard });
  // 换行块：原文里的 \n 在两个可视化区里渲染成 ↵，和标签一样看得见、拖得动、
  // 删得掉。拖到某个标签上 = 换行走这个标签后面的 gap。与标签拖拽一样必须挂
  // document 捕获阶段，否则 Nodes 2.0 下收不到事件。
  const buildBreakChip = (gapIndex, view, selector) => {
    const chip = element("span", "bpi-break-chip", "↵");
    setTitle(chip, "Line break | drag onto a tag to move it; click × to delete (the two lines merge)");
    const remove = element("span", "bpi-break-x", "×");
    setTitle(remove, "Delete this line break");
    remove.addEventListener("pointerdown", (event) => event.stopPropagation());
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 和删标签同一套动画：开关打开就先划掉擦走，擦完那一下才真正把两行合并
      if (!deleteAnimNodeEnabled() || !chip.isConnected) {
        if (removeBreakAt(gapIndex)) setStatus("已删除一个换行", "ok");
        return;
      }
      playDeleteAnim(chip, () => {
        const before = cardRects();
        // 擦除这一秒里文本可能被改过，换行已经不在了就什么都不做
        if (!removeBreakAt(gapIndex)) return;
        renderNow();
        const items = reflowItems();
        const removedAt = items.length === before.length - 1 ? findRemovedAt(before, items) : -1;
        animateReflow(before, { removedAt });
        setStatus("已删除一个换行", "ok");
      });
    });
    chip.appendChild(remove);
    chip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target === remove) return;
      if (breakGapCount() < 1) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let targetGap = null;
      let hoverChip = null;
      const clearHover = () => {
        if (hoverChip) hoverChip.classList.remove("bpi-drop-target");
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
          chip.classList.add("bpi-dragging");
        }
        moveEvent.preventDefault();
        clearHover();
        targetGap = null;
        const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const hitChip = hit?.closest?.(selector);
        if (hitChip && hitChip !== chip) {
          const index = [...view.querySelectorAll(selector)].indexOf(hitChip);
          if (index >= 0) {
            targetGap = Math.min(index, breakGapCount() - 1);
            hoverChip = hitChip;
            hoverChip.classList.add("bpi-drop-target");
          }
        }
      };
      const finish = () => {
        unbindDragTrackers(onMove, finish);
        chip.classList.remove("bpi-dragging");
        clearHover();
        if (active && targetGap !== null && chip.isConnected) {
          if (moveBreakTo(gapIndex, targetGap)) setStatus("Moved the line break", "ok");
          requestAnimationFrame(() => view.focus({ preventScroll: true }));
        }
      };
      bindDragTrackers(onMove, finish);
    });
    return chip;
  };

  // 明细表里的换行行：整行青绿色，只写「换行」两个字。
  // 以前这里有个 ⠿ 手柄可以拖动换行，实际用不上：想挪换行就到节点里拖 ↵，或者直接改文本。
  const buildBreakRow = () => {
    const row = element("div", "bpi-row bpi-break-row");
    row.appendChild(element("span", "bpi-break-row-label", "换行"));
    return row;
  };

  // 撤销/重做与顺序微调在 bpi_shortcut.js：撤销栈的条目仍由各处自己 push
  const {
    handleTokenReorderShortcut, undoStructuredEdit, redoStructuredEdit, handleHistoryShortcut,
  } = createShortcuts({ store, setHiddenTags, setUniqueKeys });
  // 编辑弹窗搬到了 bpi_editor_modal.js：DOM 与交互在那边，改文本/存词条仍走这里的钩子
  const openWeightEditor = createWeightEditor({ store });

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

  // 把当前文本解析成标签列表。render 用它，插入标签后也立刻刷一次：
  // 连着插入（双击、回车连按）时下一次要拿新坐标，否则会拿着上一次的
  // 位置去切已经变长的文本，落点就偏了。
  const parseTokens = (text) => parsePrompt(text, state.index, state.machine, { mode: state.modePreference }).map((token) => {
    const override = state.localOverrides.get(token.key);
    if (!override) return token;
    return {
      ...token,
      chinese: override.text,
      source: override.source,
      status: "session",
      confidence: "medium",
      confidenceLabel: "Medium",
      confidenceReason: "Changed for this session only; not saved to the dictionary",
    };
  });

  const insertEnglish = (english, keepSearch = false) => {
    const current = String(textWidget.value ?? "");
    // 标签视图下没有光标可依，落点跟底部「快捷添加」一致：插到当前选中标签后面，
    // 没选中标签才落到末尾。侧边栏「标签管理」复用的就是这份明细表，所以那边
    // 搜词库点结果也是走这里。
    const anchor = state.englishEditing ? null : state.tokens.find((item) => item.id === state.pinned);
    const at = anchor?.end;
    const start = state.englishEditing
      ? (englishEditor.selectionStart ?? current.length)
      : (Number.isInteger(at) && at > 0 && at <= current.length ? at : current.length);
    const end = state.englishEditing ? (englishEditor.selectionEnd ?? start) : start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const needsPrefix = before.trim() && !/[\s,\n]$/.test(before);
    const needsSuffix = after.trim() && !/^[\s,\n]/.test(after);
    const insertion = `${needsPrefix ? ", " : ""}${english}${needsSuffix ? ", " : ""}`;
    const nextText = before + insertion + after;
    // 新标签落在选中标签之后，也就是原来排在它前面的那些标签之后：加完把它设为选中，
    // 连着加几个才会依次往后排，不用每次重新点一遍落点。
    const nextId = state.englishEditing ? null : state.tokens.filter((token) => token.end <= start).length;
    withInsertAnim(() => {
      updateText(nextText, state.englishEditing ? start + insertion.length : null);
      if (nextId !== null) {
        state.tokens = parseTokens(nextText);
        state.pinned = nextId;
        state.selected.clear();
        state.selected.add(nextId);
      }
    });
    rememberRecent(english);
    if (!keepSearch) search.value = "";
    renderSearch();
    // 添加原本就没有「原来的位置」，关掉提示条后就不提示
    showToast(`已添加「${english}」`, { type: "insert" });
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

  const machineTagPayload = (token) => ({
    english: token.term,
    chinese: token.chinese,
    category: "Uncategorized",
    models: ["general", "anima"],
    source: "bpi-assistant",
    verified: true,
  });

  const saveMachineTranslation = (token) => {
    openTagDialog(machineTagPayload(token), async () => {
      deleteMachineTranslation(token.key);
      await refreshDictionary();
    });
  };

  // 批量入库：把勾选的机器翻译词条一次性写进个人词库。
  // 只用「当前列表里看得见的机器翻译行」——所见即所操作，切了筛选就换一批，
  // 不会出现「已选 3 条但列表里一条都没有」这种对不上的情况。
  const addSelectedMachineTranslations = async (tokens) => {
    if (!tokens.length) {
      setStatus("Check the entries you want to add first", "error");
      return;
    }
    setStatus(`Adding “${tokens.length}” entries…`, "busy");
    try {
      const imported = await importTags(tokens.map(machineTagPayload), "overwrite");
      for (const token of tokens) {
        deleteMachineTranslation(token.key);
        state.batchSelected.delete(token.key);
      }
      await refreshDictionary();
      const total = imported.added + imported.replaced;
      const importMsg = imported.skipped
        ? `Added “${total}” entries | new “${imported.added}”, replaced “${imported.replaced}”, skipped “${imported.skipped}”`
        : `Added “${total}” entries | new “${imported.added}”, replaced “${imported.replaced}”`;
      if (!showToast(importMsg, { type: "edit" })) setStatus(importMsg, "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  };

  // 机器翻译行的勾选框：只有这类行有待入库的译文，所以勾选只给它们。
  const buildRowCheckButton = (token) => {
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.batchSelected.has(token.key);
    checkbox.style.cssText = "flex:none;margin:0;accent-color:#3f83ba";
    setTitle(checkbox, "Check this machine translation; use the toolbar above the table to add several entries to the personal dictionary at once");
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.batchSelected.add(token.key); else state.batchSelected.delete(token.key);
      render();
    });
    return checkbox;
  };

  // 表格上方的批量操作栏：全选 + 已选计数 + 加入个人词库。
  // 没有机器翻译词条时整个隐藏，不占版面。
  const renderMachineBatchBar = (tokens) => {
    machineBatchBar.replaceChildren();
    machineBatchBar.classList.toggle("bpi-hidden", tokens.length === 0);
    if (!tokens.length) return;
    const keys = tokens.map((token) => token.key);
    const selectedCount = keys.filter((key) => state.batchSelected.has(key)).length;
    const selectAll = element("input");
    selectAll.type = "checkbox";
    selectAll.style.cssText = "margin:0;accent-color:#3f83ba";
    selectAll.checked = selectedCount === tokens.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < tokens.length;
    selectAll.addEventListener("change", () => {
      for (const key of keys) {
        if (selectAll.checked) state.batchSelected.add(key); else state.batchSelected.delete(key);
      }
      render();
    });
    const label = element("label", "bpi-source-toggle");
    label.append(selectAll, element("span", "", `Select all (${tokens.length} items)`));
    const count = element("span", "bpi-mode-info", `Selected “${selectedCount}” / “${tokens.length}”`);
    count.style.marginLeft = "auto";
    const addButton = button("Add selected to personal dictionary", () => {
      addSelectedMachineTranslations(tokens.filter((token) => state.batchSelected.has(token.key)));
    }, "bpi-primary");
    addButton.disabled = selectedCount === 0;
    machineBatchBar.append(label, count, addButton);
  };

  const beginInlineEdit = (token) => {
    state.editing = {
      id: token.id,
      key: token.key,
      // 「未收录」「自然语言片段」都只是占位说明，不是译文：改中文时不带出来，
      // 免得一个字没动就原样存回个人词库，得到一条中文名叫「未收录」的残词条
      value: [UNKNOWN_CHINESE, "自然语言片段（待翻译或确认）"].includes(token.chinese) ? "" : token.chinese,
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
      const tempMsg = `temporarily modified “${token.term}”; not saved to dictionary`;
      if (!showToast(tempMsg, { type: "edit" })) setStatus(tempMsg, "ok");
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
      const savedMsg = `saved “${token.term}” to personal dictionary`;
      if (!showToast(savedMsg, { type: "edit" })) setStatus(savedMsg, "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  };

  const isNaturalSegment = (token) => token?.segmentKind === "natural" || ["natural", "instruction"].includes(token?.inputMode);

  // 校验译文并写入机器翻译缓存；逐条翻译与批量翻译共用这一段
  const commitTranslation = (token, translated) => {
    const validation = validateTranslationResult(token.term, translated, { naturalLanguage: isNaturalSegment(token) });
    if (!validation.ok) {
      console.warn("[BilingualPromptInspector] Rejected abnormal machine translation", {
        source: token.term,
        translated,
        reason: validation.reason,
      });
      setStatus(`Rejected abnormal translation: “${validation.reason}”`, "error");
      return false;
    }
    setMachineTranslation(token.key, {
      english: token.term,
      text: validation.text,
      source: "bpi-assistant",
      createdAt: Date.now(),
    });
    return true;
  };

  // quiet（批量翻译时用）：右上角只留一张「总进度」卡，逐条结果一律走状态栏 + 右下角，
  // 不碰右上角，免得一条一弹窗。单条翻译（默认）行为不变。
  const translateToken = async (token, options = null) => {
    const say = options?.quiet === true ? setStatusQuiet : setStatus;
    if (!token?.key || state.translating.has(token.key)) return;
    state.translating.add(token.key);
    say(`Translating: “${token.term}”`, "busy");
    render();
    try {
      const naturalLanguage = isNaturalSegment(token);
      const instruction = naturalLanguage ? "This is a natural-language segment; keep the translation as natural language, do not split into a tag list." : "";
      // 撞到插件自己的「30 次 / 60 秒」（AI 服务）就等窗口滑过去再试同一个标签，
      // 别直接算成失败；百度已豁免这个计数器，走不到这里
      let translated;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          translated = await runInspectorAssistant("translate", token.term, instruction);
          break;
        } catch (error) {
          if (error.status === 429 && attempt < 3) {
            say(`Rate limited; waiting to retry “${token.term}”…`, "busy");
            await new Promise((resolve) => setTimeout(resolve, 15000));
            continue;
          }
          throw error;
        }
      }
      // 失败不上右下角（那里只报成功），走状态栏 / 右上角的红色提示
      if (!commitTranslation(token, translated)) {
        say(`Rejected invalid translation: “${token.term}”`, "error");
        return false;
      }
      say(`translated “${token.term}”; can save after confirming`, "ok");
      showToast(`已翻译「${token.term}」`, { type: "translate" });
      return true;
    } catch (error) {
      say(error.message, "error");
      return false;
    } finally {
      state.translating.delete(token.key);
      render();
    }
  };

  const setAssistantBusy = (busy) => {
    state.assistantBusy = Boolean(busy);
    optimizeButton.disabled = state.assistantBusy;
    sortPromptButton.disabled = state.assistantBusy;
  };

  // 自然语言模式下没有标签流可以重排，「按 Anima 排序」整个不出现；
  // 「优化」也随之改走自然语言规则（可以吃中文），标签模式维持「只处理英文」。
  const isNaturalPrompt = () => state.modeInfo.mode === "natural";

  // 结果不直接写回，先弹预览让用户确认。
  const runOptimize = async () => {
    if (state.assistantBusy) return;
    const source = String(textWidget.value ?? "").trim();
    if (!source) {
      setStatus("English prompt is empty; nothing to optimize", "error");
      return;
    }
    const label = "Optimize";
    const natural = isNaturalPrompt();
    const hasChinese = containsChinese(source);
    if (hasChinese && !natural) {
      setStatus("“Optimize” only processes English in tag mode; translate Chinese in the sidebar first", "error");
      return;
    }
    setAssistantBusy(true);
    // 自然语言模式是允许中文的，这里明说一句会顺带翻译，免得用户以为漏处理了
    setStatus(`Running “${label}”…${hasChinese ? " (Chinese detected; translating to English first)" : ""}`, "busy");
    try {
      const output = await runInspectorAssistant(natural ? "optimize_natural" : "optimize", source);
      const punctuationError = natural ? "" : animaPunctuationError(output);
      openTextPreview(label, output, null, label);
      if (punctuationError) {
        setStatus(`“${punctuationError}”; please fix it in the preview before confirming`, "error");
      } else {
        setStatus(`“${label}” done; please confirm in the preview window`, "ok");
      }
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setAssistantBusy(false);
    }
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

  // 排序写入之后按钮就变成「取消」：点一下把提示词和分类视图一起还原到排序前。
  const updateSortButton = () => {
    const sorted = Boolean(state.animaSortSnapshot);
    // 排序只重排标签流；整段自然语言没有可排的东西，按钮整个不出现。
    // 但已经排过序时要留着，否则「取消排序」的入口会跟着一起消失。
    sortPromptButton.hidden = isNaturalPrompt() && !state.animaSortSnapshot;
    setText(sortPromptButton, sorted ? "Cancel Anima order sort" : "Sort by Anima order");
    setTitle(sortPromptButton, sorted
      ? "Restore the prompt as it was before the Anima sort"
      : "press Anima stable sort by recommended categories, one row per non-empty category; natural language and BREAK/AND kept intact");
  };

  const cancelAnimaSort = () => {
    const snapshot = state.animaSortSnapshot;
    if (!snapshot) return;
    state.animaSortSnapshot = null;
    if (snapshot.before !== snapshot.after) {
      if (applyFullText(snapshot.before, "Cancel Anima sort")) {
        setStatus("Restored the prompt from before the Anima sort", "ok");
      }
    } else {
      // 排序没改动文本（本来就是 Anima 顺序），只切了分类视图：退出视图就回到原样
      state.categoryView = false;
      setText(englishHint, "");
      render();
      setStatus("Exited the Anima category view", "ok");
    }
    updateSortButton();
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
        // 本来就是 Anima 顺序，只是切成分类视图：前后文本相同，取消时退出视图即可
        state.animaSortSnapshot = { before: source, after: source };
        state.categoryView = true;
        render();
        setText(englishHint, "Category table view | click tags to link; category names are not written to the prompt");
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

  const tokenChineseLabel = (token) => {
    // 疑似自然语言只在还没翻译时顶掉中文：翻译过就当普通标签显示译文
    if (token.suspectedNatural && token.status === "unknown") return "Not indexed · suspected natural language";
    if (token.status === "unknown") return "Not indexed";
    const base = token.chinese || "";
    return token.weight === null ? base : `${base} ${t(`(weight ${token.weight})`)}`;
  };

  // 模式优先：customColors 只在 default 模式下看得见；status/random 覆盖它
  const tokenCardColor = (token) => {
    // 「疑似自然语言」是形状上的怀疑标记，跟收不收录无关，也不管翻译没翻译都标淡青。
    // 它只在诊断类模式（默认 / 按收录）下显示；随机和按词库是配色方案模式，
    // 让用户自己摇出来或配出来的颜色正常显示，不被诊断标记盖住。
    // 用排除法判断，旧存档里的未知值也跟默认一样显示。
    if (token.suspectedNatural && !["random", "by_pack", "by_anima"].includes(state.colorMode)) {
      return "rgba(58,132,160,.20)";
    }
    if (state.colorMode === "status") {
      // 淡橙（未收录）、淡紫（机器翻译）、已收录不变 —— 柔和不鲜艳，跟换行行一个调子
      if (token.status === "unknown") return "rgba(184,120,50,.18)";
      if (token.status === "machine") return "rgba(120,80,160,.20)";
      return null;
    }
    if (state.colorMode === "random") {
      if (!state.randomColors.has(token.key)) {
        const pool = state.tokenColors.random_pool;
        if (pool && pool.length) {
          state.randomColors.set(token.key, pool[Math.floor(Math.random() * pool.length)]);
        } else {
          state.randomColors.set(token.key, "#5b8a72");
        }
      }
      return state.randomColors.get(token.key);
    }
    if (state.colorMode === "by_pack") {
      // 没命中词库的标签归到 unindexed；没给某个词库配色的就保持默认底色
      return state.tokenColors.pack_colors?.[token.entry?.pack_id || UNINDEXED_PACK_ID] || null;
    }
    if (state.colorMode === "by_anima") {
      // 分类沿用「按 Anima 顺序排序」那套判定，分不出来的归到 uncertain
      return state.tokenColors.anima_colors?.[classifyAnimaToken(token).slot] || null;
    }
    // default：只显示双击设过的自定义色
    return state.customColors.get(token.key) || null;
  };

// ==== 卡片渲染与重复栏 ====
  // 一张双语小卡 = 上面英文标签 chip（拖拽 / 权重 / 隐藏 / 删除都挂在它身上）+ 下面对应中文。
  // chip 的结构与交互完全沿用原来的英文标签，只是外面多包一层卡片，
  // 所以 attachChipDrag 那套按 .bpi-english-token 命中的逻辑不用改。
  const buildTokenCard = (token) => {
    const classes = ["bpi-mirror-token", "bpi-english-token", `bpi-${token.status}`];
    if (state.pinned === token.id) classes.push("bpi-linked");
    const label = token.raw.trim() || token.term;
    const chip = element("span", classes.join(" "), label);
    chip.dataset.tokenId = String(token.id);
    setTitle(chip, token.suspectedNatural
      ? `“${token.term}” ↔ “${token.chinese}” | suspected natural language: more than 3 spaces; confirm or split it into tags`
      : token.segmentKind === "natural"
        ? `“${token.term}” ↔ “${token.chinese}” | natural language supports only whole-segment editing; can drag to reorder the whole segment`
        : `“${token.term}” ↔ “${token.chinese}” | click to link; Ctrl+click to select multiple; double-click to open the editor; select then press Delete; drag to reorder or Alt+↑/↓ to nudge`);
    // 隐藏角标挂在整张卡片上（不是英文那一行）：定位基准是卡片方框，
    // 角标才会落在方框的右下角，而不是跟着英文行的宽度跑到中间去。
    let hideCorner = null;
    if (canHideTokens()) {
      const tokenHidden = isTokenHidden(token);
      hideCorner = element("span", tokenHidden ? "bpi-chip-hide bpi-chip-hidden-mark" : "bpi-chip-hide");
      hideCorner.appendChild(tokenHidden ? buildEyeOffIcon() : buildEyeIcon());
      setTitle(hideCorner, tokenHidden
        ? `Unhide “${token.raw}”: back into the actual output`
        : `Hide “${token.raw}”: keeps it visible here (strikethrough) but excludes it from the actual output`);
      hideCorner.addEventListener("pointerdown", (event) => event.stopPropagation());
      hideCorner.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isTokenHidden(token)) unhideToken(token);
        else hideToken(token);
      });
    }
    // 删除的 × 也挂成角标（和眼睛一样浮在卡片方框上），不再挤在英文行末尾。
    // 纯浮层、不占位：卡片尺寸一点都不变，有字就盖在字上面，
    // 免得给 × 留出空位把卡片撑宽、把刚好一行放得下的标签挤到下一行去
    let removeCorner = null;
    if (state.pinned === token.id && ["tags", "mixed"].includes(state.modeInfo.mode) && token.segmentKind !== "natural") {
      removeCorner = element("span", "bpi-mirror-delete", "×");
      setTitle(removeCorner, `Delete “${token.term}”`);
      removeCorner.addEventListener("pointerdown", (event) => event.stopPropagation());
      removeCorner.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteTokenOccurrence(token);
      });
    }
    const chinese = element("span", "bpi-token-card-zh", tokenChineseLabel(token));
    setTitle(chinese, `“${token.term}” ↔ “${token.chinese}”`);
    const card = element("span", "bpi-token-card");
    // 插入动画播到一半被别的刷新重建了：把动画挂回新卡片，免得先完整出现一帧再补动画
    if (insertingTexts.has(label)) {
      card.classList.add("bpi-inserting");
      window.setTimeout(() => card.classList.remove("bpi-inserting"), INSERT_MS + 60);
    }
    // 卡片也要带 token id：拖动挪的是整张卡片（attachChipDrag 抓的就是它），
    // 实时预览按 data-token-id 反查落点，只写在内层 chip 上会查不到
    card.dataset.tokenId = String(token.id);
    // 隐藏的卡：划线 + 灰化褪色，但拖动/双击改权重/改色都照常
    if (isTokenHidden(token)) card.classList.add("bpi-card-hidden");
    // 「唯一」排除掉的第 2 次及以后出现：和隐藏一样划线褪色，但仍留在这里能操作
    if (isTokenSuppressed(token)) card.classList.add("bpi-dup-off");
    if (state.dupFocusId === token.id) card.classList.add("bpi-dup-hit");
    // 选中反馈给整张卡片，而不是只有英文那一行
    if (state.pinned === token.id) card.classList.add("bpi-card-linked");
    // 多选的虚线框只在真的多选时出现，单选保持原样不打扰；中间没点到的也框上
    if (inSelectionSpan(token)) card.classList.add("bpi-card-multi");
    const cardColor = tokenCardColor(token);
    if (cardColor && !card.classList.contains("bpi-card-linked") && !card.classList.contains("bpi-dup-hit")) card.style.background = cardColor;
    card.append(chip, chinese);
    if (hideCorner) card.appendChild(hideCorner);
    if (removeCorner) card.appendChild(removeCorner);
    // 拖拽也挂在整个方块上：抓中文行一样能拖，不必精确抓英文。
    // 注意必须放在 card 声明之后：在 const card 之前引用它会触发 TDZ 报错，
    // 一报错整个 render 中断，标签区会整个空白。
    attachChipDrag(card, token);
    // 点击 / 双击挂在整个方块上：点中文行、点卡片留白都算选中，不必精确点中英文。
    // 双击这里自己认：单击会立刻重渲染整个标签区，卡片元素被换成新的之后，
    // 浏览器就不再把第二下算成「同一个东西被点两次」，dblclick 根本不会派发。
    // 所以按「两次点击同一张卡 + 间隔够短」来判断，不依赖元素身份。
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      if (clickGuard.suppressed) return;
      const now = Date.now();
      if (now - lastCardClickAt < 320 && lastCardClickId === token.id) {
        lastCardClickAt = 0;
        lastCardClickId = null;
        window.getSelection()?.removeAllRanges();
        // 已经在多选里就不重选，否则整组会被打回单选、没法一起编辑
        if (!state.selected.has(token.id)) activateToken(token);
        englishTokenView.focus({ preventScroll: true });
        openWeightEditor(token);
        return;
      }
      lastCardClickAt = now;
      lastCardClickId = token.id;
      activateToken(token, { additive: event.ctrlKey || event.metaKey });
      englishTokenView.focus({ preventScroll: true });
    });
    return card;
  };

  // 分类表视图：原来画在中文对照区，合并后挪到同一张卡片里，每行仍是一张双语小卡
  const buildCategoryTable = () => {
    const categoryTable = element("div", "bpi-category-table");
    for (const group of groupAnimaTokensForDisplay(state.tokens)) {
      const row = element("div", "bpi-category-row");
      const name = element("div", "bpi-category-name", group.label);
      const content = element("div", "bpi-category-content");
      for (const token of group.tokens) content.appendChild(buildTokenCard(token));
      row.append(name, content);
      categoryTable.appendChild(row);
    }
    return categoryTable;
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
      : "");
    if (state.englishEditing) {
      if (document.activeElement !== englishEditor && !state.englishEditorDirty) englishEditor.value = text;
      return;
    }

    englishTokenView.replaceChildren();
    if (!state.tokens.length) {
      englishTokenView.appendChild(element("span", "bpi-mirror-empty", "Linked tags will appear here after you finish editing English."));
      return;
    }
    if (state.categoryView) {
      englishTokenView.appendChild(buildCategoryTable());
      requestAnimationFrame(() => autoFitGreenArea(englishTokenView, 92));
      return;
    }
    let line = null;
    const currentLine = () => {
      if (!line) {
        line = element("div", "bpi-token-line");
        englishTokenView.appendChild(line);
      }
      return line;
    };
    for (const [index, token] of state.tokens.entries()) {
      currentLine().appendChild(buildTokenCard(token));
      const next = state.tokens[index + 1];
      if (!next) continue;
      if (gapHasBreak(index)) {
        // 换行块：它自己独占行尾，后面的标签另起一行，和「实际输出」的行结构一致
        // 换行块的落点目标同样用整张卡片：拖到中文小块上也算拖到这个标签
        currentLine().appendChild(buildBreakChip(index, englishTokenView, ".bpi-token-card"));
        line = null;
      } else {
        currentLine().appendChild(element("span", "bpi-mirror-separator", ", "));
      }
    }
    requestAnimationFrame(() => autoFitGreenArea(englishTokenView, 92));
  };

  // Drag handle for the details table rows: grab the ⠿ grip to drag a token
  // to a new position.  A drop indicator line shows the insertion point and
  // the table auto-scrolls near its edges while dragging.
  const buildRowDragHandle = (row, token) => {
    const handle = element("span", "bpi-drag-handle", "⠿");
    setTitle(handle, "Drag to reorder tags; or select then press Alt+↑/↓ to nudge");
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
      // 实时预览打开后这行会被挪走，DOM 顺序就不再等于 token 顺序；拖动前先记一份
      // 明细表不要抬起效果：行自己在原地，换位置时跟着大家一起滑过去就行
      const previewEnabled = dragPreviewTableEnabled();
      const preview = createDragPreview(row, orderedRows(), previewEnabled, { raise: false });
      const finish = () => {
        unbindDragTrackers(onMove, finish);
        row.classList.remove("bpi-dragging");
        if (indicator) {
          indicator.remove();
          indicator = null;
        }
        // 先收口：把攒着的那一步落到 DOM 上，让眼前顺序 = 即将写入的文本顺序，
        // 再清掉让位动画残留（内联 transition / transform）
        preview.settle();
        const committed = active && targetIndex !== null ? moveTokenTo(token, targetIndex) : false;
        if (!committed) {
          // 没搬动：把预览挪出来的错位收回去
          preview.restore();
        } else {
          // 眼前顺序已经等于新文本，同步重排不会挪动任何东西 —— 松手时不闪回起点
          renderNow();
        }
        preview.land();
      };
      const onMove = (moveEvent) => {
        if (!row.isConnected) {
          finish();
          return;
        }
        if (!active) {
          // 阈值同样调高一点，避免点着手柄轻轻一动就进入拖动
          if (Math.abs(moveEvent.clientX - startX) < 6 && Math.abs(moveEvent.clientY - startY) < 6) return;
          active = true;
          row.classList.add("bpi-dragging");
          indicator = element("div", "bpi-drop-indicator");
          table.appendChild(indicator);
          preview.lift(moveEvent.clientX, moveEvent.clientY);
        }
        moveEvent.preventDefault();
        const tableRect = table.getBoundingClientRect();
        if (moveEvent.clientY < tableRect.top + 28) table.scrollTop -= 9;
        else if (moveEvent.clientY > tableRect.bottom - 28) table.scrollTop += 9;
        const rows = orderedRows();
        let anchorRow = null;
        for (const candidate of rows) {
          // 自己不算落点：行被挪过去后光标正好停在自己身上，再把自己当锚点会算回原位来回跳
          if (candidate === row) continue;
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
        preview.track(moveEvent.clientX, moveEvent.clientY, targetIndex);
      };
      bindDragTrackers(onMove, finish);
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

  // 眼睛 + 斜线 = 已隐藏，点击取消隐藏
  const buildEyeOffIcon = () => {
    const icon = element("span", "bpi-eye-icon bpi-eye-off");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
      '<path d="M12 5C6.5 5 2.5 10.5 2 12c.5 1.5 4.5 7 10 7s9.5-5.5 10-7c-.5-1.5-4.5-7-10-7z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="12" r="3" fill="currentColor"/>' +
      '<line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    return icon;
  };

  // Details-table row button: toggle this tag's hidden mark. Hidden tags stay in
  // the list (strikethrough, faded) and are only excluded from the actual output.
  const buildRowHideButton = (token) => {
    const tokenHidden = isTokenHidden(token);
    const hide = element("span", tokenHidden ? "bpi-hide-btn bpi-hide-btn-off" : "bpi-hide-btn");
    hide.appendChild(tokenHidden ? buildEyeOffIcon() : buildEyeIcon());
    setTitle(hide, tokenHidden
      ? `Unhide “${token.raw}”: back into the actual output`
      : `Hide “${token.raw}”: keeps it visible here (strikethrough) but excludes it from the actual output`);
    hide.addEventListener("click", (event) => {
      event.stopPropagation();
      if (isTokenHidden(token)) unhideToken(token);
      else hideToken(token);
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
    setTitle(label, "These tags stay visible above (strikethrough) but will not enter the actual output; click a tag to unhide");
    container.appendChild(label);
    for (const [index, item] of hidden.entries()) {
      // 还在文本里 → 点击就是取消隐藏；旧版工作流里不在文本的 → 点击插回原位
      const inText = state.tokens.some((token) => hiddenEntryMatches(item, token));
      const chip = element("span", "bpi-hidden-chip");
      // 胶囊改成单行截断后长提示词会显示不全，完整内容放进 tooltip
      const full = item.chinese ? `“${item.raw}” — “${item.chinese}”` : `“${item.raw}”`;
      setTitle(chip, inText
        ? `Click to unhide ${full}`
        : `Click to restore ${full} to its original position`);
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
    setTitle(restoreAll, `Unhide all ${hidden.length} hidden tags`);
    container.appendChild(restoreAll);
  };

  // 问题行里的「唯一」开关：打开后只有第一次出现进入实际输出。文本本身不动，
  // 所以 undo 条目 before === after，和隐藏/恢复一样只回滚记的那份名单。
  const toggleUniqueKey = (key, on, term) => {
    const keys = getUniqueKeys();
    const after = on ? [...keys.filter((item) => item !== key), key] : keys.filter((item) => item !== key);
    pushHistoryWithHidden({
      before: String(textWidget.value ?? ""),
      after: String(textWidget.value ?? ""),
      beforeStart: 0,
      beforeEnd: 0,
      afterCursor: 0,
      label: on ? `只保留第一次出现的「${term}」` : `恢复「${term}」的重复项`,
      uniqueBefore: keys.slice(),
      uniqueAfter: after,
    });
    setUniqueKeys(after);
    render();
    // 「唯一」开关的反馈走右下角橙色提示条；关掉时退回右上角弹窗，并给足 5 秒、连点刷新重计时
    const uniqueMsg = on ? `“${term}” now unique` : `“${term}” no longer unique`;
    if (!showToast(uniqueMsg, { type: "duplicate" })) {
      setStatus(uniqueMsg, "ok", { group: `bpi-unique-${node.id ?? "x"}`, hold: 5000 });
    }
  };

  const buildUniqueToggle = (key, group) => {
    const term = group?.tokens[0]?.term ?? key;
    const label = element("label", "bpi-source-toggle bpi-unique-toggle");
    const box = element("input");
    box.type = "checkbox";
    box.checked = isUniqueKey(key);
    label.append(box, element("span", "", "Unique"));
    setTitle(label, `Keep only the first “${term}” in the actual output; later occurrences stay here with a strikethrough`);
    box.addEventListener("click", (event) => event.stopPropagation());
    box.addEventListener("change", () => toggleUniqueKey(key, box.checked, term));
    return label;
  };

  // 重复栏里单击：从「没定位」到第 1 处，之后每次往后挪一处，到底就回第 1 处。
  // 顺带 activateToken 把提示词那边联动选中，便于直接改权重/拖动。
  const focusNextDuplicate = (key) => {
    const group = state.duplicateGroups.find((item) => item.key === key);
    if (!group) { state.dupFocus = null; return; }
    const current = state.dupFocus?.key === key ? state.dupFocus.index : -1;
    const next = current < 0 ? 0 : (current + 1) % group.tokens.length;
    state.dupFocus = { key, index: next };
    const token = group.tokens[next];
    activateToken(token);
    // 连点胶囊时右上角那张卡就地换内容（像多选翻译那样），并从最后一次点击起重新计 5 秒
    setStatus(
      `“${token.term}” occurrence ${next + 1} of ${group.tokens.length}; click again for the next one, double-click to delete it`,
      "ok",
      { group: `bpi-dup-${node.id ?? "x"}`, hold: 5000 },
    );
  };

  // 双击删掉当前定位到的那一处；没先单击定位过就不动，避免手滑删内容
  const deleteFocusedDuplicate = (key) => {
    if (state.dupFocus?.key !== key) {
      setStatus("Click a duplicate chip once to step to it before double-clicking to delete", "error");
      return;
    }
    const group = state.duplicateGroups.find((item) => item.key === key);
    const token = group?.tokens[state.dupFocus.index];
    if (!token) return;
    state.dupFocus = null;
    deleteTokenOccurrence(token);
  };

  // 英文标签区下面的「重复」栏：单击胶囊会顺带选中提示词里那一个标签，所以它的
  // 空白处也得像提示词那样「点一下就取消」，否则选中了就没法干净地退出来。
  const clearDuplicateFocus = () => {
    state.dupFocus = null;
    state.dupFocusId = null;
  };

  const renderDupBar = (container) => {
    if (!container) return;
    const groups = state.duplicateGroups;
    container.replaceChildren();
    if (!groups.length) {
      container.classList.add("bpi-hidden");
      return;
    }
    container.classList.remove("bpi-hidden");
    container.appendChild(element("span", "bpi-dup-label", `Duplicates ${groups.length}`));
    for (const group of groups) {
      const armed = state.dupFocus?.key === group.key;
      const term = group.tokens[0].term;
      const unique = isUniqueKey(group.key);
      const chip = element("span", `bpi-dup-chip${armed ? " bpi-dup-armed" : ""}${unique ? " bpi-dup-chip-unique" : ""}`);
      chip.appendChild(element("span", "bpi-dup-en", term));
      // 定位到某一处之后，数字位置直接换成「第几处 / 共几处」，不再显示 ×N
      if (armed) chip.appendChild(element("span", "bpi-dup-index", `${state.dupFocus.index + 1}/${group.tokens.length}`));
      else chip.appendChild(element("span", "bpi-dup-count", `×${group.tokens.length}`));
      if (unique) chip.appendChild(element("span", "bpi-dup-flag", "Unique"));
      setTitle(chip, armed
        ? `“${term}” appears ${group.tokens.length} times; now at ${state.dupFocus.index + 1}, click for the next one, double-click to delete it`
        : unique
          ? `“${term}” appears ${group.tokens.length} times; “Unique” is on, only the first reaches the actual output`
          : `“${term}” appears ${group.tokens.length} times; click to jump to the first one`);
      // 双击会先送两个 click：把第二个吃掉，不然第 2 下会把定位挪走再删。
      let clickTimer = null;
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        clickTimer = setTimeout(() => { clickTimer = null; focusNextDuplicate(group.key); }, 220);
      });
      chip.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        deleteFocusedDuplicate(group.key);
      });
      container.appendChild(chip);
    }
    // 末尾撑一段空白：胶囊排满时也有地方点得到，不然就取消不掉选中了
    container.appendChild(element("span", "bpi-dup-space"));
  };

  // 点重复栏的空白处 = 取消选中（胶囊自己会吃掉 click，所以只有空白处能走到这）
  englishDupBar.addEventListener("click", (event) => {
    if (event.target !== englishDupBar && !event.target.classList?.contains("bpi-dup-space")) return;
    if (state.pinned === null && !state.dupFocus) return;
    state.pinned = null;
    clearDuplicateFocus();
    render();
  });

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
  // 新版前端里 input.link 已弃用（读了会刷警告），官方替代是
  // node.isInputConnected(slot)；老版本没有这个方法，退回读 input.link。
  const upstreamConnected = () =>
    (node.inputs ?? []).some((input, index) =>
      input.name === "prompt" &&
      (typeof node.isInputConnected === "function"
        ? node.isInputConnected(index)
        : input.link != null));

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
      setStatus(`Release failed: “${error.message}”`, "error");
    }
    renderSourceBar();
  };

  const cancelUpstreamWait = async () => {
    state.upstreamWaiting = false;
    try {
      await postUpstreamAction("cancel", node.id);
      setStatus("Discarded this upstream input", "ok");
    } catch (error) {
      setStatus(`Discard failed: “${error.message}”`, "error");
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
      setStatus(`Cannot pause for confirmation: “${error.message}”`, "error");
    }
  };

  const saveFavoriteFromNode = () => {
    const text = String(textWidget.value ?? "");
    if (!text.trim()) {
      setStatus("Prompt is empty; cannot favorite", "error");
      return;
    }
    openLibraryItemDialog({ presetKind: "prompt", presetText: text });
  };

  sourceToggle.addEventListener("change", () => {
    saveUpstreamSettings({ takeOver: sourceToggle.checked });
    renderSourceBar();
  });
  sourceSelect.addEventListener("change", () => {
    saveUpstreamSettings({ importPolicy: sourceSelect.value });
    renderSourceBar();
  });

  // 快捷添加区要等面板搭完才存在，这里先占位，render 里用可选链调用就不会撞 TDZ
  let updateQuickTarget = null;
  // 命中的片段包一层 mark。全程用文本节点拼，不碰 innerHTML —— 提示词是用户输入，
  // 走字符串拼接等于给自己开个注入口子。
  const highlightFragment = (text, needle) => {
    const source = String(text ?? "");
    const fragment = document.createDocumentFragment();
    if (!needle) {
      fragment.appendChild(document.createTextNode(source));
      return fragment;
    }
    const haystack = source.toLowerCase();
    let cursor = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, cursor)) {
      if (at > cursor) fragment.appendChild(document.createTextNode(source.slice(cursor, at)));
      const hit = document.createElement("mark");
      hit.className = "bpi-hit";
      hit.textContent = source.slice(at, at + needle.length);
      fragment.appendChild(hit);
      cursor = at + needle.length;
    }
    fragment.appendChild(document.createTextNode(source.slice(cursor)));
    return fragment;
  };
  // 问题清单：重复标签要带「唯一」开关，不能被 12 条上限挤掉，所以排在最前。
  const renderIssuePanel = () => {
    issuesPanel.replaceChildren();
    // 重复标签要带「唯一」开关，不能被 12 条的显示上限挤掉，所以排到最前面
    const duplicateIssues = state.issues.filter((item) => item.code === "duplicate");
    const otherIssues = state.issues.filter((item) => item.code !== "duplicate");
    for (const item of [...duplicateIssues, ...otherIssues].slice(0, Math.max(12, duplicateIssues.length))) {
      const issueRow = element("div", "bpi-issue", item.message);
      issueRow.dataset.severity = item.severity;
      const duplicateKey = item.code === "duplicate" ? item.tokenKeys?.[0] : null;
      if (duplicateKey) {
        issueRow.appendChild(buildUniqueToggle(duplicateKey, state.duplicateGroups.find((group) => group.key === duplicateKey)));
      }
      issuesPanel.appendChild(issueRow);
    }
    issuesPanel.classList.toggle("bpi-visible", state.issues.length > 0);
  };

  // 明细表：筛选 → 搜索计数 → 批量栏 → 逐行构建（一行一个标签，含拖拽手柄与行内按钮）。
  const renderDetailTable = () => {
    const personalKeys = new Set(state.data.user.map((tag) => normalizeKey(tag.english)));
    // 勾选跟着当前提示词走：换了文本后旧 key 留着没意义，顺手清掉
    const machineKeys = new Set(state.tokens.filter((token) => token.status === "machine").map((token) => token.key));
    for (const key of [...state.batchSelected]) if (!machineKeys.has(key)) state.batchSelected.delete(key);
    const visibleTokens = state.tokens.filter((token) => {
      if (state.tableFilter === "unknown") return token.status === "unknown";
      if (state.tableFilter === "machine") return token.status === "machine";
      if (state.tableFilter === "personal") return personalKeys.has(token.key);
      if (state.tableFilter === "favorites") return isFavorite(token.term);
      return true;
    });
    // 查找和上面的筛选是叠加关系：先按来源筛，再按关键词筛，清空关键词回到筛选结果
    const query = state.tableQuery.trim().toLowerCase();
    const searchedTokens = query
      ? visibleTokens.filter((token) => token.raw.toLowerCase().includes(query) || token.chinese.toLowerCase().includes(query))
      : visibleTokens;
    tableSearchCount.textContent = query ? `${searchedTokens.length} / ${visibleTokens.length}` : "";
    tableSearchClear.classList.toggle("bpi-visible", Boolean(query));
    renderMachineBatchBar(searchedTokens.filter((token) => token.status === "machine"));

    const errorsByKey = new Map();
    for (const item of state.issues) {
      for (const key of item.tokenKeys ?? []) {
        const current = errorsByKey.get(key);
        if (current !== "error") errorsByKey.set(key, item.severity);
      }
    }

    while (table.children.length > 1) table.lastChild.remove();
    if (!state.tokens.length) {
      table.appendChild(element("div", "bpi-empty", "Enter a prompt in the English text box above; per-tag bilingual mapping will appear here."));
    } else if (!visibleTokens.length) {
      table.appendChild(element("div", "bpi-empty", "No matching items under the current filter."));
    } else if (!searchedTokens.length) {
      table.appendChild(element("div", "bpi-empty", `No tag matches “${state.tableQuery.trim()}”`));
    } else {
      searchedTokens.forEach((token, visibleIndex) => {
        const row = element("div", `bpi-row bpi-${token.status}`);
        if (token.suspectedNatural) row.classList.add("bpi-suspected-natural");
        const tokenHidden = isTokenHidden(token);
        const tokenSuppressed = isTokenSuppressed(token);
        if (tokenHidden) row.classList.add("bpi-row-hidden");
        if (tokenSuppressed) row.classList.add("bpi-dup-off");
        if (state.dupFocusId === token.id) row.classList.add("bpi-dup-hit");
        const rowSeverity = errorsByKey.get(token.key);
        if (rowSeverity === "error") row.classList.add("bpi-has-error");
        else if (rowSeverity === "warning") row.classList.add("bpi-has-warning");
        row.dataset.tokenId = String(token.id);
        if (state.pinned === token.id) row.classList.add("bpi-pinned");
        if (inSelectionSpan(token)) row.classList.add("bpi-row-multi");
        const englishCell = element("div", "bpi-cell bpi-en");
        if (token.status === "machine") englishCell.appendChild(buildRowCheckButton(token));
        // 查找状态下不给拖拽手柄：落点是按可见行算的，藏着行会把标签挪到错误的位置
        if (state.tableFilter === "all" && !query && canReorderTokens()) {
          englishCell.appendChild(buildRowDragHandle(row, token));
        }
        if (canHideTokens()) {
          englishCell.appendChild(buildRowHideButton(token));
        }
        const chineseCell = element("div", "bpi-cell bpi-zh");
        const englishText = element("span", tokenHidden || tokenSuppressed ? "bpi-hidden-term" : "");
        englishText.appendChild(highlightFragment(token.raw, query));
        setTitle(englishText, tokenSuppressed
          ? `Query: “${token.term}” | “Unique” is on: only the first occurrence reaches the actual output`
          : `Query: “${token.term}”${token.weight === null ? "" : ` | weight: ${token.weight}`}`);
        englishText.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          // 词库里已经有这条（内置 / 词库包 / 个人，都算）：双击直接开「新增或编辑个人标签」，
          // 跟侧边栏词库里点「编辑」是同一个弹窗，别名、分类、模型这些都能一起改。
          // 还没入库的（未收录、待确认的机器翻译、特殊语法）走原来的定位到提示词。
          if (token.entry) {
            // 中文以列表里现在显示的为准：可能只是本次会话临时改过、还没存进词库
            openTagDialog({ ...token.entry, chinese: token.chinese }, refreshDictionary);
            return;
          }
          setEnglishEditing(true);
          requestAnimationFrame(() => {
            englishEditor.focus({ preventScroll: true });
            englishEditor.setSelectionRange(token.start, token.end, "forward");
          });
          setStatus(`Located: “${token.term}”`, "ok");
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
          return; // forEach 里不能用 continue；这里跳过本条剩余的渲染逻辑
        }
        const chineseText = element("span", "");
        chineseText.appendChild(highlightFragment(token.chinese, query));
        setTitle(chineseText, "Double-click to edit Chinese explanation");
        chineseText.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          if (token.syntax === "tag" && token.status !== "special") beginInlineEdit(token);
        });
        chineseCell.appendChild(chineseText);

        // 未收录不再单独挂「未收录」徽章：中文列已经有占位文案，状态由置信度徽章
        // （「未判定」）表达即可，来源未知时也不再挂「未知来源」占位置。
        const badgeLabels = {
          machine: "Machine",
          unverified: "Pending",
          special: "Syntax",
        };
        if (badgeLabels[token.status]) chineseCell.appendChild(element("span", "bpi-badge", badgeLabels[token.status]));
        if (token.suspectedNatural) chineseCell.appendChild(element("span", "bpi-badge bpi-suspected", "Suspected"));
        if (token.weight !== null) chineseCell.appendChild(element("span", "bpi-badge", `Weight ${token.weight}`));
        const origin = token.entry?.pack_name ?? sourceLabel(token.source, token.status);
        if (origin !== "Unknown source") {
          const sourceBadge = element("span", "bpi-badge bpi-source", origin);
          setTitle(sourceBadge, token.status === "machine"
            ? "Generated by the assistant currently configured in the bilingual inspector; not yet saved to the personal dictionary"
            : `Explanation source: “${origin}”`);
          chineseCell.appendChild(sourceBadge);
        }
        const confidenceBadge = element("span", `bpi-badge bpi-confidence-${token.confidence}`, token.confidenceLabel);
        setTitle(confidenceBadge, token.confidenceReason);
        chineseCell.appendChild(confidenceBadge);

        const actions = element("span", "bpi-inline-actions");
        if (token.status === "unknown" && !/[\u3400-\u9fff]/.test(token.term)) {
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
          actions.append(addButton, translateButton);
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
        row.addEventListener("click", (event) => {
          activateToken(token, { additive: event.ctrlKey || event.metaKey });
        });
        table.appendChild(row);
        // 当前 token 与下一个 token 之间的 gap 有换行，就在这里插一行换行行。
        // 只在"全部"过滤下显示——别的过滤会把 token 打散，gap 下标对不上。
        // tableFilter==='all' 时 visibleIndex 就是 state.tokens 里的下标，两者一致。
        if (state.tableFilter === "all" && canReorderTokens() && gapHasBreak(visibleIndex)) {
          table.appendChild(buildBreakRow());
        }
      });
    }
  };

// ==== 主渲染（编排层）====
  const render = () => {
    renderSourceBar();
    // 输出管道跟着视图一起刷：任何文本/隐藏列表变化最后都会走到 render，
    // 在这里统一同步，漏不了（updateText / 隐藏 / 恢复 / 加载工作流都会触发 render）
    syncEffectiveOutput();
    const text = String(textWidget.value ?? "");
    state.lastText = text;
    // 排序完又手动改了文本，「回到排序前」会把这些改动一起吞掉，取消入口随之失效
    if (state.animaSortSnapshot && text.trim() !== state.animaSortSnapshot.after) state.animaSortSnapshot = null;
    state.modeInfo = detectInputMode(text, state.modePreference);
    // 按钮显隐依赖 modeInfo，必须排在它更新之后
    updateSortButton();
    state.tokens = parseTokens(text);
    queueLargeLookup(state.tokens);
    // 重复分组要在渲染两个视图之前算好，标签区和明细表都吃这份数据
    state.duplicateGroups = duplicateGroups(state.tokens);
    state.duplicateRanks = new Map();
    for (const group of state.duplicateGroups) {
      group.tokens.forEach((token, index) => state.duplicateRanks.set(token.id, { rank: index, total: group.tokens.length }));
    }
    // 定位过的那一处被删了 / 文本换了不够那么多处了，就把定位作废
    if (state.dupFocus) {
      const group = state.duplicateGroups.find((item) => item.key === state.dupFocus.key);
      if (!group || state.dupFocus.index >= group.tokens.length) state.dupFocus = null;
    }
    state.dupFocusId = dupFocusToken()?.id ?? null;
    state.issues = analyzePromptSyntax(text, state.tokens, state.modeInfo);
    if (state.pinned !== null && !state.tokens.some((token) => token.id === state.pinned)) state.pinned = null;
    // 多选跟着 pinned 走：没有当前标签就整组清空（改文本、撤销等路径都是这么清的），
    // 否则顺手丢掉已经不存在的 id，并保证 pinned 一定在名单里
    if (state.pinned === null) {
      state.selected.clear();
    } else {
      const liveIds = new Set(state.tokens.map((token) => token.id));
      for (const id of [...state.selected]) if (!liveIds.has(id)) state.selected.delete(id);
      if (!state.selected.has(state.pinned)) {
        state.selected.clear();
        state.selected.add(state.pinned);
      }
    }
    updateQuickTarget?.();
    renderEnglishTokenView(text);
    if (hasNodeSize()) requestNodeResize();
    renderIssuePanel();
    renderDetailTable();
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
    renderDupBar(englishDupBar);
  };

  const scheduleRender = (immediate = false) => {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(render, immediate ? 0 : 180);
  };

  // 同步重排：render 走的是 setTimeout(0)，等它排到时浏览器可能已经把「改动前的旧样子」
  // 画出来一帧了（拖动松手时看到的就是那一下闪回起点）。这里插队立刻刷一次，
  // 并取消排队中那次，免得紧接着又重建一遍 DOM。
  const renderNow = () => {
    if (state.renderTimer) {
      clearTimeout(state.renderTimer);
      state.renderTimer = null;
    }
    render();
  };

  // 把常用回调交给 store：拆出去的功能模块从 store.hooks 取，不必再走参数表。
  // 必须放在这些函数都定义完之后，否则 bind 进去的还是占位函数。
  bindStoreHooks(store, {
    render,
    updateText,
    setStatus,
    applyTokenWeight,
    spanForEdit,
    refreshDictionary,
    setEnglishEditing,
    moveTokenTo,
    canReorderTokens,
    gapHasBreak,
  });

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

// ==== 词库搜索与明细表 ====
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
      const usage = Number(tag.post_count) > 0 ? ` ·  · ${t(`uses “${Number(tag.post_count).toLocaleString()}”`)}` : "";
      const metaText = [t(tag.category), t(tag.pack_name ?? sourceLabel(tag.source)), ...(format ? [t(format)] : [])].join(" · ");
      meta.appendChild(element("span", "", `${metaText}${usage}`));
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
    });
    // 不设数量上限：以前砍到 30 是为了躲插件自己的 30/60 计数器，现在百度走 QPS 节流、
    // AI 撞限流会自动等窗口滑过去重试，没必要再让用户多点一次
    if (!unknown.length) {
      setStatus("No unknown tags currently", "ok");
      return;
    }
    control.disabled = true;
    let completed = 0;
    try {
      // 一个一个来：后端按 QPS 排队，慢但不会撞百度 54003，界面也能逐条看到进度
      // 右上角只挂一张「总进度」卡，逐条结果走右下角（quiet），收尾再换一张新卡报总数
      const groupKey = `bpi-translate-${node.id ?? "x"}`;
      for (let index = 0; index < unknown.length; index += 1) {
        setStatus(`Translating unknown tags ${index + 1}/${unknown.length}：“${unknown[index].term}”`, "busy", { group: groupKey });
        if (await translateToken(unknown[index], { quiet: true })) completed += 1;
      }
      const rejected = unknown.length - completed;
      const summary = rejected
        ? `Translation complete ${completed} items, rejected abnormal results ${rejected} items`
        : `Translation complete ${completed} items`;
      // fresh：先让进度卡退场，再开一张全新的报「翻译了多少条」
      setStatus(summary, rejected ? "error" : "ok", { group: groupKey, fresh: true });
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
  // 只有节点主视图的卡会着色，侧边栏明细表不受影响。
  // 颜色不占侧边栏分区（那边已经够挤了）：这里一个按钮，点一下就在过滤栏下面原地展开，
  // 跟左边那排筛选按钮一个操作逻辑——选了立刻生效，不弹窗。
  const colorSeparator = element("span", "bpi-filter-sep");
  filtersBar.appendChild(colorSeparator);
  const colorButton = element("button", "bpi-button bpi-dropdown-trigger");
  colorButton.type = "button";
  colorButton.append(
    element("span", "", t("Colors")),
    element("span", "bpi-dropdown-caret", "▾"),
  );
  setTitle(colorButton, t("Colors"));
  // 面板内容每次展开都重建，这样词库增删、配色被别处改过都能立刻反映出来
  const colorPanel = element("div", "bpi-color-panel");
  colorPanel.hidden = true;
  colorButton.addEventListener("click", () => {
    colorPanel.hidden = !colorPanel.hidden;
    colorButton.classList.toggle("bpi-color-open", !colorPanel.hidden);
    if (colorPanel.hidden) return;
    colorPanel.replaceChildren(buildColorPanel({
      data: state.data,
      colors: state.tokenColors,
      mode: state.colorMode,
      onChange: (nextMode, savedColors) => {
        state.colorMode = nextMode;
        localStorage.setItem("bpi.colorMode", nextMode);
        if (savedColors) state.tokenColors = savedColors;
        // 切到随机 → 重新摇一轮；切走 → 清掉旧的随机色，下次回来再摇
        state.randomColors.clear();
        render();
        // 让画布上其它检查器节点也重新拉一次配色，别只有这一个变
        panelSyncHub.notify("colors", state.syncSource);
      },
    }));
  });
  filtersBar.appendChild(colorButton);
  // 「适应高度」跟着明细表走：明细表被侧边栏「标签管理」复用，开关也就在那边，
  // 跟着所选节点换（每个节点一份实例 + 状态存在 node.properties 上）
  filtersBar.appendChild(fillSwitchRow);
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
  // 侧边栏「标签管理」复用的就是这份 detailsBody，而它自己就在侧边栏里，
  // 再放一个跳去词库的按钮和点顶部「词库」页签是同一件事，故不保留。
  rightTools.append(
    button("Refresh dictionary", refreshDictionary),
  );
  toolbar.append(leftTools, rightTools);
  modeSelect.value = state.modePreference;
  searchLine.append(modeSelect, searchLabel, search);
  summary.append(counts, modeInfo, status);
  detailsBody.append(toolbar, searchLine, results, summary, filtersBar, colorPanel, machineBatchBar, issuesPanel, tableSearch, table, detailsHiddenBar);
  // 底部快捷输入：中文先翻译再追加，英文直接追加。只挂在节点面板上，
  // 明细表（detailsBody）才会被侧边栏「标签管理」复用，这个输入框不会跟着过去。
  const quickSection = element("section", "bpi-quick-section");
  const quickHead = element("div", "bpi-quick-head");
  quickHead.append(
    element("span", "", "Quick add"),
    element("span", "bpi-quick-hint", "Enter to add | Shift+Enter for a new line | Ctrl+Enter to translate & optimize"),
  );
  const quickRow = element("div", "bpi-quick-row");
  const quickInput = element("textarea", "bpi-quick-input");
  quickInput.rows = 2;
  setPlaceholder(quickInput, "Type Chinese to translate it into English tags, or type English tags to add them directly");
  const quickButton = button("Add", () => submitQuickInput("translate"), "bpi-primary");
  quickRow.append(quickInput, quickButton);
  // 落点提示：加之前就让用户看见新标签会落在哪，省得猜
  const quickTarget = element("div", "bpi-quick-target");
  quickSection.append(quickHead, quickRow, quickTarget);
  updateQuickTarget = () => {
    const token = state.tokens.find((item) => item.id === state.pinned);
    quickTarget.classList.toggle("bpi-quick-target-linked", Boolean(token));
    if (token) {
      const term = token.term ?? token.raw;
      setText(quickTarget, `Insert after “${term}”`);
      setTitle(quickTarget, `The new tag goes right after “${term}”`);
    } else {
      setText(quickTarget, "Add to the end (no tag selected)");
      setTitle(quickTarget, "No tag is selected, so the new tag goes at the end of the prompt");
    }
  };
  updateQuickTarget();
  let quickBusy = false;
  // 快捷添加的落点：选中了标签就插到它后面（token.end 是它在原文里的结束位置），
  // 没选中、或选中的标签已经不在文本里，就落到末尾 —— 判定跟「插入换行」按钮一致。
  // 中文要先翻译，是异步的，所以位置只能在真正插入那一刻算：提前算的话，等翻译那几秒里
  // 用户点了别的标签，新标签就会插到旧位置上。
  const insertPieceAtTarget = (current, piece) => {
    const token = state.tokens.find((item) => item.id === state.pinned);
    const at = token?.end;
    if (Number.isInteger(at) && at > 0 && at <= current.length) {
      return `${current.slice(0, at)}, ${piece}${current.slice(at)}`;
    }
    const trimmed = current.replace(/[\s,，]+$/u, "");
    return trimmed ? `${trimmed}, ${piece}` : piece;
  };
  const appendToPrompt = (piece) => {
    withInsertAnim(() => updateText(insertPieceAtTarget(String(textWidget.value ?? ""), piece)));
  };
  async function submitQuickInput(mode = "translate") {
    if (quickBusy) return;
    const raw = quickInput.value.trim();
    // 快捷添加全程只走右下角提示条：这里没有需要逐条盯的结果，
    // 动不动作右上角弹窗都只是白占一块屏幕
    const warn = (message) => {
      if (!showToast(message, { type: "error" })) setStatusQuiet(message, "error");
    };
    if (!raw) {
      warn("先输入中文或英文标签");
      return;
    }
    if (!containsChinese(raw)) {
      appendToPrompt(raw);
      quickInput.value = "";
      const addedMsg = `已添加「${raw}」`;
      if (!showToast(addedMsg, { type: "insert" })) setStatusQuiet(addedMsg, "ok");
      quickInput.focus({ preventScroll: true });
      return;
    }
    quickBusy = true;
    quickButton.disabled = true;
    // 翻译过程只写状态栏：右上角那张「处理中」是常驻卡，用完没人收
    setStatusQuiet(`正在翻译「${raw}」…`, "busy");
    try {
      const translated = await runInspectorAssistant(mode === "optimize" ? "translate_optimize" : "translate", raw);
      const validation = validateTranslationResult(raw, translated, {});
      if (!validation.ok) {
        warn(`翻译结果异常，已拒绝：「${validation.reason}」`);
        // 被拒这一种另外开一张右上角弹窗，把模型原样返回的内容贴出来：
        // 判断是翻译跑偏了，还是校验规则太严，光看 reason 看不出来
        notify(`「${raw}」的翻译结果被拒绝：${validation.reason}\n模型返回：${translated}`, "error", { hold: 8000 });
        return;
      }
      const english = validation.text.replace(/[\s,，]+$/u, "").trim();
      if (!english) {
        warn("翻译结果为空");
        return;
      }
      appendToPrompt(english);
      // 写进机器翻译缓存，标签管理「机器翻译」页就能看到并勾选入库个人词库
      setMachineTranslation(normalizeKey(english), {
        english,
        text: raw,
        source: "bpi-assistant",
        createdAt: Date.now(),
      });
      quickInput.value = "";
      const addedMsg = `已添加「${english}」`;
      if (!showToast(addedMsg, { type: "insert" })) setStatusQuiet(addedMsg, "ok");
      quickInput.focus({ preventScroll: true });
    } catch (error) {
      warn(error.message);
    } finally {
      quickBusy = false;
      quickButton.disabled = false;
    }
  }
  quickInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    submitQuickInput(event.ctrlKey || event.metaKey ? "optimize" : "translate");
  });
  panel.append(englishSection, quickSection, aboutFooter);
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
  setTitle(englishTokenView, "Click a tag to link it with the detail table below; select then press Delete");
  setTitle(englishEditor, "Stay in text editing while typing; switch to tag view on blur or after clicking Done");
  englishTokenView.addEventListener("click", (event) => {
    // 分行之后空白处的点击目标是行容器，也算点在空白处
    if (event.target !== englishTokenView && !event.target.classList?.contains("bpi-token-line")) return;
    state.pinned = null;
    // 重复栏里定位到的那一处属于同一个选中语义，一起退掉，不然红标记会一直挂着
    clearDuplicateFocus();
    render();
  });
  const bindMirrorAction = (control, action) => control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  setTitle(optimizeButton, "Optimize with the rule for the current mode: tag mode tidies the tag flow, natural language mode rewrites it as English sentences");
  bindMirrorAction(optimizeButton, runOptimize);
  fillSwitch.checked = state.fillHeight;
  setTitle(fillSwitchRow, state.fillHeight
    ? "Back to the automatic height; the prompt area stops following the node"
    : "Let the prompt area grow with the node instead of being capped");
  panel.classList.toggle("bpi-fill", state.fillHeight);
  fillSwitch.addEventListener("change", () => setFillHeight(fillSwitch.checked));
  bindMirrorAction(sortPromptButton, () => {
    if (state.animaSortSnapshot) cancelAnimaSort();
    else sortByAnimaOrder();
  });
  updateSortButton();
  setTitle(editEnglishButton, "Switch between the English text editor and the linked tag view");
  setTitle(clearEnglishButton, "Requires a second click to clear the actual English output; after clearing, click the same button to undo");
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
  search.addEventListener("input", renderSearch);
  search.addEventListener("focus", renderSearch);
  const clearTableSearch = () => {
    tableSearchInput.value = "";
    state.tableQuery = "";
    render();
  };
  tableSearchInput.addEventListener("input", () => {
    state.tableQuery = tableSearchInput.value;
    render();
  });
  tableSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !tableSearchInput.value) return;
    // 节点里按 Esc 会被画布当成取消，这里自己吃掉
    event.preventDefault();
    event.stopPropagation();
    clearTableSearch();
  });
  tableSearchClear.addEventListener("click", () => {
    clearTableSearch();
    tableSearchInput.focus({ preventScroll: true });
  });
  modeSelect.addEventListener("change", () => {
    state.modePreference = modeSelect.value;
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    if (state.modePreference === "auto") delete node.properties.bpiMode;
    else node.properties.bpiMode = state.modePreference;
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
    } else if (kind === "colors") {
      // 侧边栏改完配色：缓存已被保存接口清掉，这里重新拉一次就能立刻看到
      const colors = await loadTokenColors();
      state.tokenColors = colors;
      render();
    }
  };

// ==== 事件绑定与对外接口 ====
  const unsubscribePanelSync = panelSyncHub.subscribe(syncFromPeer);

  refreshDictionary(false);
  // 颜色池单独读一次，失败就静默回退内置默认
  loadTokenColors().then((colors) => { state.tokenColors = colors; render(); }).catch(() => {});
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
      // 适应高度模式把上限抬高：两者相等时 ComfyUI 只按下限给，拉大节点多出来的空间全变空白
      return state.fillHeight ? EXPANDED_WIDGET_MAX_HEIGHT : state.collapsedWidgetHeight;
    },
    refreshAfterConfigure() {
      // Workflow files keep the hidden-tag list in node.properties; make sure
      // the bar is drawn even when the text itself did not change.
      getHiddenTags();
      // 工作流里的模式偏好要先回到下拉，否则按钮显隐会退回「自动」那一套
      state.modePreference = storedMode();
      modeSelect.value = state.modePreference;
      // 工作流里的「适应高度」也要还原回按钮和面板 class
      state.fillHeight = storedFillHeight();
      panel.classList.toggle("bpi-fill", state.fillHeight);
      fillSwitch.checked = state.fillHeight;
      scheduleRender(true);
    },
    syncSourceBar() {
      syncSourceBar();
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

// ── 这个文件怎么读 ─────────────────────────────────────────────────────────
// 界面逻辑都在 createPanel 这一个闭包里（DOM 构建 + 事件绑定 + 渲染编排）。
// 搜 "====" 跳段；纯逻辑与独立功能已经拆到 js/ 下的 7 个模块：
//   bpi_store.js        每节点一份 state / 偏好 / hooks；回调一律 store.hooks.xxx()
//   bpi_node_size.js    节点尺寸与高度（12 个函数，refs 收 6 个 DOM）
//   bpi_line_breaks.js  换行块数据层
//   bpi_editor_modal.js 标签编辑弹窗（权重与颜色 / 编辑 / 词条信息）
//   bpi_chip_drag.js    拖拽与实时预览
//   bpi_hidden.js       隐藏标签 /「唯一」开关 / 输出管道（effective_text）
//   bpi_shortcut.js     撤销重做与顺序微调
// 主文件留下的：面板骨架 DOM、文本入口（updateText / render / renderNow）、
//   卡片与明细表渲染、词库搜索、事件绑定、registerExtension。
// 改之前先看 tests/：parser 层有断言，UI 层只能手测（拖拽落点尤其容易改坏）。
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
      // widget.label 直接赋值，不经过 element()/set*()，也就不会走翻译层，
      // 所以这里直接写死中文（面板里的同名标题走 element()，由 i18n 处理）。
      // 叫「实际输入」而不是「实际输出」：这里显示的是编辑用的完整文本，
      // 隐藏的标签仍然在里面，真正剔除后的输出由 effective_text 送出去。
      textWidget.label = "英文提示词（实际输入）";
      // effective_text / use_effective 是 Python 侧声明的输出管道 widget（隐藏标签
      // 剔除后的文本从这里走），不应出现在节点上，三种手段一起压扁隐藏。
      for (const name of ["effective_text", "use_effective"]) {
        const pipe = this.widgets?.find((widget) => widget.name === name);
        if (!pipe) continue;
        pipe.type = "hidden";
        pipe.hidden = true;
        pipe.computeSize = () => [0, -4];
      }

      bindUpstreamListener();
      const inspector = createPanel(this, textWidget);
      this._bilingualPromptInspector = inspector;
      // 记下出厂标题。用户在画布上双击节点标题改名后 node.title 会跟着变，
      // 侧边栏拿这个当基准，才能判断「这是用户自己起的名字」。
      inspector.defaultNodeTitle = this.constructor?.title ?? this.title;
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

    // 上游输入连上/断开时立刻刷新来源栏。以前只靠 onDrawForeground 每帧轮询，
    // 而 Nodes 2.0（Vue Nodes）不再走 canvas 绘制，那个回调根本不跑，来源栏
    // 只能等输入文字/刷新/运行才更新。onConnectionsChange 是官方回调，
    // 连接与断开都会触发，且与渲染模式无关。
    const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      originalConnectionsChange?.apply(this, arguments);
      this._bilingualPromptInspector?.syncSourceBar?.();
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
