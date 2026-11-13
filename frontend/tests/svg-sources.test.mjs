import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

// 社交卡和推广图（scripts/social-cards、assets/promo）已随营销页一起删掉，剩下仓库里的标志
const DIRS = ["../../assets/"];

test("标志的 SVG 源里每条路径都以 M 开头（缺了就会少画一瓣）", async () => {
  let checked = 0;
  for (const dir of DIRS) {
    const base = new URL(dir, import.meta.url);
    for (const name of (await readdir(base)).filter((n) => n.endsWith(".svg"))) {
      const text = await readFile(new URL(name, base), "utf8");
      for (const [, d] of text.matchAll(/<path[^>]*\sd="([^"]*)"/g)) {
        checked++;
        assert.match(d.trim(), /^[Mm]/, `${dir}${name}: d="${d.slice(0, 40)}…"`);
      }
    }
  }
  assert.ok(checked >= 12, "应当扫到全部 SVG 的路径");
});
