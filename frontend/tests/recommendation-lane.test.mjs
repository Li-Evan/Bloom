import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const panel = await readFile(new URL("../src/components/learn/recommendation-panel.tsx", import.meta.url), "utf8");

test("推荐卡片的分类标签按模型给的 kind 显示，没有 kind 就不贴，不再按卡片位置猜", () => {
  assert.match(panel, /lane=\{item\.kind\}/);
  assert.match(panel, /\{lane && <Eyebrow>\{t\(`lane\.\$\{lane\}`\)\}<\/Eyebrow>\}/);
  assert.doesNotMatch(panel, /LANES\[index\]/);
  assert.doesNotMatch(panel, /"fallback"/);
});
