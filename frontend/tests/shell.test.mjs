import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "next-intl";

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([
  json("i18n/messages/en.json"),
  json("i18n/messages/zh.json"),
]);

const { MAIN_NAV, ACCOUNT_MENU, isActive } = await import("../src/lib/nav.ts");
const { initialOf } = await import("../src/lib/initial.ts");

const CJK = /[一-鿿]/;
const placeholders = (text) =>
  [...new Set([...text.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();
function leaves(node, prefix = "") {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]
  );
}

// ── 文案：外壳用到的命名空间两种语言对等 ──

const NAMESPACES = ["header", "footer", "error", "not_found"];
// 品牌名、语言按钮上的目标语言名、年份占位等不随语言变化
const SAME_IN_BOTH = new Set(["header.language_target_lang", "not_found.eyebrow"]);

test("外壳的文案命名空间：en 与 zh 键集一致、占位符一致、非空", () => {
  for (const ns of NAMESPACES) {
    const enLeaves = new Map(leaves(en[ns]));
    const zhLeaves = new Map(leaves(zh[ns]));
    assert.deepEqual([...enLeaves.keys()].sort(), [...zhLeaves.keys()].sort(), ns);
    for (const [key, text] of enLeaves) {
      const zhText = zhLeaves.get(key);
      assert.ok(typeof text === "string" && text.length > 0, `en ${ns}.${key}`);
      assert.ok(typeof zhText === "string" && zhText.length > 0, `zh ${ns}.${key}`);
      assert.deepEqual(placeholders(text), placeholders(zhText), `${ns}.${key}`);
    }
  }
});

test("中文界面是中文、英文界面不含中文（语言切换按钮、版权行等不随语言变化的除外）", () => {
  for (const ns of NAMESPACES) {
    for (const [key, text] of leaves(en[ns])) {
      // 英文页上的语言按钮写「中文」
      if (`${ns}.${key}` === "header.language_target") continue;
      assert.doesNotMatch(text, CJK, `en ${ns}.${key}`);
    }
    for (const [key, text] of leaves(zh[ns])) {
      if (SAME_IN_BOTH.has(`${ns}.${key}`)) continue;
      // 按钮上写目标语言：中文页写 EN，英文页写 中文
      if (`${ns}.${key}` === "header.language_target") continue;
      assert.match(text, CJK, `zh ${ns}.${key}: ${text}`);
    }
  }
  assert.equal(en.header.language_target, "中文");
  assert.equal(zh.header.language_target, "EN");
});

test("全部文案能用样例参数格式化，没有 ICU 语法错误", () => {
  for (const [locale, messages] of [["en", en], ["zh", zh]]) {
    const errors = [];
    for (const ns of NAMESPACES) {
      const t = createTranslator({ locale, messages, namespace: ns, onError: (e) => errors.push(e.message) });
      for (const [key, text] of leaves(messages[ns])) {
        const values = Object.fromEntries(
          placeholders(text).map((name) => [name, name === "year" ? 2026 : 3])
        );
        // 带 <terms> 这类富文本标签的另当别论，这里的外壳文案没有
        assert.ok(t(key, values).length > 0, `${locale} ${ns}.${key}`);
      }
    }
    assert.deepEqual(errors, [], locale);
  }
});

// ── 导航与路由 ──

test("导航、「我的」入口的每一项都有两种语言的文案（页脚复用同两组）", () => {
  const check = (items, enNs, zhNs, label) => {
    for (const item of items) {
      assert.equal(typeof enNs[item.key], "string", `en ${label}.${item.key}`);
      assert.equal(typeof zhNs[item.key], "string", `zh ${label}.${item.key}`);
    }
  };
  check(MAIN_NAV, en.header.nav, zh.header.nav, "header.nav");
  check(ACCOUNT_MENU, en.header.menu_items, zh.header.menu_items, "header.menu_items");
});

test("用户中心的入口都指向 /me 下的新路由，不再出现旧的 /my-* 与 /learn/profile", () => {
  const hrefs = [...MAIN_NAV, ...ACCOUNT_MENU].map((i) => i.href);
  assert.deepEqual(
    ACCOUNT_MENU.map((i) => i.href),
    ["/me", "/me/settings"]
  );
  for (const href of hrefs) {
    assert.doesNotMatch(href, /^\/my-|^\/learn\/profile/, href);
    assert.ok(href.startsWith("/"), href);
  }
});

test("只有一套导航：我的课程、知识地图、下一步学习", () => {
  assert.deepEqual(MAIN_NAV.map((i) => i.key), ["courses", "map", "next"]);
  assert.deepEqual(MAIN_NAV.map((i) => i.href), ["/learn", "/learn/map", "/learn/next"]);
});

test("当前页高亮：课程页、课文页都算「我的课程」，下一步学习、知识地图各自单独一项", () => {
  assert.equal(isActive("/learn", "/learn"), true);
  assert.equal(isActive("/learn/course/3", "/learn"), true);
  assert.equal(isActive("/learn/course/3/lesson/2", "/learn"), true);
  assert.equal(isActive("/learn/next", "/learn"), false);
  assert.equal(isActive("/learn/next", "/learn/next"), true);
  assert.equal(isActive("/learn/map", "/learn"), false);
  assert.equal(isActive("/learn/map", "/learn/map"), true);
  assert.equal(isActive("/me/settings", "/me/settings"), true);
  assert.equal(isActive("/me/settings/x", "/me/settings"), true);
  assert.equal(isActive("/me/settings-x", "/me/settings"), false);
});

// ── 头像首字 ──

test("头像首字：中文取第一个字，英文取首字母并大写，跳过开头的符号，空昵称给 ?", () => {
  assert.equal(initialOf("张三"), "张");
  assert.equal(initialOf("alice"), "A");
  assert.equal(initialOf("  bob smith "), "B");
  assert.equal(initialOf("李Alex"), "李");
  assert.equal(initialOf("@carol"), "C");
  assert.equal(initialOf("42nd"), "4");
  assert.equal(initialOf("😀 happy"), "H");
  assert.equal(initialOf("😀"), "😀");
  assert.equal(initialOf(""), "?");
  assert.equal(initialOf(null), "?");
  assert.equal(initialOf(undefined), "?");
});

test("没有任何地方再把整个昵称塞进头像，头像也不再写死 CN", async () => {
  for (const file of ["components/site/header/me-link.tsx", "components/site/header/mobile-menu.tsx"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /<AvatarFallback[^>]*>\s*\{[^}]*nickname/, file);
    assert.doesNotMatch(source, />\s*CN\s*</, file);
    assert.match(source, /InitialAvatar/, file);
  }
});

// ── 404、错误页、页脚开关 ──

test("404：[locale] 下有品牌化的 not-found 和兜底路由，根级也有；错误页分段级与全局两种", async () => {
  for (const file of [
    "app/[locale]/not-found.tsx",
    "app/[locale]/[...rest]/page.tsx",
    "app/not-found.tsx",
    "app/[locale]/error.tsx",
    "app/[locale]/(default)/error.tsx",
    "app/global-error.tsx",
  ]) {
    await access(join(root, file));
  }
  // 模板自带的 (default)/not-found 已删：它会盖过新的 [locale]/not-found
  await assert.rejects(access(join(root, "app/[locale]/(default)/not-found.tsx")));

  const catchAll = await read("app/[locale]/[...rest]/page.tsx");
  assert.match(catchAll, /notFound\(\)/);
  const notFound = await read("app/[locale]/not-found.tsx");
  assert.match(notFound, /<Header \/>/);
  assert.match(notFound, /<Footer \/>/);
  assert.match(notFound, /getTranslations\("not_found"\)/);

  // global-error 替换整个根布局：必须自带 html/body，并引入样式
  const globalError = await read("app/global-error.tsx");
  assert.match(globalError, /<html /);
  assert.match(globalError, /<body /);
  assert.match(globalError, /import "@\/app\/globals\.css"/);
});

test("页脚：带 data-site-footer，HideFooter 用同一个选择器关掉它（服务端渲染的样式，不靠客户端状态）", async () => {
  const footer = await read("components/site/footer/index.tsx");
  const hide = await read("components/site/footer/hide-footer.tsx");
  assert.match(footer, /<footer data-site-footer/);
  assert.match(hide, /\[data-site-footer\]\{display:none\}/);
  assert.doesNotMatch(hide, /use client|useState|useEffect/);
});

test("顶栏、手机抽屉、页脚都有开源仓库的 GitHub 链接，Twelve Tools 徽章已去掉", async () => {
  const { GITHUB_URL } = await import("../src/lib/nav.ts");
  assert.equal(GITHUB_URL, "https://github.com/Li-Evan/Bloom");

  const link = await read("components/site/header/github-link.tsx");
  assert.match(link, /href=\{GITHUB_URL\}/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /aria-label=\{label\}/);
  assert.match(await read("components/site/header/index.tsx"), /<GitHubLink className="hidden lg:inline-flex" \/>/);
  assert.match(await read("components/site/header/mobile-menu.tsx"), /<GitHubLink className=/);
  // 两个渲染顶栏的地方都有顶栏
  for (const file of ["app/[locale]/(default)/layout.tsx", "app/[locale]/not-found.tsx"]) {
    assert.match(await read(file), /<Header \/>/, file);
  }

  const footer = await read("components/site/footer/index.tsx");
  assert.match(footer, /href=\{GITHUB_URL\}[\s\S]*?rel="noopener noreferrer"[\s\S]*?\{t\("footer\.github"\)\}/);
  assert.doesNotMatch(footer, /twelve\.tools/);
  assert.equal(en.footer.featured_on, undefined);
  assert.equal(zh.footer.featured_on, undefined);
});

// ── 设计系统 ──

test("令牌：规格第 2.1 节的颜色原样写进 theme.css，亮暗各一套，新增的四个令牌暴露成 Tailwind 颜色", async () => {
  const css = await read("app/theme.css");
  const light = css.match(/:root\s*{([^}]*)}/)[1];
  const dark = css.match(/\.dark\s*{([^}]*)}/)[1];
  const expectLight = {
    background: "#fafaf9", foreground: "#1c1917", card: "#ffffff", popover: "#ffffff",
    muted: "#f5f5f4", "muted-foreground": "#57534e", "subtle-foreground": "#78716c",
    border: "#e7e5e4", input: "#e7e5e4", primary: "#00bc7d", "primary-hover": "#00d492",
    "primary-foreground": "#0a0908", "primary-text": "#007a55", accent: "#ecfdf5", "accent-foreground": "#007a55",
    ring: "#009966", destructive: "#dc2626", warning: "#b45309", "ink-inverse": "#0c0a09",
  };
  const expectDark = {
    background: "#0c0a09", foreground: "#f5f5f4", card: "#1c1917", popover: "#1c1917",
    muted: "#292524", "muted-foreground": "#b2aca7", "subtle-foreground": "#a39d98",
    border: "#292524", input: "#292524", primary: "#00bc7d", "primary-hover": "#00d492",
    "primary-foreground": "#0a0908", "primary-text": "#00d492", accent: "#002c22", "accent-foreground": "#5ee9b5",
    ring: "#00d492", destructive: "#f87171", warning: "#fbbf24",
  };
  for (const [block, expected, name] of [[light, expectLight, "light"], [dark, expectDark, "dark"]]) {
    for (const [token, value] of Object.entries(expected)) {
      assert.match(block, new RegExp(`--${token}:\\s*${value};`), `${name} --${token}`);
    }
  }
  assert.match(light, /--radius:\s*0\.75rem;/);
  for (const token of ["primary-hover", "primary-text", "subtle-foreground", "warning", "ink-inverse"]) {
    assert.match(css, new RegExp(`--color-${token}:\\s*var\\(--${token}\\);`), token);
  }
  // 模板的 hsl 阴影变量已删，只剩两档
  assert.doesNotMatch(css, /hsl\(/);
  assert.match(css, /--shadow-sm:/);
  assert.match(css, /--shadow-md:/);
  assert.doesNotMatch(css, /--shadow-(2xs|xs|lg|xl|2xl):/);
});

test("字体：Outfit、Public Sans 与 JetBrains Mono 用 next/font/local 自托管本地文件，不再有 Open Sans / Menlo，中文回退栈齐全", async () => {
  const fonts = await read("fonts/index.ts");
  assert.match(fonts, /from "next\/font\/local"/);
  assert.doesNotMatch(fonts, /^import .*next\/font\/google/m);
  assert.match(fonts, /localFont\(\{[\s\S]*outfit-latin\.woff2[\s\S]*weight: "400 800"[\s\S]*variable: "--font-outfit"/);
  assert.match(fonts, /localFont\(\{[\s\S]*jetbrains-mono-latin\.woff2[\s\S]*weight: "400 500"[\s\S]*variable: "--font-jetbrains"/);
  for (const file of ["outfit-latin.woff2", "public-sans-latin.woff2", "jetbrains-mono-latin.woff2"]) {
    const bytes = await readFile(join(root, "fonts", file));
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", `${file} 不是 woff2`);
    assert.ok(bytes.length > 10_000, file);
  }
  const css = await read("app/theme.css");
  assert.doesNotMatch(css, /Open Sans|Menlo, monospace/);
  // 西文字体是 --font-ui：默认 Outfit，设置里可换（lib/font.ts、tests/font.test.mjs）
  assert.match(css, /--font-ui: var\(--font-outfit\);/);
  assert.match(css, /--font-sans:\s*var\(--font-ui\), "PingFang SC", "Hiragino Sans GB",\s*"Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;/);
  const layout = await read("app/layout.tsx");
  assert.match(layout, /fontVariables/);
  // global-error 替换整个根布局，不调用字体加载器，用系统字体栈
  assert.doesNotMatch(await read("app/global-error.tsx"), /^import .*(next\/font|@\/fonts)/m);
});

test("基础组件的变体与尺寸：按钮有主、描边、幽灵、危险四种，sm / md / lg 三档", async () => {
  const button = await read("components/ui/button.tsx");
  for (const variant of ["default:", "outline:", "ghost:", "destructive:"]) {
    assert.ok(button.includes(variant), variant);
  }
  for (const size of ["sm:", "md:", "lg:"]) {
    assert.ok(button.includes(size), size);
  }
  assert.match(button, /hover:bg-primary-hover/);
  assert.match(button, /active:scale-\[0\.98\]/);
});

test("components/ui 与顶栏页脚之外的外壳组件不硬编码十六进制颜色", async () => {
  const dirs = ["components/ui", "components/site/header", "components/site/footer"];
  const offenders = [];
  for (const dir of dirs) {
    for (const entry of await readdir(join(root, dir))) {
      // chart.tsx 里的 #ccc 是 recharts 自己默认描边的选择器，不是我们用的颜色
      if (!/\.tsx$/.test(entry) || entry === "chart.tsx") continue;
      const text = await read(`${dir}/${entry}`);
      if (/#[0-9a-fA-F]{3,8}\b/.test(text.replace(/&#x27;/g, ""))) offenders.push(`${dir}/${entry}`);
    }
  }
  assert.deepEqual(offenders, []);
});


test("global-error 的「回首页」在中文页上回 /zh", async () => {
  const source = await read("app/global-error.tsx");
  assert.match(source, /pathname\.startsWith\("\/zh"\) \? "\/zh" : "\/"/);
});

test("手机抽屉里导航已有的链接不在「我的」区重复：两组链接没有相同的地址", async () => {
  const navHrefs = new Set(MAIN_NAV.map((n) => n.href));
  assert.deepEqual(ACCOUNT_MENU.filter((item) => navHrefs.has(item.href)), []);
  const source = await read("components/site/header/mobile-menu.tsx");
  assert.match(source, /nav\.map\(/);
  assert.match(source, /ACCOUNT_MENU\.map\(/);
});

test("曲线图里的字用 JetBrains Mono 已有的字重（400/500），字体目录带完整的 OFL 1.1 许可全文", async () => {
  const curve = await read("components/brand/bell-curve.tsx");
  assert.doesNotMatch(curve, /fontWeight="600"/);
  for (const [file, holder] of [
    ["OFL-Outfit.txt", "The Outfit Project Authors"],
    ["OFL-JetBrainsMono.txt", "The JetBrains Mono Project Authors"],
  ]) {
    const text = await read(`fonts/${file}`);
    assert.ok(text.startsWith(`Copyright`) && text.includes(holder), file);
    for (const clause of ["SIL OPEN FONT LICENSE Version 1.1", "PREAMBLE", "PERMISSION & CONDITIONS", "TERMINATION", "DISCLAIMER"]) {
      assert.ok(text.includes(clause), `${file} 缺少 ${clause}`);
    }
  }
  await assert.rejects(access(join(root, "fonts/LICENSE.txt")));
});

test("404 的说明文字用 text-balance，中文不会孤出一个字", async () => {
  assert.match(await read("components/brand/status-view.tsx"), /text-balance[^"]*text-muted-foreground/);
});
