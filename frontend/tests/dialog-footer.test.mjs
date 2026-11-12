import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const src = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(`${src}${path}`, "utf8");

test("新建课程对话框页脚放不下一行时折成两行（结构守卫）", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /<div className="flex flex-wrap-reverse items-center justify-end gap-3 max-sm:\[&>button\]:flex-1">/);
});

