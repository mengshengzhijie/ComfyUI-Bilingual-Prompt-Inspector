// 节点状态与偏好：每个面板（每个节点）一份，由 createStore 建。
//
// 为什么要这一个文件：主文件里所有逻辑都在 createPanel 的闭包里，拆功能模块时
// 得把 state、render、updateText… 一长串闭包变量当参数传进去。把这些放进 store，
// 新模块只要拿一个 store 就能干活，参数表不再随功能膨胀。
//
// hooks 里的函数由主文件在各处定义完以后通过 bindStoreHooks 填进来，
// 所以模块调用时必须写 `store.hooks.render()`，不能提前解构（那时还是空的）。
import { loadPreferences } from "./bpi_shared.js";
import { panelSyncHub } from "./panel_sync.js";

// 「适应高度」关掉时面板的高度上限，state 初始化要用，主文件也读它
export const COLLAPSED_WIDGET_FALLBACK_HEIGHT = 390;
// 节点尺寸的下限与「适应高度」打开时至少撑高的量：节点尺寸模块与主文件都要用，
// 放在这里导出，避免两个模块互相 import 造成循环依赖
export const FILL_HEIGHT_MIN_GROWTH = 200;
export const COLLAPSED_NODE_MIN_HEIGHT = 360;

export function createStore({ node, textWidget }) {

  // 模式跟着节点存：工作流保存后重开仍是上次选的那一档，没存过就回到自动检测
  const storedMode = () => {
    const value = node.properties?.bpiMode;
    return ["tags", "natural"].includes(value) ? value : "auto";
  };
  // 「适应高度」也跟着节点存：工作流重开后仍是上次那个状态
  const storedFillHeight = () => node.properties?.bpiFillHeight === true;

  const state = {
    data: { tags: [], builtin: [], user: [], packs: [] },
    index: new Map(),
    tokens: [],
    machine: panelSyncHub.machineTranslations,
    translating: new Set(),
    pinned: null,
    // Ctrl+点出来的多选，存 token.id；pinned 那一个恒在其中
    selected: new Set(),
    lastText: null,
    renderTimer: null,
    modePreference: storedMode(),
    fillHeight: storedFillHeight(),
    modeInfo: { mode: "tags", reason: "Empty input", confidence: "high" },
    issues: [],
    localOverrides: new Map(),
    editing: null,
    preferences: loadPreferences(),
    tableFilter: "all",
    // 明细表查找词：只筛视图，不进任何持久化数据
    tableQuery: "",
    filterButtons: new Map(),
    // 表格里勾选待入库的机器翻译词条，只存 token.key
    batchSelected: new Set(),
    // 重复分组（render 里重算）与每个 token 在组里的次序：token.id → { rank, total }
    duplicateGroups: [],
    duplicateRanks: new Map(),
    // 重复栏当前定位到的那一处：{ key, index }；-1 表示还没定位过
    dupFocus: null,
    dupFocusId: null,
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
    // 「按 Anima 顺序排序」写入后留一份快照 { before, after }，按钮据此变成「取消排序」；
    // 用户又手动改了文本就作废（见 render），避免回退把他后来的改动一起吞掉
    animaSortSnapshot: null,
    // 节点标签卡颜色模式：default（不着色）| status（按收录：未收录淡橙、机器翻译淡紫、已收录不变）
    // | random（从 token_colors.json 摇色）| by_pack（按标签所在词库取 pack_colors）
    colorMode: localStorage.getItem("bpi.colorMode") || "default",
    // 从后端读到的 { presets, random_pool, pack_colors }
    tokenColors: { presets: [], random_pool: [], pack_colors: {} },
    // 每个卡的双击自定义色，key = token.key；切到非默认模式时被模式覆盖
    customColors: new Map(),
    // 随机模式下每个 token.key 摇到的颜色
    randomColors: new Map(),
    englishEditing: !String(textWidget.value ?? "").trim(),
    englishEditingExplicit: false,
    englishEditorDirty: false,
    englishClearState: "idle",
    clearedEnglishEntry: null,
    assistantBusy: false,
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

  // 常用回调的占位：值由主文件 bindStoreHooks 填，调用方一律走 store.hooks.xxx()
  const hooks = {
    render: () => {},
    updateText: () => {},
    setStatus: () => {},
    applyTokenWeight: () => false,
    spanForEdit: () => null,
    refreshDictionary: async () => {},
    setEnglishEditing: () => {},
    moveTokenTo: () => false,
    canReorderTokens: () => false,
    gapHasBreak: () => false,
  };

  return { node, textWidget, state, hooks, storedMode, storedFillHeight };
}

export function bindStoreHooks(store, hooks) {
  Object.assign(store.hooks, hooks);
}
