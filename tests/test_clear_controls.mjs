import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../js/bilingual_prompt.js", import.meta.url), "utf8");
const shared = readFileSync(new URL("../js/bpi_shared.js", import.meta.url), "utf8");

assert.match(shared, /const PREFERENCES_KEY = "bpi\.dictionary\.preferences\.v1";/);
assert.doesNotMatch(source, /hideNativeEnglishWidget/);
assert.doesNotMatch(source, /options\.hidden\s*=\s*true/);
assert.match(source, /clearButtonLabel\(state\.englishClearState\)/);
assert.match(source, /Click again.*Confirm clear.*to clear the English actual output/);
assert.match(source, /English clear undone/);
assert.doesNotMatch(source, /clearChineseButton|clearChineseDraft|chineseClearState/);

console.log("clear controls tests passed");
