// 模块依赖体检：拆文件之后最容易犯的错是「引用了没 import / 没传进来 / 目标模块没导出的名字」。
// 这类错误 node --check 查不出来（语法合法），浏览器要到模块链接或运行时才炸 —— 这里做四重静态比对：
//
//   1) 反向：模块里用了「别的模块 export 出来的名字」，却没 import
//   2) 正向：模块里用了「主文件闭包里定义的名字」，却没通过参数传进来
//   3) 主文件用了「模块内部定义、却没导出」的名字
//   4) 链接：import 的名字在目标模块的 export 里找不到，或相对路径的文件不存在
//
// 字符串与注释先剥掉，避免把文案里的英文单词当成标识符。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JS_DIR = new URL("../js/", import.meta.url);
const MAIN = new URL("bilingual_prompt.js", JS_DIR);
const files = fs.readdirSync(JS_DIR).filter((name) => name.endsWith(".js"));

function stripLiterals(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`[^`]*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

// 全仓导出名：模块用了却没 import 的，一定是漏了
const exported = new Set();
const sources = new Map();
for (const file of files) {
  const raw = fs.readFileSync(new URL(file, JS_DIR), "utf8");
  sources.set(file, raw);
  for (const match of raw.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) exported.add(match[1]);
  for (const match of raw.matchAll(/export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) exported.add(match[1]);
  for (const match of raw.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim().split(/\s+as\s+/).pop();
      if (clean) exported.add(clean);
    }
  }
}

// 主文件闭包里的名字：模块用到了就必须出现在参数表里
const mainCode = stripLiterals(fs.readFileSync(MAIN, "utf8"));
const closureNames = new Set();
for (const match of mainCode.matchAll(/^  (?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) closureNames.add(match[1]);
for (const match of mainCode.matchAll(/^  const \{([^}]*)\}\s*=/gm)) {
  for (const name of match[1].split(",")) {
    const clean = name.trim();
    if (clean) closureNames.add(clean);
  }
}
for (const match of mainCode.matchAll(/function createPanel\(([^)]*)\)/g)) {
  for (const name of match[1].split(",")) {
    const clean = name.trim();
    if (clean) closureNames.add(clean);
  }
}

const problems = [];
let checked = 0;

for (const file of files) {
  const raw = sources.get(file);
  if (!/export function create[A-Za-z]+\(/.test(raw)) continue;
  checked += 1;

  const imports = new Set();
  for (const match of raw.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim();
      if (clean) imports.add(clean);
    }
  }

  const code = stripLiterals(raw);
  const declared = new Set();
  for (const match of code.matchAll(/export function create[A-Za-z]+\(\{([^}]*)\}\)/gs)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim();
      if (clean) declared.add(clean);
    }
  }
  for (const match of code.matchAll(/\b(?:const|let|function|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of code.matchAll(/\b(?:const|let)\s*\{([^}]*)\}\s*=/g)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim().replace(/^\.\.\./, "").split(":").pop().trim();
      if (clean) declared.add(clean);
    }
  }
  for (const match of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const name of match[1].split(",")) {
      const clean = name.trim().replace(/^\.\.\./, "").split("=")[0].trim();
      if (clean) declared.add(clean);
    }
  }
  for (const match of code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) declared.add(match[1]);
  // 对象字面量的键（duplicateGroups: [] / showToast: () => ...）不是外部引用
  for (const match of code.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*:/gm)) declared.add(match[1]);


  const used = new Set();
  for (const match of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) used.add(match[1]);

  const missingImport = [...used].filter(
    (name) => !imports.has(name) && !declared.has(name) && exported.has(name),
  );
  if (missingImport.length) {
    problems.push(`${file} 用了别处导出的名字却没 import：${missingImport.sort().join(", ")}`);
  }

  const missingParam = [...used].filter(
    (name) => closureNames.has(name) && !declared.has(name) && !imports.has(name),
  );
  if (missingParam.length) {
    problems.push(`${file} 用了主文件里的名字却没传进来：${missingParam.sort().join(", ")}`);
  }
}

assert.deepEqual(problems, [], problems.join("\n"));
assert.ok(checked >= 3, `只检查到 ${checked} 个工厂模块，匹配规则可能有问题`);

// 3) 反向：主文件用了「某个模块内部定义、但没导出」的名字 —— 拆模块时最容易漏的就是这种
const moduleLocals = new Map();
for (const [file, raw] of sources) {
  if (file === "bilingual_prompt.js") continue;
  const code = stripLiterals(raw);
  const locals = new Set();
  for (const match of code.matchAll(/\b(?:const|let|function|var)\s+([A-Za-z_$][\w$]*)/g)) locals.add(match[1]);
  moduleLocals.set(file, locals);
}

const mainImports = new Set();
for (const match of mainCode.matchAll(/import\s*\{([^}]*)\}/g)) {
  for (const name of match[1].split(",")) {
    const clean = name.trim();
    if (clean) mainImports.add(clean);
  }
}
const mainUsed = new Set();
for (const match of mainCode.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) mainUsed.add(match[1]);

const missingFromMain = new Set();
for (const [file, locals] of moduleLocals) {
  for (const name of locals) {
    if (exported.has(name) || closureNames.has(name) || mainImports.has(name)) continue;
    if (mainUsed.has(name)) missingFromMain.add(`${name}（${file} 里定义但没导出）`);
  }
}
if (missingFromMain.size) {
  problems.push(`主文件用了模块内部的名字：${[...missingFromMain].sort().join(", ")}`);
}

// 4) 链接体检：import 的名字必须真的由目标模块导出，相对路径的文件必须存在。
// 浏览器在 ESM 链接阶段就会因此让整块扩展加载失败，node --check 与上面三项都查不出来。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const exportsByFile = new Map();
for (const [file, raw] of sources) {
  const code = stripComments(raw);
  const names = new Set();
  for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of code.matchAll(/export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/gs)) {
    for (const item of match[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  exportsByFile.set(file, names);
}

const jsDir = fileURLToPath(JS_DIR);
const linkProblems = [];
for (const [file, raw] of sources) {
  const code = stripComments(raw);
  const imports = [];
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gs)) {
    for (const item of match[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/)[0].trim();
      if (name) imports.push({ name, spec: match[2] });
    }
  }
  for (const match of code.matchAll(/import\s*["']([^"']+)["']/g)) {
    imports.push({ name: null, spec: match[1] });
  }
  for (const { name, spec } of imports) {
    const abs = path.resolve(path.dirname(path.join(jsDir, file)), spec);
    const rel = path.relative(jsDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // ../../scripts/app.js 由宿主提供
    const target = path.basename(abs);
    if (!sources.has(target)) {
      linkProblems.push(`${file}: import 的文件不存在 ${spec}`);
    } else if (name && !exportsByFile.get(target).has(name)) {
      linkProblems.push(`${file}: ${spec} 没有导出 ${name}`);
    }
  }
}
assert.deepEqual(linkProblems, [], linkProblems.join("\n"));

console.log(`module deps tests: OK (${checked} files, ${sources.size} modules linked)`);
