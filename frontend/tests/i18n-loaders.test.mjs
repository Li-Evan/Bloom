import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const { locales, toLocale } = await import("../src/i18n/locale.ts");
const { messageLoaders, loadMessages } = await import("../src/i18n/messages.ts");

const src = (path) => new URL(`../src/${path}`, import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(src(path), "utf8"));

test("支持的语言就是 en 与 zh；zh-CN 归一成 zh，不认识的语言不会被当成某种语言", () => {
  assert.deepEqual([...locales], ["en", "zh"]);
  assert.equal(toLocale("zh-CN"), "zh");
  assert.equal(toLocale("ZH"), "zh");
  assert.equal(toLocale("en"), "en");
  for (const unsupported of ["fr", "wp-login.php", ".env", "zh-TW", "", undefined]) {
    assert.equal(toLocale(unsupported), undefined, String(unsupported));
  }
});

test("界面文案：每种语言加载自己的文件", async () => {
  assert.deepEqual(Object.keys(messageLoaders).sort(), [...locales].sort());
  for (const locale of locales) {
    assert.deepEqual(await loadMessages(locale), await readJson(`i18n/messages/${locale}.json`), locale);
  }
  assert.notDeepEqual(await loadMessages("zh"), await loadMessages("en"));
});

test("某种支持的语言加载失败是 bug：抛出，不悄悄回退到英文", async () => {
  const original = messageLoaders.zh;
  messageLoaders.zh = () => Promise.reject(new Error("cannot load zh"));
  try {
    await assert.rejects(loadMessages("zh"), /cannot load zh/);
  } finally {
    messageLoaders.zh = original;
  }
});
