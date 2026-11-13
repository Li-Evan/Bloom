// 课文页左栏的目录（components/learn/lesson-outline.tsx）：从课文的 Markdown 取标题，点一条滚到正文里那个标题。
// 目录随页面在服务端就渲染出来，左栏一开始就占好位置，页面加载完不会再往右挪；所以条目从 Markdown 文字解析，不等浏览器量 DOM。
// 正文那边由 rehypeSectionIds 给标题加锚点。两边都按「顶层第几个标题」编号（section-1、section-2…）：
// remark 转 rehype 时顶层标题一一对应、次序不变，编号就对得上。解析的文字必须和正文渲染的是同一份（lesson-text.ts 的 markdownText）。
import remarkParse from "remark-parse";
import { unified } from "unified";

import { markdownText } from "@/lib/learn/lesson-text";
import { remarkPlugins } from "@/lib/learn/markdown-config";
import { SOURCE_SECTION_TITLE, THOUGHTS_TITLE, type HastNode } from "@/lib/learn/rehype-lesson";

export interface OutlineEntry {
  id: string;
  text: string;
  // 0 是最高一层，最多到 2
  level: number;
}

const sectionId = (n: number) => `section-${n}`;

// 正文：顶层的 h1–h6 依次加上 id。放在 rehype 插件的最前面，在别的插件改写、替换标题之前编号
export function rehypeSectionIds() {
  return (tree: HastNode) => {
    let n = 0;
    for (const node of tree.children ?? []) {
      if (node.type !== "element" || !/^h[1-6]$/.test(node.tagName ?? "")) continue;
      n += 1;
      node.properties = { ...node.properties, id: sectionId(n) };
    }
  };
}

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
}

// 标题的纯文字：加粗、链接、行内代码、公式只留文字（公式留 TeX 源码）
const plain = (node: MdNode): string => node.value ?? (node.children ?? []).map(plain).join("");

const parser = unified().use(remarkParse).use(remarkPlugins ?? []);

// 目录最多三层：更深的小标题只会把列表拉得很长
const LEVELS = 3;

// lesson / source 和 <Markdown> 的同名参数一样：决定正文用哪套插件，那些插件会改掉几个标题
export function lessonOutline(markdown: string, { lesson = false, source = false } = {}): OutlineEntry[] {
  const root = parser.parse(markdown) as MdNode;
  const heads: { id: string; text: string; depth: number }[] = [];
  let n = 0;
  let firstH2 = true;
  let thoughts = false;

  for (const node of root.children ?? []) {
    if (node.type !== "heading") continue;
    n += 1;
    const text = plain(node).replace(/\s+/g, " ").trim();
    let depth = node.depth ?? 1;
    if (depth === 2 && firstH2) {
      firstH2 = false;
      // 原文篇的第一个二级标题「原文」渲染成一行小标签，不是标题（rehypeSourceHeading）
      if (lesson && source && SOURCE_SECTION_TITLE.test(text)) continue;
    }
    // AI 课文的「思考题」二级标题排得和小节标题（三级）一样大（rehypeThoughtQuestions），目录里也和小节同一层
    if (lesson && !source && depth === 2 && !thoughts && THOUGHTS_TITLE.test(text)) {
      thoughts = true;
      depth = 3;
    }
    if (text) heads.push({ id: sectionId(n), text, depth });
  }

  // 打头的一级标题、而且全篇只有它一个：那是整篇的标题，不进目录
  if (heads[0]?.depth === 1 && !heads.slice(1).some((h) => h.depth === 1)) heads.shift();
  if (!heads.length) return [];
  const top = Math.min(...heads.map((h) => h.depth));
  return heads
    .filter((h) => h.depth < top + LEVELS)
    .map(({ id, text, depth }) => ({ id, text, level: depth - top }));
}

// 课文页的正文按哪种内容渲染（<Markdown> 的参数）：项目文件是普通 Markdown，原文篇（学生自己的资料）
// 不做中文排版、还原被转义的加粗。目录从同一份文字、按同一组参数取标题，标题锚点的编号才对得上
export function lessonMarkdownOptions(isProject: boolean, isSourceLesson: boolean) {
  return { lesson: !isProject, source: isSourceLesson && !isProject, typography: !isSourceLesson, restoreBold: isSourceLesson };
}

// 一篇课文的目录：和 <Markdown {...options} sectionIds> 渲染出来的标题一一对应
export function outlineOf(content: string | undefined, options: ReturnType<typeof lessonMarkdownOptions>): OutlineEntry[] {
  return lessonOutline(markdownText(content, options), options);
}
