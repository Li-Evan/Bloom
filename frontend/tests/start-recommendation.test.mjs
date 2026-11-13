import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startRecommendationCourse } from "../src/lib/learn/start-recommendation.ts";

const item = { id: 11 };

function deps({ createFails = false, linkFails = false } = {}) {
  const calls = [];
  return {
    calls,
    started: new Set(),
    create: async () => {
      calls.push("create");
      if (createFails) throw new Error("创建失败");
      return { id: 100 };
    },
    link: async (recommendationId, courseId) => {
      calls.push(`link ${recommendationId} ${courseId}`);
      if (linkFails) throw new Error("标记失败");
    },
  };
}

test("建课成功、链接失败：不抛错，返回已建好的课程和链接错误", async () => {
  const d = deps({ linkFails: true });
  const result = await startRecommendationCourse({ item, ...d });
  assert.deepEqual(result.course, { id: 100 });
  assert.equal(result.linkError.message, "标记失败");
  assert.deepEqual(d.calls, ["create", "link 11 100"]);
});

test("链接失败后再对同一条推荐触发（没有刷新页面）：不会再建一门课", async () => {
  const d = deps({ linkFails: true });
  await startRecommendationCourse({ item, ...d });
  const again = await startRecommendationCourse({ item, ...d });
  assert.equal(again, null);
  assert.equal(d.calls.filter((c) => c === "create").length, 1);
});

test("建课成功且链接成功后，同一条推荐也不会再建", async () => {
  const d = deps();
  assert.deepEqual((await startRecommendationCourse({ item, ...d })).course, {
    id: 100,
  });
  assert.equal(await startRecommendationCourse({ item, ...d }), null);
  assert.equal(d.calls.filter((c) => c === "create").length, 1);
});

test("建课本身失败：错误照常抛出，之后可以再试", async () => {
  const failing = deps({ createFails: true });
  await assert.rejects(
    startRecommendationCourse({ item, ...failing }),
    /创建失败/
  );
  assert.deepEqual(failing.calls, ["create"]);
  assert.equal(failing.started.size, 0);

  const ok = deps();
  ok.started = failing.started;
  assert.deepEqual((await startRecommendationCourse({ item, ...ok })).course, {
    id: 100,
  });
});

test("别的推荐不受影响", async () => {
  const d = deps({ linkFails: true });
  await startRecommendationCourse({ item, ...d });
  const other = await startRecommendationCourse({ item: { id: 12 }, ...d });
  assert.deepEqual(other.course, { id: 100 });
  assert.equal(d.calls.filter((c) => c === "create").length, 2);
});

test("「下一步学习」页的 handleStartRecommendation 经 startRecommendationCourse，链接失败时不再回到可重复创建的状态", async () => {
  const source = await readFile(
    new URL("../src/components/learn/next.tsx", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("const handleStartRecommendation");
  const body = source.slice(start, source.indexOf("\n  };", start));
  assert.match(body, /startRecommendationCourse\(/);
  assert.doesNotMatch(
    body,
    /\bstartRecommendation\(/,
    "不该再直接调 startRecommendation"
  );
});
