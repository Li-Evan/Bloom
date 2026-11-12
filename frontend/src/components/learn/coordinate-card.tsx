"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bookmark, Check, EyeOff } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Eyebrow from "@/components/brand/eyebrow";
import { QuietNotice } from "@/components/learn/shell";
import { useLearnError } from "@/components/learn/use-learn-error";
import Words from "@/components/learn/words";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { dismissRecommendation, restoreRecommendation, saveRecommendation } from "@/lib/learn/api";
import {
  advanceCoordinate,
  findingDirections,
  getCoordinate,
  placing,
  stepCoordinate,
  type CoordinateCard as Card,
} from "@/lib/learn/coordinate";
import { cn } from "@/lib/utils";

// 读卡片，缺哪步就在这里一步一步补上（每门课只算一次，后端存下来复用）。课程页在手机和桌面各放一份卡片，数据只取这一份
export function useCoordinate(courseId: string) {
  const locale = useLocale();
  const report = useLearnError();
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const alive = useRef(true);

  const run = useCallback(async (start?: Card) => {
    setError("");
    try {
      const first = start ?? (await getCoordinate(courseId, locale));
      if (!alive.current) return;
      setCard(first);
      if (!first.needs.length || first.retry_after != null) return;
      setRunning(true);
      await advanceCoordinate(first, {
        step: () => stepCoordinate(courseId, locale),
        load: () => getCoordinate(courseId, locale),
        onCard: (next) => alive.current && setCard(next),
        stopped: () => !alive.current,
      });
    } catch (err) {
      if (alive.current) setError(report(err));
    } finally {
      if (alive.current) setRunning(false);
    }
  }, [courseId, locale, report]);

  useEffect(() => {
    alive.current = true;
    void run();
    return () => {
      alive.current = false;
    };
  }, [run]);

  // 重试：退避时间还没到也重新读一次卡片，到了才会真的再算
  const retry = () => run();
  // 课程页归档 / 取消归档文件后「接着学」可能换了一篇：只重读一次卡片，不往下算，读不到就留着原来的
  const refresh = () => {
    getCoordinate(courseId, locale).then((next) => alive.current && setCard(next), () => undefined);
  };
  // 收进待学、点「不感兴趣」、撤销：只改这一条的状态。点了「不感兴趣」的留在原位、换成一行带「撤销」的提示，下次打开就没有了
  const setStatus = (id: number, status: string) =>
    setCard((current) => current && { ...current, directions: current.directions.map((d) => (d.id === id ? { ...d, status } : d)) });
  return { card, error, running, retry, refresh, setStatus };
}

// 顶部那条带：骨架的全部顶层排成一行小格，学过的点亮，这门课所在的描边。不给百分比，只说点亮了哪几块、各几门课
function Band({ band }: { band: Card["band"] }) {
  const t = useTranslations("learn.coordinate");
  // 点亮的顶层，加上这门课所在的顶层（还没读课文时它不亮，但也要说出来）
  const named = band.filter((b) => b.courses > 0 || b.here);
  return (
    <div className="mt-3">
      <ol className="flex gap-1" aria-label={t("bandLabel")}>
        {band.map((b) => (
          <li
            key={b.node_id}
            title={b.courses ? t("bandCourses", { name: b.label, count: b.courses }) : b.label}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              b.courses ? "bg-primary" : "bg-muted",
              b.here && !b.courses && "bg-primary/35",
            )}
          >
            <span className="sr-only">{b.courses ? t("bandCourses", { name: b.label, count: b.courses }) : b.label}</span>
          </li>
        ))}
      </ol>
      {named.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {named.map((b) => (b.courses ? t("bandCourses", { name: b.label, count: b.courses }) : b.label)).join(t("bandSeparator"))}
        </p>
      )}
    </div>
  );
}

const ACTION = "flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60";

function Direction({
  item,
  canSave,
  onStatus,
}: {
  item: Card["directions"][number];
  canSave: boolean;
  onStatus: (id: number, status: string) => void;
}) {
  const t = useTranslations("learn.coordinate");
  const report = useLearnError();
  const [busy, setBusy] = useState<"save" | "dismiss" | "restore" | null>(null);
  const [error, setError] = useState("");

  const act = async (action: "save" | "dismiss" | "restore", work: () => Promise<unknown>, status: string) => {
    setBusy(action);
    setError("");
    try {
      await work();
      onStatus(item.id, status);
    } catch (err) {
      setError(t(`${action}Failed`, { message: report(err) }));
    } finally {
      setBusy(null);
    }
  };
  const failure = error && <p role="alert" className="mt-1 text-pretty text-xs text-destructive">{error}</p>;

  if (item.status === "dismissed") {
    return (
      <li>
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="min-w-0 break-words text-[13px] text-muted-foreground">{t("dismissed", { name: item.label })}</p>
          <button
            type="button"
            onClick={() => act("restore", () => restoreRecommendation(item.id), "suggested")}
            disabled={busy !== null}
            aria-busy={busy === "restore" || undefined}
            className={cn("-my-1.5 -mr-2", ACTION)}
          >
            {busy === "restore" && <Spinner />}
            {t("undo")}
          </button>
        </div>
        {failure}
      </li>
    );
  }

  return (
    <li>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words font-medium leading-snug">
          <Words text={item.label} />
        </p>
        {canSave &&
          (item.status !== "suggested" ? (
            <Link href="/learn/next" className="flex shrink-0 items-center gap-1 text-xs font-medium text-accent-foreground hover:underline">
              <Check className="size-3.5" aria-hidden="true" />
              {t("saved")}
            </Link>
          ) : (
            <div className="-my-1.5 -mr-2 flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => act("dismiss", () => dismissRecommendation(item.id), "dismissed")}
                disabled={busy !== null}
                aria-busy={busy === "dismiss" || undefined}
                aria-label={t("dismissLabel", { name: item.label })}
                title={t("dismissLabel", { name: item.label })}
                className={ACTION}
              >
                {busy === "dismiss" ? <Spinner /> : <EyeOff className="size-3.5" strokeWidth={1.8} aria-hidden="true" />}
                {/* 卡片窄（桌面右栏）时只留图标，悬停有提示：标题（英文常很长）不被挤成几行 */}
                <span className="@max-[18rem]:sr-only">{t("dismiss")}</span>
              </button>
              <button
                type="button"
                onClick={() => act("save", () => saveRecommendation(item.id), "saved")}
                disabled={busy !== null}
                aria-busy={busy === "save" || undefined}
                aria-label={t("saveLabel", { name: item.label })}
                className={ACTION}
              >
                {busy === "save" ? <Spinner /> : <Bookmark className="size-3.5" strokeWidth={1.8} aria-hidden="true" />}
                {t("save")}
              </button>
            </div>
          ))}
      </div>
      <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">{item.question}</p>
      {failure}
    </li>
  );
}

// 「你在这里 + 接着学 + 相邻方向」。「接着学」去后端给的那一篇（项目课的下一个没读的文件），没给就去「继续学习」那一篇
export default function CoordinateCard({
  state,
  courseId,
  continueNumber,
  className,
}: {
  state: ReturnType<typeof useCoordinate>;
  courseId: string;
  continueNumber?: number;
  className?: string;
}) {
  const t = useTranslations("learn.coordinate");
  const common = useTranslations("learn.common");
  const { card, error, running, retry, setStatus } = state;
  const nextNumber = card?.next_item?.lesson_number ?? continueNumber;
  const nextHref = nextNumber != null ? `/learn/course/${courseId}/lesson/${nextNumber}` : undefined;

  if (!card) {
    return error ? (
      <section className={cn("rounded-xl border bg-card p-5", className)}>
        <Eyebrow>{t("eyebrow")}</Eyebrow>
        <QuietNotice className="mt-3" message={t("failed", { message: error })}>
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={retry}>
            {common("retry")}
          </button>
        </QuietNotice>
      </section>
    ) : (
      <Skeleton className={cn("h-48 rounded-xl", className)} />
    );
  }
  if (card.state === "empty" || card.state === "none") return null;

  const here = card.here;
  const failed = error || (card.state === "failed" ? t("retryLater") : "");

  return (
    <section aria-label={t("eyebrow")} aria-busy={running || undefined} className={cn("@container rounded-xl border bg-card p-5", className)}>
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      {here ? (
        <>
          <Band band={card.band} />
          <div className="mt-4">
            <p className="text-xs text-muted-foreground">{t("here")}</p>
            {here.crumbs.length > 0 && (
              <p className="mt-1 break-words text-[13px] leading-snug text-muted-foreground">
                {here.crumbs.map((c) => c.label).join(" › ")}
              </p>
            )}
            <p className="mt-0.5 break-words text-lg font-semibold leading-snug">
              <Words text={here.label} />
            </p>
            {here.also.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{t("also")}</span>
                {here.also.map((node) => (
                  <Badge key={node.node_id} variant="outline">
                    {node.label}
                  </Badge>
                ))}
              </div>
            )}
            {card.connect && (
              <p className="mt-2 text-pretty text-[13px] text-muted-foreground">
                <Link href={`/learn/course/${card.connect.course_id}`} className="underline-offset-2 hover:underline">
                  {card.connect.node_id === here.node_id
                    ? t("connectSame", { course: card.connect.course_name })
                    : t("connect", { course: card.connect.course_name, node: card.connect.label })}
                </Link>
              </p>
            )}
          </div>
        </>
      ) : (
        placing(card) && (
          <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner className="text-primary-text" />
            {t("placing")}
          </p>
        )
      )}

      <div className="mt-4 border-t pt-4">
        <p className="text-xs text-muted-foreground">{t("next")}</p>
        {card.next_item ? (
          nextHref ? (
            <Link href={nextHref as any} className="group mt-1 flex items-start gap-2 font-medium leading-snug hover:text-primary-text">
              <span className="min-w-0 break-words">{card.next_item.text}</span>
              <ArrowRight className="mt-0.5 size-4 shrink-0 transition-transform group-hover:translate-x-0.5 rtl:rotate-180" aria-hidden="true" />
            </Link>
          ) : (
            <p className="mt-1 break-words font-medium leading-snug">{card.next_item.text}</p>
          )
        ) : (
          <p className="mt-1 text-sm">{t("nextDone")}</p>
        )}
        {card.covered.length > 0 && (
          <p className="mt-2 text-pretty text-[13px] leading-relaxed text-muted-foreground">
            {t("covered")}
            {card.covered.map((c) => t("coveredItem", { text: c.text, state: t(`state.${c.state}`) })).join(t("separator"))}
          </p>
        )}
      </div>

      {here && (card.directions.length > 0 || findingDirections(card)) && (
        <div className="mt-4 border-t pt-4">
          <p className="text-xs text-muted-foreground">{t("directions")}</p>
          {card.directions.length > 0 ? (
            <ul className="mt-2 space-y-3">
              {card.directions.map((item) => (
                <Direction key={item.id} item={item} canSave={card.can_save} onStatus={setStatus} />
              ))}
            </ul>
          ) : (
            <p role="status" className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="text-primary-text" />
              {t("findingDirections")}
            </p>
          )}
        </div>
      )}

      {failed && !running && (
        <QuietNotice className="mt-4" message={error ? t("failed", { message: error }) : failed}>
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={retry}>
            {common("retry")}
          </button>
        </QuietNotice>
      )}
    </section>
  );
}
