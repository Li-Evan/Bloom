import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "zh" } };
const { ApiError } = await import("../src/lib/api-client.ts");
const { coordinateTree, matchesCourse, placeCourses } = await import("../src/lib/learn/coordinate-map.ts");

const band = [
  { node_id: "life", label: "日常生活", placed: 0, courses: 0 },
  { node_id: "society", label: "社会与社会科学", placed: 3, courses: 2 },
];
const n = (node_id, label) => ({ node_id, label });
const course = (course_id, name, path, here, extra = {}) => ({
  course_id, name, state: "placed", read: true, learned: "encountered", area: "society", path, also: [], directions: [],
  retry_after: null, here: { node_id: here[0], place: here[0], label: here[1], level: "article" }, ...extra,
});
const POLITICS = n("politics", "政治与经济");
const salary = course(1, "怎么谈工资", [POLITICS, n("law", "法律"), n("basics", "法律基础")], ["negotiation", "谈判"]);
const fund = course(2, "公积金", [POLITICS, n("business-econ", "商业与经济"), n("business", "商业")], ["fund", "住房公积金"]);
const interview = course(3, "面试准备", [POLITICS, n("business-econ", "商业与经济"), n("business", "商业")], ["interview", "面试"]);

test("按顶层分区，课挂在树上的位置；只有一条路往下的中间各级并成一行，在课程分开的地方分叉", () => {
  const [area, ...rest] = coordinateTree({ band, courses: [salary, fund, interview] });
  assert.equal(rest.length, 0);  // 没课的顶层不列
  assert.equal(area.area.label, "社会与社会科学");
  assert.equal(area.count, 3);
  const [politics] = area.nodes;
  assert.deepEqual([politics.label, politics.trail, politics.count], ["政治与经济", [], 3]);  // 三门课在这里相连
  const [law, business] = politics.children;
  assert.deepEqual([law.trail, law.label, law.courses.map((c) => c.name)], [["法律", "法律基础"], "谈判", ["怎么谈工资"]]);
  assert.deepEqual([business.trail, business.label, business.count], [["商业与经济"], "商业", 2]);
  assert.deepEqual(business.children.map((c) => [c.label, c.courses.map((x) => x.name)]), [["住房公积金", ["公积金"]], ["面试", ["面试准备"]]]);
});

test("两门课落在同一个节点：同一行下两门课；只有一门课的分区整条路径并成一行", () => {
  const twin = course(4, "谈判入门", salary.path, ["negotiation", "谈判"]);
  const [area] = coordinateTree({ band, courses: [salary, twin] });
  assert.equal(area.nodes.length, 1);
  const [only] = area.nodes;
  assert.deepEqual([only.trail, only.label, only.courses.map((c) => c.name)], [["政治与经济", "法律", "法律基础"], "谈判", ["怎么谈工资", "谈判入门"]]);
});

test("没定位的课不进树；落点显示成上级时按显示的节点归位", () => {
  const pending = { ...course(5, "还没定位", [], ["x", "x"]), state: "pending", here: null, area: null };
  const deep = course(6, "雇佣法", [POLITICS, n("business-econ", "商业与经济")], ["employment-unnamed", "商业"], {});
  deep.here.place = "business";
  const [area] = coordinateTree({ band, courses: [pending, fund, deep] });
  const business = area.nodes[0];
  assert.deepEqual([business.trail, business.label, business.courses.map((c) => c.name)], [["政治与经济", "商业与经济"], "商业", ["雇佣法"]]);
  assert.deepEqual(business.children.map((c) => c.label), ["住房公积金"]);
});

test("搜索看课名、落点、上级名字和已学主题", () => {
  assert.ok(matchesCourse(salary, "谈判"));
  assert.ok(matchesCourse(salary, "法律基础"));
  assert.ok(matchesCourse(salary, "batna", ["BATNA 的用法"]));
  assert.ok(!matchesCourse(salary, "相对论"));
  assert.ok(matchesCourse(salary, "  "));
});

function run(needs, { steps, loads }) {
  const seen = [];
  const placing = [];
  const done = placeCourses({ band, courses: [], needs }, {
    step: async (id) => { const r = steps.shift(); if (r instanceof Error) throw r; return r; },
    load: async () => loads.shift(),
    onOverview: (o) => seen.push(o.needs.join() || "-"),
    onPlacing: (id) => placing.push(id),
    stopped: () => false,
  });
  return { done, seen, placing };
}
const ov = (needs) => ({ band, courses: [], needs });

test("逐门定位，每定位完一门重读一次总览", async () => {
  const r = run([1, 2], { steps: [{}, {}], loads: [ov([2]), ov([])] });
  await r.done;
  assert.deepEqual(r.seen, ["2", "-"]);
  assert.deepEqual(r.placing, [1, 2, null]);
});

test("别的窗口在定位（409）跳过；次数用完（429）停下；模型出错接着下一门，最后再读一次", async () => {
  const busy = run([1, 2], { steps: [new ApiError(409, "busy"), {}], loads: [ov([])] });
  await busy.done;
  assert.deepEqual(busy.seen, ["-"]);
  const limited = run([1, 2], { steps: [new ApiError(429, "limit")], loads: [] });
  await limited.done;
  assert.deepEqual(limited.seen, []);
  const broken = run([1, 2], { steps: [new ApiError(502, "down"), new ApiError(504, "slow")], loads: [ov([])] });
  await broken.done;
  assert.deepEqual(broken.seen, ["-"]);
});

test("地图页走坐标总览：总览随页面批量读取，定位只跑落点这一步", async () => {
  const lib = await readFile(new URL("../src/lib/learn/coordinate-map.ts", import.meta.url), "utf8");
  assert.match(lib, /api<CoordinateOverview>\(`\/api\/knowledge-map\/coordinate\?locale=\$\{locale\}`, \{ signal \}\)/);
  const page = await readFile(new URL("../src/components/learn/knowledge-map.tsx", import.meta.url), "utf8");
  assert.match(page, /coordinateTree\(/);
  assert.match(page, /placeCourses\(/);
  assert.doesNotMatch(page, /knowledgeLayout|connectionPath/);
});
