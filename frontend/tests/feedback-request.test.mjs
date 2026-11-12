import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
globalThis.document = { documentElement: { lang: "zh" } };

const { submitFeedback } = await import("../src/lib/learn/api.ts");

async function sentBody(t, ...args) {
  let body;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(String(url), "http://x").pathname === "/api/token") {
      return new Response(
        JSON.stringify({ token: "t", expires_at: Date.now() / 1000 + 900 })
      );
    }
    assert.equal(init.method, "POST");
    assert.equal(
      String(url),
      "/api/backend/courses/1/lessons/3/feedback"
    );
    body = init.body;
    return new Response(JSON.stringify({ id: 1 }));
  });
  await submitFeedback(1, 3, ...args);
  return body;
}

// 后端把 thought_answers 当字符串，空值发 null 会让第二次保存同一课的反馈返回 500
test("保存反馈：思考题回答为空时发空字符串，不发 null；反馈内容同样", async (t) => {
  for (const [content, thoughts, expected] of [
    ["反馈", "", { content: "反馈", thought_answers: "" }],
    ["反馈", "   ", { content: "反馈", thought_answers: "" }],
    ["反馈", " 答案 ", { content: "反馈", thought_answers: "答案" }],
    ["", "答案", { content: "", thought_answers: "答案" }],
    ["", "", { content: "", thought_answers: "" }],
  ]) {
    const body = await sentBody(t, content, thoughts);
    assert.deepEqual(
      JSON.parse(body),
      { ...expected, scope: "auto" },
      JSON.stringify([content, thoughts])
    );
    assert.doesNotMatch(body, /null/);
  }
});

test("课文页不再对思考题回答写 `|| null` / `?? null`", async () => {
  const source = await readFile(
    new URL("../src/components/learn/lesson.tsx", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /thoughtAnswers[^\n]*(\|\||\?\?)\s*null/);
});
