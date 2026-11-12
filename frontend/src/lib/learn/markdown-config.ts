import type ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  rehypeKeepWords,
  rehypeLessonMeta,
  rehypeProgressCards,
  rehypeScriptBlocks,
  rehypeScrollMath,
  rehypeSourceHeading,
  rehypeTaskLabels,
  rehypeThoughtQuestions,
  rehypeWrapTables,
} from "@/lib/learn/rehype-lesson";

type Props = React.ComponentProps<typeof ReactMarkdown>;

// remarkCjkFriendly：CommonMark 规定「标点后面紧跟文字」的 ** 不能收尾，中文里「…。**公司」这种加粗会关不上、** 原样露出来
export const remarkPlugins: Props["remarkPlugins"] = [remarkGfm, remarkCjkFriendly, remarkMath];

// throwOnError:false → 个别不规范公式显示为红色文本而非整页崩溃（LLM 生成的 LaTeX 未必规范）
const katex: NonNullable<Props["rehypePlugins"]>[number] = [
  rehypeKatex,
  { throwOnError: false, errorColor: "var(--destructive)", strict: "ignore" },
];

// rehypeTaskLabels 放在 katex 之前：这时公式还是源码文本，不会把渲染后的 MathML 重复读进复选框的名字
// rehypeScrollMath 在 katex 之后：包的是 KaTeX 渲染出来的块级公式
// rehypeScriptBlocks 放最后：按最终的顶层块判断中文段落（表格已包好容器，公式已渲染、不算字）
export const rehypePlugins: Props["rehypePlugins"] = [rehypeTaskLabels, rehypeWrapTables, rehypeProgressCards, katex, rehypeScrollMath, rehypeScriptBlocks];

// 课文：另外把标题下的元信息引用块排成一行小字，标题里的中文按词不折行，「思考题」小节标题和别的小节一样大。
// 带 note 的版本（课文页用）在思考题小节末尾补一句「参考答案在哪里」
const lessonPlugins = (thoughts: { note?: string }): Props["rehypePlugins"] => [
  rehypeLessonMeta,
  [rehypeThoughtQuestions, thoughts],
  rehypeKeepWords,
  rehypeTaskLabels,
  rehypeWrapTables,
  katex,
  rehypeScrollMath,
  rehypeScriptBlocks,
];

export const lessonRehypePlugins = lessonPlugins({});
export const lessonRehypePluginsWithNote = (note: string) => lessonPlugins({ note });

// 生成下一篇的流式预览：不显示阅读时间（边写边估的数字以完成后的为准）
export const streamingLessonRehypePlugins: Props["rehypePlugins"] = [
  [rehypeLessonMeta, { hideReadingTime: true }],
  rehypeThoughtQuestions,
  rehypeKeepWords,
  rehypeTaskLabels,
  rehypeWrapTables,
  katex,
  rehypeScrollMath,
  rehypeScriptBlocks,
];

// 原文篇（学生自己的资料）：元信息里去掉旧数据的占位，标题用课程名，「原文」二级标题变小标签。
// rehypeSourceHeading 在 rehypeKeepWords 之前：换上去的课程名也要按词折行
export const sourceLessonRehypePlugins = (title?: string): Props["rehypePlugins"] => [
  [rehypeLessonMeta, { source: true }],
  [rehypeSourceHeading, { title }],
  rehypeKeepWords,
  rehypeTaskLabels,
  rehypeWrapTables,
  katex,
  rehypeScrollMath,
  rehypeScriptBlocks,
];
