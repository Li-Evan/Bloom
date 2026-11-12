import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isRouteId } from "../src/lib/learn/route-params.ts";

test("路由参数：只接受不带前导零的非负整数", () => {
  for (const ok of ["0", "1", "7", "42", "123456789012345"])
    assert.equal(isRouteId(ok), true, ok);
  for (const bad of [
    "",
    "-1",
    "+1",
    "1.5",
    "1e3",
    " 1",
    "1 ",
    "0x1",
    "007",
    "abc",
    "1/2",
    "1%2F2",
    "../1",
    "1?x=1",
    "１２",
    "1234567890123456",
    "NaN",
    "Infinity",
  ]) {
    assert.equal(isRouteId(bad), false, JSON.stringify(bad));
  }
});

const pages = {
  "course/[courseId]/page.tsx": ["courseId"],
  "course/[courseId]/syllabus/page.tsx": ["courseId"],
  "course/[courseId]/lesson/[lessonNum]/page.tsx": ["courseId", "lessonNum"],
};

test("带动态参数的学习页面：参数不合法就 notFound()，且在请求任何数据之前", async () => {
  for (const [file, params] of Object.entries(pages)) {
    const source = await readFile(
      new URL(`../src/app/[locale]/(default)/learn/${file}`, import.meta.url),
      "utf8"
    );
    assert.match(source, /\bnotFound\(\)/, `${file}: 没有调用 notFound()`);
    for (const param of params) {
      assert.match(
        source,
        new RegExp(`isRouteId\\(${param}\\)`),
        `${file}: 没有校验 ${param}`
      );
    }
    // 页面本身（default export）里：先校验参数，再取数据、再渲染
    const body = source.slice(source.indexOf("export default"));
    const guard = body.search(/\bnotFound\(\)/);
    const work = body.search(/\blessonStart\(|\bbackendFetch\b|\bmeFetch\b|\bapi\(|return </);
    assert.ok(
      guard !== -1 && work !== -1 && guard < work,
      `${file}: 校验应在取数据和渲染之前`
    );
  }
});
