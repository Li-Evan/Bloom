import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const { FONTS, FONT_SCRIPT, parseFont } = await import("../src/lib/font.ts");

// 在一个假的页面里跑根布局的内联脚本：返回 <html> 的 dataset 和触发 storage 事件的函数
function page(stored, { throws = false } = {}) {
  const dataset = {};
  const listeners = [];
  const localStorage = { getItem: (key) => { if (throws) throw new Error("denied"); return key === "bloom:font" ? stored : null; } };
  vm.runInNewContext(FONT_SCRIPT, { document: { documentElement: { dataset } }, localStorage, addEventListener: (type, fn) => listeners.push([type, fn]) });
  const fire = (key, newValue) => listeners.filter(([type]) => type === "storage").forEach(([, fn]) => fn({ key, newValue }));
  return { dataset, fire };
}

test("字体选项：存的值不认识就回到默认 Outfit", () => {
  assert.deepEqual(FONTS, ["outfit", "public-sans", "system"]);
  assert.equal(parseFont("public-sans"), "public-sans");
  assert.equal(parseFont("system"), "system");
  for (const value of [null, undefined, "", "comic-sans"]) assert.equal(parseFont(value), "outfit");
});

test("根布局的内联脚本：首次绘制前按 localStorage 设 data-font，别的标签页改了跟着换，读不到存储也不报错", () => {
  assert.equal(page(null).dataset.font, undefined);
  const { dataset, fire } = page("public-sans");
  assert.equal(dataset.font, "public-sans");
  fire("bloom:font", "system");
  assert.equal(dataset.font, "system");
  fire("other", "outfit");
  assert.equal(dataset.font, "system");
  fire("bloom:font", null);
  assert.equal("font" in dataset, false);
  assert.equal(page("system", { throws: true }).dataset.font, undefined);
});

test("每个非默认字体在 theme.css 里都有 data-font 规则；--font-sans 从 --font-ui 开头，中文回退栈不变；字标固定用 Outfit", async () => {
  const theme = await read("app/theme.css");
  assert.match(theme, /--font-ui: var\(--font-outfit\);/);
  assert.match(theme, /--font-sans: var\(--font-ui\), "PingFang SC"/);
  for (const font of FONTS.filter((f) => f !== "outfit")) assert.match(theme, new RegExp(`:root\\[data-font="${font}"\\] \\{\\s*--font-ui: `));
  const logo = await read("components/brand/logo.tsx");
  assert.match(logo, /font-\[family-name:var\(--font-outfit\)\]/);
});

test("Public Sans 自托管、带许可、不预加载（没选它的人不下载）；内联脚本放在 <head> 里", async () => {
  await access(join(root, "fonts/public-sans-latin.woff2"));
  assert.match(await read("fonts/OFL-PublicSans.txt"), /SIL Open Font License/);
  const fonts = await read("fonts/index.ts");
  assert.match(fonts, /src: "\.\/public-sans-latin\.woff2",[^}]*variable: "--font-public-sans",[^}]*preload: false/);
  assert.match(fonts, /publicSans\.variable/);
  const layout = await read("app/layout.tsx");
  assert.match(layout, /<head>[\s\S]*__html: FONT_SCRIPT[\s\S]*<\/head>/);
});
