import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../js/bilingual_prompt.js", import.meta.url), "utf8");

assert.match(source, /const PROJECT_URL = "https:\/\/github\.com\/mengshengzhijie\/ComfyUI-Bilingual-Prompt-Inspector";/);
assert.doesNotMatch(source, /space\.bilibili\.com/);
assert.match(source, /"关于插件"/);
assert.match(source, /"访问插件仓库 ↗"/);
assert.match(source, /projectLink\.target = "_blank";/);
assert.match(source, /projectLink\.rel = "noopener noreferrer";/);
assert.match(source, /projectLink\.referrerPolicy = "no-referrer";/);
assert.match(source, /"bpi-about-footer"/);

console.log("project link tests passed");
