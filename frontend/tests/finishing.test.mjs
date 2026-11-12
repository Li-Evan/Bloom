import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

const src = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(src, path), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);

async function files(dir, pattern = /\.(tsx?|css)$/) {
  const out = [];
  for (const entry of await readdir(join(src, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await files(path, pattern)));
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

// ── 全站配色：除品牌深色区块外只用语义令牌 ──

// 允许写死颜色的文件，和理由。新增的写死颜色必须来这里登记，说清楚为什么不能用令牌
const HARD_CODED = {
  "app/layout.tsx": "浏览器地址栏颜色（viewport themeColor）只能是具体色值",
  "app/not-found.tsx": "根级 404：品牌深色整页，不在主题提供者里",
  "app/global-error.tsx": "根布局出错时的兜底页：品牌深色整页，自带 <html>",
  "app/globals.css": "代码块（深色底）的文字色；大纲复选框对勾的 data URI 写不了变量",
  "app/learn.css": "PDF 页面是纸，暗色主题下也必须是白底",
  "components/brand/bell-curve.tsx": "钟形曲线的 SVG 配色按底色分深/浅两套",
  "components/brand/eyebrow.tsx": "深色区块上的小标签用亮翠绿",
  "components/brand/grid-glow.tsx": "深色区块的网格与光晕",
  "components/brand/logo.tsx": "字标在深色区块上的两套颜色",
  "components/learn/zoomable-image.tsx": "图片查看器：深色遮罩上的关闭按钮；透明图片的白底（否则黑字线稿融进遮罩）",
  "components/locale/toggle.tsx": "顶栏（深色）里的语言按钮",
  "components/theme/toggle.tsx": "顶栏（深色）里的主题按钮",
  "components/ui/button.tsx": "深色底上的描边按钮、禁用态，和翠绿行动区上的深色 cta 按钮变体",
};
const COLOUR = /\b(?:stone|emerald|zinc|gray|slate|neutral)-\d|#[0-9a-fA-F]{3,6}\b|\bbg-white\b|\btext-white\b|\bbg-black\b|\bhover:text-white\b|\b(?:bg|text|border)-(?:white|black)\b/;

test("写死的颜色（stone / emerald / gray 色阶、十六进制、white / black）只出现在登记过的品牌深色区块里", async () => {
  const hits = [];
  for (const file of [...(await files("app")), ...(await files("components")), ...(await files("lib"))]) {
    if (file === "app/theme.css") continue;
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    if (COLOUR.test(text)) hits.push(file);
  }
  assert.deepEqual(hits.filter((f) => !(f in HARD_CODED)), [], "这些文件写死了颜色，要么换成令牌，要么到 HARD_CODED 登记理由");
  assert.deepEqual(Object.keys(HARD_CODED).filter((f) => !hits.includes(f)), [], "这些登记项已经没有写死的颜色了，从 HARD_CODED 去掉");
});

test("用户可见的页面里没有其它色系的写死颜色（红、琥珀、绿、蓝……）", async () => {
  for (const file of [...(await files("app")), ...(await files("components"))]) {
    const text = await read(file);
    assert.doesNotMatch(text, /\b(?:text|bg|border|ring|fill|stroke)-(?:red|amber|green|blue|yellow|orange|indigo|purple|violet|pink|rose|sky|cyan|teal|lime|fuchsia)-\d/, file);
  }
});

test("令牌是十六进制颜色：没有 hsl(var(--…)) 这种模板时代的无效写法（值会整条失效）", async () => {
  for (const file of [...(await files("app")), ...(await files("components"))]) {
    assert.doesNotMatch(await read(file), /(?:hsl|rgb)a?\(\s*var\(--/, file);
  }
});

// ── 焦点环 ──

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const theme_token = (block, name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1];
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("焦点环：base 层里 :where() 的一条规则（优先级 0，组件类能改）；颜色在亮暗底和深色顶栏上都 ≥ 3:1", async () => {
  const css = await read("app/globals.css");
  const baseStart = css.indexOf("@layer base {");
  const baseEnd = css.indexOf("\n}\n", baseStart);
  const rule = css.indexOf(":where(:focus-visible) {");
  assert.ok(rule > baseStart && rule < baseEnd, "规则要放在 @layer base 里，组件上的工具类才盖得过它（放在层外会盖过 outline-offset-*、outline-none）");
  const body = css.slice(rule, css.indexOf("}", rule));
  assert.match(body, /outline:\s*2px solid var\(--ring\)/);
  assert.match(body, /outline-offset:\s*2px/);
  // 不再全局清 ring：选中态（ring-2 ring-foreground）聚焦时不能被抹掉
  assert.doesNotMatch(css, /--tw-ring-shadow/);
  assert.match(css, /:where\(:focus-visible\[aria-invalid="true"\]\)\s*{\s*outline-color:\s*var\(--destructive\)/);
  // Firefox：Tailwind preflight 同层的 :-moz-focusring { outline: auto } 优先级（0,1,0）高于 :where()，不另写一条 Firefox 会显示自带的蓝色 auto 轮廓。
  // 要在 base 层里、写在 preflight 之后，单独成规则（Chrome 不认这个伪类，放进选择器列表会整条作废）
  const moz = css.indexOf("\n  :-moz-focusring {");
  assert.ok(moz > baseStart && moz < baseEnd, ":-moz-focusring 规则要放在 @layer base 里");
  assert.match(css.slice(moz, css.indexOf("}", moz)), /outline:\s*2px solid var\(--ring\);\s*outline-offset:\s*2px;/);
  assert.match(css, /:-moz-focusring\[aria-invalid="true"\]\s*{\s*outline-color:\s*var\(--destructive\)/);

  const theme = await read("app/theme.css");
  const token = (block, name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1];
  const light = theme.match(/:root\s*{([^}]*)}/)[1];
  const dark = theme.match(/\.dark\s*{([^}]*)}/)[1];
  // 焦点环用 --ring（不是 --primary：主按钮的亮绿在浅色底上只有 2.4:1）
  assert.ok(contrast(token(light, "ring"), token(light, "background")) >= 3, "亮色底上的焦点环");
  assert.ok(contrast(token(light, "ring"), token(light, "card")) >= 3, "亮色卡片上的焦点环");
  assert.ok(contrast(token(dark, "ring"), token(dark, "background")) >= 3, "暗色底上的焦点环");
  assert.ok(contrast(token(dark, "ring"), token(dark, "card")) >= 3, "暗色卡片上的焦点环");
  assert.ok(contrast(token(light, "ring"), token(light, "ink-inverse")) >= 3, "深色顶栏、页脚上的焦点环（亮色主题）");
  assert.ok(contrast(token(dark, "ring"), token(dark, "ink-inverse")) >= 3, "深色顶栏、页脚上的焦点环（暗色主题）");
  assert.match(css, /\* \{\s*@apply border-border outline-ring;/);
});

// ── 主按钮配色：亮绿底 + 近黑字，亮暗一致；文字用的绿、禁用态都够对比度 ──

test("主按钮：亮绿 #00bc7d（v4 emerald-500）底 + 近黑字，亮暗两套一致，文字对比度 ≥ 4.5:1；禁用态 muted 底 + muted-foreground 字也 ≥ 4.5:1", async () => {
  const theme = await read("app/theme.css");
  const token = (block, name) => theme_token(block, name);
  const light = theme.match(/:root\s*{([^}]*)}/)[1];
  const dark = theme.match(/\.dark\s*{([^}]*)}/)[1];

  for (const [name, block] of [["亮色", light], ["暗色", dark]]) {
    assert.equal(token(block, "primary"), "#00bc7d", `${name} --primary`);
    assert.equal(token(block, "primary-foreground"), "#0a0908", `${name} --primary-foreground`);
    assert.equal(token(block, "primary-hover"), "#00d492", `${name} --primary-hover`);
    assert.ok(contrast(token(block, "primary-foreground"), token(block, "primary")) >= 4.5, `${name}主按钮文字对比度`);
    assert.ok(contrast(token(block, "primary-foreground"), token(block, "primary-hover")) >= 4.5, `${name}主按钮悬停文字对比度`);
    assert.ok(contrast(token(block, "muted-foreground"), token(block, "muted")) >= 4.5, `${name}禁用态对比度`);
    assert.ok(contrast(token(block, "accent-foreground"), token(block, "accent")) >= 4.5, `${name}强调底上的字（accent-foreground）对比度`);
  }
  // 白字压在亮绿上只有 2.3:1，所以不会有人再把 primary-foreground 改回白色
  assert.ok(contrast("#ffffff", token(light, "primary")) < 3);

  const button = await read("components/ui/button.tsx");
  assert.match(button, /default:\s*"bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-muted disabled:text-muted-foreground"/);
  assert.match(button, /"on-dark":\s*"bg-primary text-primary-foreground hover:bg-primary-hover/);
  assert.match(button, /\bcta:\s*"bg-stone-950/);
  // 翠绿行动区上的 cta 按钮：焦点轮廓用深色（见下面「bg-primary 区域内的焦点环」）
  assert.match(button, /\bcta:\s*"[^"]*focus-visible:outline-ink-inverse/);
  // 禁用态不拿主色淡化，实心按钮的基础类里也没有全局的 disabled:opacity-*
  assert.doesNotMatch(button.match(/cva\(\s*"([^"]*)"/)[1], /disabled:opacity/);
  // 字重统一 600
  assert.match(button.match(/cva\(\s*"([^"]*)"/)[1], /\bfont-semibold\b/);
  assert.doesNotMatch(button.match(/cva\(\s*"([^"]*)"/)[1], /\bfont-medium\b/);
  // 链接类变体用文字绿令牌，不用亮绿
  assert.match(button, /link:\s*"text-primary-text/);
});

// ── 文字绿令牌 --primary-text，--primary / --primary-hover 不当文字色 ──

test("文字绿令牌 --primary-text：亮 #007a55（v4 emerald-700）、暗 #00d492（emerald-400），在页面底 / 卡片 / muted / 强调底上都 ≥ 4.5:1，并映射成 Tailwind 的 text-primary-text", async () => {
  const theme = await read("app/theme.css");
  const light = theme.match(/:root\s*{([^}]*)}/)[1];
  const dark = theme.match(/\.dark\s*{([^}]*)}/)[1];
  assert.equal(theme_token(light, "primary-text"), "#007a55");
  assert.equal(theme_token(dark, "primary-text"), "#00d492");
  assert.match(theme, /--color-primary-text:\s*var\(--primary-text\);/);
  for (const [name, block] of [["亮色", light], ["暗色", dark]]) {
    for (const surface of ["background", "card", "muted", "accent"]) {
      assert.ok(contrast(theme_token(block, "primary-text"), theme_token(block, surface)) >= 4.5, `${name}：文字绿在 ${surface} 上`);
    }
  }
  // 反面：亮绿主色当文字在亮色底上不够（悬停色更不够），所以才要分开
  assert.ok(contrast(theme_token(light, "primary"), theme_token(light, "background")) < 3);
  assert.ok(contrast(theme_token(light, "primary-hover"), theme_token(light, "background")) < 2);
});

// ── 绿色令牌 = 原官网（https://li-evan.github.io/Bloom/）用的 Tailwind v4 emerald 色板 ──

// 原官网样式表里的 --color-emerald-*（oklch，Tailwind v4 默认色板；200 / 800 / 900 按 v4 默认值，官网没用到）
const EMERALD_OKLCH = {
  50: [97.9, 0.021, 166.113], 100: [95, 0.052, 163.051], 200: [90.5, 0.093, 164.15], 300: [84.5, 0.143, 164.978],
  400: [76.5, 0.177, 163.223], 500: [69.6, 0.17, 162.48], 600: [59.6, 0.145, 163.225], 700: [50.8, 0.118, 165.612],
  950: [26.2, 0.051, 172.552],
};
function oklchToHex([lightness, chroma, hue]) {
  const h = (hue * Math.PI) / 180;
  const [L, a, b] = [lightness / 100, chroma * Math.cos(h), chroma * Math.sin(h)];
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((x) => x ** 3);
  const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const encode = (x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  return `#${linear.map((x) => encode(Math.min(1, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;
}
const emerald = (step) => oklchToHex(EMERALD_OKLCH[step]);

test("主色 / 悬停 / 文字绿 / 焦点环 / 强调底都取自原官网的 v4 emerald 色板（按 oklch 换算），全站没有 v3 的绿色十六进制", async () => {
  // 换算本身：和 Tailwind v4 文档里的十六进制一致
  assert.deepEqual([500, 400, 600, 700, 300, 50, 950].map(emerald), ["#00bc7d", "#00d492", "#009966", "#007a55", "#5ee9b5", "#ecfdf5", "#002c22"]);
  const theme = await read("app/theme.css");
  const light = theme.match(/:root\s*{([^}]*)}/)[1];
  const dark = theme.match(/\.dark\s*{([^}]*)}/)[1];
  for (const [name, block] of [["亮色", light], ["暗色", dark]]) {
    assert.equal(theme_token(block, "primary"), emerald(500), `${name} --primary = emerald-500`);
    assert.equal(theme_token(block, "primary-hover"), emerald(400), `${name} --primary-hover = emerald-400`);
    assert.equal(theme_token(block, "sidebar-primary"), emerald(500), `${name} --sidebar-primary`);
  }
  assert.equal(theme_token(light, "primary-text"), emerald(700), "亮色文字绿 = emerald-700");
  assert.equal(theme_token(light, "ring"), emerald(600), "亮色焦点环 = emerald-600");
  assert.equal(theme_token(light, "accent"), emerald(50));
  assert.equal(theme_token(light, "accent-foreground"), emerald(700));
  assert.equal(theme_token(dark, "primary-text"), emerald(400), "暗色文字绿 = emerald-400");
  assert.equal(theme_token(dark, "ring"), emerald(400));
  assert.equal(theme_token(dark, "accent"), emerald(950));
  assert.equal(theme_token(dark, "accent-foreground"), emerald(300));
  // 对比度（实测过的数）：文字 ≥ 4.5:1；焦点环（非文本）≥ 3:1，亮色在页面底 / 卡片 / muted / 强调底 / 深色顶栏上都要
  for (const surface of ["background", "card", "muted", "accent"]) {
    assert.ok(contrast(theme_token(light, "primary-text"), theme_token(light, surface)) >= 4.5, `亮色文字绿在 ${surface}`);
    assert.ok(contrast(theme_token(light, "ring"), theme_token(light, surface)) >= 3, `亮色焦点环在 ${surface}`);
    assert.ok(contrast(theme_token(dark, "primary-text"), theme_token(dark, surface)) >= 4.5, `暗色文字绿在 ${surface}`);
    assert.ok(contrast(theme_token(dark, "ring"), theme_token(dark, surface)) >= 3, `暗色焦点环在 ${surface}`);
  }
  assert.ok(contrast(theme_token(light, "ring"), theme_token(light, "ink-inverse")) >= 3, "深色顶栏上的亮色焦点环");
  // 全站（源码、测试之外）不再有 v3 emerald 的十六进制：theme.css、钟形曲线 SVG、注释都已换
  const V3 = /#(?:10b981|34d399|059669|047857|6ee7b7|a7f3d0|052e1f)\b/i;
  for (const file of [...(await files("app")), ...(await files("components")), ...(await files("lib"))]) {
    assert.doesNotMatch(await read(file), V3, `${file} 里还有 v3 emerald 的十六进制`);
  }
});

// 文字一律用 text-primary-text：text-primary（含 /40 这类透明度写法）、text-primary-hover、hover:text-primary-hover 一律不许。
// 填充用 bg-primary，描边装饰用 border-primary，这两种不受限。深色区块里的亮绿文字写的是 emerald-400（HARD_CODED 登记过），不在这条里。
const TEXT_PRIMARY = /(?<![\w-])text-primary(?!-text(?![\w-])|-foreground(?![\w-]))/;

test("源码里没有把 --primary / --primary-hover 当文字色用：不许 text-primary、text-primary-hover、hover:text-primary-hover", async () => {
  const hits = [];
  for (const file of [...(await files("app")), ...(await files("components")), ...(await files("lib"))]) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    if (TEXT_PRIMARY.test(text)) hits.push(file);
    // CSS 里 color: var(--primary) / var(--primary-hover) 同理（background、border、stroke 不算）
    if (file.endsWith(".css") && /(?:^|[;{\s])color:\s*var\(--primary(?:-hover)?\)/.test(text)) hits.push(file);
  }
  assert.deepEqual(hits, [], "这些文件把亮绿 --primary 当文字色了：改用 text-primary-text（hover:text-primary-text）");

  // 守卫本身有效
  for (const bad of ["text-primary", "hover:text-primary", "text-primary/40", "text-primary-hover", "hover:text-primary-hover", "size-4 text-primary shrink-0"]) {
    assert.match(bad, TEXT_PRIMARY, bad);
  }
  for (const ok of ["text-primary-text", "hover:text-primary-text", "text-primary-text/40", "text-primary-foreground", "bg-primary text-primary-foreground", "hover:bg-primary-hover", "border-primary/30", "ring-primary/20"]) {
    assert.doesNotMatch(ok, TEXT_PRIMARY, ok);
  }
});

test("排版里的链接和悬停用文字绿（--primary-text），不用 --primary-hover；悬停靠下划线加粗区分", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /--tw-prose-links:\s*var\(--primary-text\);/);
  assert.match(css, /\.prose-bloom a:hover \{\s*color: var\(--primary-text\);\s*text-decoration-thickness: 2px;/);
  assert.match(await read("components/brand/eyebrow.tsx"), /"text-primary-text"/);
});

// ── 亮绿区域里的焦点环 ──

test("bg-primary（翠绿行动区）里的焦点环用深色：--ink-inverse 对亮绿底 ≥ 3:1（默认的 --ring 只有 1.3–1.5:1）", async () => {
  const theme = await read("app/theme.css");
  const light = theme.match(/:root\s*{([^}]*)}/)[1];
  const dark = theme.match(/\.dark\s*{([^}]*)}/)[1];
  for (const [name, block] of [["亮色", light], ["暗色", dark]]) {
    assert.ok(contrast(theme_token(block, "ring"), theme_token(block, "primary")) < 3, `${name}：默认焦点环压在亮绿上看不见，这就是要单独处理的原因`);
    assert.ok(contrast(theme_token(block, "ink-inverse"), theme_token(block, "primary")) >= 3, `${name}：深色焦点环在亮绿底上`);
  }
  // cta 变体（深色按钮）自带深色焦点环，放在亮绿底上时用它
  const button = await read("components/ui/button.tsx");
  assert.match(button, /\bcta:\s*"[^"]*focus-visible:outline-ink-inverse/);
});

test("焦点指示只有一套（轮廓）：组件里没有半透明的 focus-visible:ring-*，也没有 outline-none 盖掉它；几处特殊控件各自调整了轮廓", async () => {
  const sources = [...(await files("app")), ...(await files("components"))].filter((f) => f.endsWith(".tsx"));
  for (const file of sources) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(text, /\bfocus(?:-visible)?:(?:after:)?ring-/, `${file} 还在用 focus-visible:ring-*（会和选中的 ring 抢同一个 box-shadow）`);
    // 任何写法的 outline-none / outline-hidden / outline-0 都不行（含 focus:、data-[x]:、aria-[x]: 等变体和 [&_x]: 任意变体）；
    // 唯一的例外是整卡拉伸链接的 focus-visible:outline-none（它在 ::after 上画整卡的轮廓），先把这一处摘掉再查
    const allowed = file === "components/learn/course-card.tsx" ? text.replaceAll("focus-visible:outline-none", "") : text;
    assert.doesNotMatch(allowed, /\boutline-(?:none|hidden|0)\b/, `${file} 有 outline-none / outline-hidden / outline-0（会抹掉焦点轮廓）`);
  }

  // 顶栏链接和顶栏一样高：轮廓收进框里，左右留白让轮廓不压字，下划线仍和文字等宽
  const header = await read("components/site/header/index.tsx");
  assert.match(header, /h-full items-center whitespace-nowrap px-1\.5 [^"]*focus-visible:-outline-offset-2/);
  assert.match(header, /after:inset-x-2/);
  // 手机用户中心标签条是横向滚动容器，会截上下：轮廓收进框里
  const meNav = await read("components/me/nav.tsx");
  assert.match(meNav, /h-12 shrink-0[^"]*focus-visible:-outline-offset-2/);
  // Tab 到只露出一半的标签：浏览器不会把它完整滚进来，聚焦时自己滚
  // 补的这一次滚动只在键盘聚焦时做：鼠标 / 触摸点一个只露出一截的标签，不能把它从手指下滚走（点击会落空）
  assert.match(meNav, /onFocus=\{\(e\) => \{\s*if \(e\.currentTarget\.matches\(":focus-visible"\)\) \{\s*e\.currentTarget\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\);/);
  // 会滚动的容器里 Tab 聚焦：滚动区留出 scroll-padding，控件才不会贴着边、轮廓才不被截
  const dialogSource = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialogSource, /onFocus=\{\(e\) => \{\s*if \(e\.target\.matches\(":focus-visible"\)\) e\.target\.scrollIntoView\(\{ block: "nearest" \}\);\s*\}\}\s*className="min-h-0 flex-1 scroll-py-1 space-y-5 overflow-y-auto/);
  // 两个文件拖放区（参考资料、项目文件）里的文件框是 sr-only：键盘聚焦时由整块拖放区画出焦点轮廓
  assert.match(dialogSource, /const dropZone = [\s\S]*?has-\[:focus-visible\]:outline has-\[:focus-visible\]:outline-2 has-\[:focus-visible\]:outline-offset-2 has-\[:focus-visible\]:outline-ring/);
  assert.equal([...dialogSource.matchAll(/className=\{dropZone\(/g)].length + [...dialogSource.matchAll(/\bdropZone\(projectDrag\)/g)].length >= 2, true);
  assert.match(await read("components/learn/lesson-nav.tsx"), /min-h-0 flex-1 scroll-py-1 overflow-y-auto p-3/);
  assert.match(await read("app/globals.css"), /scroll-padding-bottom:\s*0\.5rem/);
  // 页边的划线小圆点贴着视口右缘（手机上更近），轮廓收进圆点里
  assert.match(await read("components/learn/lesson.tsx"), /group\/dot absolute z-10 flex size-6 items-center justify-center rounded-full focus-visible:-outline-offset-2 lg:size-7/);
  // 三页的右栏吸顶内容（.learn-rail）是会滚动的容器，四周留 4px（padding）再用负 margin 抵掉，给轮廓
  const rail = (await read("app/learn.css")).match(/\.learn-rail \{([^}]*)\}/)[1];
  assert.match(rail, /margin: -0\.25rem;/);
  assert.match(rail, /padding: 0\.25rem;/);
  assert.match(rail, /overflow-y: auto;/);
  assert.match(rail, /scroll-padding-block: 0\.25rem;/);
  assert.match(await read("components/learn/lesson.tsx"), /"learn-rail hidden lg:block"/);
  // 整卡拉伸链接：轮廓只画在整卡（::after）上，链接自己不再画第二圈
  const card = await read("components/learn/course-card.tsx");
  assert.match(card, /focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring/);
  // 选中 / 今天用 ring 表示的日期：轮廓挪到 ring 外面；热力格的横向滚动容器四周留出轮廓的位置
  const activity = await read("components/me/activity-view.tsx");
  assert.match(activity, /ring-2 ring-ring ring-offset-2 ring-offset-card focus-visible:outline-offset-\[6px\]/);
  assert.match(activity, /ring-1 ring-ring focus-visible:outline-offset-4/);
  // 足迹热力图按卡片宽度等分铺满，放几周和概览的小热力图一样（use-heat-weeks.ts），不再是横向滚动容器
  assert.match(activity, /useHeatWeeks\(\)/);
  assert.doesNotMatch(activity, /overflow-x-auto/);
  assert.doesNotMatch(activity, /\n\s*\/\/ 横向滚动容器/, "JSX 子节点里不能写 // 注释（会当文字渲染出来）");
});

// ── 顶栏 ──

test("顶栏跟随亮暗主题：主题底色 95% 不透明 + 8px 模糊，高度 64；课文页的面包屑条仍然不透明", async () => {
  const header = await read("components/site/header/index.tsx");
  const cls = header.match(/<header className="([^"]*)"/)[1];
  assert.match(cls, /\bbg-background\/95\b/, "主题背景 95%");
  assert.match(cls, /\bbackdrop-blur-sm\b/, "Tailwind v4 的 backdrop-blur-sm 是 8px");
  assert.match(cls, /\bh-16\b/);
  assert.match(cls, /\bsticky top-0\b/);
  assert.equal(luminance(theme_token((await read("app/theme.css")).match(/:root\s*{([^}]*)}/)[1], "ink-inverse")), luminance("#0c0a09"));
  // 面包屑条（吸在顶栏下面）保持不透明：课文页滚动时正文不会隔着它透出来
  const shell = await read("components/learn/shell.tsx");
  const crumb = shell.match(/cn\(\s*"(z-30 h-14 [^"]*)"/)[1];
  assert.match(crumb, /\bbg-background\b(?!\/)/);
  assert.doesNotMatch(crumb, /backdrop-blur/);
});

test("顶栏的焦点轮廓：95% 不透明叠在任何内容上，合成后的顶栏底色对轮廓色都 ≥ 4.5:1（亮暗主题）", async () => {
  const header = await read("components/site/header/index.tsx");
  const cls = header.match(/<header className="([^"]*)"/)[1];
  // 使用主题文字绿作为焦点轮廓，确保在半透明顶栏上仍有足够对比度。
  assert.match(cls, /\[--ring:var\(--primary-text\)\]/);
  const theme = await read("app/theme.css");
  const light = theme.match(/:root\s*{([^}]*)}/)[1];
  const dark = theme.match(/\.dark\s*{([^}]*)}/)[1];
  const alpha = Number(cls.match(/\bbg-background\/(\d+)\b/)[1]) / 100;
  // 半透明顶栏叠在内容上：顶栏色 × alpha + 内容色 × (1 - alpha)
  const over = (ink, content) => `#${[1, 3, 5].map((i) => Math.round(parseInt(ink.slice(i, i + 2), 16) * alpha + parseInt(content.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;

  const contents = ["#ffffff", theme_token(light, "background"), theme_token(light, "muted"), theme_token(light, "accent"), emerald(500), theme_token(dark, "background"), theme_token(dark, "card"), theme_token(dark, "muted")];
  for (const [name, block] of [["亮色", light], ["暗色", dark]]) {
    const ink = theme_token(block, "background");
    const ring = theme_token(block, "primary-text"); // header 上 --ring 就是它
    for (const content of contents) {
      assert.ok(contrast(ring, over(ink, content)) >= 4.5, `${name}：顶栏叠在 ${content} 上，轮廓 ${ring} 对比 ${contrast(ring, over(ink, content)).toFixed(2)}`);
    }
  }

});

// ── 通知容器 ──

test("Sonner 通知容器的 aria-label 跟随界面语言（不再是英文的 Notifications alt+T）", async () => {
  const provider = await read("providers/theme.tsx");
  assert.match(provider, /<Toaster[^>]*containerAriaLabel=\{t\("notifications"\)\}/);
  assert.match(provider, /useTranslations\("common"\)/);
  assert.equal(zh.common.notifications, "通知");
  assert.equal(en.common.notifications, "Notifications");
});

// ── 语言自动识别 ──

test("语言自动识别默认开启：只有明确设成 false 才关闭；本地环境样例、Docker 构建参数都是 true", async () => {
  const locale = await read("i18n/locale.ts");
  assert.match(locale, /NEXT_PUBLIC_LOCALE_DETECTION !== "false"/);
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, /^NEXT_PUBLIC_LOCALE_DETECTION=true$/m);
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG NEXT_PUBLIC_LOCALE_DETECTION=true$/m);
  const routing = await read("i18n/routing.ts");
  assert.match(routing, /localeDetection,/);

  const previous = process.env.NEXT_PUBLIC_LOCALE_DETECTION;
  try {
    delete process.env.NEXT_PUBLIC_LOCALE_DETECTION;
    assert.equal((await import("../src/i18n/locale.ts?unset")).localeDetection, true);
    process.env.NEXT_PUBLIC_LOCALE_DETECTION = "true";
    assert.equal((await import("../src/i18n/locale.ts?true")).localeDetection, true);
    process.env.NEXT_PUBLIC_LOCALE_DETECTION = "false";
    assert.equal((await import("../src/i18n/locale.ts?false")).localeDetection, false);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_LOCALE_DETECTION;
    else process.env.NEXT_PUBLIC_LOCALE_DETECTION = previous;
  }
});

test("语言自动识别的行为：中文浏览器打开根地址进 /zh，英文留在 /；手动选过的语言（NEXT_LOCALE）优先；/learn 同理", async () => {
  const { defaultLocale, localeDetection, localePrefix, locales } = await import("../src/i18n/locale.ts");
  const { defineRouting } = await import("next-intl/routing");
  const createMiddleware = (await import("next-intl/middleware")).default;
  const { NextRequest } = await import("next/server");
  const middleware = createMiddleware(defineRouting({ locales, defaultLocale, localePrefix, localeDetection, alternateLinks: false }));
  const visit = async (path, headers) => {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`, { headers }));
    const location = response.headers.get("location");
    return location ? new URL(location).pathname : `留在 ${new URL(response.headers.get("x-middleware-rewrite")).pathname}`;
  };

  assert.equal(await visit("/", { "accept-language": "zh-CN,zh;q=0.9" }), "/zh");
  assert.equal(await visit("/", { "accept-language": "en-US,en;q=0.9" }), "留在 /en");
  assert.equal(await visit("/learn", { "accept-language": "zh-CN" }), "/zh/learn");
  assert.equal(await visit("/me", { "accept-language": "zh-CN" }), "/zh/me");
  assert.equal(await visit("/learn", { "accept-language": "en-US" }), "留在 /en/learn");
  // 用户在顶栏手动切换过语言：next-intl 写下 NEXT_LOCALE cookie，以它为准
  assert.equal(await visit("/", { "accept-language": "zh-CN", cookie: "NEXT_LOCALE=en" }), "留在 /en");
  assert.equal(await visit("/", { "accept-language": "en-US", cookie: "NEXT_LOCALE=zh" }), "/zh");
  assert.equal(await visit("/learn", { "accept-language": "zh-CN", cookie: "NEXT_LOCALE=en" }), "留在 /en/learn");
  assert.equal(await visit("/me", { "accept-language": "en-US", cookie: "NEXT_LOCALE=zh" }), "/zh/me");
  // 已经带语言前缀的地址不会被浏览器语言改走
  assert.equal(await visit("/zh/me", { "accept-language": "en-US" }), "留在 /zh/me");
});

// ── 删除课程对话框里的长课名 ──

test("删除课程对话框：课程名折行（break-words），无空格的长课名不会把按钮挤出手机视口", async () => {
  const dialog = await read("components/learn/delete-course-dialog.tsx");
  assert.match(dialog, /<DialogDescription className="[^"]*break-words/);
  const ui = await read("components/ui/dialog.tsx");
  // 对话框本身是单列 grid；列要能收缩，长词才会折行而不是撑宽整列
  assert.match(ui, /grid-cols-\[minmax\(0,1fr\)\]/);
});

// ── 小标签样式只有一份：EYEBROW_CLASS / LABEL_CLASS──

// 自己写的小标签样式 = 一串类名里同时有「字距 ≥ 0.1em」「大写或等宽」「小字号」。这种组合必须用 brand/eyebrow.tsx 的 EYEBROW_CLASS / LABEL_CLASS
// （或 <Eyebrow>），不能再手写一份：手写的会漏掉中文那一档（500 / 13px / 0.16em），中英文就又不一致了
// 豁免名单现在是空的（A 路的两个文件已经改用 LABEL_CLASS）；以后真有不能用共用样式的文件，在这里写明理由
const EYEBROW_EXEMPT = {};

function ownEyebrowStyles(text) {
  const hits = [];
  for (const match of text.matchAll(/(["'`])((?:(?!\1)[^\n\\])*)\1/g)) {
    const literal = match[2];
    const tokens = literal.split(/\s+/);
    const wide = tokens.some((t) => /^tracking-(wider|widest|\[0\.(1\d*|2\d*)em\])$/.test(t));
    const labelish = tokens.includes("uppercase") || tokens.includes("font-mono");
    const small = tokens.some((t) => /^text-(xs|sm|\[(\d|1[0-5])px\])$/.test(t));
    if (wide && labelish && small) hits.push(literal);
  }

  return hits;
}

test("自己写的小标签样式（字距 ≥ 0.1em + 大写/等宽 + 小字号）必须用 EYEBROW_CLASS / LABEL_CLASS；豁免名单不许过期", async () => {
  const found = {};
  for (const file of (await files("", /\.tsx$/)).map((f) => f.replace(/^\//, ""))) {
    if (file === "components/brand/eyebrow.tsx") continue;
    const hits = ownEyebrowStyles(await read(file));
    if (hits.length) found[file] = hits;
  }
  const unexpected = Object.keys(found).filter((file) => !(file in EYEBROW_EXEMPT));
  assert.deepEqual(unexpected, [], `这些文件自己手写了小标签样式，改用 EYEBROW_CLASS / LABEL_CLASS：${JSON.stringify(unexpected.map((f) => found[f]))}`);
  const stale = Object.keys(EYEBROW_EXEMPT).filter((file) => !(file in found));
  assert.deepEqual(stale, [], "豁免名单里的文件已经不再手写小标签样式了：从 EYEBROW_EXEMPT 里去掉");

  // 守卫自己要抓得到：几种手写写法都能命中，用共用样式的、不是小标签的不误伤
  assert.equal(ownEyebrowStyles('<p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">').length, 1);
  assert.equal(ownEyebrowStyles('cn("text-[11px] tracking-[0.12em] uppercase")').length, 1);
  assert.equal(ownEyebrowStyles("`font-mono text-sm tracking-widest`").length, 1);
  assert.equal(ownEyebrowStyles('<p className={cn("text-stone-400", LABEL_CLASS)}>').length, 0);
  assert.equal(ownEyebrowStyles('<p className="font-mono text-5xl font-medium tracking-tight">').length, 0, "大号等宽数字不是小标签");
  assert.equal(ownEyebrowStyles('"text-muted-foreground ml-auto text-xs tracking-widest"').length, 0, "没有大写 / 等宽的小字不是小标签");
});
