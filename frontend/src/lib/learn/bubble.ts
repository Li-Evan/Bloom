// 选中课文后冒出的「提问 / 标记 / 翻译」气泡放在哪儿：紧挨着选中的字，手机和电脑一样。纯计算，量 DOM 的事在 lesson.tsx 里做。
//
// - above：默认放在选区第一行的正上方，底下一个小三角指向选区（和多数阅读器一样，盖住的是已经读过的上一行）。
// - below：上方被顶栏（和面包屑条）挡住时，放在选区最后一行的正下方，顶上一个小三角。
// 水平居中在那一行被选中的部分上，不出正文的左右边缘；贴边时气泡往里挪，小三角仍对准选中的字。

// 气泡高 32px；离选中的字 8px（含小三角）
export const BUBBLE_HEIGHT = 32;
export const BUBBLE_GAP = 8;
// 水平居中时两边至少留的距离（半个气泡宽）；有「翻译」时更宽，由调用方传
export const BUBBLE_HALF_WIDTH = 48;

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// top：气泡顶；left：气泡中心（都相对 <article>）；arrow：小三角离气泡中心多远（贴边被挪过时不是 0）
export interface BubblePlacement {
  mode: "above" | "below";
  top: number;
  left: number;
  arrow: number;
}

export function placeBubble({
  head,
  tail,
  box,
  article,
  topSafe,
  halfWidth = BUBBLE_HALF_WIDTH,
}: {
  // 选区第一行、最后一行被选中的部分（视口坐标）
  head: Box;
  tail: Box;
  // 整个选区的外框（视口坐标）：跨行时第一行一直选到行尾、最后一行从行首选起，左右两端用它
  box: Box;
  // 课文区（<article>）的位置（视口坐标）和宽度
  article: { left: number; top: number; width: number };
  // 屏幕顶上被顶栏（和面包屑条）盖住的高度
  topSafe: number;
  halfWidth?: number;
}): BubblePlacement {
  const oneLine = Math.abs(head.top - tail.top) < (head.bottom - head.top) / 2;
  const above = head.top - BUBBLE_GAP - BUBBLE_HEIGHT >= topSafe;
  const [from, to] = above
    ? [head.left, oneLine ? tail.right : box.right]
    : [oneLine ? head.left : box.left, tail.right];
  const want = (from + to) / 2 - article.left;
  const center = Math.min(Math.max(want, halfWidth), article.width - halfWidth);
  const top = above ? head.top - BUBBLE_GAP - BUBBLE_HEIGHT : tail.bottom + BUBBLE_GAP;

  return { mode: above ? "above" : "below", top: Math.round(top - article.top), left: Math.round(center), arrow: Math.round(want - center) };
}
