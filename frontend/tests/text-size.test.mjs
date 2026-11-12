import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const { TEXT_SIZES, TEXT_SIZE_SCRIPT, parseTextSize } = await import("../src/lib/text-size.ts");

// 在一个假的页面里跑根布局的内联脚本：返回 <html> 的 dataset 和触发 storage 事件的函数
function page(stored, { throws = false } = {}) {
  const dataset = {};
  const listeners = [];
  const localStorage = { getItem: (key) => { if (throws) throw new Error("denied"); return key === "bloom:text-size" ? stored : null; } };
  vm.runInNewContext(TEXT_SIZE_SCRIPT, { document: { documentElement: { dataset } }, localStorage, addEventListener: (type, fn) => listeners.push([type, fn]) });
  const fire = (key, newValue) => listeners.filter(([type]) => type === "storage").forEach(([, fn]) => fn({ key, newValue }));
  return { dataset, fire };
}

test("正文字号五档，存的值不认识就回到标准", () => {
  assert.deepEqual(TEXT_SIZES, ["sm", "md", "lg", "xl", "xxl"]);
  for (const size of TEXT_SIZES) assert.equal(parseTextSize(size), size);
  for (const value of [null, undefined, "", "huge"]) assert.equal(parseTextSize(value), "md");
});

test("根布局的内联脚本：首次绘制前按 localStorage 设 data-text-size，别的标签页改了跟着换，读不到存储也不报错", () => {
  assert.equal(page(null).dataset.textSize, undefined);
  const { dataset, fire } = page("lg");
  assert.equal(dataset.textSize, "lg");
  fire("bloom:text-size", "xxl");
  assert.equal(dataset.textSize, "xxl");
  fire("bloom:font", "system");
  assert.equal(dataset.textSize, "xxl");
  fire("bloom:text-size", null);
  assert.equal("textSize" in dataset, false);
  assert.equal(page("sm", { throws: true }).dataset.textSize, undefined);
});

test("内联脚本放在 <head> 里，和字体脚本各占一个 <script>（两个 IIFE 直接拼起来会把前一个的返回值当函数调）", async () => {
  const layout = await read("app/layout.tsx");
  assert.match(layout, /<head>[\s\S]*__html: FONT_SCRIPT \}\} \/>[\s\S]*__html: TEXT_SIZE_SCRIPT \}\} \/>[\s\S]*<\/head>/);
});

test("每个非标准档在 theme.css 里都有 --text-scale；正文里用 rem 写的字号都乘它", async () => {
  const theme = await read("app/theme.css");
  assert.match(theme, /:root \{[^}]*--text-scale: 1;/);
  for (const size of TEXT_SIZES.filter((s) => s !== "md")) {
    assert.match(theme, new RegExp(`:root\\[data-text-size="${size}"\\] \\{\\s*--text-scale: [\\d.]+;`));
  }

  // learn.css 和 globals.css 里都不能有写死的 rem 字号：阅读正文全部跟着 --text-scale 变
  const learn = await read("app/learn.css");
  assert.deepEqual(learn.match(/font-size: [\d.]+rem;/g), null);
  const globals = await read("app/globals.css");
  assert.match(globals, /\.prose-bloom \{[^}]*font-size: calc\(1rem \* var\(--text-scale\)\);/);
  const bare = [...globals.matchAll(/^([^\n{}]*)\{[^{}]*font-size: [\d.]+rem;/gm)].map((m) => m[1].trim());
  assert.deepEqual(bare, []);
});
