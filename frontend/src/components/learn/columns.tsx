import { cn } from "@/lib/utils";

// 课程页、大纲页、课文页共用的两栏栅格：正文最宽 720px，中间 48 / 64px，右栏 304px，三页的右栏起点一样。
// 桌面（lg 起）两栏；手机上只有一栏：右栏的内容放在正文后面（after）或者页头和正文之间（before）；
// 课文页的右栏在手机上本来就是抽屉 / 底部卡片，里面没有占位置的东西。右栏上下的间距由放进去的内容自己留。
//
// head：正文栏最上面的页头（课程页的标题和徽标），右栏和它们同一行起头。
// 右栏本身撑满整个栅格高度（里面的 sticky 元素才有地方走）：吸顶的内容用 learn.css 里的 .learn-rail。
export default function LearnColumns({
  head,
  rail,
  railOnMobile = "after",
  className,
  children,
}: {
  head?: React.ReactNode;
  rail: React.ReactNode;
  railOnMobile?: "before" | "after";
  className?: string;
  children: React.ReactNode;
}) {
  // DOM 顺序就是阅读和 Tab 的顺序：右栏在手机上排在正文后面（after）时，它在 DOM 里也在正文后面，
  // 键盘用户不必先 Tab 过整个课文列表才到正文；桌面上两栏的位置由栅格的显式行列决定，和 DOM 顺序无关
  const aside = (
    <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:flex lg:flex-col">
      {rail}
    </aside>
  );

  return (
    <div
      data-learn-columns
      className={cn(
        "grid grid-cols-1 lg:grid-cols-[minmax(0,720px)_19rem] lg:justify-between lg:gap-x-12 xl:gap-x-16",
        className
      )}
    >
      {head && <div className="min-w-0 lg:col-start-1 lg:row-start-1">{head}</div>}
      {railOnMobile === "before" && aside}
      <div className="min-w-0 lg:col-start-1">{children}</div>
      {railOnMobile === "after" && aside}
    </div>
  );
}
