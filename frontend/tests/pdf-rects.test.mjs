import assert from "node:assert/strict";
import { test } from "node:test";
import { PDF_MAX_RECTS, nearestTextBox, normalizePdfRects, pdfTextLines, snapPdfRects } from "../src/lib/learn/pdf-rects.ts";

const r = (page, x, y, w, h) => ({ page, x, y, w, h });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);

test("同一行的碎矩形（含 span 与文字节点的重复矩形）并成一个，换行、换页、隔栏的分开", () => {
  const rects = normalizePdfRects([
    r(1, 0.1, 0.2, 0.1, 0.02),
    r(1, 0.1, 0.2, 0.1, 0.02),
    r(1, 0.2, 0.201, 0.15, 0.02),
    r(1, 0.6, 0.2, 0.2, 0.02),
    r(1, 0.1, 0.23, 0.3, 0.02),
    r(2, 0.1, 0.05, 0.2, 0.02),
  ]);
  assert.equal(rects.length, 4);
  assert.deepEqual(rects.map((x) => x.page), [1, 1, 1, 2]);
  assert.ok(Math.abs(rects[0].x + rects[0].w - 0.35) < 1e-9);
});

test("越出页面的坐标夹回 [0, 1]，零宽高的丢掉，数量不超过后端上限", () => {
  const [clamped] = normalizePdfRects([r(1, -0.05, 0.98, 0.2, 0.05), r(1, 0.5, 0.5, 0, 0.02)]);
  assert.deepEqual([clamped.x, clamped.y], [0, 0.98]);
  assert.ok(clamped.y + clamped.h <= 1 && clamped.x + clamped.w <= 1);
  const many = Array.from({ length: 5000 }, (_, i) => r(1 + Math.floor(i / 40), 0.1 + Math.PI / 1e4, (i % 40) * 0.025 + Math.E / 1e5, 0.5 + Math.SQRT2 / 1e4, 0.01));
  const out = normalizePdfRects(many);
  assert.equal(out.length, PDF_MAX_RECTS);
  assert.ok(out.every((x) => [x.x, x.y, x.w, x.h].every((v) => v >= 0 && v <= 1)));
  // 后端：pdf_position 序列化后不超过 400000 字
  assert.ok(JSON.stringify({ page: out[0].page, rects: out }).length <= 400000);
});

// 100×100 的页、缩放 1：PDF 坐标 y 朝上，视口 y 朝下
const viewport = (rotation = 0) => ({ width: 100, height: 100, rotation, convertToViewportPoint: (x, y) => [x, 100 - y] });
const item = (str, x, baseline, width, size = 2, transform = [size, 0, 0, size, x, baseline]) => ({ str, width, height: size, transform });
// 字高 2，行距 2.4：第一行基线 80，两栏（10–52 一段，中间空 3，55–90 另一段）；第二行基线 77.6，只有左栏 10–40
const items = [
  item("Hello world", 10, 80, 40),
  item(",", 50.5, 80, 1.5),
  item("second column", 55, 80, 35),
  item("next line", 10, 77.6, 30),
  { type: "beginMarkedContent", id: "mc0" },
  item("   ", 60, 77.6, 5),
  item("rotated", 95, 20, 30, 2, [0, 2, -2, 0, 95, 20]),
];
const lines = pdfTextLines(items, viewport());

test("按 PDF 文字几何分行：每行只记有字的几段，隔栏的分开；空白、标记、斜排的字不算，旋转过的页不算", () => {
  assert.equal(lines.length, 2);
  const [first, second] = lines;
  // 字框：基线往上 0.85、往下 0.22 个字高
  near(first.y0, (100 - 80 - 1.7) / 100);
  near(first.y1, (100 - 80 + 0.44) / 100);
  assert.ok(first.y1 <= second.y0, "上下两行的字框不重叠");
  assert.deepEqual(first.segments.map((s) => [s.x0, s.x1].map((v) => Math.round(v * 100) / 100)), [[0.1, 0.52], [0.55, 0.9]]);
  assert.deepEqual(second.segments.map((s) => [s.x0, s.x1].map((v) => Math.round(v * 100) / 100)), [[0.1, 0.4]]);
  assert.deepEqual(pdfTextLines(items, viewport(90)), []);
});

test("高亮框收到字上：行尾空白和栏间空白不画，偏高的旧框只落在一行，没有行信息或附近没字的照原样", () => {
  const linesOf = (page) => (page === 1 ? lines : undefined);
  const [first, second] = lines;

  // 早先文字层偏宽时存下的框：第二行从 0.2 一直伸到 0.7（字只到 0.4）
  const [trimmed] = snapPdfRects([r(1, 0.2, second.y0, 0.5, 0.03)], linesOf);
  near(trimmed.x, 0.2);
  near(trimmed.x + trimmed.w, 0.4);
  near(trimmed.y, second.y0);
  near(trimmed.h, second.y1 - second.y0);

  // 偏高的框盖住第一行、又压到第二行一半多：只算第一行
  const tall = snapPdfRects([r(1, 0.1, first.y0, 0.2, (second.y0 + second.y1) / 2 + 0.001 - first.y0)], linesOf);
  assert.equal(tall.length, 1);
  near(tall[0].y, first.y0);

  // 跨两栏的框：拆成两段，中间的空白不画
  const cols = snapPdfRects([r(1, 0.3, first.y0, 0.4, first.y1 - first.y0)], linesOf);
  assert.deepEqual(cols.map((c) => [c.x, c.x + c.w].map((v) => Math.round(v * 100) / 100)), [[0.3, 0.52], [0.55, 0.7]]);

  const away = r(1, 0.1, 0.5, 0.3, 0.02);
  assert.deepEqual(snapPdfRects([away], linesOf), [away]);
  const unknown = r(2, 0.1, 0.18, 0.8, 0.03);
  assert.deepEqual(snapPdfRects([unknown], linesOf), [unknown]);
});

// 双栏的一页（像素坐标）：字高 12、行距 13。左栏 100–400，右栏 430–730，右栏比左栏低 5px（两栏的行对不齐）。
// 左栏第 3 行是段落末行，只到 220；隔 8px 是下一段，它的第 1 行拆成两段字
const box = (name, x0, x1, y0) => ({ name, x0, x1, y0, y1: y0 + 12 });
const columns = [
  box("左1", 100, 400, 100), box("左2", 100, 400, 113), box("左3短", 100, 220, 126),
  box("左4前", 100, 250, 146), box("左4后", 252, 400, 146), box("左5", 100, 400, 159),
  ...[105, 118, 131, 144, 157].map((y0, i) => box(`右${i + 1}`, 430, 730, y0)),
];
const pick = (x, y) => nearestTextBox(columns, 12, x, y)?.name;

test("从空白处起拖时选区从哪段字开始：鼠标所在那一行（同一栏）里最近的，不在任何一行上就是最近的字，不跳栏", () => {
  // 左页边、行尾右边的空白：鼠标所在的那一行
  assert.equal(pick(75, 119), "左2");
  assert.equal(pick(410, 119), "左2");
  // 段落末行右边的空白，上一行的字离得更近（正上方 7px），还是这一行
  assert.equal(pick(320, 132), "左3短");
  // 两行之间 1px 的缝：挨着的那一行。右栏正好有一行和鼠标一样高，不跳过去
  assert.equal(pick(250, 112.3), "左1");
  assert.equal(pick(250, 112.8), "左2");
  // 两段之间的空白，同上；最近的那一行里取左右最近的一段字
  assert.equal(pick(380, 142), "左4后");
  assert.ok(["左3短", "左4前"].includes(pick(75, 142)));
  // 两栏中间：哪一栏近算哪一栏
  assert.equal(pick(410, 150), "左4后");
  assert.equal(pick(424, 150), "右4");
  // 鼠标就在字上（上面盖着高亮时会走到这里）
  assert.equal(pick(300, 150), "左4后");
  assert.equal(nearestTextBox([], 12, 0, 0), undefined);
});
