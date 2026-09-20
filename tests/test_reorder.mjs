import assert from "node:assert/strict";

import {
  buildDictionaryIndex,
  movePromptToken,
  parsePrompt,
} from "../js/parser.js";

const dictionary = buildDictionaryIndex([
  { english: "masterpiece", chinese: "杰作", verified: true },
  { english: "best quality", chinese: "最佳质量", verified: true },
  { english: "looking up", chinese: "向上看", verified: true },
  { english: "white hair", chinese: "白发", verified: true },
]);

const parse = (text) => parsePrompt(text, dictionary);
const move = (text, tokenIndex, target) => {
  const tokens = parse(text);
  return movePromptToken(text, tokens, tokens[tokenIndex], target);
};

// 基本移动与往返一致
assert.deepEqual(move("a, b, c", 2, 0).text, "c, a, b");
assert.deepEqual(move("a, b, c", 0, 3).text, "b, c, a");
assert.equal(move("a, b, c", 2, 0).changed, true);
const roundTrip = move(move("a, b, c", 0, 3).text, 2, 0);
assert.deepEqual(roundTrip.text, "a, b, c");
assert.equal(roundTrip.changed, true);

// 原地不动视为未修改
assert.equal(move("a, b, c", 1, 1).changed, false);
assert.equal(move("a, b, c", 1, 2).changed, false);
assert.equal(move("a, b, c", 0, 0).changed, false);

// 跨换行移动：多行结构保留
assert.deepEqual(move("a, b,\nc, d", 1, 3).text, "a,\nc, b, d");
assert.deepEqual(move("a, b\nc, d\ne, f", 2, 0).text, "c, a, b\nd\ne, f");
assert.deepEqual(move("a, b\nc, d\ne, f", 1, 3).text, "a\nc, b, d\ne, f");
assert.deepEqual(move("a, b\nc, d\ne, f", 5, 0).text, "f, a, b\nc, d\ne");
assert.deepEqual(move("a, b,\r\nc, d", 1, 3).text, "a,\r\nc, b, d");

// 跨 BREAK / AND 移动
assert.deepEqual(move("masterpiece, BREAK, best quality", 2, 0).text, "best quality, masterpiece, BREAK");
assert.deepEqual(move("x, AND, y, z", 3, 1).text, "x, z, AND, y");

// 权重、@、<lora:> 等原样保留
assert.deepEqual(move("a, (b:1.2), <lora:x:0.8>", 2, 0).text, "<lora:x:0.8>, a, (b:1.2)");
assert.deepEqual(move("a, @artist, (c:0.9)", 1, 0).text, "@artist, a, (c:0.9)");

// 重复标签按出现位置移动
{
  const tokens = parse("red, blue, red");
  const second = tokens[2];
  const result = movePromptToken("red, blue, red", tokens, second, 0);
  assert.deepEqual(result.text, "red, red, blue");
  assert.equal(result.index, 0);
}

// 末尾逗号保留
assert.deepEqual(move("a, b, c,", 0, 4).text, "b, c, a,");
assert.deepEqual(move("a, b, c,", 2, 0).text, "c, a, b,");

// 单标签与空串不变
assert.equal(move("solo", 0, 0).changed, false);
assert.equal(move("", 0, 0).changed, false);
assert.equal(movePromptToken("a, b", parse("a, b"), null, 0).changed, false);
assert.equal(movePromptToken("a, b", parse("a, b"), { start: 99, end: 99, raw: "zzz" }, 0).changed, false);

// mixed 模式：自然语言块整段不可拆，标签可跨块移动
{
  const mixed = "masterpiece, best quality, white hair, looking up, Nahida sits on the edge of the bed in a bedroom, asking for a hug.";
  const tokens = parse(mixed);
  assert.equal(tokens[tokens.length - 1].segmentKind, "natural");
  const naturalRaw = tokens[tokens.length - 1].raw;

  const toFront = movePromptToken(mixed, tokens, tokens[2], 0);
  assert.equal(toFront.text.startsWith("white hair, masterpiece,"), true);
  assert.equal(toFront.text.includes(naturalRaw), true);

  const across = movePromptToken(mixed, tokens, tokens[0], tokens.length);
  assert.deepEqual(across.text, `${mixed.slice("masterpiece, ".length)}, masterpiece`);
  assert.equal(across.text.includes(naturalRaw), true);

  // 移动到自然语言块前后：块内部不被插入
  const beforeBlock = movePromptToken(mixed, tokens, tokens[1], tokens.length - 1);
  assert.equal(beforeBlock.text.includes(naturalRaw), true);
  assert.equal(beforeBlock.text.endsWith(`, best quality, ${naturalRaw}`), true);
  const afterBlock = movePromptToken(mixed, tokens, tokens[1], tokens.length);
  assert.equal(afterBlock.text.endsWith(`${naturalRaw}, best quality`), true);
}

// 返回的 index 指向移动后的新位置
{
  const tokens = parse("a, b, c, d");
  assert.equal(movePromptToken("a, b, c, d", tokens, tokens[3], 0).index, 0);
  assert.equal(movePromptToken("a, b, c, d", tokens, tokens[0], 4).index, 3);
  assert.equal(movePromptToken("a, b, c, d", tokens, tokens[1], 3).index, 2);
}

console.log("reorder tests: OK");
