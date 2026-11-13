import assert from "node:assert/strict";
import { test } from "node:test";

import { clampView, FIT_VIEW, fitSize, zoomView } from "../src/lib/learn/image-zoom.ts";

const viewport = { width: 1280, height: 900 };

test("放大后铺满屏幕：大图缩小，窄图放大，保持比例，小图最多放大 3 倍", () => {
  assert.deepEqual(fitSize({ width: 2496, height: 868 }, viewport), { width: 1248, height: 434 });
  const narrow = fitSize({ width: 640, height: 480 }, viewport);
  assert.equal(narrow.height, 868);
  assert.ok(Math.abs(narrow.width / narrow.height - 640 / 480) < 1e-9);
  assert.deepEqual(fitSize({ width: 100, height: 50 }, viewport), { width: 300, height: 150 });
});

test("滚轮向上放大、向下缩小，范围在 1 到 8 倍之间", () => {
  const center = { x: 0, y: 0 };
  assert.ok(zoomView(FIT_VIEW, -100, center).scale > 1);
  assert.equal(zoomView(FIT_VIEW, 100, center).scale, 1);
  assert.equal(zoomView(FIT_VIEW, -100000, center).scale, 8);
});

test("滚轮缩放时鼠标指着的点留在原地", () => {
  const anchor = { x: 200, y: -100 };
  const before = { scale: 2, x: 30, y: 40 };
  const after = zoomView(before, -300, anchor);
  const imagePoint = (view) => ({ x: (anchor.x - view.x) / view.scale, y: (anchor.y - view.y) / view.scale });
  assert.ok(Math.abs(imagePoint(before).x - imagePoint(after).x) < 1e-9);
  assert.ok(Math.abs(imagePoint(before).y - imagePoint(after).y) < 1e-9);
});

test("图比屏幕大才能移动，不能移出边界，缩回原大小回到正中", () => {
  const image = { width: 1000, height: 500 };
  const fit = clampView({ scale: 1, x: 300, y: -200 }, image, viewport);
  assert.ok(fit.x === 0 && fit.y === 0);
  assert.deepEqual(clampView({ scale: 2, x: 9999, y: -9999 }, image, viewport), { scale: 2, x: 360, y: -50 });
});
