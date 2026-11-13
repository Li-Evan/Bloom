import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { createTranslator } from "next-intl";

const load = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const [en, zh] = await Promise.all([
  load("../src/i18n/messages/en.json"),
  load("../src/i18n/messages/zh.json"),
]);

function leaves(node, prefix = "") {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "object"
      ? leaves(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value]]
  );
}
const enLeaves = new Map(leaves(en.learn));
const zhLeaves = new Map(leaves(zh.learn));
const placeholders = (text) =>
  [...new Set([...text.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();

test("learn 命名空间在 en 与 zh 里键集完全一致", () => {
  assert.deepEqual([...enLeaves.keys()].sort(), [...zhLeaves.keys()].sort());
});

test("每条文案非空；en 不含中文；两种语言的占位符一致", () => {
  for (const [key, text] of enLeaves) {
    assert.ok(typeof text === "string" && text.length > 0, `en ${key}`);
    assert.doesNotMatch(text, /[一-鿿]/, `en ${key} 含中文`);
    const zhText = zhLeaves.get(key);
    assert.ok(typeof zhText === "string" && zhText.length > 0, `zh ${key}`);
    assert.deepEqual(placeholders(text), placeholders(zhText), key);
  }
});

test("全部文案是合法的 ICU 消息，能用样例参数格式化", () => {
  for (const [locale, messages] of [
    ["en", en],
    ["zh", zh],
  ]) {
    const errors = [];
    const t = createTranslator({
      locale,
      messages,
      namespace: "learn",
      onError: (e) => errors.push(e),
    });
    for (const [key, text] of locale === "en" ? enLeaves : zhLeaves) {
      const values = Object.fromEntries(
        placeholders(text).map((name) => [name, name === "count" ? 2 : "x"])
      );
      assert.ok(t(key, values).length > 0, `${locale} ${key}`);
    }
    assert.deepEqual(
      errors.map((e) => e.message),
      [],
      locale
    );
  }
});

const dirs = [
  "../src/components/learn/",
  "../src/app/[locale]/(default)/learn/",
];
async function sources() {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await walk(url);
      else if (/\.tsx?$/.test(entry.name))
        out.push([entry.name, await readFile(url, "utf8")]);
    }
  };
  for (const dir of dirs) await walk(new URL(dir, import.meta.url));

  return out;
}

test('源码里 t("…") 用到的键都在 learn 命名空间里存在', async () => {
  let checked = 0;
  for (const [file, source] of await sources()) {
    const ns = source.match(/useTranslations\("learn((?:\.\w+)?)"\)/)?.[1];
    if (ns === undefined) continue;
    const base = ns ? `${ns.slice(1)}.` : "";
    for (const m of source.matchAll(/\bt\(\s*"([^"$]+)"/g)) {
      assert.ok(zhLeaves.has(base + m[1]), `${file}: 缺少 ${base + m[1]}`);
      checked++;
    }
    for (const m of source.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) {
      assert.ok(
        [...zhLeaves.keys()].some((k) => k.startsWith(base + m[1])),
        `${file}: 没有以 ${base + m[1]} 开头的键`
      );
      checked++;
    }
  }
  assert.ok(checked > 100, `只检查到 ${checked} 处`);
});

test("动态拼出的键：深度、推荐位、建课阶段文案都存在", () => {
  for (const key of [
    ...["simple", "standard", "deep"].flatMap((d) => [
      `depth.${d}.label`,
      `depth.${d}.hint`,
    ]),
    ...["foundation", "connect", "explore", "fallback"].map(
      (l) => `recs.lane.${l}`
    ),
    ...["analyze", "syllabus", "finish"].map(
      (s) => `dashboard.creating.topic.${s}`
    ),
    ...["parse", "merge", "syllabus"].map(
      (s) => `dashboard.creating.materials.${s}`
    ),
    ...["noBody", "interrupted", "timeout"].map((c) => `errors.${c}`),
    ...["modeTopic", "modeProject", "modeWeb"].map(
      (m) => `dashboard.form.${m}`
    ),
  ]) {
    assert.ok(zhLeaves.has(key) && enLeaves.has(key), key);
  }
});

test("界面文字和属性里没有未翻译的中文；课文 Markdown 不经过翻译", async () => {
  for (const [file, source] of await sources()) {
    const cleaned = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.deepEqual(
      [...cleaned.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g)].map((m) => m[1]),
      [],
      file
    );
    assert.doesNotMatch(
      cleaned,
      /(?:title|placeholder|aria-label|label)=["'][^"']*[一-鿿]/,
      file
    );
    assert.doesNotMatch(cleaned, /toLocaleDateString\(["']zh/, file);
    assert.doesNotMatch(cleaned, /<Markdown[^>]*>\{t\(/, file);
  }
});

test("顶栏导航有指向 /learn 的「我的课程 / My courses」，每个导航项两种语言都有文案", async () => {
  const { MAIN_NAV } = await import("../src/lib/nav.ts");
  const courses = MAIN_NAV.find((i) => i.href === "/learn");
  assert.equal(en.header.nav[courses?.key], "My courses");
  assert.equal(zh.header.nav[courses?.key], "我的课程");
  for (const item of MAIN_NAV) {
    assert.equal(typeof en.header.nav[item.key], "string", `en ${item.key}`);
    assert.equal(typeof zh.header.nav[item.key], "string", `zh ${item.key}`);
  }
});

test("生成超时的提示：课文可能仍会出现，请稍后刷新查看（后端没有心跳，也不替用户中断）", () => {
  for (const key of ["timeout", "connectTimeout"]) {
    assert.match(en.learn.errors[key], /may still appear/, `en ${key}`);
    assert.match(en.learn.errors[key], /refresh the course/, `en ${key}`);
    assert.match(zh.learn.errors[key], /可能仍会出现/, `zh ${key}`);
    assert.match(zh.learn.errors[key], /刷新课程/, `zh ${key}`);
  }
  assert.match(en.learn.errors.timeout, /2 minutes/);
  assert.match(zh.learn.errors.timeout, /2 分钟/);
  assert.match(en.learn.errors.connectTimeout, /3 minutes/);
  assert.match(zh.learn.errors.connectTimeout, /3 分钟/);
});

test("「课程可能仍在生成」的提示：先看课程列表再决定要不要重试，列表接下来一分钟自动刷新，中英文一致", () => {
  assert.match(en.learn.errors.createUnconfirmed, /may still be generating/);
  assert.match(zh.learn.errors.createUnconfirmed, /可能仍在生成/);
  assert.match(en.learn.errors.createUnconfirmed, /Check your course list before trying again/);
  assert.match(zh.learn.errors.createUnconfirmed, /先看一下课程列表再决定要不要重试/);
  assert.match(en.learn.errors.createUnconfirmed, /next minute/);
  assert.match(zh.learn.errors.createUnconfirmed, /接下来的一分钟/);
});
