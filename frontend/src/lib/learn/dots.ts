// 页边的小圆点：几条问答落在同一处（或挨得很近）时纵向错开，别叠在一起点不到。
// 只改显示位置，不改问答自己保存的 anchor_top。
export function spreadDots<T extends string | number>(
  items: { id: T; top: number }[],
  gap = 22
): Map<T, number> {
  const out = new Map<T, number>();
  let prev = Number.NEGATIVE_INFINITY;
  for (const item of [...items].sort((a, b) => a.top - b.top)) {
    const top = Math.max(item.top, prev + gap);
    out.set(item.id, top);
    prev = top;
  }
  return out;
}
