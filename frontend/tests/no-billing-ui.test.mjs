import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { loadTsx } from "./load-tsx.mjs";

// 开源版没有积分、价格和付费：界面文案和学习操作上都不该出现这些字样
const root = new URL("../src/", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const BILLING_ZH = /积分|扣费|收费|付费|计费|余额|充值|订阅|套餐|定价/;
const BILLING_EN = /\bcredits?\b|\bbilling\b|\bcharged?\b|\bpricing\b|\bsubscri|\brefund/i;

function strings(value, path = "") {
  if (typeof value === "string") return [[path, value]];
  return Object.entries(value).flatMap(([key, child]) => strings(child, path ? `${path}.${key}` : key));
}

test("中英文案里没有积分、扣费、价格、订阅这类说法", async () => {
  for (const locale of ["zh", "en"]) {
    const messages = JSON.parse(await read(`i18n/messages/${locale}.json`));
    for (const [key, text] of strings(messages)) {
      assert.doesNotMatch(text, locale === "zh" ? BILLING_ZH : BILLING_EN, `${locale}:${key}`);
    }
  }
});

for (const locale of ["zh", "en"]) {
  test(`${locale}: 没有课程时的空状态不写价格`, async () => {
    const { default: EmptyCourses } = await loadTsx("components/learn/empty-courses.tsx");
    const messages = JSON.parse(await read(`i18n/messages/${locale}.json`));
    const html = renderToStaticMarkup(
      createElement(NextIntlClientProvider, { locale, messages, timeZone: "UTC" }, createElement(EmptyCourses, { onStart: () => {} }))
    );
    assert.doesNotMatch(html, locale === "zh" ? BILLING_ZH : BILLING_EN);
  });
}

test("课文页的提问、反馈、生成下一篇旁边没有费用标签", async () => {
  for (const file of ["lesson-feedback.tsx", "annotation-panel.tsx", "lesson.tsx"]) {
    assert.doesNotMatch(await read(`components/learn/${file}`), /<Cost|<FreeTag|tokenCost/);
  }
});
