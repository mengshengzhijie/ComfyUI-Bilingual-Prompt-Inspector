import assert from "node:assert/strict";

import {
  analyzePromptSyntax,
  buildDictionaryIndex,
  duplicateGroups,
  normalizeKey,
  parsePrompt,
  removePromptToken,
} from "../js/parser.js";
import { setLanguageMode, t } from "../js/i18n.js";

const dictionary = buildDictionaryIndex([
  { english: "1girl", chinese: "一个女孩", verified: true },
  { english: "smile", chinese: "微笑", verified: true },
]);

// 同一个标签出现 3 次：权重写法不同的那次也算同一 key
const groups = duplicateGroups(parsePrompt("1girl, smile, (1girl:1.3), 1girl", dictionary));
assert.equal(groups.length, 1);
assert.equal(groups[0].key, normalizeKey("1girl"));
assert.equal(groups[0].tokens.length, 3);
// 顺序按原文，且三次都是普通标签
assert.equal(groups[0].tokens[0].raw.trim(), "1girl");
assert.equal(groups[0].tokens[1].raw.trim(), "(1girl:1.3)");
assert.ok(groups[0].tokens.every((token) => token.syntax === "tag"));

// key 归一：大小写差异算同一个标签（下划线是按空格算的，"sm_ile" 不等于 "smile"）
assert.equal(duplicateGroups(parsePrompt("smile, Smile", dictionary)).length, 1);

// BREAK 与 <lora:…> 不算重复标签
assert.equal(duplicateGroups(parsePrompt("BREAK, BREAK", dictionary)).length, 0);
assert.equal(duplicateGroups(parsePrompt("<lora:a:1>, <lora:a:1>", dictionary)).length, 0);

// 问题行的「重复标签」提示与分组口径一致（同一个标签只提示一次）
const text = "1girl, 1girl, smile";
const issues = analyzePromptSyntax(text, parsePrompt(text, dictionary));
assert.equal(issues.filter((item) => item.code === "duplicate").length, 1);
assert.deepEqual(issues.find((item) => item.code === "duplicate").tokenKeys, [normalizeKey("1girl")]);

// 「唯一」的输出剔除：按出现次序删，第一次出现的那次要留着
let output = "1girl, smile, (1girl:1.3), 1girl";
for (;;) {
  const parsed = parsePrompt(output, dictionary);
  const target = duplicateGroups(parsed)
    .filter((group) => group.key === normalizeKey("1girl"))
    .flatMap((group) => group.tokens.slice(1))[0];
  if (!target) break;
  const step = removePromptToken(output, target);
  assert.ok(step.changed);
  output = step.text;
}
assert.equal(output.trim(), "1girl, smile");

// 界面文案：英文原文 + 中文译表双写，变量折成 {} 后要能命中
setLanguageMode("en");
assert.equal(t("Unique"), "Unique");
assert.equal(t("Duplicates {}").replace("{}", "3"), "Duplicates 3");
setLanguageMode("zh");
assert.equal(t("Unique"), "唯一");
assert.equal(t("Duplicates 3"), "重复 3");
assert.equal(t("Keep only the first “1girl” in the actual output; later occurrences stay here with a strikethrough"),
  "只让第一次出现的「1girl」进入实际输出；其余照常显示在界面上（划线）");
assert.equal(t("Tags repeated in this prompt; click a chip to step through its occurrences, double-click to delete the one you stepped to; click empty space here to clear the selection"),
  "提示词里重复的标签：单击胶囊依次跳到每一次出现，双击删掉跳到的那一处；点这里空白处取消选中");
assert.equal(t("“1girl” appears 3 times; click to jump to the first one"), "「1girl」出现了 3 次；单击跳到第一次");
// 开了「唯一」的胶囊是另一个提示语，里面嵌套的「Unique」要跟着翻成「唯一」
assert.equal(t("“1girl” appears 3 times; “Unique” is on, only the first reaches the actual output"),
  "「1girl」出现了 3 次；已开「唯一」：只有第一次进入实际输出");
assert.equal(t("“1girl” occurrence 2 of 3; click again for the next one, double-click to delete it"),
  "「1girl」第 2 / 3 处；再点一次跳下一处，双击删除这一处");
assert.equal(t("“1girl” now unique: only the first occurrence enters the actual output; press Ctrl+Z to undo"),
  "「1girl」已设为唯一：只有第一次出现进入实际输出；按 Ctrl+Z 可撤销");
// 「Unique」在译文里会被二次翻译，tooltip 读起来是一致的中文
assert.equal(t("Query: “1girl” | “Unique” is on: only the first occurrence reaches the actual output"),
  "查询「1girl」｜已开「唯一」：只有第一次出现进入实际输出");

console.log("test_duplicates: ok");
