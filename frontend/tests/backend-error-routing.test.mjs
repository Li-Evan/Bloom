import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

// 后端报错的中文原文不能原样进英文界面：弹出或显示请求错误时要经过 useBackendError / backendErrorText 翻译
const EXEMPT = {};

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await sourceFiles(url)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(url);
  }
  return out;
}

const RAW = /(?:toast\.error|toast|setError|setErrorMessage)\(\s*\(?\s*\w+(?: as \w+)?\)?\.message\b/;

test("没有任何地方把请求错误的 .message 原样交给 toast / setError", async () => {
  const offenders = [];
  for (const url of await sourceFiles(new URL("../src/", import.meta.url))) {
    const file = url.pathname.split("/src/")[1];
    const text = await readFile(url, "utf8");
    if (RAW.test(text) && !(file in EXEMPT)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("原来直接显示后端原文的地方都改用了后端报错翻译", async () => {
  for (const [file, marker] of [
    ["contexts/app.tsx", /backendErrorRef\.current\(/],
    // 用户中心：取数失败时的说明走服务端的 backendErrorText，浏览器里的请求走 useBackendError
    ["app/[locale]/(default)/me/page.tsx", /backendErrorText\(/],
    ["app/[locale]/(default)/me/activity/page.tsx", /backendErrorText\(/],
    ["app/[locale]/(default)/me/notes/page.tsx", /backendErrorText\(/],
    ["components/me/settings-panels.tsx", /useBackendError\(\)/],
  ]) {
    const text = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.match(text, marker, file);
  }
});
