import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// Turbopack 解析不了带多个插值的模板 import（next 15.5 的 `next dev --turbopack` 上
// "complex patterns into wildcard exports fields are not implemented yet"），外面的 try/catch 还会悄悄回退到英文。
// 所以源码里所有动态 import() / require() 都必须是写死的字符串，由显式的映射表按语言挑选。
async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await sourceFiles(url)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(url);
  }
  return out;
}

const isDynamicLoad = (node) =>
  ts.isCallExpression(node) &&
  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require"));

function interpolations(node) {
  const [arg] = node.arguments;
  if (!arg || ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return 0;
  return ts.isTemplateExpression(arg) ? arg.templateSpans.length : Infinity;
}

async function dynamicLoads() {
  const found = [];
  for (const url of await sourceFiles(new URL("../src/", import.meta.url))) {
    const text = await readFile(url, "utf8");
    const sf = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (isDynamicLoad(node)) {
        found.push({ file: url.pathname.split("/src/")[1], text: node.getText().replace(/\s+/g, " "), count: interpolations(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test("扫描能找到源码里的动态 import（防止扫描失效后测试空转）", async () => {
  const files = (await dynamicLoads()).map((d) => d.file);
  assert.ok(files.includes("components/learn/lesson.tsx"), "next/dynamic 里的 import 没扫到");
  assert.ok(files.includes("i18n/messages.ts"), "按语言挑文案的映射表没扫到");
});

test("没有带多个插值的动态 import()：会在 turbopack 开发服务器上解析失败", async () => {
  const bad = (await dynamicLoads()).filter((d) => d.count > 1);
  assert.deepEqual(bad.map((d) => `${d.file}: ${d.text}`), []);
});

test("所有动态 import() / require() 的路径都是写死的字符串，不拼变量也不插值", async () => {
  const bad = (await dynamicLoads()).filter((d) => d.count !== 0);
  assert.deepEqual(bad.map((d) => `${d.file}: ${d.text}`), []);
});
