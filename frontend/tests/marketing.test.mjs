import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");

test("中文名统一写「布鲁姆」，不再混用「布卢姆」", async () => {
  assert.doesNotMatch(await read("i18n/messages/zh.json"), /布卢姆/);
});

test("模板的首页区块已删除，类型定义也一起删了", async () => {
  for (const dir of ["hero", "feature", "feature1", "feature3", "cta", "faq", "pricing", "blog", "blog-detail"]) {
    await assert.rejects(access(join(root, `components/blocks/${dir}`)), `components/blocks/${dir} 还在`);
  }
  await assert.rejects(access(join(root, "components/markdown")), "components/markdown 还在");
});

test("顶栏抽屉的占位按钮与真抽屉触发按钮的属性一致（水合时不换属性）", async () => {
  const source = await read("components/site/header/mobile-menu.tsx");
  const placeholder = source.slice(source.indexOf("if (!mounted)"), source.indexOf("return (\n    <Sheet"));
  assert.ok(placeholder.length > 0);
  assert.match(placeholder, /aria-haspopup="dialog"/);
  assert.match(placeholder, /aria-expanded="false"/);
});
