import dynamic from "next/dynamic";

import Marked from "@/components/me/marked";
import { notePreviewParts } from "@/lib/me/note-preview";

// 公式渲染（react-markdown + KaTeX）只在摘要里真有公式时才加载
const MathText = dynamic(() => import("@/components/me/math-text"));

export default function AnswerPreview({ text, cut, query }: { text: string; cut: boolean; query: string }) {
  return notePreviewParts(text, cut).map((part, index) => part.math ? (
    <span key={index} className="[&_.katex]:text-[1em]">
      <MathText text={part.text} />
    </span>
  ) : <Marked key={index} text={part.text} query={query} />);
}
