import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// 文案标点守卫：中文界面文案用全角标点；英文文案用弯撇号 ’；圆点 · 两侧统一各一个空格。
// 代码和占位符不算文案：ICU 占位符 {…}（含 plural 分支）、<tag> 标签、网址先摘掉再查。

const src = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(`${src}${path}`, "utf8");
const json = async (path) => JSON.parse(await read(path));

const ZH_JSON = ["i18n/messages/zh.json"];
const EN_JSON = ["i18n/messages/en.json"];
const HAN = "\\p{Script=Han}";

function* strings(node, path = "") {
  if (typeof node === "string") yield [path, node];
  else if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* strings(v, `${path}[${i}]`);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) yield* strings(v, path ? `${path}.${k}` : k);
}

// 摘掉占位符（可嵌套）、标签、网址，只留给人读的文字
function prose(text) {
  let out = text;
  for (let i = 0; i < 4; i++) out = out.replace(/\{[^{}]*\}/g, "");
  return out.replace(/<\/?[A-Za-z][^>]*>/g, "").replace(/https?:\/\/\S+/g, "");
}

// 中文文案里的违规：半角 ? !、紧挨汉字的半角冒号、带空格的英文破折号（按钮、标题里要用逗号）
const ZH_BAD = [
  [/[?!]/, "半角 ? 或 !（要用全角 ？ ！）"],
  [new RegExp(`(?:${HAN}\\s*:|:\\s*${HAN})`, "u"), "紧挨汉字的半角冒号（要用全角 ：）"],
  [/\s—\s/, "带空格的破折号（要么改逗号，要么用 ——）"],
];
// 圆点 · 两侧各一个空格；译名里的间隔号（本杰明·布鲁姆）不算
const NAMES = ["本杰明·布鲁姆"];

const violations = (text) => {
  const t = prose(text);
  if (!new RegExp(HAN, "u").test(t)) return [];
  return ZH_BAD.filter(([re]) => re.test(t)).map(([, why]) => why);
};
const dotProblem = (text) => {
  let t = prose(text);
  for (const name of NAMES) t = t.replaceAll(name, "");

  return [...t.matchAll(/·/g)].some((m) => !(t[m.index - 1] === " " && t[m.index + 1] === " "));
};

test("守卫本身有效：半角标点、带空格的破折号、圆点没空格都能抓到，占位符、网址、人名间隔号不误伤", () => {
  for (const bad of ["Bloom 到底是什么?", "感谢阅读!", "难度: 入门", "难度 ：入门".replace("：", ":"), "我读完了 — 生成下一篇"]) {
    assert.ok(violations(bad).length > 0, bad);
  }
  for (const ok of ["Bloom 到底是什么？", "感谢阅读！", "难度：入门", "我读完了，生成下一篇", "最近 {weeks} 周 · 共 {count} 天", "共 {count, plural, one {# day} other {# days}} 有效",
    "访问 https://bloom.test/learn?x=1 查看", "<link>{email}</link>", "更新于 12:30", "本杰明·布鲁姆 1984 年", "昵称需要 {min}–{max} 个字符。"]) {
    assert.deepEqual(violations(ok), [], ok);
  }
  assert.ok(dotProblem("新建课程·主题"));
  assert.ok(dotProblem("1 篇· 创建"));
  assert.ok(!dotProblem("1 篇 · 创建于"));
  assert.ok(!dotProblem("本杰明·布鲁姆报告说"));
});

test("中文界面文案里没有半角 ? ! :、带空格的破折号", async () => {
  const found = [];
  for (const file of ZH_JSON) {
    for (const [path, text] of strings(await json(file))) {
      for (const why of violations(text)) found.push(`${file} ${path}：${why}：${text.slice(0, 60)}`);
    }
  }
  assert.deepEqual(found, []);
});

test("圆点 · 两侧统一各一个空格（中英文文案；人名里的间隔号除外）", async () => {
  const found = [];
  for (const file of [...ZH_JSON, ...EN_JSON]) {
    for (const [path, text] of strings(await json(file))) {
      if (dotProblem(text)) found.push(`${file} ${path}：${text.slice(0, 60)}`);
    }
  }
  assert.deepEqual(found, []);
});

test("英文界面文案用弯撇号 ’，不用直撇号 '", async () => {
  const found = [];
  for (const file of EN_JSON) {
    for (const [path, text] of strings(await json(file))) {
      if (text.includes("'")) found.push(`${file} ${path}：${text.slice(0, 60)}`);
    }
  }
  assert.deepEqual(found, []);
});

test("按钮「我读完了，生成下一篇」：中文不再用破折号连接动作", async () => {
  const zh = await json("i18n/messages/zh.json");
  assert.equal(zh.learn.lesson.next.finished, "我读完了，生成下一篇");
  for (const key of ["finished", "finishedEval"]) assert.doesNotMatch(zh.learn.lesson.next[key], /—/, key);
  assert.doesNotMatch(zh.learn.lesson.markRead, /—/);
});
