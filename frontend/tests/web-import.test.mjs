import assert from "node:assert/strict";
import test from "node:test";
import { displayFileName } from "../src/lib/learn/files.ts";
import { webArticleMarkdown, webArticleFilename } from "../src/lib/learn/web-import.ts";

test("article serialization preserves body verbatim and includes a safe source link", () => {
  const content = '## 示例\n\n```python\nprint("你好")\n```\n\n![图片](https://example.com/p.png)';
  const result = webArticleMarkdown({ title: "原文 [标题]", url: "https://example.com/a?q=(x)", content }, "来源");
  assert.ok(result.endsWith(content + "\n"));
  assert.ok(result.startsWith("# 原文 \\[标题\\]"));
  assert.ok(result.includes("[来源](<https://example.com/a?q=(x)>)"));
});

test("unsafe source URLs are rejected", () => {
  assert.throws(() => webArticleMarkdown({ title: "x", content: "x", url: "javascript:alert(1)" }, "Source"));
});

test("article titles produce one readable Markdown filename", () => {
  assert.equal(webArticleFilename("网页/学习:提问"), "网页 学习 提问.md");
  assert.equal(webArticleFilename(""), "article.md");
  assert.ok(webArticleFilename("a".repeat(300)).length <= 163);
});

test("file lists show the article title without .md; other extensions stay", () => {
  assert.equal(displayFileName(webArticleFilename("Simulations Now in Public Beta")), "Simulations Now in Public Beta");
  assert.equal(displayFileName(webArticleFilename("Node.js 22 发布")), "Node.js 22 发布");
  assert.equal(displayFileName("docs/Notes.MD"), "docs/Notes");
  assert.equal(displayFileName("paper.pdf.md"), "paper.pdf");
  for (const name of ["paper.pdf", "src/main.py", "notes.txt", "README.markdown", "cmd"]) assert.equal(displayFileName(name), name);
});
