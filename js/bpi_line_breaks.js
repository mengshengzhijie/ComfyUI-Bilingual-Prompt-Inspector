// 换行块的数据层：原文里的换行既不是 token、也进不了撤销栈，所以用「第 n 个标签与
// 第 n+1 个标签之间的原文片段」（gap）来定位换行。这里只读写文本与撤销栈，不碰 DOM；
// 界面上的 ↵ 块由渲染层按 gapHasBreak 决定要不要画。
export function createLineBreaks({ store }) {
  // 依赖统一从 store 取：state / textWidget 是稳定引用，回调走 store.hooks（运行时再取，
  // 因为主文件是在这些函数定义完之后才 bind 进来的）
  const { state, textWidget } = store;
  const hooks = store.hooks;
  // ---- Line breaks --------------------------------------------------------
  // 换行在原文里就是真正的 \n：parser 只把它当分隔符丢掉，所以它既不是 token
  // 也进不了撤销栈。这里给两个可视化区补一层「换行块」，让它和标签一样看得见、
  // 拖得动、删得掉。换行唯一能待的位置是第 n 个标签与第 n+1 个标签之间的原文
  // 片段（下面叫 gap），所以换行块一律用 gap 下标定位，parser 与数据格式不动。
  const breakGapCount = () => Math.max(0, state.tokens.length - 1);

  const gapSource = (gapIndex) => {
    const source = String(textWidget.value ?? "");
    const left = state.tokens[gapIndex];
    const right = state.tokens[gapIndex + 1];
    if (!left || !right) return "";
    return source.slice(left.end, right.start);
  };

  const gapHasBreak = (gapIndex) => /[\r\n]/.test(gapSource(gapIndex));

  const currentBreakGaps = () => {
    const gaps = new Set();
    for (let index = 0; index < breakGapCount(); index += 1) if (gapHasBreak(index)) gaps.add(index);
    return gaps;
  };

  // 只改写 gap：标签原文（权重、括号、自然语言整段）一个字符都不动。
  // 注意 parser 把分隔符后面的空格算进下一个 token（token.start 在空格前），
  // 所以 gap 里本来就只有 "," / "\n" 这类分隔符——去掉换行时补一个逗号就够，
  // 再补空格会出现 "a,  b" 这种双空格。
  const rebuildTextWithBreaks = (breakGaps) => {
    const source = String(textWidget.value ?? "");
    if (state.tokens.length < 2) return source;
    const first = state.tokens[0];
    const last = state.tokens[state.tokens.length - 1];
    let out = source.slice(0, first.start);
    for (const [index, token] of state.tokens.entries()) {
      out += source.slice(token.start, token.end);
      const next = state.tokens[index + 1];
      if (!next) break;
      const gap = source.slice(token.end, next.start);
      if (!/[\r\n]/.test(gap)) {
        out += breakGaps.has(index) ? "\n" : gap;
        continue;
      }
      if (breakGaps.has(index)) {
        out += gap;
        continue;
      }
      const flat = gap.replace(/[\r\n]+/g, "").trim();
      out += flat || ",";
    }
    return out + source.slice(last.end);
  };

  const replacePromptText = (nextText, label) => {
    const before = String(textWidget.value ?? "");
    if (nextText === before) return false;
    state.undoStack.push({
      before,
      after: nextText,
      beforeStart: before.length,
      beforeEnd: null,
      afterCursor: nextText.length,
      label,
    });
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    hooks.updateText(nextText);
    return true;
  };

  const applyBreakGaps = (breakGaps, label) => replacePromptText(rebuildTextWithBreaks(breakGaps), label);

  const removeBreakAt = (gapIndex) => {
    const gaps = currentBreakGaps();
    if (!gaps.delete(gapIndex)) return false;
    return applyBreakGaps(gaps, "删除换行");
  };

  const moveBreakTo = (fromGap, toGap) => {
    const gaps = currentBreakGaps();
    if (!gaps.has(fromGap)) return false;
    const target = Math.max(0, Math.min(breakGapCount() - 1, toGap));
    if (target === fromGap) return false;
    gaps.delete(fromGap);
    gaps.add(target);
    return applyBreakGaps(gaps, "移动换行");
  };

  const insertBreakFromToolbar = () => {
    if (state.englishEditing) {
      hooks.setEnglishEditing(false, true);
      hooks.render(); // setEnglishEditing 只排了个异步渲染，这里同步跑一遍拿最新的 token 偏移
    }
    if (!state.tokens.length) {
      hooks.setStatus("Enter tags first, then insert a line break", "");
      return;
    }
    const pinnedIndex = state.tokens.findIndex((item) => item.id === state.pinned);
    if (pinnedIndex >= 0 && pinnedIndex < breakGapCount()) {
      const gaps = currentBreakGaps();
      gaps.add(pinnedIndex);
      if (applyBreakGaps(gaps, "插入换行")) hooks.setStatus("Inserted a line break", "ok");
      return;
    }
    // 没选中标签，或选中的是最后一个标签（它后面没有 gap）：换行加在整段末尾。
    const source = String(textWidget.value ?? "");
    if (replacePromptText(`${source.replace(/[ \t]+$/, "")}\n`, "插入换行")) {
      hooks.setStatus("Inserted a line break", "ok");
    }
  };

  return {
    breakGapCount, gapSource, gapHasBreak, currentBreakGaps, rebuildTextWithBreaks,
    replacePromptText, applyBreakGaps, removeBreakAt, moveBreakTo, insertBreakFromToolbar,
  };
}
