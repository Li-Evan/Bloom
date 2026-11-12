"use client";

import { useMemo } from "react";

import { wordRuns } from "@/lib/learn/words";

// 中文标题里一个词一个不换行的片段，长标题只在词与词之间折行（课文标题由 rehype 插件做，其余标题用它）。
// 只放在客户端取到数据之后才渲染的标题里：服务端渲染没有这些片段，会和水合对不上。
export default function Words({ text }: { text: string }) {
  const runs = useMemo(() => wordRuns(text), [text]);

  return (
    <>
      {runs.map((run, i) =>
        run.keep ? (
          <span key={i} className="whitespace-nowrap">
            {run.text}
          </span>
        ) : (
          run.text
        )
      )}
    </>
  );
}
