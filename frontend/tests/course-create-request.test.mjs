import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
globalThis.document = { documentElement: { lang: "en" } };

const { createCourse, createCourseFromMaterials, createProjectCourse } =
  await import("../src/lib/learn/api.ts");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

let tokens = 0;

function backend(t, { failFirstWith } = {}) {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/backend/uploads")) return json({id:"upload", chunk_bytes:1048576});
    if (String(url).includes("/api/backend/uploads/")) return json({ok:true});
    if (String(url).endsWith("/api/token")) {
      return json({ token: `t${++tokens}`, expires_at: Date.now() / 1000 + 900 });
    }
    seen.push({
      method: init.method,
      path: new URL(String(url), "http://frontend.test").pathname,
      auth: init.headers.get("Authorization"),
      body: typeof init.body === "string" ? init.body : null,
    });
    if (failFirstWith && seen.length === 1) return json({ detail: "访问令牌已过期，请刷新页面" }, failFirstWith);
    return json({ id: 1 });
  });
  return seen;
}

test("每种建课方式都 POST 到各自的接口", async (t) => {
  const seen = backend(t);
  const file = new File(["# hi"], "a.md");

  await createCourse("主题");
  await createCourseFromMaterials("主题", "", [file]);
  await createProjectCourse("项目", [file]);

  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), [
    "POST /api/backend/courses", "POST /api/backend/courses/from-materials", "POST /api/backend/courses/from-project",
  ]);
});

test("401 后客户端自动重试同一次建课请求：令牌换新，请求体不变", async (t) => {
  const seen = backend(t, { failFirstWith: 401 });

  await createCourse("主题");

  assert.equal(seen.length, 2);
  assert.equal(seen[0].body, seen[1].body);
  assert.match(seen[0].body, /"name":"主题"/);
  assert.notEqual(seen[0].auth, seen[1].auth);
});
