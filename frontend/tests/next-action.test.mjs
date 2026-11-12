import assert from "node:assert/strict";
import { test } from "node:test";

const { nextAction } = await import("../src/lib/learn/next-action.ts");

const lessons = (...numbers) => numbers.map((number) => ({ number }));

test("最后一篇、课程在学：才是会调用模型的「生成下一篇」", () => {
  assert.deepEqual(nextAction(4, lessons(1, 2, 3, 4), false), {
    kind: "generate",
  });
});

test("回看更早的课文：免费跳到紧接着的下一篇，绝不生成", () => {
  assert.deepEqual(nextAction(2, lessons(1, 2, 3, 4), false), {
    kind: "go",
    lessonNumber: 3,
  });
  assert.deepEqual(nextAction(1, lessons(1, 2, 3, 4), false), {
    kind: "go",
    lessonNumber: 2,
  });
});

test("课程已完结：最后一篇上什么按钮都不给，更早的课文仍然免费跳转", () => {
  assert.deepEqual(nextAction(4, lessons(0, 1, 2, 3, 4), true), {
    kind: "none",
  });
  assert.deepEqual(nextAction(3, lessons(0, 1, 2, 3, 4), true), {
    kind: "go",
    lessonNumber: 4,
  });
});

test("总结（第 0 篇）不算最后一篇，也不参与跳转", () => {
  assert.deepEqual(nextAction(3, lessons(0, 1, 2, 3), false), {
    kind: "generate",
  });
  assert.deepEqual(nextAction(0, lessons(0, 1, 2, 3), true), { kind: "none" });
});

test("课文列表还没加载出来：不给任何会调用模型的按钮", () => {
  assert.deepEqual(nextAction(1, [], false), { kind: "none" });
});

test("课文编号不连续时跳到比当前大的最小一篇", () => {
  assert.deepEqual(nextAction(2, lessons(1, 2, 5), false), {
    kind: "go",
    lessonNumber: 5,
  });
});
