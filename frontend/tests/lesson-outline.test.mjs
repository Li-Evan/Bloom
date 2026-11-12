import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

const { markdownText } = await import("../src/lib/learn/lesson-text.ts");
const { remarkPlugins, rehypePlugins, lessonRehypePlugins, sourceLessonRehypePlugins } = await import(
  "../src/lib/learn/markdown-config.ts"
);
const { lessonOutline, rehypeSectionIds } = await import("../src/lib/learn/outline.ts");

// 和课文页一样：<Markdown sectionIds> 渲染正文，目录从同一份文字取标题
function page(content, { lesson = false, source = false, title } = {}) {
  const options = { lesson, typography: !source && lesson };
  const text = markdownText(content, options);
  const plugins = lesson ? (source ? sourceLessonRehypePlugins(title) : lessonRehypePlugins) : rehypePlugins;
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins, rehypePlugins: [rehypeSectionIds, ...plugins] }, text)
  );
  return { html, outline: lessonOutline(text, { lesson, source }) };
}

// 正文里 id 为 section-N 的那个元素：标签名和文字
function headingById(html, id) {
  const m = html.match(new RegExp(`<(h[1-6])[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`));
  const text = m?.[2]
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return m && { tag: m[1], text: text.replace(/\s+/g, " ").trim() };
}

// 每一条目录都指向正文里的一个标题，文字一样
function assertLinked({ html, outline }) {
  for (const entry of outline) {
    const heading = headingById(html, entry.id);
    assert.ok(heading, `正文里没有 #${entry.id}`);
    assert.equal(heading.text, entry.text);
  }
}

const brief = (outline) => outline.map((e) => `${e.level}:${e.text}`);

test("AI 课文：整篇标题不进目录，隐藏的「正文内容」「你的反馈」不进，思考题和小节同一层", () => {
  const content = [
    "# 第 1 篇：贝叶斯",
    "> 难度：入门\n> 预计阅读时间：5 分钟",
    "## 正文内容",
    "### 1. 先验",
    "正文",
    "### 2. 似然",
    "#### 一个例子",
    "正文",
    "## 思考题",
    "1. 为什么？",
    "## 你的反馈",
    "（写在这里）",
  ].join("\n\n");
  const result = page(content, { lesson: true });
  assert.deepEqual(brief(result.outline), ["0:1. 先验", "0:2. 似然", "1:一个例子", "0:思考题"]);
  assertLinked(result);
  assert.ok(!result.html.includes("正文内容"));
});

test("原文篇：标题换成课程名、「原文」变成小标签，都不进目录；资料自己的标题照常", () => {
  const content = "# 原文 · notes.md\n\n## 原文\n\n## 第一章\n\n正文\n\n### 小节\n\n## 第二章";
  const result = page(content, { lesson: true, source: true, title: "我的资料" });
  assert.deepEqual(brief(result.outline), ["0:第一章", "1:小节", "0:第二章"]);
  assertLinked(result);
  assert.match(result.html, /<p class="lesson-label"[^>]*>原文<\/p>/);
  assert.deepEqual(result.outline.map((e) => e.id), ["section-3", "section-4", "section-5"]);
});

test("项目文件（网页剪藏等）：打头的唯一一级标题不进目录；有好几个一级标题时都进", () => {
  const clip = page("# Build Your Desk\n\n## Part 1 - Setup\n\n### Here's what you're building:\n\n## Part 2 - Run");
  assert.deepEqual(brief(clip.outline), ["0:Part 1 - Setup", "1:Here's what you're building:", "0:Part 2 - Run"]);
  assertLinked(clip);

  const chapters = page("# 第一章\n\n## 1.1\n\n# 第二章\n\n## 2.1");
  assert.deepEqual(brief(chapters.outline), ["0:第一章", "1:1.1", "0:第二章", "1:2.1"]);
  assertLinked(chapters);
});

test("编号只数顶层标题：代码块里的 #、引用块和列表里的标题不进目录，也不打乱后面的锚点", () => {
  const content = [
    "# 标题",
    "## 甲",
    "```md\n# 不是标题\n## 也不是\n```",
    "> ## 引用里的标题",
    "- 列表\n\n  ## 列表里的标题",
    "## 乙",
    "丙（setext 写法）\n---",
  ].join("\n\n");
  const result = page(content);
  assert.deepEqual(brief(result.outline), ["0:甲", "0:乙", "0:丙（setext 写法）"]);
  assert.deepEqual(result.outline.map((e) => e.id), ["section-2", "section-3", "section-4"]);
  assertLinked(result);
});

test("标题里的加粗、行内代码、链接、公式只留文字；最多三层", () => {
  const content = "## **加粗** `code` [链接](https://example.com) $x^2$\n\n### 二\n\n#### 三\n\n##### 四";
  const result = page(content);
  assert.deepEqual(brief(result.outline), ["0:加粗 code 链接 x^2", "1:二", "2:三"]);
  for (const entry of result.outline) assert.ok(headingById(result.html, entry.id));
});

test("没有标题、只有整篇标题：目录是空的", () => {
  assert.deepEqual(page("只有一段正文").outline, []);
  assert.deepEqual(page("# 标题\n\n正文", { lesson: true }).outline, []);
});

const src = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("课文页：正文开锚点，目录用同一组参数从同一份文字取", async () => {
  const { lessonMarkdownOptions, outlineOf } = await import("../src/lib/learn/outline.ts");
  // 原文篇不做中文排版、还原加粗；项目文件按普通 Markdown
  assert.deepEqual(lessonMarkdownOptions(false, false), { lesson: true, source: false, typography: true, restoreBold: false });
  assert.deepEqual(lessonMarkdownOptions(false, true), { lesson: true, source: true, typography: false, restoreBold: true });
  assert.deepEqual(lessonMarkdownOptions(true, true), { lesson: false, source: false, typography: false, restoreBold: true });
  const ai = "# 标题\n\n## 正文内容\n\n### 一\n\n### 二\n\n## 思考题\n\n## 你的反馈";
  assert.deepEqual(outlineOf(ai, lessonMarkdownOptions(false, false)).map((e) => e.text), ["一", "二", "思考题"]);

  const lesson = await src("components/learn/lesson.tsx");
  assert.match(lesson, /<Markdown \{\.\.\.markdownOptions\} sectionIds title=\{course\?\.name\}>/);
  assert.match(lesson, /outlineOf\(lesson\?\.content, lessonMarkdownOptions\(isProject, isSourceLesson\)\)/);
  assert.match(lesson, /data-outline=\{showOutline \? "" : undefined\}/);
  // 改文件时左栏、右栏、抽屉里的目录都收掉（版面照旧让位，不左右跳）
  assert.match(lesson, /const sectionEntries = showOutline && !editing \? outline : NO_OUTLINE;/);
  assert.match(lesson, /outline: sectionEntries,\s*activeSection: sections\.active,\s*onJumpSection: sections\.jump,/);
});

test("窄一点的屏幕：右栏（1024–1279px）和手机抽屉里有「目录」一组，宽屏左栏有了就不再列；抽屉里默认展开，点了先关抽屉再跳", async () => {
  const nav = await src("components/learn/lesson-nav.tsx");
  assert.match(nav, /<RailGroup\s+className="xl:hidden"\s+defaultOpen=\{outlineOpen\}[\s\S]*?label=\{t\("lesson\.outline"\)\}/);
  assert.match(nav, /onJumpSection\(id\);\s*onNavigate\?\.\(\);/);
  // 抽屉开着时页面锁着滚动、焦点出不去：等抽屉关完（onCloseAutoFocus）再跳，焦点落到标题上而不是「课文」按钮
  assert.match(nav, /outlineOpen\s*onJumpSection=\{onJumpSection && \(\(id\) => \{ pendingSection\.current = id; \}\)\}/);
  assert.match(nav, /onCloseAutoFocus=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\);\s*onJumpSection\(id\);/);

  // 读到哪一节、跳过去：三处共用页面上的一份
  const hook = await src("components/learn/use-sections.ts");
  assert.match(hook, /heading\.focus\(\{ preventScroll: true \}\);\s*heading\.scrollIntoView\(\{ block: "start" \}\);/);
  assert.doesNotMatch(hook, /history\.|location\.hash/);
});

test("宽屏给目录让位：课文页连面包屑行一起让；参考原文面板打开时不让", async () => {
  const css = await src("app/learn.css");
  assert.match(
    css,
    /body:not\(:has\(\[data-reference-panel\]\[data-state="open"\]\)\) \.lesson-page\[data-outline\] :is\(\[data-learn-page\], \[data-crumb-row\]\) \{\s*width: auto;\s*margin-left: max\(14rem, calc\(\(100% - 72rem\) \/ 2\)\);/
  );
  assert.match(css, /body:has\(\[data-reference-panel\]\[data-state="open"\]\) \[data-lesson-outline\] \{\s*display: none;/);
});
