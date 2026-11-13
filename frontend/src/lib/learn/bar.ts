// 课文页的面包屑条：往下滚时收起，往上滚时出现（吸顶只剩全站顶栏）。纯函数，滚动监听在 components/learn/use-bar-hidden.ts。
// 翻转要「累计」滚满一段距离：收起后往回滚满 BAR_FLIP_DISTANCE 才出现、显示时往下滚满它才收起——
// 触控板到底后的回弹、惯性尾巴只有几个像素，不会让条一闪一闪。

// 离页面顶部这么近时一直显示
export const BAR_TOP_ZONE = 80;
// 反方向累计滚动这么多才翻转
export const BAR_FLIP_DISTANCE = 24;

export interface BarState {
  hidden: boolean;
  // 参照位置：收起时是往下滚到过的最低位置，显示时是往上滚到过的最高位置
  ref: number;
}

export function nextBar(state: BarState, y: number): BarState {
  if (y <= BAR_TOP_ZONE) return { hidden: false, ref: y };

  if (state.hidden) {
    if (state.ref - y >= BAR_FLIP_DISTANCE) return { hidden: false, ref: y };

    return { hidden: true, ref: Math.max(state.ref, y) };
  }

  if (y - state.ref >= BAR_FLIP_DISTANCE) return { hidden: true, ref: y };

  return { hidden: false, ref: Math.min(state.ref, y) };
}
