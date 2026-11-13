import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// 小标签、触控区、404 标题等界面细节的行为与结构守卫。

const src = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(`${src}${path}`, "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);
const { cn } = await import("../src/lib/utils.ts");

test("小标签：英文 regular / 14px / 0.2em / 大写；中文 500 / 13px / 0.08em；带序号时是等宽的「01 / …」", async () => {
  const eyebrow = await read("components/brand/eyebrow.tsx");
  const cls = (name) => eyebrow.match(new RegExp(`export const ${name} =\\s*"([^"]*)"`))[1];
  const main = cls("EYEBROW_CLASS");
  assert.match(main, /\bfont-mono text-sm font-normal uppercase tracking-\[0\.2em\]/);
  assert.match(main, /\[&:lang\(zh\)\]:font-sans \[&:lang\(zh\)\]:text-\[13px\] \[&:lang\(zh\)\]:font-medium \[&:lang\(zh\)\]:tracking-\[0\.08em\]/);
  assert.doesNotMatch(main + cls("LABEL_CLASS"), /font-semibold|0\.12em/, "中文不再用 600 / 0.12em");
  assert.match(cls("LABEL_CLASS"), /font-normal uppercase tracking-\[0\.2em\] \[&:lang\(zh\)\]:font-sans \[&:lang\(zh\)\]:font-medium \[&:lang\(zh\)\]:tracking-\[0\.08em\]/);
  assert.match(eyebrow, /<span className="font-mono tabular">\{String\(index\)\.padStart\(2, "0"\)\}<\/span>/);
});

test("账户侧栏分组小标签中英文同一字号（不被 EYEBROW_CLASS 的中文 13px 盖掉）；全局错误页用共用小标签", async () => {
  const eyebrow = await read("components/brand/eyebrow.tsx");
  const base = eyebrow.match(/export const EYEBROW_CLASS =\s*"([^"]*)"/)[1];
  const nav = await read("components/me/nav.tsx");
  const override = nav.match(/<Eyebrow className="([^"]*)">\{t\(`group_\$\{group\.key\}`\)\}<\/Eyebrow>/)[1];
  const classes = cn(base, override).split(/\s+/);
  // 英文那一档和中文那一档都落在同一个字号上：合并后不剩 text-sm，也不剩中文的 13px
  assert.ok(classes.includes("text-xs") && classes.includes("[&:lang(zh)]:text-xs"), classes.join(" "));
  assert.ok(!classes.includes("text-sm") && !classes.includes("[&:lang(zh)]:text-[13px]"), classes.join(" "));
  assert.doesNotMatch(override, /text-\[\d+px\]/, "固定像素的字号会被中文那一档盖掉");
  const globalError = await read("app/global-error.tsx");
  assert.match(globalError, /<Eyebrow tone="dark">Error · 出错了<\/Eyebrow>/);
  assert.doesNotMatch(globalError, /tracking-\[/);
});

test("学习操作只显示动作，不带费用标签", async () => {
  for (const file of ["lesson-feedback.tsx", "new-course-dialog.tsx", "annotation-panel.tsx"]) {
    assert.doesNotMatch(await read(`components/learn/${file}`), /<Cost|<FreeTag|credits\.tokenCost/);
  }
});

test("抽屉里语言 / 主题按钮是 44px 触控区", async () => {
  const menu = await read("components/site/header/mobile-menu.tsx");
  assert.match(menu, /<LocaleToggle tone="auto" className="h-11 min-w-11/);
  assert.match(menu, /<ThemeToggle tone="auto" className="size-11"/);
});

test("404 页 <title>：「Page not found | Bloom」/「找不到页面 | Bloom」，水合后也不被换回首页标题", async () => {
  assert.equal(en.not_found.meta_title, "Page not found | Bloom");
  assert.equal(zh.not_found.meta_title, "找不到页面 | Bloom");
  for (const file of ["app/[locale]/not-found.tsx", "app/not-found.tsx"]) {
    const page = await read(file);
    assert.match(page, /title: \{ absolute: t\("meta_title"\) \}/, file);
    assert.match(page, /<DocumentTitle title=\{t\("meta_title"\)\} \/>/, file);
  }
  assert.match(await read("components/brand/document-title.tsx"), /document\.title = title/);
});

test("tsconfig 的 include 里没有 .next-build/types", async () => {
  const tsconfig = await readFile(new URL("../tsconfig.json", import.meta.url), "utf8");
  assert.doesNotMatch(tsconfig, /\.next-build/);
});
