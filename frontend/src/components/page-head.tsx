import Eyebrow from "@/components/brand/eyebrow";
import { PAGE_TITLE } from "@/lib/page-title";
import { cn } from "@/lib/utils";

// 学习区和用户中心所有页面共用的页头：等宽小标签（所属分组，可选）+ 36px 标题 + 一句说明，右侧放主操作。
// 标题和小标签、标题和说明之间都是 8px（mt-2），每个页面一样；服务端、客户端组件都能用，所以放在不带 "use client" 的模块里。
export function PageHead({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)}>
      <div className="min-w-0 flex-1 basis-72">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className={cn(PAGE_TITLE, eyebrow && "mt-2", "text-balance")}>{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-pretty leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>}
    </header>
  );
}
