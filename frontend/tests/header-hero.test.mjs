import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const src = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(`${src}${path}`, "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);

// ── 「我的」入口 ──

test("「我的」入口：「用户中心 / User center」「设置 / Settings」是两个不同的词", () => {
  assert.equal(zh.header.menu_items.center, "用户中心");
  assert.equal(en.header.menu_items.center, "User center");
  assert.equal(zh.header.menu_items.settings, "设置");
  assert.equal(en.header.menu_items.settings, "Settings");
});

test("顶栏导航在 logo 和右侧按钮之间居中，右侧按钮不被压窄", async () => {
  const header = await read("components/site/header/index.tsx");
  assert.match(header, /items-center gap-2 px-4 sm:px-6 lg:gap-8 lg:px-8"/);
  assert.doesNotMatch(header, /lg:grid-cols-\[1fr_auto_1fr\]/, "不按整页居中：右侧按钮比 logo 宽，logo 后面会空一大段");
  assert.match(header, /className="hidden h-full min-w-0 flex-1 items-center justify-center md:flex lg:gap-1"/);
  assert.match(header, /"ml-auto hidden shrink-0 items-center justify-end gap-1\.5 md:flex lg:gap-2"/);
  assert.match(header, /<Link href="\/learn" aria-label=\{t\("home"\)\} className="shrink-0 rounded-md">/, "logo 不被压窄");
});

// ── 通知放到顶栏下面 ──

test("通知（Sonner）不压在吸顶顶栏上：桌面 offset 在顶栏下方，手机用一条媒体查询规则改掉写死的 top: 20px", async () => {
  const provider = await read("providers/theme.tsx");
  assert.match(provider, /<Toaster[^>]*position="top-center"/s);
  assert.match(provider, /offset="calc\(var\(--header-height\) \+ 0\.75rem\)"/);
  const css = await read("app/globals.css");
  assert.match(css, /@media \(max-width: 600px\) \{\s*html \[data-sonner-toaster\]\[data-y-position="top"\] \{\s*top: calc\(var\(--header-height\) \+ 0\.75rem\);/);
  const theme = await read("app/theme.css");
  assert.match(theme, /--header-height:\s*4rem;/, "顶栏高 64px，通知偏移量引用它");
});

// ── 钟形曲线标注 ──

test("钟形曲线：手机上标注字号放大一档（缩放后 ≥ 10px）", async () => {
  const curve = await read("components/brand/bell-curve.tsx");
  // 手机（< 640px）标签 18px：整张图约 320px 宽（缩放 0.57），缩放后 10.3px；sigma 20px → 11.4px
  assert.match(curve, /\[--bc-label:18px\] \[--bc-sigma:20px\] sm:\[--bc-label:14px\] sm:\[--bc-sigma:18px\] lg:\[--bc-label:17px\] xl:\[--bc-label:18px\]/);
});
