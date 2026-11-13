import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// 让测试能真的渲染 .tsx 组件（node 自己只转 .ts）：用 TypeScript 把组件源码转成 ESM，写到 node_modules/.cache 下再 import
// （放在 node_modules 里，里面的 react/jsx-runtime 才解析得到；node_modules 不进 git）。
// 组件里 `@/…` 的 import 会被改写成真实路径：指向 .tsx 的递归转换，指向 .ts 的直接用源文件（测试进程带着 --experimental-transform-types）。
// 只适合不依赖浏览器 API / next-intl 钩子的纯展示组件（Mono、Eyebrow、BellCurve）；有这些依赖的组件继续用源码结构断言 + 真实浏览器测试。
const ROOT = new URL("../", import.meta.url);
const OUT = new URL("node_modules/.cache/test-tsx/", ROOT);
const cache = new Map();

function resolveAlias(specifier) {
  const base = new URL(`src/${specifier.slice(2)}`, ROOT).pathname;
  for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 ${specifier}`);
}

async function toUrl(path) {
  if (cache.has(path)) return cache.get(path);
  const source = await readFile(new URL(`src/${path}`, ROOT), "utf8");
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  for (const specifier of new Set([...outputText.matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1]))) {
    const file = resolveAlias(specifier);
    const url = file.endsWith(".tsx") ? await toUrl(file.slice(new URL("src/", ROOT).pathname.length)) : pathToFileURL(file).href;
    outputText = outputText.replaceAll(`"${specifier}"`, `"${url}"`);
  }
  await mkdir(OUT, { recursive: true });
  const file = new URL(`${createHash("sha1").update(path + outputText).digest("hex").slice(0, 12)}.mjs`, OUT);
  await writeFile(file, outputText);
  cache.set(path, file.href);

  return file.href;
}

export async function loadTsx(path) {
  return import(await toUrl(path));
}
