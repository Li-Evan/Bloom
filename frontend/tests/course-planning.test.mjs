import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "zh" } };
const { clarifyCourseGoal, createCourse } = await import("../src/lib/learn/api.ts");

test("目标澄清传递真实回答，建课保留目标和假设", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === "/api/token") {
      return Response.json({ token: "test", expires_at: Date.now() / 1000 + 900 });
    }
    requests.push({ url: String(url), body: JSON.parse(init.body), method: init.method });
    return Response.json(String(url).endsWith("clarify")
      ? { title: "客服评测", summary: "设计可执行的评测", assumptions: [], questions: [] }
      : { id: 1, name: "客服评测" });
  });
  const answers = [{ question: "用于什么场景？", answer: "客服 Agent，我会 Python" }];
  const result = await clarifyCourseGoal({ goal: "LLM rubric", language: "zh", learning_depth: "standard", reference_excerpt: "",
    material_names: [], answers, skip_questions: false });
  const intent = { goal: "LLM rubric", summary: result.summary, assumptions: result.assumptions, answers };
  await createCourse(result.title, "", "standard", "zh", intent);
  assert.equal(requests[0].url, "/api/backend/courses/clarify");
  assert.deepEqual(requests[0].body.answers, answers);
  assert.equal(requests[1].body.name, "客服评测");
  assert.deepEqual(requests[1].body.learning_intent, intent);
});
