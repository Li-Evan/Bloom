import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "zh" } };

const { api } = await import("../src/lib/api-client.ts");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("401 重试：并发时不丢掉别的请求刚换好的新令牌", async (t) => {
  let issued = 0;
  const used = [];
  const revoked = new Set();
  let releaseB;
  const bGate = new Promise((resolve) => (releaseB = resolve));

  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/token")) {
      const token = `t${++issued}`;
      return json({ token, expires_at: Date.now() / 1000 + 900 });
    }
    const token = init.headers.get("Authorization").replace("Bearer ", "");
    used.push([String(url).split("/").pop(), token]);
    if (revoked.has(token)) {
      if (String(url).endsWith("/b")) await bGate;
      return json({ detail: "未登录" }, 401);
    }
    return json({ ok: true, token });
  });

  assert.equal((await api("/api/a")).token, "t1");
  revoked.add("t1");

  // A 先失败并换到 t2；B 的 401 在 A 完成之后才到达
  const a = api("/api/a2");
  const b = api("/api/b");
  assert.equal((await a).token, "t2");
  releaseB();
  assert.equal((await b).token, "t2");
  assert.equal(issued, 2, "B 不应再取第三个令牌");
});

test("401 重试：仍然 401 就抛出后端 detail，只重试一次", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/token")) {
      return json({ token: "x", expires_at: Date.now() / 1000 + 900 });
    }
    calls++;
    return json({ detail: "未登录" }, 401);
  });
  // 模块里已缓存令牌，直接请求
  const error = await api("/api/me").catch((e) => e);
  assert.equal(error.status, 401);
  assert.equal(error.message, "未登录");
  assert.equal(calls, 2);
});

test("后端连不上：中文页面给中文说明，且不重试", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/token")) {
      return json({ token: "y", expires_at: Date.now() / 1000 + 900 });
    }
    calls++;
    throw new TypeError("fetch failed");
  });
  const error = await api("/api/me").catch((e) => e);
  assert.equal(error.name, "BackendUnreachableError");
  assert.equal(error.message, "无法连接后端服务（原因：fetch failed）");
  assert.equal(calls, 1);
});

test("换账号：resetToken 之后的第一个请求必须重新取令牌", async (t) => {
  const { resetToken } = await import("../src/lib/api-client.ts");
  let issued = 0;
  const used = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/token")) {
      return json({ token: `acct${++issued}`, expires_at: Date.now() / 1000 + 900 });
    }
    used.push(init.headers.get("Authorization"));
    return json({ ok: true });
  });

  resetToken();
  await api("/api/a");
  await api("/api/b");
  assert.equal(issued, 1, "同一个账号内令牌被复用");

  resetToken();
  await api("/api/c");
  assert.equal(issued, 2);
  assert.deepEqual(used, ["Bearer acct1", "Bearer acct1", "Bearer acct2"]);
});

test("换账号：reset 之前发出、之后才返回的旧令牌不会被缓存", async (t) => {
  const { resetToken } = await import("../src/lib/api-client.ts");
  let issued = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => (releaseFirst = resolve));
  const used = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/token")) {
      const n = ++issued;
      if (n === 1) await firstGate;
      return json({ token: `acct${n}`, expires_at: Date.now() / 1000 + 900 });
    }
    used.push(init.headers.get("Authorization"));
    return json({ ok: true });
  });

  resetToken();
  const inFlight = api("/api/old");
  await new Promise((resolve) => setImmediate(resolve));
  resetToken();
  releaseFirst();
  await inFlight;

  await api("/api/new");
  assert.equal(issued, 2, "旧账号迟到的令牌不能顶替新账号的");
  assert.equal(used.at(-1), "Bearer acct2");
});

test("no-store 读到的最新结果写回缓存：之后的普通读取直接用它，不再拿到更旧的那份", async (t) => {
  let version = 0;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/token")) return json({ token: "c", expires_at: Date.now() / 1000 + 900 });
    reads++;
    return json([{ id: ++version }]);
  });
  assert.deepEqual(await api("/api/courses"), [{ id: 1 }]);
  assert.deepEqual(await api("/api/courses", { cache: "no-store" }), [{ id: 2 }]);
  assert.deepEqual(await api("/api/courses"), [{ id: 2 }]);
  assert.equal(reads, 2);
});

test("上传分片、目标澄清、知识地图同步不清空读缓存；真正的写请求照常清", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/token")) return json({ token: "d", expires_at: Date.now() / 1000 + 900 });
    if (String(url).endsWith("/backend/stats")) reads++;
    return json({ ok: true });
  });
  await api("/api/stats");
  await api("/api/uploads/abc/files/0/parts/0", { method: "PUT", body: "x" });
  await api("/api/uploads", { method: "POST", json: { files: [] } });
  await api("/api/courses/clarify", { method: "POST", json: {} });
  await api("/api/knowledge-map/sync", { method: "POST", json: {} });
  await api("/api/stats");
  assert.equal(reads, 1);
  await api("/api/courses/1/lessons/2/feedback", { method: "POST", json: {} });
  await api("/api/stats");
  assert.equal(reads, 2);
});

test("令牌按本机经过的时间换：本机时钟比服务端快一小时，也不会每个请求都重新取令牌", async (t) => {
  const { resetToken } = await import("../src/lib/api-client.ts");
  const serverNow = Date.now();
  let localNow = serverNow + 3600_000;
  t.mock.method(Date, "now", () => localNow);
  let issued = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/token")) {
      return json({ token: `fast${++issued}`, expires_at: serverNow / 1000 + 900, expires_in: 900 });
    }
    return json({ ok: true });
  });
  resetToken();
  await api("/api/fast-a");
  localNow += 60_000;
  await api("/api/fast-b");
  assert.equal(issued, 1);
});

test("令牌按本机经过的时间换：本机时钟比服务端慢两小时，有效期一过照样换新令牌，不一直用过期的", async (t) => {
  const { resetToken } = await import("../src/lib/api-client.ts");
  const serverNow = Date.now();
  let localNow = serverNow - 7200_000;
  t.mock.method(Date, "now", () => localNow);
  let issued = 0;
  const used = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/token")) {
      return json({ token: `slow${++issued}`, expires_at: serverNow / 1000 + 900, expires_in: 900 });
    }
    used.push(init.headers.get("Authorization"));
    return json({ ok: true });
  });
  resetToken();
  await api("/api/slow-a");
  localNow += 869_000;
  await api("/api/slow-b");
  localNow += 2_000;
  await api("/api/slow-c");
  assert.deepEqual(used, ["Bearer slow1", "Bearer slow1", "Bearer slow2"]);
});
