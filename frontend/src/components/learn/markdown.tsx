"use client";

import "katex/dist/katex.min.css";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";

import { scrollFadeComponents } from "@/components/learn/scroll-fade";
import { markdownText } from "@/lib/learn/lesson-text";
import { rehypeSectionIds } from "@/lib/learn/outline";
import {
  lessonRehypePluginsWithNote,
  rehypePlugins,
  remarkPlugins,
  sourceLessonRehypePlugins,
  streamingLessonRehypePlugins,
} from "@/lib/learn/markdown-config";

// 所有内容统一剥掉 HTML 注释（不渲染 `<!-- mastery: … -->` 这类内部标记）。
// lesson：课文本身——另外隐藏末尾的「你的反馈」占位小节和「正文内容」小节标题，并把标题下的元信息引用块排成一行小字。
// source：原文篇（学生自己上传的资料）——元信息里去掉旧数据的占位（前置知识、难度、「按原文长度而定」），
//   标题用课程名（title），「原文」二级标题变小标签。
// streaming：内容还在流式写入（问答回答、生成下一篇的预览）——写了一半的注释先不显示；课文的流式预览不显示阅读时间。已完成的内容不要传。
// typography：中文排版（成对直引号 → 弯引号、汉字后的半角冒号 → 全角，见 lib/learn/lesson-text.ts），课文、问答、大纲、笔记都开；
//   默认关，博客等别处的 Markdown 不受影响。
// restoreBold：导入的原文（txt、Word、网页）里被转义成 \*\* 的加粗还原成加粗（lib/learn/lesson-text.ts）；AI 写的内容不开。
// sectionIds：标题加上锚点 section-1、section-2…，课文页左栏的目录点了滚过去（lib/learn/outline.ts）。一页只给一处正文开。
export default function Markdown({
  children,
  lesson = false,
  source = false,
  streaming = false,
  typography = false,
  restoreBold = false,
  sectionIds = false,
  title,
}: {
  children?: string;
  lesson?: boolean;
  source?: boolean;
  streaming?: boolean;
  typography?: boolean;
  restoreBold?: boolean;
  sectionIds?: boolean;
  title?: string;
}) {
  const t = useTranslations("learn.lesson");
  // 思考题小节末尾的一句说明：参考答案写在下一篇末尾（课文里没有这句话，渲染时补上）
  const note = t("thoughtsNote");
  const lessonPlugins = useMemo(() => lessonRehypePluginsWithNote(note), [note]);
  const sourcePlugins = useMemo(() => sourceLessonRehypePlugins(title), [title]);
  const base = lesson ? (source ? sourcePlugins : streaming ? streamingLessonRehypePlugins : lessonPlugins) : rehypePlugins;
  const plugins = useMemo(() => (sectionIds ? [rehypeSectionIds, ...(base ?? [])] : base), [base, sectionIds]);
  const text = useMemo(
    () => markdownText(children, { lesson, streaming, typography, restoreBold }),
    [children, lesson, streaming, typography, restoreBold]
  );

  // 解析 Markdown + KaTeX 很重：文字和插件都没变就复用上一次的结果（父组件因为别的状态重渲染时不重新解析）
  return useMemo(
    () => (
      <ReactMarkdown remarkPlugins={remarkPlugins} components={scrollFadeComponents} rehypePlugins={plugins}>
        {text}
      </ReactMarkdown>
    ),
    [plugins, text]
  );
}
