import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./load-tsx.mjs";

// 顶栏、小标签、等宽数字等界面细节的行为与结构守卫；配色和顶栏的断言在 finishing.test.mjs 里。

const src = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(`${src}${path}`, "utf8");

const theme = await read("app/theme.css");
const light = theme.match(/:root\s*{([^}]*)}/)[1];
const dark = theme.match(/\.dark\s*{([^}]*)}/)[1];
const token = (block, name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1];
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("圆角（和原官网一致）：小按钮 / 小控件 6px、按钮与输入框 8px、中等容器 12px、卡片 16px", async () => {
  const radius = Number(light.match(/--radius:\s*([\d.]+)rem/)[1]) * 16;
  const px = (name) => {
    const m = theme.match(new RegExp(`--radius-${name}:\\s*calc\\(var\\(--radius\\) ([+-]) (\\d+)px\\)`));
    return m ? radius + (m[1] === "+" ? 1 : -1) * Number(m[2]) : radius; // 没有 calc 的就是 var(--radius) 本身
  };
  assert.deepEqual(["sm", "md", "lg", "xl"].map(px), [6, 8, 12, 16]);
  const button = await read("components/ui/button.tsx");
  assert.match(button.match(/cva\(\s*"([^"]*)"/)[1], /\brounded-md\b/, "按钮默认 rounded-md = 8px");
  assert.match(button, /sm: "h-8 gap-1\.5 rounded-sm px-3/, "小按钮 rounded-sm = 6px");
  assert.match(await read("components/ui/input.tsx"), /\brounded-md\b/, "输入框 rounded-md = 8px");
  // 卡片不动：Card 组件 rounded-lg（12px）
  assert.match(await read("components/ui/card.tsx"), /\brounded-lg\b/);
});

test("中文小标签：字距 0.08em、外层正文字体，数字 / 斜杠 / 拉丁字母是等宽（渲染 Eyebrow 与 Mono 本身）", async () => {
  const { default: Mono } = await loadTsx("components/brand/mono.tsx");
  const { default: Eyebrow, EYEBROW_CLASS, LABEL_CLASS } = await loadTsx("components/brand/eyebrow.tsx");
  const mono = (text) => renderToStaticMarkup(createElement(Mono, { text }));
  const span = (t) => `<span class="font-mono">${t}</span>`;
  assert.equal(mono("一门 10 篇的课"), `一门 ${span("10")} 篇的课`);
  assert.equal(mono("每 100 页 ¥35.00"), `每 ${span("100")} 页 ${span("¥35.00")}`);
  assert.equal(mono("100 页 · 12 个月内读完"), `${span("100")} 页 · ${span("12")} 个月内读完`);
  assert.equal(mono("布鲁姆的两个标准差 · 1984"), `布鲁姆的两个标准差 · ${span("1984")}`);
  assert.equal(mono("Bloom 是一位 AI 私教"), `${span("Bloom")} 是一位 ${span("AI")} 私教`);
  assert.equal(mono("没有数字也没有字母"), "没有数字也没有字母");
  assert.equal(mono("").length, 0);
  // 文字不变
  assert.equal(mono("© 2026 Bloom. 保留所有权利。").replace(/<[^>]+>/g, ""), "© 2026 Bloom. 保留所有权利。");

  const html = (props, children) => renderToStaticMarkup(createElement(Eyebrow, props, children));
  const indexed = html({ index: 2 }, "怎么学");
  assert.match(indexed, /<span class="font-mono tabular">02<\/span> <span aria-hidden="true" class="font-mono">\/<\/span> 怎么学<\/p>/);
  assert.match(html({}, "一门 10 篇的课"), /一门 <span class="font-mono">10<\/span> 篇的课<\/p>/);
  // 中文：外层改成正文字体（汉字和空格不再是等宽字形，间距均匀）、字距 0.08em；英文那一档不变
  for (const cls of [EYEBROW_CLASS, LABEL_CLASS]) {
    assert.match(cls, /\bfont-mono\b/);
    assert.match(cls, /\[&:lang\(zh\)\]:font-sans/);
    assert.match(cls, /\[&:lang\(zh\)\]:tracking-\[0\.08em\]/);
    assert.match(cls, /\btracking-\[0\.2em\]/);
    assert.doesNotMatch(cls, /0\.16em/);
  }
});

test("页脚链接手机点击区 ≥ 40px（min-h-10），桌面仍是紧凑行距", async () => {
  const footer = await read("components/site/footer/index.tsx");
  assert.equal([...footer.matchAll(/inline-flex min-h-10 items-center [^"]*sm:min-h-0/g)].length, 2, "GitHub 链接和导航链接");
  assert.equal([...footer.matchAll(/<(?:a|Link)\b/g)].length, 2, "页脚只有这两处链接，都在上面数过了");
  assert.match(footer, /<ul className="flex flex-wrap items-center gap-x-5 text-sm">/);
});

test("暗色下的灰字提亮：说明文字（--muted-foreground）在页面底 / 卡片上 ≥ 7:1，脚注（--subtle-foreground）≥ 6:1；永远深色的区块里小灰字用 stone-300", async () => {
  for (const surface of ["background", "card"]) {
    assert.ok(contrast(token(dark, "muted-foreground"), token(dark, surface)) >= 7, `暗色 muted-foreground 在 ${surface} 上`);
    assert.ok(contrast(token(dark, "subtle-foreground"), token(dark, surface)) >= 6, `暗色 subtle-foreground 在 ${surface} 上`);
  }
  // 翠绿填充上的字：近黑（primary-foreground / stone-950）≥ 7.5:1；原来的 emerald-950 只有 6.1:1，不再用
  assert.ok(contrast(token(light, "primary-foreground"), token(light, "primary")) >= 7.5);
  // 提亮之后层次还在：前景 > 说明 > 脚注
  assert.ok(luminance(token(dark, "foreground")) > luminance(token(dark, "muted-foreground")));
  assert.ok(luminance(token(dark, "muted-foreground")) > luminance(token(dark, "subtle-foreground")));
  // 亮色不动
  assert.ok(contrast(token(light, "muted-foreground"), token(light, "card")) >= 7);
  for (const file of [
    "components/site/footer/index.tsx",
    "components/site/header/mobile-menu.tsx",
    "app/global-error.tsx",
    "app/not-found.tsx",
  ]) {
    assert.doesNotMatch(await read(file), /text-stone-400/, `${file}：深色底上的小灰字用 stone-300（≥ 10:1）`);
  }
});

test("钟形曲线的标注：中文里数字、拉丁字母等宽、汉字用正文字体（渲染 BellCurve 本身）；英文整句等宽原样", async () => {
  const { monoRuns } = await import("../src/lib/mono-runs.ts");
  assert.deepEqual(monoRuns("前 2%"), [{ text: "前 ", mono: false }, { text: "2%", mono: true }]);
  assert.deepEqual(monoRuns("一门 10 篇"), [{ text: "一门 ", mono: false }, { text: "10", mono: true }, { text: " 篇", mono: false }]);
  assert.deepEqual(monoRuns(""), []);
  const { default: BellCurve } = await loadTsx("components/brand/bell-curve.tsx");
  const html = (labels) => renderToStaticMarkup(createElement(BellCurve, { labels, animated: false }));
  const zhHtml = html({ avg: "传统课堂", tutored: "一对一辅导", top: "前 2%" });
  assert.match(zhHtml, /<tspan class="font-sans">前 <\/tspan><tspan class="font-mono">2%<\/tspan>/);
  assert.match(zhHtml, /<tspan class="font-sans">传统课堂<\/tspan>/);
  const enHtml = html({ avg: "Conventional class", tutored: "1-on-1 tutored", top: "Top 2%" });
  assert.doesNotMatch(enHtml, /<tspan/, "英文没有汉字，整句本来就是等宽，不拆 tspan（否则单词间的空格变成正文字体的窄空格）");
  assert.match(enHtml, />Top 2%<\/text>/);
});

