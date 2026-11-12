"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";

import { readingMinutes, statesReadingTime } from "@/lib/learn/reading-time";
import { monoRuns } from "@/lib/mono-runs";

// 正文上方一行「预计阅读时间：约 N 分钟」，和课文标题下的元信息同一个样式（.lesson-meta）。
// 资料课的文件（Markdown、PDF 提取出的文字）、旧原文篇没有这一行；正文里已经写着的（AI 课文的元信息、原文篇头部）不再加，没有文字也不显示
export default function ReadingTime({ content }: { content?: string }) {
  const t = useTranslations("learn.lesson.readingTime");
  const minutes = useMemo(() => (content && !statesReadingTime(content) ? readingMinutes(content) : 0), [content]);
  if (!minutes) return null;

  return (
    <p className="lesson-meta lesson-meta-top">
      <span className="lesson-meta-item">
        <span className="lesson-meta-key">{t("label")}</span>
        {/* 中文页整行是正文字体，只有数字用等宽（和 rehype-lesson.ts 里元信息行的做法一样） */}
        <span className="lesson-meta-val">
          {monoRuns(t("value", { minutes })).map((run, i) => (run.mono ? <span key={i} className="lesson-mono">{run.text}</span> : run.text))}
        </span>
      </span>
    </p>
  );
}
