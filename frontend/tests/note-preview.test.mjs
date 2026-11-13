import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { notePreviewParts } from "../src/lib/me/note-preview.ts";
import { rehypePlugins, remarkPlugins } from "../src/lib/learn/markdown-config.ts";

test("笔记摘要中的向量与矩阵使用现有数学渲染，纯文字不变", () => {
  const raw = String.raw`方向不变。取 $(1,0)$，矩阵 $A=\begin{pmatrix}2&0\\0&2\end{pmatrix}$ 让它伸长。`;
  const parts = notePreviewParts(raw, false);
  assert.deepEqual(parts.filter((p) => !p.math).map((p) => p.text), ["方向不变。取 ", "，矩阵 ", " 让它伸长。"]);
  assert.equal(parts.filter((p) => p.math).length, 2);
  for (const part of parts.filter((p) => p.math)) {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, part.text));
    assert.match(html, /class="katex"/);
    assert.doesNotMatch(html, /katex-error/);
    const visible = html.replace(/<annotation[\s\S]*?<\/annotation>/g, "").replace(/<[^>]+>/g, "");
    assert.doesNotMatch(visible, /\\begin|\\end|\$/);
  }
});

test("后端截到公式中间时不显示残缺命令，完整公式与前文保留", () => {
  const raw = String.raw`先看 $x=2$。再看 $A=\begin{pmatrix}2&0\\`;
  const parts = notePreviewParts(raw, true);
  assert.deepEqual(parts, [{ text: "先看 ", math: false }, { text: "$x=2$", math: true }, { text: "。再看", math: false }]);
  assert.doesNotMatch(parts.map((p) => p.text).join(""), /\\begin/);
  assert.deepEqual(notePreviewParts(String.raw`公式 \(x=`, true), [{ text: "公式", math: false }]);
});

test("美元金额和普通回答保留原样，块公式在摘要里转为行内公式", () => {
  assert.deepEqual(notePreviewParts("投入 $100，下一年有 $105。", true), [{ text: "投入 $100，下一年有 $105。", math: false }]);
  assert.deepEqual(notePreviewParts("普通回答，搜索命中仍交给纯文字高亮。", false), [{ text: "普通回答，搜索命中仍交给纯文字高亮。", math: false }]);
  assert.deepEqual(notePreviewParts(String.raw`结果 \[x^2+1\]。`, false), [{ text: "结果\n", math: false }, { text: "$x^2+1$", math: true }, { text: "\n。", math: false }]);
});
