import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "zh" } };

const { createBatcher, lineResponse, MAX_BATCH } = await import("../src/lib/batch.ts");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// 一个可以逐行推送的 NDJSON 响应：测试决定每一行什么时候到
function ndjsonStream() {
  let controller;
  const body = new ReadableStream({ start: (c) => (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
    push: (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)),
    end: () => controller.close(),
    fail: () => controller.error(new TypeError("terminated")),
  };
}

const ndjson = (lines) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("同一时刻的读请求合成一批，每条拿到自己的状态码、正文和 Retry-After", async () => {
  const sent = [];
  const get = createBatcher({
    send: async (paths, key) => {
      sent.push([key, paths]);
      return ndjson([
        { i: 2, status: 429, body: { detail: "慢一点" }, headers: { "retry-after": "60" } },
        { i: 0, status: 200, body: { id: 1 } },
        { i: 1, status: 404, body: { detail: "找不到这门课程" } },
      ]);
    },
    single: async () => assert.fail("不该逐条请求"),
  });

  const [a, b, c] = await Promise.all([get("/api/a", "user"), get("/api/b", "user"), get("/api/c", "user")]);
  assert.deepEqual(sent, [["user", ["/api/a", "/api/b", "/api/c"]]]);
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { id: 1 });
  assert.equal(b.status, 404);
  assert.deepEqual(await b.json(), { detail: "找不到这门课程" });
  assert.equal(c.status, 429);
  assert.equal(c.headers.get("retry-after"), "60");
});

test("先完成的那条先返回，不等整批结束", async () => {
  const stream = ndjsonStream();
  const get = createBatcher({ send: async () => stream.response, single: async () => assert.fail() });
  const fast = get("/api/lesson", "user");
  const slow = get("/api/knowledge-map", "user");
  await tick();
  stream.push({ i: 0, status: 200, body: { text: "正文" } });
  assert.deepEqual(await (await fast).json(), { text: "正文" });

  let slowDone = false;
  slow.then(() => (slowDone = true));
  await tick();
  assert.equal(slowDone, false);
  stream.push({ i: 1, status: 200, body: { nodes: [] } });
  stream.end();
  assert.deepEqual(await (await slow).json(), { nodes: [] });
});

test("只有一条时照常单独请求；不同身份的请求绝不合进同一批", async () => {
  const sent = [];
  const singles = [];
  const get = createBatcher({
    send: async (paths, key) => (sent.push([key, paths]), ndjson(paths.map((_, i) => ({ i, status: 200, body: { key } })))),
    single: async (path, key) => (singles.push([key, path]), json({ key })),
  });

  await get("/api/only", "user");
  assert.deepEqual(singles, [["user", "/api/only"]]);

  const results = await Promise.all([
    get("/api/me", "user tokenA"),
    get("/api/me", "user tokenB"),
    get("/api/stats", "user tokenA"),
    get("/api/health", "public"),
  ]);
  assert.deepEqual(sent, [["user tokenA", ["/api/me", "/api/stats"]]]);
  assert.deepEqual(singles.slice(1).sort(), [["public", "/api/health"], ["user tokenB", "/api/me"]]);
  assert.deepEqual(await results[1].json(), { key: "user tokenB" });
});

test("批量接口不可用（旧后端 404、平台错误页、连不上）时逐条重发", async () => {
  for (const failure of [
    async () => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } }),
    async () => json({ detail: "服务暂时不可用，请稍后重试" }, 503),
    async () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const singles = [];
    const get = createBatcher({ send: failure, single: async (path) => (singles.push(path), json({ path })) });
    const results = await Promise.all([get("/api/a", "user"), get("/api/b", "user")]);
    assert.deepEqual(singles, ["/api/a", "/api/b"]);
    assert.deepEqual(await results[1].json(), { path: "/api/b" });
  }
});

test("整批中途断开：已经拿到的不重发，只重发没拿到的", async () => {
  const stream = ndjsonStream();
  const singles = [];
  const get = createBatcher({ send: async () => stream.response, single: async (path) => (singles.push(path), json({ path })) });
  const a = get("/api/a", "user");
  const b = get("/api/b", "user");
  await tick();
  stream.push({ i: 0, status: 200, body: { from: "batch" } });
  await tick();
  stream.fail();
  assert.deepEqual(await (await a).json(), { from: "batch" });
  assert.deepEqual(await (await b).json(), { path: "/api/b" });
  assert.deepEqual(singles, ["/api/b"]);
});

test("单条超时只让那一条失败；全部都不要了才取消整批", async () => {
  const stream = ndjsonStream();
  let batchSignal;
  const get = createBatcher({
    send: async (_paths, _key, signal) => ((batchSignal = signal), stream.response),
    single: async () => assert.fail(),
  });
  const first = new AbortController();
  const second = new AbortController();
  const a = get("/api/a", "user", first.signal);
  const b = get("/api/b", "user", second.signal);
  await tick();

  first.abort(new DOMException("timed out", "TimeoutError"));
  const error = await a.catch((e) => e);
  assert.equal(error.name, "TimeoutError");
  assert.equal(batchSignal.aborted, false);

  stream.push({ i: 1, status: 200, body: { ok: true } });
  assert.deepEqual(await (await b).json(), { ok: true });

  const third = new AbortController();
  const fourth = new AbortController();
  const stuck = ndjsonStream();
  let stuckSignal;
  const get2 = createBatcher({ send: async (_p, _k, signal) => ((stuckSignal = signal), stuck.response), single: async () => assert.fail() });
  const c = get2("/api/c", "user", third.signal).catch((e) => e.name);
  const d = get2("/api/d", "user", fourth.signal).catch((e) => e.name);
  await tick();
  third.abort();
  fourth.abort();
  assert.deepEqual(await Promise.all([c, d]), ["AbortError", "AbortError"]);
  assert.equal(stuckSignal.aborted, true);
});

test(`超过 ${MAX_BATCH} 条分成几批`, async () => {
  const sizes = [];
  const get = createBatcher({
    send: async (paths) => (sizes.push(paths.length), ndjson(paths.map((path, i) => ({ i, status: 200, body: { path } })))),
    single: async (path) => (sizes.push(1), json({ path })),
  });
  const paths = Array.from({ length: MAX_BATCH * 2 + 1 }, (_, i) => `/api/item/${i}`);
  const results = await Promise.all(paths.map((path) => get(path, "user")));
  assert.deepEqual(sizes, [MAX_BATCH, MAX_BATCH, 1]);
  assert.deepEqual(await results.at(-1).json(), { path: paths.at(-1) });
});

test("合并结果还原成和单独请求一样的 Response：纯文本错误页、204", async () => {
  const page = lineResponse({ i: 0, status: 500, text: "Internal Server Error" });
  assert.equal(page.status, 500);
  assert.equal(await page.text(), "Internal Server Error");
  const empty = lineResponse({ i: 0, status: 204, body: null });
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), "");
});

test("浏览器端：并发的读请求走一次 /api/backend/batch，错误、带对象 detail 的错误、401 换令牌都和单独请求一致", async (t) => {
  const { api, resetToken } = await import("../src/lib/api-client.ts");
  resetToken();
  let issued = 0;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = String(url);
    if (path.endsWith("/api/token")) return json({ token: `tok${++issued}`, expires_in: 900 });
    const auth = init.headers.get("Authorization");
    calls.push([init.method ?? "GET", path, auth]);
    if (path === "/api/backend/batch") {
      const { paths } = JSON.parse(init.body);
      return ndjson(
        paths.map((p, i) =>
          p === "/api/courses/9"
            ? { i, status: 404, body: { detail: "找不到这门课程" } }
            : p === "/api/expired"
              ? { i, status: 401, body: { detail: "访问令牌已过期，请刷新页面" } }
              : p === "/api/broke"
                ? { i, status: 409, body: { detail: { code: "busy", message: "另一项生成正在进行" } } }
                : { i, status: 200, body: { path: p } }
        )
      );
    }
    return json({ path: path.replace("/api/backend/", "/api/"), auth });
  });

  const [me, stats, missing, expired, broke] = await Promise.all([
    api("/api/me"),
    api("/api/stats"),
    api("/api/courses/9").catch((e) => e),
    api("/api/expired"),
    api("/api/broke").catch((e) => e),
  ]);
  assert.deepEqual(me, { path: "/api/me" });
  assert.deepEqual(stats, { path: "/api/stats" });
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "找不到这门课程");
  assert.equal(broke.name, "ApiError");
  assert.equal(broke.status, 409);
  assert.equal(broke.message, "另一项生成正在进行");
  assert.deepEqual(broke.detail, { code: "busy", message: "另一项生成正在进行" });
  // 401 那条换了新令牌单独重发
  assert.deepEqual(expired, { path: "/api/expired", auth: "Bearer tok2" });
  assert.deepEqual(calls.map(([method, path]) => `${method} ${path}`), ["POST /api/backend/batch", "GET /api/backend/expired"]);
  assert.equal(calls[0][2], "Bearer tok1");

  // 读缓存照旧：刚读过的不再发请求
  calls.length = 0;
  assert.deepEqual(await api("/api/stats"), { path: "/api/stats" });
  assert.deepEqual(calls, []);
});

test("浏览器端：带请求头之类额外选项的读请求不合并", async (t) => {
  const { api, resetToken } = await import("../src/lib/api-client.ts");
  resetToken();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/token")) return json({ token: "h", expires_in: 900 });
    calls.push(String(url));
    return json({ ok: true });
  });
  await Promise.all([api("/api/x", { headers: { "X-Test": "1" } }), api("/api/y", { headers: { "X-Test": "1" } })]);
  assert.deepEqual(calls.sort(), ["/api/backend/x", "/api/backend/y"]);
});
