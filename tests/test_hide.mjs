import assert from "node:assert/strict";

import {
  buildDictionaryIndex,
  parsePrompt,
  removePromptToken,
  restorePromptToken,
} from "../js/parser.js";

const dictionary = buildDictionaryIndex([
  { english: "masterpiece", chinese: "杰作", verified: true },
  { english: "best quality", chinese: "最佳质量", verified: true },
  { english: "white hair", chinese: "白发", verified: true },
]);

const parse = (text) => parsePrompt(text, dictionary);
const restore = (text, raw, afterRaw) =>
  restorePromptToken(text, parse(text), raw, afterRaw);

// 隐藏 + 恢复的往返：先删一个标签，再按记录的锚点恢复，文本回到原样
{
  const original = "a, b, c";
  const tokens = parse(original);
  const removed = removePromptToken(original, tokens[1]); // 删 "b"
  assert.equal(removed.text, "a, c");
  const restored = restorePromptToken(removed.text, parse(removed.text), "b", "a");
  assert.deepEqual(restored.text, "a, b, c");
  assert.equal(restored.changed, true);
}
{
  const original = "masterpiece, best quality, white hair";
  const tokens = parse(original);
  const removed = removePromptToken(original, tokens[0]);
  const restored = restorePromptToken(removed.text, parse(removed.text), "masterpiece", null);
  assert.deepEqual(restored.text, original);
}

// 恢复到最前（afterRaw === null 表示原来就是第一个）
assert.deepEqual(restore("b, c", "a", null).text, "a, b, c");
assert.deepEqual(restore("b\nc", "a", null).text, "a, b\nc");

// 锚点在中间：插到锚点后面
assert.deepEqual(restore("a, b, d", "c", "b").text, "a, b, c, d");
assert.deepEqual(restore("a, d", "c", "a").text, "a, c, d");

// 锚点失效（文本被改过）：留在尾部
assert.deepEqual(restore("x, y", "c", "b").text, "x, y, c");
assert.deepEqual(restore("x, y", "c", "missing").text, "x, y, c");

// afterRaw 缺省（undefined）：留在尾部
assert.deepEqual(restore("x, y", "c", undefined).text, "x, y, c");

// 尾部换行在恢复并移动后仍然保留
assert.deepEqual(restore("a, b\n", "c", "a").text, "a, c, b\n");
assert.deepEqual(restore("a, b\n", "c", "b").text, "a, b, c\n");
assert.deepEqual(restore("a, b\n", "c", null).text, "c, a, b\n");
assert.deepEqual(restore("a, b\n", "c", undefined).text, "a, b, c\n");

// 尾逗号风格保留：追加标签后逗号仍收尾
assert.deepEqual(restore("a, b,", "c", "a").text, "a, c, b,");
assert.deepEqual(restore("a, b,", "c", undefined).text, "a, b, c,");
assert.deepEqual(restore("a, b, ", "c", "a").text, "a, c, b, ");
assert.deepEqual(restore("a, b,\n", "c", "a").text, "a, c, b,\n");

// 空文本恢复唯一标签
assert.deepEqual(restore("", "a", null).text, "a");
assert.deepEqual(restore("", "a", undefined).text, "a");
assert.deepEqual(restore("  ", "a", null).text, "a");

// 权重 / <lora:> / BREAK / @ 前缀按记录的 raw 原样恢复
assert.deepEqual(restore("a, b", "(c:1.2)", "a").text, "a, (c:1.2), b");
assert.deepEqual(restore("a, b", "<lora:x:0.8>", "b").text, "a, b, <lora:x:0.8>");
assert.deepEqual(restore("a, b", "BREAK", "a").text, "a, BREAK, b");
assert.deepEqual(restore("a, b", "@artist", "a").text, "a, @artist, b");

// 重复标签作锚点：取第一个匹配
{
  const text = "a, b, a";
  const result = restore(text, "x", "a");
  assert.deepEqual(result.text, "a, x, b, a");
}

// 恢复的 cursor 指向恢复后标签的末尾
{
  const result = restore("a, b, d", "c", "b");
  assert.equal(result.text.indexOf("c"), result.cursor - 1);
}
{
  const result = restore("a, b, d", "c", undefined);
  assert.equal(result.text.length, result.cursor);
}

// 空 raw 或空白 raw：不变
assert.equal(restore("a, b", "", "a").changed, false);
assert.equal(restore("a, b", "   ", "a").changed, false);
assert.equal(restorePromptToken("a, b", null, null, null).changed, false);

// 多标签逐个恢复后整体还原（隐藏两个再全放回）
{
  const original = "masterpiece, best quality, white hair";
  const tokens = parse(original);
  const first = removePromptToken(original, tokens[2]); // 去 white hair
  const second = removePromptToken(first.text, parse(first.text).find((t) => t.raw === "best quality")); // 去 best quality
  assert.deepEqual(second.text, "masterpiece");
  const back1 = restorePromptToken(second.text, parse(second.text), "best quality", "masterpiece");
  assert.deepEqual(back1.text, "masterpiece, best quality");
  const back2 = restorePromptToken(back1.text, parse(back1.text), "white hair", "best quality");
  assert.deepEqual(back2.text, original);
}

// 接口宽容：tokens 只需要 raw/start/end 字段（手工构造即可）
{
  const handTokens = [{ raw: "a", start: 0, end: 1 }, { raw: "b", start: 3, end: 4 }];
  const result = restorePromptToken("a, b", handTokens, "x", "a");
  assert.deepEqual(result.text, "a, x, b");
}

console.log("hide/restore tests: OK");
