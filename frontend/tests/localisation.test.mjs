import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createTranslator } from "next-intl";

const read = (path) =>
  readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
const [en, zh] = await Promise.all(
  ["en", "zh"].map(async (l) => JSON.parse(await read(`i18n/messages/${l}.json`)))
);
const translator = (messages, locale, namespace) =>
  createTranslator({ locale, messages, namespace });

const CJK = /[一-鿿]/;

test("对话框的关闭按钮有两种语言的文案，源码里没有写死的英文", async () => {
  assert.equal(typeof en.common.close, "string");
  assert.equal(typeof zh.common.close, "string");
  assert.ok(CJK.test(zh.common.close) && !CJK.test(en.common.close));

  assert.doesNotMatch(await read("components/ui/dialog.tsx"), />Close</);
});

test("用户中心每一页都有自己的本地化标题，不用站点通用标题", async () => {
  for (const [dir, key] of [
    ["", "header.menu_items.center"],
    ["activity", "me.nav.activity"],
    ["notes", "me.nav.notes"],
    ["teaching", "me.nav.teaching"],
    ["settings", "me.nav.settings"],
  ]) {
    const page = await read(`app/[locale]/(default)/me/${dir}${dir ? "/" : ""}page.tsx`);
    assert.match(page, /export async function generateMetadata/, dir);
    assert.ok(page.includes(`privatePageMetadata("${key}")`), `${dir} 的标题没有取 ${key}`);
    const [a, b, ...rest] = key.split(".");
    const pick = (messages) => [b, ...rest].reduce((node, k) => node[k], messages[a]);
    assert.ok(CJK.test(pick(zh)) && !CJK.test(pick(en)), key);
  }
});
