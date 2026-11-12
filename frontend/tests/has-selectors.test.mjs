import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

// Tailwind 的 group-has-* / peer-has-* 编译出来是 :is(:where(.group):has(…) *)：:has() 在祖先位置，后面跟着 *。
// 整站共用一份 CSS，只要有一条这样的规则，任何页面上每插一个节点，下一次量尺寸（getBoundingClientRect、canvas 的 measureText）
// 浏览器都要把 body 下面整棵树的样式重算一遍。PDF 文字层每放一段字就量一次字宽：课文页上铺一页文字层要卡 0.5–2 秒，
// 点缩放、往下滚都卡（2026-11-10，后台侧边栏的两条 group-has-* 拖慢了课文页）
test("不用 group-has-* / peer-has-*：它们让整页样式跟着每次插入节点重算，PDF 铺一页文字层要卡上百毫秒", async () => {
  const root = new URL("../src/", import.meta.url);
  const hits = [];
  for (const name of await readdir(root, { recursive: true })) {
    if (!/\.(tsx?|css)$/.test(name)) continue;
    if (/\b(group|peer)-has-/.test(await readFile(new URL(name, root), "utf8"))) hits.push(name);
  }
  assert.deepEqual(hits, []);
});
