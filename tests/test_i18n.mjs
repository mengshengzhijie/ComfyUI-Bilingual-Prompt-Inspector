import assert from "node:assert/strict";

import {
  getLanguageMode,
  registerLocaleReader,
  resolveLanguage,
  setLanguageMode,
  t,
} from "../js/i18n.js";

// 强制英文：原文原样返回
setLanguageMode("en");
assert.equal(getLanguageMode(), "en");
assert.equal(resolveLanguage(), "en");
assert.equal(t("Cancel"), "Cancel");
assert.equal(t("Save to Personal Dictionary"), "Save to Personal Dictionary");

// 强制中文：命中译表
setLanguageMode("zh");
assert.equal(resolveLanguage(), "zh");
assert.equal(t("Cancel"), "取消");
assert.equal(t("Save to Personal Dictionary"), "保存到个人词库");

// 没翻译的文案按英文原样返回，不会出现空字符串
assert.equal(t("Definitely not in the table"), "Definitely not in the table");
assert.equal(t(""), "");
assert.equal(t(undefined), undefined);

// 带变量的文案：「“...”」和数字折叠成占位符后回填
assert.equal(t("deleted “masterpiece”; press Ctrl+Z to undo"), "已删除「masterpiece」；按 Ctrl+Z 可撤销");
assert.equal(t("restored 3 hidden tags; press Ctrl+Z to undo"), "已恢复 3 个隐藏标签；按 Ctrl+Z 可撤销");

// 用户实际会看到的组合文案：统计行、词包信息、操作回执、模式提示
assert.equal(t("items 3 | recognized 1 | unknown 2"), "共 3 个标签｜已识别 1｜未收录 2");
assert.equal(t("items 3 | recognized 1 | unknown 2 | pending 1"), "共 3 个标签｜已识别 1｜未收录 2｜待确认 1");
assert.equal(t("Personal"), "个人");
assert.equal(t("Highest"), "最高");
assert.equal(t("12 items | Local user | Always enabled, overrides same-name entries"), "12 条｜本地用户｜始终启用，覆盖同名条目");

// 词库页统计行：这行是分段翻译后再拼起来的，三种大词库形态都要覆盖
assert.equal(
  [
    t("Showing 952"),
    t("Selected 0"),
    t("Enabled packs 6/7"),
    t("Built-in 951"),
    t("Large not installed"),
    t("Personal 1"),
    t("Pending 0"),
  ].join(" | "),
  "显示 952 | 已选 0 | 已启用词包 6/7 | 内置 951 | 大词库未安装 | 个人 1 | 待确认 0",
);
assert.equal(t("Large 12000 (on-demand)"), "大词库 12000（按需）");
assert.equal(t("Large 12000 (disabled)"), "大词库 12000（已停用）");
assert.equal(t("Common dictionary 952 items"), "通用词库 952 条");
assert.equal(t("moved “1girl”; press Ctrl+Z to undo"), "已移动「1girl」；按 Ctrl+Z 可撤销");
assert.equal(t("Mode: “Tag” | “标签式输入”"), "模式：标签｜标签式输入");
assert.equal(t("Mode: “Tag”"), "模式：标签");
assert.equal(
  t("Possible conflict: “Solo vs multiple subjects” (“1girl” ↔ “2girls”)"),
  "可能存在冲突：单人 vs 多人（1girl ↔ 2girls）",
);

// 自由文本变量必须用「"…"」包起来才能折叠成 {}，否则整句永远匹配不上。
// 这里锁死「运行时真实形态」，防止以后有人把引号去掉或换成 ASCII 直引号。
for (const [source, expected] of [
  ["“Optimize to Anima” done; please confirm in the preview window", "「优化为 Anima」完成；请在预览窗口确认"],
  ["applied “Translate & optimize”; press Ctrl+Z to undo", "已应用 翻译并优化；按 Ctrl+Z 可撤销"],
  ["Undone: “Sort to Anima order”", "已撤销：Sort to Anima order"],
  ["Redone: “Sort to Anima order”", "已重做：Sort to Anima order"],
  ["Running “Translate”…", "正在运行 翻译…"],
  ["“Result still contains Chinese”; please fix it in the preview before confirming", "「结果仍包含中文」；请在预览里改好再确认"],
  ["Release failed: “network down”", "放行失败：network down"],
  ["Discard failed: “network down”", "放弃失败：network down"],
  ["Cannot pause for confirmation: “network down”", "无法暂停等待确认：network down"],
  ["Translating unknown tags 1/12：“1girl”", "正在翻译未收录标签 1/12：1girl"],
  ["Translation complete 5 items, rejected abnormal results 2 items", "翻译完成 5 条，已拒绝异常结果 2 条"],
  ["uses “12,345”", "使用 12,345 次"],
  ["tag: “1girl” | Anima format: (Tag:Weight)", "标签：1girl｜Anima 格式：(标签:权重)"],
  ["Node #3 · 12  tags", "节点 #3 · 12 个标签"],
  ["Translating: “1girl”", "正在翻译：1girl"],
  ["Re-translated “1girl”", "已重新翻译「1girl」"],
  ["Copied “1girl”", "已复制 1girl"],
  ["Processed “1girl”", "已处理「1girl」"],
  ["Exported “My Pack”", "已导出「My Pack」"],
  ["Deleted and backed up “My Pack”", "已删除并备份「My Pack」"],
  ["community pack “My Pack”, 12 items", "社区词包「My Pack」，12 条"],
  ["Connection OK: “pong”", "连接正常：pong"],
  ["Community pack read failed: “bad json”", "社区词包读取失败：bad json"],
  ["“image.png” · 12 KB", "image.png · 12 KB"],
  ["Weight 5 outside common range 0–3", "权重 5 超出常见范围 0–3"],
  [
    "Delete community pack “My Pack”? File is backed up first; recoverable from data/backups.",
    "删除社区词包「My Pack」？会先备份文件，可从 data/backups 恢复。",
  ],
]) {
  assert.equal(t(source), expected, `未命中：${source}`);
}

// 置信度徽章：这几个是 parser.js 直接产出的界面文本
assert.equal(t("Low · pending"), "低 · 待确认");
assert.equal(t("Medium · pending"), "中 · 待确认");
assert.equal(t("Medium · session-only"), "中 · 仅本次会话");
assert.equal(t("Low"), "低");

// 收藏星标按钮（带符号的整串）
assert.equal(t("★ Unfavorite"), "★ 取消收藏");
assert.equal(t("☆ Favorite"), "☆ 收藏");

// 分段翻译所需的独立片段
assert.equal(t("Tags 12"), "标签 12 条");
assert.equal(t("Sample"), "示例");
assert.equal(t("Updated"), "已更新");
assert.equal(t("Imported"), "已导入");
assert.equal(t("(empty prompt)"), "（空提示词）");
assert.equal(t("(weight 1.5)"), "（权重 1.5）");
// 插件名：侧边栏标签写死中文，面板/关于框走译表，三处必须同一个名字
assert.equal(t("Bilingual Prompt Manager"), "提示词翻译与管理");
assert.equal(t("Bilingual Prompt Inspector"), "提示词翻译与管理");
// 确认对话框：默认确认按钮是 "OK"，必须译为「确认」而不是「正常」
assert.equal(t("OK"), "确认");
assert.equal(t("Cancel"), "取消");
assert.equal(t("This will overwrite node #3 prompt. Cannot be undone with Ctrl+Z."), "这会覆盖节点 #3 的提示词，Ctrl+Z 无法撤销。");
assert.equal(t("Delete “Fluffy”? Reference image will be deleted too."), "删除「Fluffy」？参考图也会一并删除。");
assert.equal(
  t("Bilingual Prompt Inspector: Tag Manager, Dictionary, Packs & Assistant Settings"),
  "提示词翻译与管理：标签管理、词库、词包与助手设置",
);
assert.equal(t("restored 3 hidden tags; press Ctrl+Z to undo"), "已恢复 3 个隐藏标签；按 Ctrl+Z 可撤销");
assert.equal(t("Node #3"), "节点 #3");

// 状态提示（整句形态）
assert.equal(t("Paused, waiting for confirmation…"), "已暂停，等待确认…");
assert.equal(t("Querying dictionary…"), "正在查询词库…");
assert.equal(t("Searching for more…"), "正在搜索更多…");

// 非法值一律退回 auto
setLanguageMode("klingon");
assert.equal(getLanguageMode(), "auto");

// auto：读 ComfyUI 的 Comfy.Locale，中文系语言走中文，其余走英文
registerLocaleReader(() => "zh-CN");
setLanguageMode("auto");
assert.equal(resolveLanguage(), "zh");
assert.equal(t("Save"), "保存");

registerLocaleReader(() => "zh-TW");
setLanguageMode("auto");
assert.equal(resolveLanguage(), "zh");

registerLocaleReader(() => "en");
setLanguageMode("auto");
assert.equal(resolveLanguage(), "en");
assert.equal(t("Save"), "Save");

// 读不到设置（或设置面板还没起来）时不崩，结果只能是 zh / en
registerLocaleReader(() => {
  throw new Error("settings panel not ready");
});
setLanguageMode("auto");
assert.ok(["zh", "en"].includes(resolveLanguage()));

console.log("i18n tests: OK");
