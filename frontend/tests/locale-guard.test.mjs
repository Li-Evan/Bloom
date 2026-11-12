import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { hasLocale } from "next-intl";

const { locales } = await import("../src/i18n/locale.ts");

test("扫描器常打的一级路径都不是语言", () => {
  for (const segment of ["wp-login.php", ".env", "ads.txt", "apple-touch-icon.png", "foo.bar", "admin", "EN"]) {
    assert.equal(hasLocale(locales, segment), false, segment);
  }
  for (const locale of locales) {
    assert.equal(hasLocale(locales, locale), true, locale);
  }
});

test("[locale] 布局的 generateMetadata 和组件都在使用 locale 之前校验，不认识就 404", async () => {
  const source = await readFile(new URL("../src/app/[locale]/layout.tsx", import.meta.url), "utf8");
  const guard = "if (!hasLocale(routing.locales, locale)) {\n    notFound();\n  }\n  setRequestLocale(locale);";
  assert.equal(source.split(guard).length - 1, 2, "两处都要先校验再 setRequestLocale");
});
