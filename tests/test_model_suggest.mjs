import assert from "node:assert/strict";

import { matchModelNames } from "../js/model_suggest.js";

const catalog = [
  { name: "anima-pencil-XL", kind: "checkpoints" },
  { name: "Anima", kind: "checkpoints" },
  { name: "animagine-xl-3.1", kind: "checkpoints" },
  { name: "Illustrious-anima", kind: "diffusion_models" },
  { name: "detail-tweaker", kind: "loras" },
];

const names = (items) => items.map((item) => item.name);

// 空输入不给候选，免得一聚焦就糊一屏
assert.deepEqual(matchModelNames(catalog, ""), []);
assert.deepEqual(matchModelNames(catalog, "   "), []);
assert.deepEqual(matchModelNames(catalog, null), []);

// 前缀匹配排在包含匹配前面：输 A 先看到几个 anima 开头的大模型
assert.deepEqual(names(matchModelNames(catalog, "a")), [
  "Anima",
  "anima-pencil-XL",
  "animagine-xl-3.1",
  "detail-tweaker",
  "Illustrious-anima",
]);

// 大小写不敏感
assert.deepEqual(names(matchModelNames(catalog, "ANIMA")), names(matchModelNames(catalog, "anima")));

// 位置相同时短名优先
assert.equal(names(matchModelNames(catalog, "anima"))[0], "Anima");

// 包含匹配也能命中中间的片段
assert.deepEqual(names(matchModelNames(catalog, "xl")), ["animagine-xl-3.1", "anima-pencil-XL"]);

// limit 生效，且不会改动原数组
assert.equal(matchModelNames(catalog, "a", 2).length, 2);
assert.equal(catalog.length, 5);

// 没命中返回空数组
assert.deepEqual(matchModelNames(catalog, "zzz"), []);

// 脏数据不炸
assert.deepEqual(matchModelNames(null, "a"), []);
assert.deepEqual(matchModelNames("nope", "a"), []);
assert.deepEqual(matchModelNames([{ name: 42 }, null], "a"), []);

console.log("model_suggest ok");
