import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "zh" } };
const { ApiError } = await import("../src/lib/api-client.ts");
const { advanceCoordinate, BUSY_ROUNDS, findingDirections, placing } = await import("../src/lib/learn/coordinate.ts");

const card = (needs, extra = {}) => ({
  state: needs.includes("anchor") ? "pending" : "placed", needs, retry_after: null, here: null, band: [], connect: null,
  next_item: null, covered: [], directions: [], can_save: true, ...extra,
});

function run(first, { steps, loads = [] }) {
  const seen = [];
  const waits = [];
  let stepped = 0;
  const done = advanceCoordinate(
    first,
    {
      step: async () => {
        stepped++;
        const next = steps.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      load: async () => loads.shift(),
      onCard: (c) => seen.push(c.needs.join() || "-"),
      stopped: () => false,
    },
    async (ms) => { waits.push(ms); },
  );
  return { done, seen, waits, stepped: () => stepped };
}

test("一步一步跑完：落点先出来，再是相邻方向", async () => {
  const r = run(card(["anchor", "directions"]), {
    steps: [card(["directions"]), card([])],
  });
  const last = await r.done;
  assert.deepEqual(r.seen, ["directions", "-"]);
  assert.deepEqual(last.needs, []);
});

test("别的窗口正在算同一步（409）：等 5 秒重读卡片再接着走", async () => {
  const r = run(card(["anchor"]), {
    steps: [new ApiError(409, "busy"), card([])],
    loads: [card(["anchor"])],
  });
  await r.done;
  assert.deepEqual(r.waits, [5000]);
  assert.deepEqual(r.seen, ["anchor", "-"]);
});

test("一直忙就在几轮之后报错，不无限等", async () => {
  const busy = () => new ApiError(409, "busy");
  const r = run(card(["anchor"]), {
    steps: Array.from({ length: BUSY_ROUNDS + 1 }, busy),
    loads: Array.from({ length: BUSY_ROUNDS }, () => card(["anchor"])),
  });
  await assert.rejects(r.done, (err) => err.status === 409);
  assert.equal(r.waits.length, BUSY_ROUNDS);
});

test("上次失败还在退避就不调，模型出错原样抛出", async () => {
  const waiting = run(card(["anchor"], { state: "failed", retry_after: 120 }), { steps: [] });
  await waiting.done;
  assert.equal(waiting.stepped(), 0);
  const broken = run(card(["anchor"]), { steps: [new ApiError(502, "模型出错")] });
  await assert.rejects(broken.done, (err) => err.status === 502);
});

test("没有进展就停下，不空转", async () => {
  const r = run(card(["directions"]), { steps: [card(["directions"])] });
  await r.done;
  assert.equal(r.stepped(), 1);
});

test("等待提示只在真的要等时出现", () => {
  assert.equal(placing(card(["anchor"])), true);
  assert.equal(placing(card(["anchor"], { state: "failed", retry_after: 30 })), false);
  assert.equal(findingDirections(card(["directions"])), true);
  assert.equal(findingDirections(card([])), false);
});

test("坐标作业不清读缓存；卡片随课程一起走批量读取，不带额外参数", async () => {
  const client = await readFile(new URL("../src/lib/api-client.ts", import.meta.url), "utf8");
  assert.match(client, /courses\\\/\\d\+\\\/coordinate\\\/step/);
  const lib = await readFile(new URL("../src/lib/learn/coordinate.ts", import.meta.url), "utf8");
  assert.match(lib, /api<CoordinateCard>\(`\/api\/courses\/\$\{courseId\}\/coordinate\?locale=\$\{locale\}`\)/);
  const page = await readFile(new URL("../src/components/learn/course.tsx", import.meta.url), "utf8");
  // 手机和桌面各放一份卡片，数据只取一次
  assert.equal(page.match(/useCoordinate\(/g).length, 1);
  assert.equal(page.match(/<CoordinateCard /g).length, 2);
});
