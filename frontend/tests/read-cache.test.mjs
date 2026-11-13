import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadCache, readTtl } from "../src/lib/read-cache.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("重复读取合并请求，回访复用独立的数据副本", async () => {
  const cache = createReadCache(); const wait = deferred(); let calls = 0;
  const load = () => { calls++; return wait.promise; };
  const first = cache.read("lesson", 30000, load);
  const second = cache.read("lesson", 30000, load);
  wait.resolve({ title: "原课文" });
  const a = await first; a.title = "本地修改";
  assert.equal((await second).title, "原课文");
  assert.equal((await cache.read("lesson", 30000, load)).title, "原课文");
  assert.equal(calls, 1);
});

test("换身份或写入后，迟到的旧读取不能重新填充缓存", async () => {
  const cache = createReadCache(); const old = deferred();
  const first = cache.read("course", 30000, () => old.promise);
  cache.clear();
  await cache.read("course", 30000, async () => ({ owner: "new" }));
  old.resolve({ owner: "old" }); await first;
  assert.deepEqual(await cache.read("course", 30000, async () => assert.fail("must use new cache")), { owner: "new" });
});

test("记录打开事件只刷新统计，不丢弃正在读取的课文", async () => {
  const cache = createReadCache(); const lesson = deferred();
  const first = cache.read("lesson", 30000, () => lesson.promise);
  await cache.read("stats", 30000, async () => 1);
  cache.clear(key => key === "stats");
  lesson.resolve("正文"); await first;
  assert.equal(await cache.read("lesson", 30000, async () => assert.fail("unrelated read invalidated")), "正文");
  assert.equal(await cache.read("stats", 30000, async () => 2), 2);
});

test("失败不会被缓存，零TTL数据始终重新读取", async () => {
  const cache = createReadCache(); let calls = 0;
  await assert.rejects(cache.read("failed", 30000, async () => { throw new Error("offline"); }));
  assert.equal(await cache.read("failed", 30000, async () => "recovered"), "recovered");
  assert.equal(await cache.read("uncached", 0, async () => ++calls), 1);
  assert.equal(await cache.read("uncached", 0, async () => ++calls), 2);
  assert.equal(readTtl("/api/health"), 0);
  assert.equal(readTtl("/api/knowledge-map"), 0);
});

test("到期或内存预算耗尽会重新读取", async t => {
  let now = 100; t.mock.method(Date, "now", () => now);
  const cache = createReadCache(50); let calls = 0;
  await cache.read("short", 10, async () => ++calls);
  now = 111;
  assert.equal(await cache.read("short", 10, async () => ++calls), 2);
  await cache.read("huge", 30000, async () => "x".repeat(40));
  assert.equal(await cache.read("huge", 30000, async () => "fresh"), "fresh");
});

test("只缓存稳定阅读数据，批注和反馈读取保持最新", () => {
  assert.equal(readTtl("/api/courses"), 30000);
  assert.equal(readTtl("/api/courses/5"), 30000);
  assert.equal(readTtl("/api/courses/5/lessons"), 30000);
  assert.equal(readTtl("/api/courses/5/lessons/2"), 120000);
  for (const suffix of ["annotations", "feedback", "highlights"]) {
    assert.equal(readTtl(`/api/courses/5/lessons/2/${suffix}`), 0);
  }
});
