// 课文渲染用的几个 rehype 插件（纯 hast 变换，不依赖 React，单测直接 import）：
// - rehypeLessonMeta：H1 之后紧跟的「前置知识 / 难度 / 预计阅读时间」引用块，改成一行灰色等宽小字；
//   原文篇（source）另外去掉旧数据里的占位（前置知识、难度、「按原文长度而定」的阅读时间），新数据里的「字数 / 阅读时间」真实值保留；
//   流式预览（hideReadingTime）不显示阅读时间：模型边写边估的数字和写完后后端按字数算的不一样，以完成后的为准；
// - rehypeSourceHeading：原文篇的 H1（后端写的是「原文 · 文件名」）换成课程名，「原文 / Original text」二级标题换成一行小标签；
// - rehypeKeepWords：标题里的中文按词切开，每个词一个不换行的片段，长标题只在词与词之间折行；
// - rehypeWrapTables：表格外包一层可横向滚动的容器，窄屏不撑破页面；
// - rehypeTaskLabels：GFM 任务列表（大纲里的掌握项）的复选框没有名字，用那一项的文字给它 aria-label；
// - rehypeScriptBlocks：中文段落标 data-script="cjk"，整段按汉字的字号排（所有内容都带）。

import { monoRuns } from "@/lib/mono-runs";
import { wordRuns } from "@/lib/learn/words";

export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// 中文课与英文课的元信息键（英文课写法见后端 course_language.py 的 EN 表）
const META_KEY =
  /^\s*(前置知识|先修知识|难度|预计阅读时间|阅读时间|字数|prerequisites?|difficulty|estimated reading time|reading time|length|word count)\s*[:：]/i;

// 原文篇（学生自己上传的资料）旧数据头部的占位：前置知识、难度整行不要；阅读时间写着「按原文长度而定」这类也不要
const SOURCE_SKIP_KEY = /^\s*(前置知识|先修知识|难度|prerequisites?|difficulty)\s*[:：]/i;
const SOURCE_TIME_KEY = /^\s*(预计阅读时间|阅读时间|estimated reading time|reading time)\s*[:：]/i;
const PLACEHOLDER_VALUE = /而定|取决于|depends? on/i;

const isSourcePlaceholder = (line: string) =>
  SOURCE_SKIP_KEY.test(line) || (SOURCE_TIME_KEY.test(line) && PLACEHOLDER_VALUE.test(line));

const isElement = (node: HastNode | undefined, tag?: string): boolean =>
  node?.type === "element" && (tag === undefined || node.tagName === tag);

const isBlank = (node: HastNode) =>
  node.type === "text" && !(node.value ?? "").trim();

const textOf = (node: HastNode): string =>
  node.type === "text"
    ? (node.value ?? "")
    : (node.children ?? []).map(textOf).join("");

// 引用块里的行：段落里的软换行（文本里的 \n）与硬换行（<br>）都算换行
function linesOf(blockquote: HastNode): HastNode[][] {
  const lines: HastNode[][] = [];
  let current: HastNode[] = [];
  const endLine = () => {
    if (current.some((n) => !isBlank(n))) lines.push(current);
    current = [];
  };

  for (const block of blockquote.children ?? []) {
    if (isBlank(block)) continue;
    if (!isElement(block, "p")) return [];
    for (const node of block.children ?? []) {
      if (isElement(node, "br")) {
        endLine();
      } else if (node.type === "text") {
        const pieces = (node.value ?? "").split("\n");
        pieces.forEach((piece, i) => {
          if (i > 0) endLine();
          if (piece) current.push({ type: "text", value: piece });
        });
      } else {
        current.push(node);
      }
    }
    endLine();
  }
  return lines;
}

const el = (
  tagName: string,
  className: string[],
  children: HastNode[]
): HastNode => ({
  type: "element",
  tagName,
  properties: { className },
  children,
});

// 长的（比如前置知识）单独占一行，排在短的后面。汉字按两个字符宽算
const LONG_VALUE = 40;
const width = (text: string) =>
  [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);

// 中文课文页里的元信息行（「难度： 入门　预计阅读时间： 4 分钟」）整行是等宽字体，汉字落到系统黑体，数字、空格是等宽字形，
// 数字两边的空隙被拉开。改成正文字体，只把数字和拉丁字母的片段包成 .lesson-mono（等宽）；英文页整行本来就是等宽，这一层是空操作
const HAN_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const monoText = (nodes: HastNode[]): HastNode[] =>
  nodes.flatMap((node) =>
    node.type === "text" && HAN_TEXT.test(node.value ?? "")
      ? monoRuns(node.value ?? "").map((run) => (run.mono ? el("span", ["lesson-mono"], [{ type: "text", value: run.text }]) : { type: "text", value: run.text }))
      : [node]
  );

function toItem(line: HastNode[]): HastNode {
  const first = line[0];
  const colon =
    first.type === "text" ? (first.value ?? "").search(/[:：]/) : -1;
  let key: HastNode | null = null;
  let value = line;
  if (first.type === "text" && colon >= 0) {
    const text = first.value ?? "";
    key = el("span", ["lesson-meta-key"], [
      { type: "text", value: text.slice(0, colon + 1) },
    ]);
    const rest = text.slice(colon + 1).trimStart();
    value = monoText([
      ...(rest ? [{ type: "text", value: rest }] : []),
      ...line.slice(1),
    ]);
  }
  const long = width(value.map(textOf).join("")) > LONG_VALUE;
  return el(
    "span",
    long ? ["lesson-meta-item", "lesson-meta-long"] : ["lesson-meta-item"],
    [...(key ? [key] : []), el("span", ["lesson-meta-val"], value)]
  );
}

export function rehypeLessonMeta(options: { source?: boolean; hideReadingTime?: boolean } = {}) {
  return (tree: HastNode) => {
    const kids = tree.children ?? [];
    const h1 = kids.findIndex((n) => isElement(n, "h1"));
    if (h1 < 0) return;
    let i = h1 + 1;
    while (kids[i] && isBlank(kids[i])) i++;
    const quote = kids[i];
    if (!isElement(quote, "blockquote")) return;
    const lines = linesOf(quote);
    // 只要有一行不是元信息，就当成普通引用块，不动
    if (!lines.length || !lines.every((l) => META_KEY.test(l.map(textOf).join(""))))
      return;
    const shown = lines
      .filter((l) => !(options.source && isSourcePlaceholder(l.map(textOf).join(""))))
      .filter((l) => !(options.hideReadingTime && SOURCE_TIME_KEY.test(l.map(textOf).join(""))));
    if (shown.length === 0) {
      // 整个引用块都是占位：连同它后面的空白一起拿掉
      kids.splice(i, 1);
      return;
    }
    kids[i] = el("div", ["lesson-meta"], shown.map(toItem));
  };
}

// 原文篇（学生自己的资料，后端写成「# 原文 · 文件名 … ## 原文 …」）：页面标题用课程名，不是文件名；
// 紧接着的「原文 / Original text」二级标题不该和标题一样大，换成一行小标签（样式 .lesson-label，见 learn.css）。
// 没有课程名（还没取到）就不动标题。只换整篇里第一个二级标题，而且文字整个就是「原文」才换——资料自己的小标题不受影响
export const SOURCE_SECTION_TITLE = /^(?:原文|original text)$/i;

export function rehypeSourceHeading(options: { title?: string } = {}) {
  return (tree: HastNode) => {
    const kids = tree.children ?? [];
    const title = options.title?.trim();
    const h1 = kids.find((n) => isElement(n, "h1"));
    if (h1 && title) h1.children = [{ type: "text", value: title }];

    const h2 = kids.findIndex((n) => isElement(n, "h2"));
    if (h2 >= 0 && SOURCE_SECTION_TITLE.test(textOf(kids[h2]).trim())) {
      kids[h2] = el("p", ["lesson-label"], kids[h2].children ?? []);
    }
  };
}

// 课文末尾的「思考题」小节（二级标题）：
// - 标题加上 lesson-thoughts：和别的小节标题（三级）一样大，靠上方的细分隔线显得是单独的一块（样式见 learn.css）；
// - 给了 note 就在这一节的最后补一句说明（参考答案写在下一篇末尾）。后端的课文里不会有这句话；它是一段普通文字，
//   后面的划线定位靠课文原文去找（locateOffsets 按原文匹配，存档位置只用来在多处出现时挑最近的），不受它影响。
export const THOUGHTS_TITLE = /^(?:思考题|reflection questions?|thinking questions?|questions to think about)\s*[:：]?$/i;

export function rehypeThoughtQuestions(options: { note?: string } = {}) {
  return (tree: HastNode) => {
    const kids = tree.children ?? [];
    const start = kids.findIndex((n) => isElement(n, "h2") && THOUGHTS_TITLE.test(textOf(n).trim()));
    if (start < 0) return;
    const heading = kids[start];
    const cls = heading.properties?.className;
    heading.properties = { ...heading.properties, className: [...(Array.isArray(cls) ? cls : []), "lesson-thoughts"] };
    if (!options.note) return;

    let end = start + 1;
    while (end < kids.length && !isElement(kids[end], "h1") && !isElement(kids[end], "h2")) end++;
    while (end > start + 1 && isBlank(kids[end - 1])) end--;
    kids.splice(end, 0, { type: "text", value: "\n" }, el("p", ["lesson-note"], [{ type: "text", value: options.note }]));
  };
}

// 标题里的中文按词切开，每个词一个不换行的片段（折行只发生在词与词之间）。
// 文字内容不变（textContent 原样），所以划线定位不受影响。代码、公式里的文字不动。
const HEADINGS = new Set(["h1", "h2", "h3"]);
const SKIP_INSIDE = new Set(["code", "pre", "svg", "math"]);

function keepWordsIn(node: HastNode, locale: string) {
  const kids = node.children;
  if (!kids) return;
  const out: HastNode[] = [];
  for (const child of kids) {
    if (child.type === "text") {
      const runs = wordRuns(child.value ?? "", locale);
      if (runs.length === 1 && !runs[0].keep) {
        out.push(child);
        continue;
      }
      for (const run of runs) {
        out.push(
          run.keep
            ? el("span", ["nw"], [{ type: "text", value: run.text }])
            : { type: "text", value: run.text }
        );
      }
    } else {
      if (child.type === "element" && !SKIP_INSIDE.has(child.tagName ?? "") && !hasClass(child, "katex")) {
        keepWordsIn(child, locale);
      }
      out.push(child);
    }
  }
  node.children = out;
}

export function rehypeKeepWords(options: { locale?: string } = {}) {
  const locale = options.locale ?? "zh";
  const walk = (node: HastNode) => {
    for (const child of node.children ?? []) {
      if (child.type !== "element") continue;
      if (HEADINGS.has(child.tagName ?? "")) keepWordsIn(child, locale);
      else walk(child);
    }
  };
  return (tree: HastNode) => walk(tree);
}

// 块级公式（KaTeX 画出来的 span.katex-display）外面包一层 div.math-scroll：手机上长公式能横滑，两端有渐隐提示（components/learn/scroll-fade.tsx）。
// 必须放在 rehypeKatex 之后——这时公式才是 HTML
export function rehypeScrollMath() {
  const walk = (node: HastNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (isElement(child, "span") && hasClass(child, "katex-display")) {
        kids[i] = el("div", ["math-scroll"], [child]);
      } else {
        walk(child);
      }
    }
  };
  return (tree: HastNode) => walk(tree);
}

// 大纲末尾的「学习进度」表：窄屏上改成一篇一张的竖排卡片（样式 .progress-cards，见 learn.css）。
// 找「学习进度 / Learning progress」二级标题后面第一个表格容器（要放在 rehypeWrapTables 之后）
const PROGRESS_TITLE = /^(?:学习进度|learning progress)$/i;

// 「覆盖要点」一格原来是一长串用「；」（英文用「 · 」）连起来的句子，不好扫读：每一条换成列表里的一项。
// 后端写进来的换行（<br>）在 prepareSyllabus 里先换成这个私用字符 ITEM_BREAK；旧课程里的「；」「 · 」也认
export const ITEM_BREAK = "\ue000";
const ITEM_SPLIT = new RegExp(`${ITEM_BREAK}|；|\\s·\\s`);

function itemsInCell(cell: HastNode) {
  const groups: HastNode[][] = [[]];
  for (const child of cell.children ?? []) {
    if (child.type !== "text") {
      groups[groups.length - 1].push(child);
      continue;
    }
    (child.value ?? "").split(ITEM_SPLIT).forEach((part, index) => {
      if (index) groups.push([]);
      if (part) groups[groups.length - 1].push({ type: "text", value: part });
    });
  }
  const items = groups.filter((nodes) => nodes.some((node) => textOf(node).trim()));
  if (items.length < 2) return;
  for (const nodes of items) {
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (first.type === "text") first.value = first.value?.trimStart();
    if (last.type === "text") last.value = last.value?.trimEnd();
  }
  cell.children = [el("ul", ["progress-items"], items.map((nodes): HastNode => ({ type: "element", tagName: "li", properties: {}, children: nodes })))];
}

function listCoveredItems(table: HastNode) {
  const walk = (node: HastNode) => {
    if (isElement(node, "tr")) {
      const cells = (node.children ?? []).filter((child) => isElement(child, "td"));
      if (cells[1]) itemsInCell(cells[1]);
      return;
    }
    (node.children ?? []).forEach(walk);
  };
  walk(table);
}

export function rehypeProgressCards() {
  return (tree: HastNode) => {
    const kids = tree.children ?? [];
    const start = kids.findIndex((n) => isElement(n, "h2") && PROGRESS_TITLE.test(textOf(n).trim()));
    if (start < 0) return;
    for (let i = start + 1; i < kids.length && !isElement(kids[i], "h1") && !isElement(kids[i], "h2"); i++) {
      const node = kids[i];
      if (isElement(node, "div") && hasClass(node, "lesson-table")) {
        const cls = node.properties?.className;
        node.properties = { ...node.properties, className: [...(Array.isArray(cls) ? cls : []), "progress-cards"] };
        listCoveredItems(node);
        return;
      }
    }
  };
}

export function rehypeWrapTables() {
  const walk = (node: HastNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (isElement(child, "table")) {
        kids[i] = el("div", ["lesson-table"], [child]);
      } else if (!isElement(child, "div") || !hasClass(child, "lesson-table")) {
        walk(child);
      }
    }
  };
  return (tree: HastNode) => walk(tree);
}

function hasClass(node: HastNode, name: string) {
  const cls = node.properties?.className;
  return Array.isArray(cls) && cls.includes(name);
}

// 中文段落标 data-script="cjk"：整段按汉字那一档的字号排，夹在里面的英文、数字跟着整段一起缩，和汉字保持中文排版的正常比例
// （globals.css）。只标顶层的块（段落、标题、列表、引用、表格容器），里面不再标，字号不会叠着缩。
// 汉字（含假名）不少于英文单词就算中文；代码、公式里的字母不算。要放在 rehypeKatex、rehypeWrapTables 之后
const HAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const LATIN_WORD = /[A-Za-z]+/g;

const isCodeOrMath = (node: HastNode) =>
  isElement(node, "code") || isElement(node, "pre") ||
  (Array.isArray(node.properties?.className) && node.properties.className.some((name) => /^(katex|math)/.test(String(name))));

const proseText = (node: HastNode): string =>
  node.type === "text" ? (node.value ?? "") : isCodeOrMath(node) ? "" : (node.children ?? []).map(proseText).join("");

export function isCjkText(text: string) {
  const han = text.match(HAN)?.length ?? 0;
  return han > 0 && han >= (text.match(LATIN_WORD)?.length ?? 0);
}

export function rehypeScriptBlocks() {
  return (tree: HastNode) => {
    for (const node of tree.children ?? []) {
      if (node.type === "element" && isCjkText(proseText(node))) node.properties = { ...node.properties, dataScript: "cjk" };
    }
  };
}

// 复选框所在列表项里，除了复选框本身和嵌套的子列表之外的文字，折成一行
function itemText(li: HastNode): string {
  const parts: string[] = [];
  const walk = (node: HastNode) => {
    if (node.type === "text") parts.push(node.value ?? "");
    else if (isElement(node, "input") || isElement(node, "ul") || isElement(node, "ol")) return;
    else (node.children ?? []).forEach(walk);
  };
  (li.children ?? []).forEach(walk);

  return parts.join("").replace(/\s+/g, " ").trim();
}

const isCheckbox = (node: HastNode) =>
  isElement(node, "input") && node.properties?.type === "checkbox";

// 复选框可能直接在 <li> 里，也可能在 <li> 里的 <p> 里（松散列表）；不往嵌套的子列表里找
function findCheckbox(li: HastNode): HastNode | undefined {
  for (const child of li.children ?? []) {
    if (isCheckbox(child)) return child;
    if (isElement(child, "p")) {
      const inside = (child.children ?? []).find(isCheckbox);
      if (inside) return inside;
    }
  }
  return undefined;
}

export function rehypeTaskLabels() {
  const walk = (node: HastNode) => {
    if (isElement(node, "li") && hasClass(node, "task-list-item")) {
      const checkbox = findCheckbox(node);
      const label = itemText(node);
      if (checkbox && label) {
        checkbox.properties = { ...checkbox.properties, ariaLabel: label };
      }
    }
    (node.children ?? []).forEach(walk);
  };
  return (tree: HastNode) => walk(tree);
}
