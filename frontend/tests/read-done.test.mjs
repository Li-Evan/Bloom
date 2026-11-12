import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
globalThis.document = { documentElement: { lang: "zh" } };

const { saveFeedbackThenGenerate } =
  await import("../src/lib/learn/read-done.ts");
const { submitFeedback, generateNextLesson } =
  await import("../src/lib/learn/api.ts");

test("反馈保存失败：不调用生成，并报告没有生成", async () => {
  const events = [];
  const generated = await saveFeedbackThenGenerate(
    async () => (events.push("save"), false),
    async () => void events.push("generate")
  );
  assert.equal(generated, false);
  assert.deepEqual(events, ["save"]);
});

test("反馈保存成功：先保存、再生成；没有要保存的就直接生成", async () => {
  const events = [];
  assert.equal(
    await saveFeedbackThenGenerate(
      async () => (events.push("save"), true),
      async () => void events.push("generate")
    ),
    true
  );
  assert.equal(
    await saveFeedbackThenGenerate(
      null,
      async () => void events.push("generate")
    ),
    true
  );
  assert.deepEqual(events, ["save", "generate", "generate"]);
});

test("保存抛出意外错误：同样不生成，错误原样抛给调用方", async () => {
  let generated = false;
  await assert.rejects(
    saveFeedbackThenGenerate(
      async () => {
        throw new Error("boom");
      },
      async () => {
        generated = true;
      }
    ),
    /boom/
  );
  assert.equal(generated, false);
});

test("真实请求函数：保存反馈的请求被后端拒绝时，POST /next 一次都没有发出", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(String(url), "http://x").pathname;
    if (path === "/api/token") {
      return new Response(
        JSON.stringify({ token: "t", expires_at: Date.now() / 1000 + 900 })
      );
    }
    calls.push(`${init.method} ${path}`);
    if (path.endsWith("/feedback")) {
      return new Response(
        JSON.stringify({ detail: "服务暂时不可用，请稍后重试" }),
        { status: 500 }
      );
    }
    return new Response('data: {"done":true,"lesson_number":2}\n\n');
  });

  let reported;
  const save = async () => {
    try {
      await submitFeedback(1, 3, "反馈", "思考题回答");
      return true;
    } catch (e) {
      reported = e.message;
      return false;
    }
  };

  const generated = await saveFeedbackThenGenerate(save, () =>
    generateNextLesson(
      1,
      () => {},
      () => {}
    )
  );

  assert.equal(generated, false);
  assert.equal(reported, "服务暂时不可用，请稍后重试");
  assert.deepEqual(calls, ["POST /api/backend/courses/1/lessons/3/feedback"]);
});

test("课文页的 handleReadDone 经 saveFeedbackThenGenerate 调生成接口，且未保存的反馈或思考题回答都会触发保存", async () => {
  const text = await readFile(
    new URL("../src/components/learn/lesson.tsx", import.meta.url),
    "utf8"
  );
  const sf = ts.createSourceFile(
    "lesson.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let body;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "handleReadDone"
    )
      body = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(body, "没找到 handleReadDone");
  const calls = [];
  const collect = (node) => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText());
    ts.forEachChild(node, collect);
  };
  collect(body);
  assert.ok(
    calls.includes("saveFeedbackThenGenerate"),
    "handleReadDone 没有经 saveFeedbackThenGenerate"
  );
  assert.ok(
    !calls.includes("generateNextLesson"),
    "handleReadDone 里不该直接调 generateNextLesson"
  );
  assert.match(
    body.getText(),
    /thoughtAnswers\.trim\(\)/,
    "只写了思考题回答时也要保存"
  );
});
