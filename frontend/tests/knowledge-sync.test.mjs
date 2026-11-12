import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "zh" } };
const { ApiError } = await import("../src/lib/api-client.ts");
const { syncKnowledgeMap, mergeSynced, focusRefreshDue, FOCUS_REFRESH_MS } = await import("../src/lib/learn/knowledge.ts");

const chunk = (lesson_id) => ({ lesson_id, part_index: 0, fingerprint: `f${lesson_id}` });
const map = (queue, extra = {}) => ({
  nodes: [], courses: [], read_lessons: 1, pending_count: queue.length, failed_count: 0,
  next_chunk: queue[0] ?? null, queue, ...extra,
});
const source = (course_id, lesson_number) => ({ course_id, course_name: "c", lesson_number, lesson_title: "t", quote: "q" });
const node = (id, ...sources) => ({ id, label: id, summary: "s", domain: "mathematics", sources });
const added = (...nodes) => ({ updated: true, nodes });

function run(first, { syncs, loads }) {
  const synced = [];
  const seen = [];
  const waits = [];
  let loaded = 0;
  const done = syncKnowledgeMap(
    first,
    {
      load: async () => { loaded++; return loads.shift(); },
      sync: async (c) => {
        synced.push(c.lesson_id);
        const outcome = syncs.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome ?? added();
      },
      onMap: (m) => seen.push(m),
      stopped: () => false,
    },
    async (ms) => { waits.push(ms); }
  );
  return { done, synced, seen, waits, loads: () => loaded };
}

test("按队列整理：每块只把新增主题并进地图，整轮结束才重新读一次地图", async () => {
  const r = run(map([chunk(1), chunk(2), chunk(3)]), {
    syncs: [added(node("a", source(1, 1))), added(node("a", source(2, 1)), node("b", source(2, 1))), { updated: false, nodes: [] }],
    loads: [map([])],
  });
  await r.done;
  assert.deepEqual(r.synced, [1, 2, 3]);
  assert.equal(r.loads(), 1);
  assert.deepEqual(r.seen.slice(0, 3).map((m) => [m.nodes.map((n) => n.id), m.pending_count, m.next_chunk?.lesson_id ?? null]),
    [[["a"], 2, 2], [["a", "b"], 1, 3], [["a", "b"], 0, null]]);
  assert.deepEqual(r.seen[1].nodes[0].sources.map((s) => s.course_id), [1, 2]);
});

test("重新读到的地图里有新的待整理分块就接着整理，已经试过的不再试", async () => {
  const r = run(map([chunk(1)]), { syncs: [], loads: [map([chunk(1), chunk(2)]), map([])] });
  await r.done;
  assert.deepEqual(r.synced, [1, 2]);
  assert.equal(r.loads(), 2);
});

test("一块整理失败（502 / 504 / 这块稍后重试的 429）：计入失败数，接着整理下一块，不停下来等用户点重试", async () => {
  for (const status of [502, 504, 429]) {
    const r = run(map([chunk(1), chunk(2)]), {
      syncs: [new ApiError(status, "这部分内容上次整理失败，之后打开地图时会再试"), null],
      loads: [map([], { failed_count: 1, pending_count: 1 })],
    });
    await r.done;
    assert.deepEqual(r.synced, [1, 2], String(status));
    assert.equal(r.seen[0].failed_count, 1);
    assert.deepEqual(r.waits, []);
  }
});

test("后端没记下失败、重读的队列里还是那一块：把错误抛出去（页面显示错误和重试），不原地打转", async () => {
  const failure = new ApiError(502, "模型失败");
  const r = run(map([chunk(1)]), { syncs: [failure], loads: [map([chunk(1)])] });
  await assert.rejects(r.done, (e) => e === failure);
  assert.deepEqual(r.synced, [1]);
});

test("409 冲突：这一轮其余分块照常整理，之后退避 3 秒起逐轮加倍再重读重试；连续 5 轮冲突才报错", async () => {
  const busy = () => new ApiError(409, "知识地图正在更新，请稍后重试");
  const r = run(map([chunk(1), chunk(2)]), { syncs: [busy(), null, null], loads: [map([chunk(1)]), map([])] });
  await r.done;
  assert.deepEqual(r.synced, [1, 2, 1]);
  assert.deepEqual(r.waits, [3000]);

  const stuck = run(map([chunk(1)]), {
    syncs: Array.from({ length: 6 }, busy),
    loads: Array.from({ length: 6 }, () => map([chunk(1)])),
  });
  await assert.rejects(stuck.done, (e) => e instanceof ApiError && e.status === 409);
  assert.deepEqual(stuck.waits, [3000, 6000, 12000, 24000, 48000]);
  assert.equal(stuck.synced.length, 6);
});

test("别的错误直接抛出", async () => {
  const bad = new ApiError(400, "坏请求");
  await assert.rejects(run(map([chunk(1)]), { syncs: [bad], loads: [] }).done, (e) => e === bad);
});

test("页面停下（离开 / 换账号）后不再整理、不再更新地图", async () => {
  let stopped = false;
  const synced = [];
  const seen = [];
  await syncKnowledgeMap(map([chunk(1), chunk(2)]), {
    load: async () => assert.fail("停下后不应再读地图"),
    sync: async (c) => { synced.push(c.lesson_id); stopped = true; return added(); },
    onMap: (m) => seen.push(m),
    stopped: () => stopped,
  });
  assert.deepEqual(synced, [1]);
  assert.deepEqual(seen, []);
});

test("合并新增主题：同一课程同一篇只记一次来源", () => {
  const before = map([chunk(1)], { nodes: [node("a", source(1, 1))] });
  const after = mergeSynced(before, chunk(1), added(node("a", source(1, 1), source(1, 2))));
  assert.deepEqual(after.nodes[0].sources.map((s) => s.lesson_number), [1, 2]);
  assert.equal(after.pending_count, 0);
  assert.deepEqual(after.queue, []);
});

test("切回窗口：距上次读完地图不到一分钟、或正在更新时不重新读", async () => {
  assert.equal(FOCUS_REFRESH_MS, 60_000);
  assert.equal(focusRefreshDue(1_000, 60_999), false);
  assert.equal(focusRefreshDue(1_000, 61_000), true);
  const page = await readFile(new URL("../src/components/learn/knowledge-map.tsx", import.meta.url), "utf8");
  assert.match(page, /const onFocus = \(\) => \{ if \(!run\.current && focusRefreshDue\(lastRead\)\) void read\(\); \};/);
  assert.match(page, /window\.addEventListener\("focus", onFocus\)/);
});

test("进地图页只读，不调模型：整理课文和定位都只在点「更新地图」时跑", async () => {
  const page = await readFile(new URL("../src/components/learn/knowledge-map.tsx", import.meta.url), "utf8");
  const [onLoad, onClick] = page.split("const update = async () => {");
  assert.ok(onClick, "页面里要有「更新地图」的处理函数");
  for (const call of ["syncKnowledgeMap(", "syncKnowledgeChunk(", "placeCourses(", "stepCoordinate("]) {
    assert.ok(!onLoad.includes(call), `进页面就会调 ${call}`);
    assert.ok(onClick.includes(call), `更新地图没有调 ${call}`);
  }
  assert.match(page, /onClick=\{\(\) => void update\(\)\}/);
});
