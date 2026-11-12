import BellCurve from "@/components/brand/bell-curve";
import { cn } from "@/lib/utils";

// 空状态只有两种：
// - 页面级（EmptyAction）：实线卡 + 钟形曲线插图 + 标题 + 一句话 + 按钮，告诉用户下一步去哪。所有页面用同一张插图，
//   只有「我的课程」换成带标注的大一号（art）；
// - 区块级（EmptyHint）：虚线框 + 一行字，只说明这里还没有东西。

export function EmptyAction({
  art = <BellCurve tone="auto" annotated={false} className="mx-auto w-44 sm:w-52" />,
  title,
  text,
  children,
  className,
}: {
  // 插图：默认是小号钟形曲线，「我的课程」传带标注的大一号
  art?: React.ReactNode;
  title: string;
  text?: string;
  // 行动按钮
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border bg-card px-5 py-10 text-center sm:px-10 sm:py-12",
        className
      )}
    >
      {art}
      <h2 className={cn("mx-auto max-w-xl text-xl sm:text-2xl", art && "mt-5")}>
        {title}
      </h2>
      {text && (
        <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
          {text}
        </p>
      )}
      {children && <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{children}</div>}
    </section>
  );
}

export function EmptyHint({
  children,
  action,
  className,
}: {
  children: React.ReactNode;
  // 可选：一个小按钮（比如「清除筛选」）
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground",
        className
      )}
    >
      <p className="text-pretty">{children}</p>
      {action}
    </div>
  );
}
