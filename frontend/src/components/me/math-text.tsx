import "katex/dist/katex.min.css";

import ReactMarkdown from "react-markdown";

import { rehypePlugins, remarkPlugins } from "@/lib/learn/markdown-config";

// 笔记摘要里的一段公式（answer-preview 按需加载它）
export default function MathText({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{ p: ({ children }) => <>{children}</> }}>
      {text}
    </ReactMarkdown>
  );
}
