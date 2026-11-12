import StatHint from "@/components/learn/stat-hint";
import { cn } from "@/lib/utils";

export interface Stat {
  key: string;
  value: React.ReactNode;
  label: string;
  // 短的补充（一行放得下）：写在名字下面
  hint?: string;
  // 长的说明：收进名字旁边的「i」，悬停、聚焦或点一下才显示，格子里不放长句
  info?: string;
}

const COLUMNS = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
} as const;

// 统计条：我的课程、用户中心概览 / 学习记录共用的一种长相——
// 一块带细分隔线的面板，每格是 30px 等宽数字 + 13px 灰色说明（可再加一行更小的补充 hint）；长句放进标题旁的「i」里（info），格子里不放长句。
// 分隔线画在格子自己的右边和下边，外层 overflow-hidden 把最右一列和最后一行多出来的线裁掉，所以格子数不整齐（手机上两列放五格）也没有灰色空块。
export default function StatStrip({
  items,
  columns = items.length as keyof typeof COLUMNS,
  className,
}: {
  items: Stat[];
  columns?: keyof typeof COLUMNS;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <dl className={cn("-mb-px -mr-px grid grid-cols-2", COLUMNS[columns])}>
        {items.map((item) => (
          <div
            key={item.key}
            // 手机上两列，格数是单数时最后一格占满一行，不留带边框的空格
            className="flex flex-col border-b border-r px-5 py-4 max-sm:[&:last-child:nth-child(odd)]:col-span-2"
          >
            {/* 读屏的顺序是 dt（名字）在前、dd（数字）在后；看上去数字在上、名字在下，靠 CSS 的 order 调 */}
            <dt className="order-2 mt-1 text-[13px] text-muted-foreground">
              {item.label}
              {item.info && <StatHint hint={item.info} />}
              {item.hint && <span className="mt-0.5 block text-xs text-subtle-foreground">{item.hint}</span>}
            </dt>
            <dd className="order-1 font-mono text-3xl font-medium tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
