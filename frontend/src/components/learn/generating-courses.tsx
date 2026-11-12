"use client";

import { useState } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { LABEL_CLASS } from "@/components/brand/eyebrow";
import { type PendingCourse, elapsedParts, pendingState } from "@/lib/learn/pending-courses";
import { cn } from "@/lib/utils";

export interface FinishedCourse {
  key: string;
  name: string;
  courseId: number;
}

// 「我的课程」顶部的「正在生成」卡片：提交建课后课程要等一会儿才出现在列表里，卡片说清楚「在生成、大概多久」。
// 等够这种建课方式的最长时间（pending-courses.ts 的 PENDING_STALE_MS）还没出现才改口：
// 先请人刷新列表核对（主按钮），确认没有再重新创建（「重新创建」本身也会先不走缓存查一次列表）；课程出现后短暂变成「生成好了」。
// 没收到应答的（unconfirmed）在这段时间里同样当作还在生成，写出没收到确认的具体原因，并给「刷新列表」。
export default function GeneratingCourses({
  items,
  finished,
  now,
  onRefresh,
  onRetry,
  onDismiss,
  onDismissFinished,
}: {
  items: PendingCourse[];
  finished: FinishedCourse[];
  now: number;
  // 两个都先不走缓存取一次列表：取到了返回 null，没取到返回原因（写在点的那张卡片上）
  onRefresh: () => Promise<string | null>;
  onRetry: (item: PendingCourse) => Promise<string | null>;
  onDismiss: (item: PendingCourse) => void;
  onDismissFinished: (key: string) => void;
}) {
  const t = useTranslations("learn.generating");
  const locale = useLocale();
  // 点了哪张卡片的哪个按钮、正在等列表：同一时间只查一次，其它卡片上的按钮先禁用
  const [busy, setBusy] = useState<{ id: string; action: "refresh" | "retry" } | null>(null);
  // 点完之后这张卡片还在：列表取到了但还没有这门课（写出刷新的时刻，再点一次也看得出变化），或者没取到的原因
  const [checked, setChecked] = useState<Record<string, { at: number; error: string | null }>>({});

  if (items.length === 0 && finished.length === 0) return null;

  const timeText = (startedAt: number) => {
    const { minutes, seconds } = elapsedParts(startedAt, now);

    return minutes > 0 ? t("minutes", { minutes, seconds }) : t("seconds", { seconds });
  };

  const check = async (item: PendingCourse, action: "refresh" | "retry") => {
    setBusy({ id: item.id, action });
    const error = await (action === "refresh" ? onRefresh() : onRetry(item));
    setBusy(null);
    // 「重新创建」核对成功时这张卡片已经没了（课程出现了，或者打开了新建课程），只有没取到列表才需要写
    if (action === "refresh" || error !== null) setChecked((prev) => ({ ...prev, [item.id]: { at: Date.now(), error } }));
  };

  return (
    <div className="mb-6 space-y-3" data-testid="generating-courses">
      {finished.map((course) => (
        <section
          key={course.key}
          role="status"
          className="flex flex-col gap-4 rounded-xl border border-primary/30 bg-accent p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-3" strokeWidth={3} aria-hidden="true" />
            </span>
            <h2 className="min-w-0 break-words text-lg">
              {course.name ? t("doneTitle", { name: course.name }) : t("doneTitleUntitled")}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild>
              <Link href={`/learn/course/${course.courseId}`}>
                {t("open")}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <button
              type="button"
              onClick={() => onDismissFinished(course.key)}
              aria-label={t("dismiss")}
              className="flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </section>
      ))}

      {items.map((item) => {
        const stalled = pendingState(item, now) === "stalled";
        const expect = t(`expect.${item.kind}`);
        const time = timeText(item.startedAt);
        const refreshing = busy?.id === item.id && busy.action === "refresh";
        const retrying = busy?.id === item.id && busy.action === "retry";
        const result = checked[item.id];

        return (
          <section
            key={item.id}
            // 读屏只在出现和状态变化时播报，已等多久的秒数每秒在变，标成 aria-hidden
            role="status"
            className={cn(
              "flex flex-col gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6",
              stalled ? "border-warning/50" : "border-primary/30"
            )}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                {!stalled && <Spinner className="text-primary-text" />}
                <span className={cn(LABEL_CLASS, stalled ? "text-warning" : "text-accent-foreground")}>
                  {stalled ? t("stalledLabel") : t("label")}
                </span>
                {!stalled && <span
                  className="text-xs text-muted-foreground tabular-nums"
                  aria-hidden="true"
                >
                  {t("waited", { time })}
                </span>}
              </div>
              <h2 className="mt-2 break-words text-lg sm:text-xl">
                {stalled
                  ? item.name
                    ? t("stalledTitle", { name: item.name })
                    : t("stalledTitleUntitled")
                  : item.name
                    ? t("title", { name: item.name })
                    : t("titleUntitled")}
              </h2>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">
                {stalled
                  ? t("stalledBody")
                  : item.unconfirmed
                    ? // 没收到后端的应答：不知道任务开始了没有
                      t("unconfirmed", { expect })
                    : expect}
              </p>
              {item.unconfirmed && item.reason && (
                <p className="mt-1 break-words text-xs text-muted-foreground">{t("reason", { reason: item.reason })}</p>
              )}
              {result && (
                <p className={cn("mt-2 break-words text-[13px]", result.error === null ? "text-foreground" : "text-destructive")}>
                  {result.error === null
                    ? t("stillMissing", {
                        time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(result.at),
                      })
                    : t("refreshFailed", { message: result.error })}
                </p>
              )}
            </div>

            {(stalled || item.unconfirmed) && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button loading={refreshing} disabled={!!busy} onClick={() => check(item, "refresh")}>
                  {refreshing ? t("refreshing") : t("refresh")}
                </Button>
                {stalled && (
                  <>
                    <Button variant="outline" loading={retrying} disabled={!!busy} onClick={() => check(item, "retry")}>
                      {retrying ? t("checking") : t("retry")}
                    </Button>
                    <button
                      type="button"
                      onClick={() => onDismiss(item)}
                      aria-label={t("dismiss")}
                      className="flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
