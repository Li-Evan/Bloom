import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// 用户中心每一页的页头和学习区共用一个（components/page-head.tsx）；这里再导出一次，用户中心的页面不用改引用
export { PageHead } from "@/components/page-head";

// 卡片标题：全站统一 16px / 600，放在卡片里左上；页面级的才用绿色小标签（Eyebrow）。「查看全部」放在标题同一行右侧（PanelLink）
export const CARD_TITLE = "text-base font-semibold tracking-tight";

// 一块内容：卡片底、1px 描边，带标题行（可选右侧操作）
export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border bg-card p-5 sm:p-6", className)}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          {title && <h2 className={CARD_TITLE}>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

// 内容块标题行右侧的「查看全部 →」
export function PanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    // 点击区高 40px（上下各撑 10px，用负外边距抵掉，版面不变）
    <Link href={href} className="-my-2.5 inline-flex items-center py-2.5 text-sm font-medium text-accent-foreground underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}
