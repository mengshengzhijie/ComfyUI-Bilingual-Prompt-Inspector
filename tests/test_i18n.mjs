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
assert.equal(t("moved “1girl”; press Ctrl+Z to undo"), "已移动「1girl」；按 Ctrl+Z 可撤销");
assert.equal(t("Mode: “Tag” | “标签式输入”"), "模式：标签｜标签式输入");
assert.equal(t("Mode: “Tag”"), "模式：标签");
assert.equal(
  t("Possible conflict: “Solo vs multiple subjects” (“1girl” ↔ “2girls”)"),
  "可能存在冲突：单人 vs 多人（1girl ↔ 2girls）",
);

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
