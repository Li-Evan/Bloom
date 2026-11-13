"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { elapsedParts } from "@/lib/learn/pending-courses";
import { cn } from "@/lib/utils";

// 学习区页面的统一容器：和顶栏同宽（max-w-6xl），左右留白 16 / 24 / 32
export function LearnPage({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-learn-page
      className={cn(
        "mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface Crumb {
  label: React.ReactNode;
  href?: string;
}

// 面包屑条：课程页、大纲页、课文页三页用同一条（56px 高、下边线、同样的字和分隔）。
// 最后一项是当前页，不带链接。课文页让它吸在全站顶栏下面，往下滚时收起（hidden），往上滚时出现；
// actions 放在右侧（课文页的徽标和按钮）。
// 宽屏排成一行；lg 以下右边的按钮占掉大半宽度，改成两行：上面小字只留上一层（课程名），下面是当前页，
// 每一层放不下就省略号截断，长标题（比如很长的文件名）不会再压到按钮上。
export function CrumbBar({
  items,
  actions,
  sticky = false,
  hidden = false,
  onFocusCapture,
}: {
  items: Crumb[];
  actions?: React.ReactNode;
  sticky?: boolean;
  hidden?: boolean;
  onFocusCapture?: () => void;
}) {
  const t = useTranslations("learn");

  return (
    <div
      onFocusCapture={onFocusCapture}
      className={cn(
        "z-30 h-14 border-b bg-background",
        sticky &&
          "sticky top-[var(--header-height)] transition-transform duration-150 motion-reduce:transition-none",
        sticky && hidden && "-translate-y-full"
      )}
    >
      <div data-crumb-row className="mx-auto flex h-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <nav aria-label={t("common.breadcrumb")} className="min-w-0">
          <ol className="flex min-w-0 text-sm text-muted-foreground max-lg:flex-col lg:items-center lg:gap-1.5">
            {items.map((item, i) => {
              const last = i === items.length - 1;

              return (
                <li
                  key={i}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5",
                    last ? "font-medium text-foreground" : "max-lg:text-xs",
                    // 两行排法里上面只放上一层：三层以上时收掉「我的课程」，课程名和当前页留着；
                    // 一行排开时「我的课程」是固定的短词，不跟着缩成「我…」，挤的时候只截课程名和当前页
                    !last && i < items.length - 2 && "shrink-0 max-lg:hidden"
                  )}
                  aria-current={last ? "page" : undefined}
                >
                  {item.href && !last ? (
                    <Link
                      href={item.href as any}
                      title={typeof item.label === "string" ? item.label : undefined}
                      className="min-w-0 truncate rounded-sm transition-colors hover:text-foreground"
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span className="truncate" title={typeof item.label === "string" ? item.label : undefined}>
                      {item.label}
                    </span>
                  )}
                  {!last && (
                    <ChevronRight
                      className="size-3.5 shrink-0 text-subtle-foreground max-lg:hidden rtl:rotate-180"
                      aria-hidden="true"
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// 请求出错时的提示条（也用来放「课程可能仍在生成」这类需要用户注意的说明）
export function ErrorBar({
  message,
  onClose,
  className,
}: {
  message: string;
  onClose: () => void;
  className?: string;
}) {
  const t = useTranslations("learn");

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive",
        className
      )}
    >
      <span className="min-w-0 text-pretty">{message}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="shrink-0 rounded-sm p-0.5 transition-colors hover:text-foreground"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// 不挡操作的轻提示：后台请求（统计、自动刷新、学习记录）失败时用，说清楚哪一项没成功、原因是什么，不像 ErrorBar 那样醒目
export function QuietNotice({
  message,
  onClose,
  className,
  children,
}: {
  message: string;
  onClose?: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const t = useTranslations("learn");

  return (
    <div role="status" className={cn("flex items-start justify-between gap-3 text-[13px] text-muted-foreground", className)}>
      <span className="min-w-0 text-pretty">{message}</span>
      <div className="flex shrink-0 items-center gap-3">
        {children}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-sm p-0.5 transition-colors hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

// 「已等 12 秒」：startedAt 是开始等的时刻（Date.now()），每秒刷新一次
export function useWaited(startedAt: number | null) {
  const t = useTranslations("learn");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt == null) return "";
  const { minutes, seconds } = elapsedParts(startedAt, now);
  return t("generating.waited", {
    time: minutes > 0 ? t("generating.minutes", { minutes, seconds }) : t("generating.seconds", { seconds }),
  });
}

// 进行中提示：要等好几秒以上的操作（生成大纲、课文、回答）放在触发按钮旁边，转圈 + 正在做什么 + 一般要多久 + 已等多久，
// 让人一眼看出「点上了、还在做、没卡住」。读屏只在出现时播报标题，秒数每秒在变，标成 aria-hidden。
// 出现时如果不在可视区（手机上常落在按钮下面一屏外），滚到刚好看得见的位置。
export function WorkingBar({
  title,
  expect,
  startedAt,
  className,
}: {
  title: string;
  expect?: string;
  startedAt?: number | null;
  className?: string;
}) {
  const waited = useWaited(startedAt ?? null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  return (
    <div
      ref={ref}
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-primary/30 bg-accent px-4 py-3 text-sm ann-in",
        className
      )}
    >
      <Spinner className="mt-px size-5 text-primary-text" />
      <div className="min-w-0">
        <p className="font-medium text-pretty text-foreground">{title}</p>
        {(expect || waited) && (
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {expect}
            {expect && waited && <span aria-hidden="true"> · </span>}
            {waited && <span aria-hidden="true" className="tabular-nums">{waited}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

// 完成提示：操作成功、但页面上的变化不一定显眼（大纲整份换掉、设置保存了）时，明确说一句「好了」
export function DoneBar({
  message,
  onClose,
  className,
  children,
}: {
  message: string;
  onClose?: () => void;
  className?: string;
  // 跟在说明后面的操作（比如去看看的链接）
  children?: React.ReactNode;
}) {
  const t = useTranslations("learn");

  return (
    <div
      role="status"
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border border-primary/30 bg-accent px-4 py-3 text-sm text-foreground ann-in",
        className
      )}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" strokeWidth={3} aria-hidden="true" />
        </span>
        <span className="text-pretty">{message}{children && <> {children}</>}</span>
      </span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// 完成提示过几秒自己收起：flash(message) 显示，clear() 立即收起
export function useFlash(ms = 8000) {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), ms);
    return () => clearTimeout(timer);
  }, [message, ms]);
  return [message, setMessage, () => setMessage("")] as const;
}
