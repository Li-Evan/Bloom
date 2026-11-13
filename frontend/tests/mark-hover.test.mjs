import assert from "node:assert/strict";
import { test } from "node:test";
import { markBadgeAt, markedLineAt } from "../src/lib/learn/highlight.ts";

const line = (left, top, right, bottom) => ({ left, top, right, bottom });

test("指针落在哪条标记的哪一行：多行标记每一行都算命中，空白处不算", () => {
  const marks = [
    { id: 7, lines: [line(100, 200, 300, 224), line(100, 224, 260, 248)] },
    { id: 9, lines: [line(100, 300, 400, 324)] },
  ];
  assert.deepEqual(markedLineAt(marks, 280, 210), { id: 7, line: marks[0].lines[0] });
  assert.deepEqual(markedLineAt(marks, 150, 240), { id: 7, line: marks[0].lines[1] });
  // 上一行只到 260，指针落在 260–300 之间、又在下一行的高度里：哪里都不是
  assert.deepEqual(markedLineAt(marks, 399, 320), { id: 9, line: marks[1].lines[0] });
  assert.equal(markedLineAt(marks, 280, 240), null);
  assert.equal(markedLineAt(marks, 50, 210), null);
  assert.equal(markedLineAt([], 100, 200), null);
});

test("按钮贴在那一行末尾外侧、纵向压在行中间", () => {
  const article = { left: 80, top: 100, width: 900 };
  // 行：视口坐标 (700, 300) – (900, 324)，正文从 80 开始、宽 900（先装得下 gap）
  assert.deepEqual(markBadgeAt(line(700, 300, 900, 324), article, 24, 2), { left: 822, top: 200 });
});

test("正文排到很右边时按钮收进正文里，不留负坐标", () => {
  const article = { left: 80, top: 100, width: 800 };
  // 行尾几乎贴着正文右缘：再加 gap 就出去了，收回 width - size
  assert.deepEqual(markBadgeAt(line(80, 100, 875, 124), article, 24, 2), { left: 776, top: 0 });
  // 正文比按钮还窄：不能出现负数
  assert.deepEqual(markBadgeAt(line(0, 0, 10, 10), { left: 0, top: 0, width: 12 }, 24, 2), { left: 0, top: 0 });
});

test("同一行被加粗、链接拆成几段时并成一段，按钮贴在这一行标记的末尾", async () => {
  const { markLines } = await import("../src/lib/learn/highlight.ts");
  // 第一行三段（普通字、<strong> 的外框和它里面的字、普通字），第二行一段；还有一个零宽的换行点
  const rects = [
    line(320, 448, 482, 468),
    line(482, 446, 666, 470), // <strong> 外框：比里面的字高，去掉，留里面的字
    line(482, 448, 666, 468),
    line(666, 448, 742, 468),
    line(742, 448, 742, 468),
    line(96, 479, 140, 499),
  ];
  assert.deepEqual(markLines(rects), [line(320, 448, 742, 468), line(96, 479, 140, 499)]);
  // 外框和字一样高（链接）：两个都留着，并进同一行
  assert.deepEqual(markLines([line(320, 448, 400, 468), line(400, 448, 480, 468), line(400, 448, 480, 468)]), [line(320, 448, 480, 468)]);
});

test("整段落在标记里的段落外框不算一行：按字的行来，按钮不会跑到段落中间", async () => {
  const { markLines } = await import("../src/lib/learn/highlight.ts");
  const paragraph = line(96, 300, 816, 362); // <p> 外框：两行高，包住下面两行字
  const rects = [line(500, 268, 816, 288), paragraph, line(96, 305, 810, 325), line(96, 336, 300, 356)];
  assert.deepEqual(markLines(rects), [line(500, 268, 816, 288), line(96, 305, 810, 325), line(96, 336, 300, 356)]);
});

test("指针到按钮边上（包括按钮和行尾之间的缝）也算在按钮上", async () => {
  const { nearBadge } = await import("../src/lib/learn/highlight.ts");
  const badge = line(791, 334, 815, 358);
  assert.equal(nearBadge(badge, 790, 346), true); // 行尾和按钮之间那 2px
  assert.equal(nearBadge(badge, 803, 330), true); // 按钮上沿外面一点
  assert.equal(nearBadge(badge, 770, 346), false);
  assert.equal(nearBadge(badge, 803, 370), false);
});
