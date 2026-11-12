import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./load-tsx.mjs";

const { Button } = await loadTsx("components/ui/button.tsx");

test("Button loading：aria-busy + aria-disabled + 前面一个转圈；不用原生 disabled（保住键盘焦点，也就不会变成禁用的灰色）", () => {
  const html = renderToStaticMarkup(h(Button, { loading: true, disabled: true }, "保存"));
  assert.match(html, /<button[^>]*data-loading="true"[^>]*aria-busy="true"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.match(html, /pointer-events-none/);
  assert.match(html, /<svg[^>]*animate-spin[^>]*>.*<\/svg>保存<\/button>/);
});

test("Button 不在 loading 时不带转圈、不禁用；asChild 只交出一个子元素（Slot 要求）", () => {
  const idle = renderToStaticMarkup(h(Button, null, "保存"));
  assert.doesNotMatch(idle, /animate-spin|disabled=|aria-busy/);
  const link = renderToStaticMarkup(h(Button, { asChild: true, loading: false }, h("a", { href: "/x" }, "去")));
  assert.match(link, /^<a [^>]*href="\/x"[^>]*>去<\/a>$/);
});
