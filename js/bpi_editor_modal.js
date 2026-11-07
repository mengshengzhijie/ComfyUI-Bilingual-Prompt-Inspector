// 标签编辑弹窗：权重与颜色 / 编辑原文 / 词条信息三页。
// 只负责 DOM 与交互，改文本、存词条都通过调用方传进来的钩子做。
import { buildTagFields, button, element, saveTag, setPlaceholder, setText, setTitle, t } from "./bpi_shared.js";
import { replacePromptSpan, UNKNOWN_CHINESE } from "./parser.js";
import { showToast } from "./bpi_toast.js";

export function createWeightEditor({ store }) {
  // 依赖统一从 store 取：state / textWidget 是稳定引用，回调走 store.hooks
  const { state, textWidget } = store;
  const hooks = store.hooks;
  const openWeightEditor = (token) => {
    if (!token) return;
    // 自然语言片段（以及 BREAK、<lora:…> 这类特殊语法）没有独立权重、也没有词条，
    // 所以这两个页签按 token 形态收起来，但弹窗照开：配色和整段编辑对它们一样有用
    const isPlainTag = token.syntax === "tag" && token.segmentKind !== "natural";
    const canWeight = isPlainTag && ["tags", "mixed"].includes(state.modeInfo.mode);
    const shade = element("div", "bpi-modal-shade");
    const modal = element("div", "bpi-modal");
    // 这句直接写中文：带变量 + 固定术语，走翻译层反而匹配不上，界面必须中文
    // 自然语言片段 / BREAK 这类不叫「标签」，标题换个说法免得看着别扭
    modal.appendChild(element("h3", "", isPlainTag ? `编辑标签：${token.term}` : `编辑片段：${token.term}`));

    // 多选着进来、或者双击的不是普通标签（自然语言片段）→ 直接停在编辑页：
    // 权重只对单个标签有意义，而自然语言片段本来就是整段改的
    const startOnRaw = state.selected.size > 1 || !isPlainTag;
    // Tab 切换：权重与颜色（一页管两样）/ 编辑（改这行原文）/ 词条信息（改的是整条词条）
    // 自然语言片段没有权重也没有词条，顺序改成 编辑 → 颜色
    const tabs = element("div", "bpi-editor-tabs");
    // 没有权重可改时这页只剩配色，标签也就只写「颜色」
    const tabWeight = element("button", `bpi-editor-tab${startOnRaw ? "" : " bpi-editor-tab-active"}`, canWeight ? t("Weight / color") : t("Colors"));
    const tabRaw = element("button", `bpi-editor-tab${startOnRaw ? " bpi-editor-tab-active" : ""}`, t("Edit"));
    const tabEdit = element("button", "bpi-editor-tab", t("Entry info"));
    tabWeight.type = tabRaw.type = tabEdit.type = "button";
    if (isPlainTag) tabs.append(tabWeight, tabRaw, tabEdit);
    else tabs.append(tabRaw, tabWeight);
    modal.appendChild(tabs);

    const weightPanel = element("div", `bpi-editor-panel${startOnRaw ? " bpi-hidden" : ""}`);
    // 权重那三块（说明 / 输入框 / 预设）单独装一个盒子，不能改权重时整盒收起，
    // 下半部分的配色照旧留着 —— 自然语言片段也要能上色
    const weightBlock = element("div");
    // 这句直接写中文：固定术语，走翻译层反而匹配不上
    weightBlock.appendChild(element("div", "bpi-config-note", "Anima 格式：(标签:权重)"));
    const form = element("div", "bpi-form");
    const input = element("input", "");
    input.type = "number";
    input.min = "0";
    input.max = "3";
    input.step = "0.05";
    input.value = token.weight === null ? "1" : String(token.weight);
    // 打开弹窗时这个数字是多少：只有它变了才写回权重，
    // 否则「只想换个颜色」会被顺手落成 (标签:1)
    const initialWeight = token.weight === null ? 1 : token.weight;
    form.append(element("label", "", "Weight"), input);
    weightBlock.appendChild(form);

    const presets = element("div", "bpi-weight-presets");
    for (const value of [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5]) {
      presets.appendChild(button(String(value), () => {
        input.value = String(value);
        input.focus();
      }, "bpi-mini"));
    }
    weightBlock.appendChild(presets);
    weightPanel.appendChild(weightBlock);

    // 同一页下半部分是配色：预设色块 + 自定义输入框；只在 default 模式下才看得见效果
    // 说明跟上方的「Anima 格式」一样放在控件上面
    const colorDivider = element("div", "bpi-editor-divider");
    weightPanel.appendChild(colorDivider);
    weightBlock.hidden = !canWeight;
    colorDivider.hidden = !canWeight;
    // 双击设的自定义色优先级最低：只有「默认」模式才轮到它显示，其它模式会盖住
    weightPanel.appendChild(element("div", "bpi-color-note", t("This color has the lowest priority: it only shows in Default mode; other color modes override it.")));
    const presetsRow = element("div", "bpi-color-presets");
    let pickedColor = state.customColors.get(token.key) || "";
    const customInput = element("input", "");
    customInput.value = pickedColor;
    // 统一选中态：值相同才高亮，「无」用空串，所以点它能直接清掉自定义色
    const markPicked = (value, keepInput) => {
      pickedColor = value;
      if (!keepInput) customInput.value = value;
      presetsRow.querySelectorAll(".bpi-color-swatch").forEach((s) => {
        s.classList.toggle("bpi-color-swatch-active", (s.dataset.color || "") === value);
      });
    };
    // 「无」= 不着色、跟随主题，放在预设色块最前面，一键回到默认
    const noneSwatch = element("span", "bpi-color-swatch bpi-color-swatch-none", t("None"));
    noneSwatch.dataset.color = "";
    setTitle(noneSwatch, t("None"));
    noneSwatch.addEventListener("click", () => markPicked(""));
    presetsRow.appendChild(noneSwatch);
    const presetsPool = (state.tokenColors.presets && state.tokenColors.presets.length) ? state.tokenColors.presets : ["#6b9b78"];
    for (const hex of presetsPool) {
      const swatch = element("span", "bpi-color-swatch");
      swatch.dataset.color = hex;
      if (hex === pickedColor) swatch.classList.add("bpi-color-swatch-active");
      swatch.style.background = hex;
      swatch.title = hex;
      swatch.addEventListener("click", () => markPicked(hex));
      presetsRow.appendChild(swatch);
    }
    if (!pickedColor) noneSwatch.classList.add("bpi-color-swatch-active");
    weightPanel.appendChild(presetsRow);
    const customRow = element("div", "bpi-color-custom");
    customRow.appendChild(element("span", "", t("Custom")));
    setPlaceholder(customInput, "#5b8a72 or rgb(91,138,114)");
    customInput.addEventListener("input", () => {
      // keepInput：正在打字就不要回写输入框，否则光标会被拉到末尾
      markPicked(customInput.value.trim(), true);
    });
    customInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); apply(); }
    });
    customRow.appendChild(customInput);
    weightPanel.appendChild(customRow);

    // 编辑 Tab：把选中那段原文原样搬进输入框，怎么改都行，应用时整段写回提示词
    const rawPanel = element("div", `bpi-editor-panel${startOnRaw ? "" : " bpi-hidden"}`);
    const rawSpan = hooks.spanForEdit(token);
    const originalSlice = String(textWidget.value ?? "").slice(rawSpan.start, rawSpan.end).trim();
    // 这三句直接写中文：本页专属说明，走翻译层反而匹配不上，界面必须中文
    rawPanel.appendChild(element("div", "bpi-config-note", rawSpan.tokens.length > 1
      ? `已选中 ${rawSpan.tokens.length} 个标签，下面是它们在原文里的整段（含中间的标签）`
      : isPlainTag ? "下面是这个标签在原文里的那段文字" : "下面是这段文字在原文里的整段"));
    const rawEditor = element("textarea", "bpi-raw-editor");
    rawEditor.value = originalSlice;
    rawPanel.appendChild(rawEditor);
    rawPanel.appendChild(element("div", "bpi-config-note", "怎么改都行：逗号会被重新切成标签，清空等于删除这一段；Ctrl+Enter 应用"));

    // 编辑 Tab：整套词条字段（含分类下拉），跟「新增／编辑个人标签」弹窗同一份构件。
    // 命中词库就整条带过来改；没命中就按这条标签卡起个头，存进去即新建。
    const editPanel = element("div", "bpi-editor-panel bpi-hidden");
    // 两句说明收进同一个盒子：应用时若发现还是「未收录」，整盒换成红色警告，
    // 并先把盒子按当前高度钉住，换文案就不会把下面的表单顶上去
    const editNotes = element("div", "bpi-editor-notes");
    // 这两句是原文（英文的走翻译层，中文那句本页专属、不进译表），来回切换时都按原文重新渲染
    const noteSavedSource = "Edits go to the personal dictionary and override same-name entries.";
    const noteReadonlySource = "英文标签在这里只读；要改提示词里的文字，请用「编辑」页。";
    const noteSaved = element("div", "bpi-config-note", noteSavedSource);
    const noteReadonly = element("div", "bpi-config-note", noteReadonlySource);
    editNotes.append(noteSaved, noteReadonly);
    editPanel.appendChild(editNotes);
    const editForm = element("div", "bpi-form");
    const editFields = buildTagFields(editForm, state.index.get(token.key) ?? {
      english: token.term,
      // 未收录的中文名只是占位，这里预填成空：想存就得自己写一个，
      // 下面的「还是未收录就拦掉」只是兜底（防手动敲回这三个字）
      chinese: token.chinese === UNKNOWN_CHINESE ? "" : token.chinese ?? "",
      models: ["general", "anima"],
      source: "user",
      verified: true,
      // 英文只读：改它只会另存一条词条，不会动提示词；改文字请去「编辑」页
    }, { withTarget: false, readonlyEnglish: true });
    editPanel.appendChild(editForm);

    // 保护性占位：未收录标签的中文名只是提示文案，原样存进个人词库会得到
    // 一条中文名是「未收录」的残词条，标签从此显示成已收录却看不出是什么。
    // 所以「词条信息」页点应用时先比对中文名，还是占位就不保存、只把说明换成红色警告。
    let warnTimer = 0;
    const restoreEditNotes = () => {
      clearTimeout(warnTimer);
      editNotes.style.minHeight = "";
      setText(noteSaved, noteSavedSource);
      setText(noteReadonly, noteReadonlySource);
      noteSaved.classList.remove("bpi-config-note-warn");
      noteReadonly.classList.remove("bpi-config-note-warn");
    };
    const warnUnknownChinese = () => {
      // 先按现在的高度钉住：警告比原文短也不会缩，下面的表单一动不动
      const height = editNotes.getBoundingClientRect().height;
      if (height > 0) editNotes.style.minHeight = `${height}px`;
      setText(noteSaved, "Nothing was saved: the Chinese name is still the unknown placeholder.");
      setText(noteReadonly, "Enter a real Chinese name, then apply again.");
      noteSaved.classList.add("bpi-config-note-warn");
      noteReadonly.classList.add("bpi-config-note-warn");
      clearTimeout(warnTimer);
      warnTimer = setTimeout(restoreEditNotes, 2000);
      // 光标直接落到中文名那一格，省得再去找
      editFields.focus();
    };

    modal.append(weightPanel, rawPanel, editPanel);

    const close = () => {
      clearTimeout(warnTimer);
      editFields.destroy();
      shade.remove();
    };
    // 配色跟权重在同一页，所以 Apply 一次存两样；改动与否各自判断，
    // 只想改颜色的人不会被「权重没有变化」挡住
    const saveColor = () => {
      const value = String(customInput.value || "").trim();
      const previous = state.customColors.get(token.key) || "";
      // 任何模式下都允许设置（切回 default 就显示）；显示与否由 tokenCardColor 按模式决定
      if (!value) state.customColors.delete(token.key);
      else {
        const okHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
        const okRgb = /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(value);
        if (!okHex && !okRgb) {
          hooks.setStatus("Invalid color; use #hex or rgb(r,g,b)", "error");
          customInput.focus();
          return null;
        }
        state.customColors.set(token.key, value);
      }
      return value !== previous;
    };
    const apply = () => {
      // 不能改权重时这一页只剩配色，直接存色走人
      if (!canWeight) {
        const colorOnly = saveColor();
        if (colorOnly === null) return;
        if (colorOnly) hooks.render();
        close();
        return;
      }
      const raw = String(input.value ?? "").trim();
      const numeric = Number(raw);
      if (!raw || !Number.isFinite(numeric) || numeric < 0 || numeric > 3) {
        hooks.setStatus("Weight must be between 0 and 3", "error");
        input.focus();
        return;
      }
      const colorChanged = saveColor();
      if (colorChanged === null) return;
      // 打开时是 1（原标签没写权重）就不算改过：光改颜色的不应该被写成 (标签:1)
      const weightDirty = Math.abs(numeric - initialWeight) > 1e-9;
      if (weightDirty) {
        // 改文本会顺带重绘，配色不用再刷一次
        if (hooks.applyTokenWeight(token, numeric)) close();
        return;
      }
      if (colorChanged) hooks.render();
      close();
    };
    // 编辑页：整段写回当前节点的提示词原文，跟手改原文一样进撤销栈
    const applyRawEdit = () => {
      const before = String(textWidget.value ?? "");
      const result = replacePromptSpan(before, rawSpan.start, rawSpan.end, rawEditor.value);
      if (!result.changed) {
        hooks.setStatus("No content change", "ok");
        close();
        return;
      }
      const multi = rawSpan.tokens.length > 1;
      const label = multi ? `Edit ${rawSpan.tokens.length} tags` : `Edit “${rawSpan.tokens[0].term}”`;
      state.undoStack.push({
        before,
        after: result.text,
        beforeStart: rawSpan.start,
        beforeEnd: rawSpan.end,
        afterCursor: result.cursor,
        label,
      });
      if (state.undoStack.length > 50) state.undoStack.shift();
      state.redoStack = [];
      state.pinned = null;
      hooks.updateText(result.text, result.cursor);
      close();
      // 状态栏这两句分开写：套一层「“…”」再塞带引号的 label 会打乱变量折叠
      const rewroteMsg = multi
        ? `rewrote ${rawSpan.tokens.length} tags`
        : `rewrote “${rawSpan.tokens[0].term}”`;
      if (!showToast(rewroteMsg, { type: "edit" })) hooks.setStatus(rewroteMsg, "ok");
    };
    // 词条页：只改词条，不动当前这行提示词文本，所以不进撤销栈
    const applyEdit = async () => {
      const payload = editFields.collect();
      // 中文名还是「未收录」占位：存下去只会得到一条残词条，直接拦掉不保存
      if (String(payload.chinese ?? "").trim() === UNKNOWN_CHINESE) {
        warnUnknownChinese();
        return;
      }
      try {
        await saveTag(payload);
        await hooks.refreshDictionary();
        close();
        hooks.setStatus(t("Tag saved"), "ok");
      } catch (saveError) {
        hooks.setStatus(saveError.message, "error");
      }
    };
    const actions = element("div", "bpi-modal-actions");
    // 「清除权重」只对权重页有意义，切到别的页就收起来；先存配色再清，别丢改动
    let clearWeightButton = null;
    if (canWeight && token.weight !== null) {
      clearWeightButton = button("Clear weight", () => {
        if (saveColor() === null) return;
        if (hooks.applyTokenWeight(token, null)) close();
      }, "bpi-danger");
      clearWeightButton.hidden = startOnRaw;
      actions.appendChild(clearWeightButton);
    }
    actions.append(button("Cancel", close));
    // 先声明再让 applyButton 引用它：let 有 TDZ，声明放在闭包之后会有隐患
    let activeTab = startOnRaw ? "raw" : "weight";
    const applyButton = button(t("Apply"), () => {
      if (activeTab === "edit") applyEdit();
      else if (activeTab === "raw") applyRawEdit();
      else apply();
    }, "bpi-primary");
    actions.append(applyButton);
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
    // 编辑框要能打换行，所以 Enter 不提交，只有 Ctrl/Cmd+Enter 才应用
    rawEditor.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        applyRawEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    // Tab 切换：共用底部那个 Apply 按钮，按 activeTab 分派到三个动作
    const showPanel = (tab) => {
      tabWeight.classList.toggle("bpi-editor-tab-active", tab === "weight");
      tabRaw.classList.toggle("bpi-editor-tab-active", tab === "raw");
      tabEdit.classList.toggle("bpi-editor-tab-active", tab === "edit");
      weightPanel.classList.toggle("bpi-hidden", tab !== "weight");
      rawPanel.classList.toggle("bpi-hidden", tab !== "raw");
      editPanel.classList.toggle("bpi-hidden", tab !== "edit");
      // 离开词条页就把红色警告收回去，别等 2 秒后回来还挂着
      if (tab !== "edit") restoreEditNotes();
      if (clearWeightButton) clearWeightButton.hidden = tab !== "weight";
    };
    tabWeight.addEventListener("click", () => {
      activeTab = "weight";
      showPanel("weight");
      // 不能改权重时这一页只有配色，光标落到颜色输入框
      setTimeout(() => {
        if (canWeight) { input.focus(); input.select(); }
        else { customInput.focus(); customInput.select(); }
      }, 0);
    });
    tabRaw.addEventListener("click", () => {
      activeTab = "raw";
      showPanel("raw");
      setTimeout(() => { rawEditor.focus(); rawEditor.select(); }, 0);
    });
    tabEdit.addEventListener("click", () => {
      activeTab = "edit";
      showPanel("edit");
      setTimeout(() => editFields.focus(), 0);
    });
    if (startOnRaw) setTimeout(() => { rawEditor.focus(); rawEditor.select(); }, 0);
    else if (canWeight) setTimeout(() => { input.focus(); input.select(); }, 0);
    else setTimeout(() => { customInput.focus(); customInput.select(); }, 0);
  };

  return openWeightEditor;
}
