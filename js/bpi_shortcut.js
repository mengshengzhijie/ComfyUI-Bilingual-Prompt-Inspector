// 撤销/重做与顺序微调：Shift+Alt+Z / Shift+Alt+Y、Alt+↑ / Alt+↓。
//
// 撤销栈的条目由各个操作自己 push（文本前后、光标、隐藏/唯一键的快照），
// 这里只负责「把最后一条回滚/重放」，以及把快捷键分派过来。
import { showToast } from "./bpi_toast.js";

// 撤销/重做用哪套修饰键由用户决定：Ctrl+Z 在 ComfyUI 里属于画布，
// 所以这里只提供几种不冲突的组合，主键固定 Z（撤销）/ Y（重做）。
const COMBO_KEY = "bpi.shortcut.undo.v1";
const COMBOS = {
  "shift+alt": { shiftKey: true, altKey: true, label: "Shift+Alt" },
  "ctrl+shift": { shiftKey: true, ctrlKey: true, label: "Ctrl+Shift" },
  "ctrl+alt": { ctrlKey: true, altKey: true, label: "Ctrl+Alt" },
  alt: { altKey: true, label: "Alt" },
  "shift": { shiftKey: true, label: "Shift" },
};

export function undoComboId() {
  try {
    const stored = localStorage.getItem(COMBO_KEY);
    return COMBOS[stored] ? stored : "shift+alt";
  } catch {
    return "shift+alt";
  }
}

export function setUndoCombo(id) {
  try {
    localStorage.setItem(COMBO_KEY, COMBOS[id] ? id : "shift+alt");
  } catch {
    // 存不了就只影响本次会话
  }
}

export function undoComboLabel() {
  return COMBOS[undoComboId()].label;
}

export function undoComboOptions() {
  return Object.entries(COMBOS).map(([id, combo]) => ({ id, label: combo.label }));
}

function comboMatches(event) {
  const combo = COMBOS[undoComboId()];
  if (event.metaKey) return false;
  return Boolean(event.ctrlKey) === Boolean(combo.ctrlKey)
    && Boolean(event.shiftKey) === Boolean(combo.shiftKey)
    && Boolean(event.altKey) === Boolean(combo.altKey);
}

export function createShortcuts({ store, setHiddenTags, setUniqueKeys }) {
  const { state, textWidget } = store;
  const hooks = store.hooks;

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
    const moved = hooks.moveTokenTo(token, upward ? index - 1 : index + 2);
    if (!moved) hooks.setStatus(upward ? `“${token.term}” is already at the front` : `“${token.term}” is already at the back`, "");
    return true;
  };

  const undoStructuredEdit = () => {
    const entry = state.undoStack.at(-1);
    if (!entry || String(textWidget.value ?? "") !== entry.after) return false;
    state.undoStack.pop();
    state.redoStack.push(entry);
    state.pinned = null;
    if (typeof entry.beforeCategoryView === "boolean") state.categoryView = entry.beforeCategoryView;
    if (Array.isArray(entry.hiddenBefore)) setHiddenTags(entry.hiddenBefore);
    if (Array.isArray(entry.uniqueBefore)) setUniqueKeys(entry.uniqueBefore);
    hooks.updateText(entry.before, entry.beforeStart);
    const undoneMsg = `已撤销：${entry.label}`;
    if (!showToast(undoneMsg, { type: "history" })) hooks.setStatus(undoneMsg, "ok");
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
    if (Array.isArray(entry.uniqueAfter)) setUniqueKeys(entry.uniqueAfter);
    hooks.updateText(entry.after, entry.afterCursor);
    const redoneMsg = `已重做：${entry.label}`;
    if (!showToast(redoneMsg, { type: "history" })) hooks.setStatus(redoneMsg, "ok");
    return true;
  };

  // 撤销/重做用 Shift+Alt+Z / Shift+Alt+Y：
  // Ctrl+Z 在 ComfyUI 里被画布自己的撤销吃掉（焦点不在文本框时甚至根本到不了这里），
  // 与其抢一个抢不过的键，不如整个让给它，换一个没人占的组合。
  const handleHistoryShortcut = (event) => {
    if (!comboMatches(event)) return;
    const key = event.key.toLowerCase();
    const handled = key === "y" ? redoStructuredEdit() : key === "z" ? undoStructuredEdit() : false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return {
    handleTokenReorderShortcut, undoStructuredEdit, redoStructuredEdit, handleHistoryShortcut,
  };
}
