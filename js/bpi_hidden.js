// 隐藏标签与「唯一」开关，以及它们怎么影响真正的输出。
//
// 隐藏的标签仍然留在 text 里（界面上划线显示，照常拖动/改色/改权重），
// 真正送去出图的是两个隐藏 widget：effective_text（剔除隐藏后的文本）
// 和 use_effective（上游是否采纳）。旧工作流没有这两个 widget 时直通 text。
import { duplicateGroups, normalizeKey, parsePrompt, removePromptToken, restorePromptToken } from "./parser.js";
import { showToast } from "./bpi_toast.js";

export function createHiddenTags({ store, buildTokenCard }) {
  const { state, textWidget, node } = store;
  const hooks = store.hooks;

  // ---- Hidden tags ---------------------------------------------------------
  // A hidden tag STAYS in the text (the views draw it with a strikethrough and
  // it can still be dragged / recolored / re-weighted); it is only stripped
  // from the actual output, via the effective_text/use_effective widgets that
  // syncEffectiveOutput keeps up to date.  The list lives in
  // properties.bpiHiddenTags so it survives workflow save/load, and every undo
  // entry snapshots the list so undo rolls mark and text back together.
  // Entries from older saves (whose tags were physically removed from the text
  // back then) are re-inserted at their old anchor on restore.
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

  // 隐藏条目 ↔ 当前 token 的匹配：优先按 key（normalizeKey(term)，改权重不影响），
  // 旧存档的条目没有 key，退回按 raw 匹配。
  const hiddenEntryMatches = (item, token) =>
    (item.key && token.key === item.key) || (!item.key && token.raw === item.raw);
  const hiddenIndexOf = (token) => getHiddenTags().findIndex((item) => hiddenEntryMatches(item, token));
  const isTokenHidden = (token) => hiddenIndexOf(token) >= 0;

  // ---- Duplicate tags ------------------------------------------------------
  // 重复标签走两条互不干扰的线路：
  //   1. 「唯一」开关（问题行里）：按 key 记进 node.properties.bpiUniqueKeys，
  //      打开后第 2 次及以后出现的那几次不进实际输出，界面照常显示（划线）。
  //      和隐藏标记一样按节点存，跟着工作流一起保存/读取。
  //   2. 英文标签区下面的「重复」栏：单击依次跳到每一次出现（标红 + 联动选中），
  //      已经定位过再双击就删掉当前这一处。
  const getUniqueKeys = () => {
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    if (!Array.isArray(node.properties.bpiUniqueKeys)) node.properties.bpiUniqueKeys = [];
    return node.properties.bpiUniqueKeys;
  };
  const setUniqueKeys = (nextList) => {
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    node.properties.bpiUniqueKeys = Array.isArray(nextList) ? nextList : [];
  };
  const isUniqueKey = (key) => Boolean(key) && getUniqueKeys().includes(key);

  // 同一个标签的第 2 次及以后出现，被「唯一」开关排除在输出之外
  const isTokenSuppressed = (token) => {
    const rank = state.duplicateRanks.get(token.id);
    return Boolean(rank && rank.rank > 0 && isUniqueKey(token.key));
  };

  // 重复栏当前标红的那一处所在的 token（跨 render 只记 key + 第几次，够稳）
  const dupFocusToken = () => {
    if (!state.dupFocus) return null;
    const group = state.duplicateGroups.find((item) => item.key === state.dupFocus.key);
    return group?.tokens[state.dupFocus.index] ?? null;
  };

  // ---- 输出管道 ------------------------------------------------------------
  // 隐藏的标签留在 text 里（界面上划线显示，照常拖动/改色/改权重），真正输出
  // 走两个隐藏 widget：effective_text = 剔除隐藏标签后的文本，use_effective = true。
  // 旧工作流没有它们，Python 默认直通 text，行为不变。
  const effectiveWidget = node.widgets?.find((widget) => widget.name === "effective_text") || null;
  const useEffectiveWidget = node.widgets?.find((widget) => widget.name === "use_effective") || null;
  const syncEffectiveOutput = () => {
    if (!effectiveWidget) return;
    const hidden = getHiddenTags();
    let out = String(textWidget.value ?? "");
    if (hidden.length) {
      // 每次删完重新解析，偏移才不会错；隐藏条目通常很少，代价可忽略
      for (;;) {
        const tokens = parsePrompt(out, state.index, state.machine, { mode: state.modePreference });
        const target = tokens.find((token) => hidden.some((item) => hiddenEntryMatches(item, token)));
        if (!target) break;
        const step = removePromptToken(out, target);
        if (!step.changed) break;
        out = step.text;
      }
    }
    // 「唯一」再去重：同一个 key 只留第一次出现的那一次
    const unique = getUniqueKeys();
    if (unique.length) {
      for (;;) {
        const tokens = parsePrompt(out, state.index, state.machine, { mode: state.modePreference });
        const target = duplicateGroups(tokens)
          .filter((group) => unique.includes(group.key))
          .flatMap((group) => group.tokens.slice(1))[0];
        if (!target) break;
        const step = removePromptToken(out, target);
        if (!step.changed) break;
        out = step.text;
      }
    }
    effectiveWidget.value = out;
    if (useEffectiveWidget) useEffectiveWidget.value = true;
  };

  const pushHistoryWithHidden = (entry) => {
    state.undoStack.push(entry);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
  };

  // 隐藏只是"打标记"：标签留在文本里，界面上划线显示，照常拖动/改色/改权重，
  // 只是 syncEffectiveOutput 会把它从实际输出里剔除。所以隐藏/恢复的 undo 条目
  // before === after（文本没变），撤销只回滚隐藏列表。
  const hideToken = (token) => {
    if (!token || !canHideTokens()) return false;
    if (isTokenHidden(token)) return false;
    const hidden = getHiddenTags();
    const before = String(textWidget.value ?? "");
    const entry = {
      before,
      after: before,
      beforeStart: token.start,
      beforeEnd: token.end,
      afterCursor: token.start,
      label: `隐藏「${token.term}」`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: hidden.concat([{
        raw: token.raw,
        chinese: token.chinese ?? "",
        after: null,
        key: token.key,
      }]),
    };
    pushHistoryWithHidden(entry);
    setHiddenTags(entry.hiddenAfter);
    state.pinned = null;
    hooks.updateText(before, token.start);
    // 有了右下角提示条就不用再写「点眼睛斜线图标取消隐藏」这种操作说明了
    const hiddenMsg = `已隐藏「${token.term}」`;
    if (!showToast(hiddenMsg, { type: "edit" })) hooks.setStatus(hiddenMsg, "ok");
    return true;
  };

  // 取消隐藏 = 把条目从隐藏列表里摘掉。两种形态都兼容：
  // 标签还在文本里（新模型）→ 只摘标记；旧版工作流当时把标签从文本删了 → 按旧锚点插回去。
  const restoreHiddenTag = (index) => {
    const hidden = getHiddenTags();
    const item = hidden[index];
    if (!item) return false;
    const before = String(textWidget.value ?? "");
    const inText = state.tokens.some((token) => hiddenEntryMatches(item, token));
    let after = before;
    let cursor = before.length;
    if (!inText) {
      const result = restorePromptToken(before, state.tokens, item.raw, item.after);
      if (!result.changed) return false;
      after = result.text;
      cursor = result.cursor;
    }
    const entry = {
      before,
      after,
      beforeStart: 0,
      beforeEnd: before.length,
      afterCursor: cursor,
      label: `恢复「${item.raw}」`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: hidden.filter((_, i) => i !== index),
    };
    pushHistoryWithHidden(entry);
    setHiddenTags(entry.hiddenAfter);
    hooks.updateText(after, cursor);
    const restoreMsg = inText ? `已取消隐藏「${item.raw}」` : `已把「${item.raw}」恢复到原位置`;
    if (!showToast(restoreMsg, { type: "edit" })) hooks.setStatus(restoreMsg, "ok");
    return true;
  };

  const unhideToken = (token) => {
    const index = hiddenIndexOf(token);
    return index >= 0 ? restoreHiddenTag(index) : false;
  };

  const restoreAllHiddenTags = () => {
    const hidden = getHiddenTags();
    if (!hidden.length) return false;
    const before = String(textWidget.value ?? "");
    let text = before;
    let tokens = state.tokens;
    for (const item of hidden) {
      if (tokens.some((token) => hiddenEntryMatches(item, token))) continue; // 还在文本里，只摘标记
      const step = restorePromptToken(text, tokens, item.raw, item.after);
      if (!step.changed) continue;
      text = step.text;
      tokens = parsePrompt(text, state.index, state.machine, { mode: state.modePreference });
    }
    const entry = {
      before,
      after: text,
      beforeStart: 0,
      beforeEnd: before.length,
      afterCursor: text.length,
      label: `恢复全部隐藏标签（${hidden.length}）`,
      hiddenBefore: hidden.slice(),
      hiddenAfter: [],
    };
    pushHistoryWithHidden(entry);
    setHiddenTags([]);
    state.pinned = null;
    hooks.updateText(text, text.length);
    const restoreAllMsg = `已恢复 ${hidden.length} 个隐藏标签`;
    if (!showToast(restoreAllMsg, { type: "edit" })) hooks.setStatus(restoreAllMsg, "ok");
    return true;
  };

  return {
    canHideTokens, dupFocusToken, effectiveWidget, getHiddenTags, getUniqueKeys, hiddenEntryMatches, hiddenIndexOf, hideToken, isTokenHidden, isTokenSuppressed, isUniqueKey, pushHistoryWithHidden, restoreAllHiddenTags, restoreHiddenTag, setHiddenTags, setUniqueKeys, syncEffectiveOutput, unhideToken, useEffectiveWidget,
  };
}
