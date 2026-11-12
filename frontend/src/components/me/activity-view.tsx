"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import ActivityStats from "@/components/me/activity-stats";
import { HEAT_CELL } from "@/components/me/mini-heatmap";
import { Panel } from "@/components/me/page-head";
import { useTodayKey } from "@/components/me/today";
import StatHint from "@/components/learn/stat-hint";
import Mono from "@/components/brand/mono";
import { useHeatWeeks } from "@/components/me/use-heat-weeks";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/navigation";
import type { Calendar, CalendarDay } from "@/lib/learn/types";
import { WEEKDAYS, dateKey, heatWeeks, level, monthCells } from "@/lib/me/activity";
import type { MeStats } from "@/lib/me/types";
import { cn } from "@/lib/utils";

// 月历单元格：强度 0–4。没有学习记录的日子不画底色（只留数字），有记录的才按深浅涂绿；文字色要和底色配对，亮暗主题下都读得清
const CELL = [
  "text-subtle-foreground",
  "bg-primary/15 text-accent-foreground",
  "bg-primary/30 text-foreground",
  "bg-primary/70 text-foreground",
  "bg-primary text-primary-foreground",
] as const;

const parseKey = (key: string) => key.split("-").map(Number) as [number, number, number];

export default function ActivityView({ stats, calendar }: { stats: MeStats; calendar: Calendar }) {
  const t = useTranslations("me.activity");
  const locale = useLocale();
  const today = useTodayKey();

  const dayMap = useMemo(() => {
    const map: Record<string, CalendarDay> = {};
    for (const day of calendar.days) map[day.date] = day;
    return map;
  }, [calendar.days]);

  // 默认定位到最近一次学习的那天，右边的面板直接有内容（页面只在有学习记录时才渲染这个组件）
  const [selected, setSelected] = useState<string | null>(calendar.last_active_date);
  const [month, setMonth] = useState(() => {
    const [y, mm] = parseKey(calendar.last_active_date ?? "1970-01-01");
    return new Date(y, mm - 1, 1);
  });

  const year = month.getFullYear();
  const m = month.getMonth();
  const cells = useMemo(() => monthCells(year, m), [year, m]);
  // 足迹热力图：格子按卡片宽度等分铺满（不再有横向滚动），放几周和概览里的小热力图一样
  const weeks = useHeatWeeks();
  const grid = useMemo(() => {
    if (!today) return null;
    const [y, mm, d] = parseKey(today);

    return heatWeeks(new Date(y, mm - 1, d), weeks);
  }, [today, weeks]);
  const footprintDays = grid ? grid.flat().filter((cell) => !cell.future && dayMap[cell.key]).length : null;
  const isCurrentMonth = today ? today.startsWith(`${year}-${String(m + 1).padStart(2, "0")}`) : false;

  // 换月份：选中的那天不在新的月份里，右边的明细就清空，改成「点一个有颜色的日期」
  const goMonth = (next: Date) => {
    setMonth(next);
    const prefix = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    setSelected((current) => (current?.startsWith(prefix) ? current : null));
  };

  const select = (key: string) => {
    setSelected(key);
    const [y, mm] = parseKey(key);
    if (y !== year || mm - 1 !== m) setMonth(new Date(y, mm - 1, 1));
  };

  const detail = selected ? dayMap[selected] : null;
  const selectedTitle = (() => {
    if (!selected) return "";
    const [y, mm, d] = parseKey(selected);
    return new Date(y, mm - 1, d).toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" });
  })();

  const navButton = "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="space-y-6">
      <ActivityStats stats={stats} />

      <div className="grid items-start gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Panel>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight">
              {month.toLocaleDateString(locale, { year: "numeric", month: "long" })}
            </h2>
            <div className="flex items-center gap-1">
              <button type="button" className={navButton} aria-label={t("prev_month")} onClick={() => goMonth(new Date(year, m - 1, 1))}>
                <ChevronLeft className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                className={navButton}
                aria-label={t("next_month")}
                disabled={isCurrentMonth}
                onClick={() => goMonth(new Date(year, m + 1, 1))}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1 text-center text-[11px] font-medium text-subtle-foreground">
                {t(`weekdays.${w}`)}
              </div>
            ))}
            {cells.map((d, i) => {
              if (d === null) return <div key={`blank-${i}`} />;
              const key = dateKey(year, m, d);
              const day = dayMap[key];

              return (
                <button
                  key={key}
                  type="button"
                  disabled={!day}
                  onClick={() => select(key)}
                  aria-pressed={key === selected}
                  title={day ? t("day_tooltip", { lessons: day.lessons_read, asks: day.annotations }) : undefined}
                  className={cn(
                    "relative flex aspect-square items-center justify-center rounded-md text-xs font-medium transition-transform",
                    CELL[level(day?.event_count ?? 0)],
                    day ? "hover:scale-105" : "cursor-default",
                    // 选中 = 2px 的 ring 色环（和卡片底之间隔 2px，叠在任何深浅的绿格子上都看得清；用 --ring 而不是 --primary：亮绿主色在浅底上对比不够）；今天 = 淡一点的环。
                    // 聚焦的轮廓要挪到 ring 外面，不然正好盖在环上
                    key === selected
                      ? "ring-2 ring-ring ring-offset-2 ring-offset-card focus-visible:outline-offset-[6px]"
                      : key === today && "ring-1 ring-ring focus-visible:outline-offset-4"
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-end gap-1.5 text-[11px] text-subtle-foreground" aria-hidden="true">
            {t("less")}
            {HEAT_CELL.map((c) => (
              <span key={c} className={cn("size-3 rounded-[3px]", c)} />
            ))}
            {t("more")}
          </div>
        </Panel>

        <Panel>
          {detail ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-base font-semibold tracking-tight">{selectedTitle}</h2>
                <span className="shrink-0 text-xs text-subtle-foreground">
                  <Mono text={t("day_courses", { count: detail.courses.length })} />
                </span>
              </div>
              <p className="mt-1 mb-4 text-sm text-muted-foreground">
                {t("day_summary", { lessons: detail.lessons_read, asks: detail.annotations })}
                {/* 这一行写的是「打开了」几篇，上面的统计写的是「已读」几篇，数字对不上：和统计格一样带一个 ⓘ 说明两者的区别 */}
                <StatHint hint={t("day_info")} />
              </p>
              <ul className="max-h-[22rem] space-y-2.5 overflow-y-auto pr-1">
                {detail.courses.map((c) => (
                  <li key={c.course_id} className="rounded-md border bg-muted/50 p-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/learn/course/${c.course_id}`}
                        title={c.course_name}
                        className="min-w-0 truncate text-sm font-medium underline-offset-4 hover:text-accent-foreground hover:underline"
                      >
                        {c.course_name}
                      </Link>
                      {c.mode === "source" && (
                        <Badge variant="outline" className="shrink-0">
                          {t("source")}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {c.lessons.length > 0 ? (
                        c.lessons.map((n) => (
                          <Link
                            key={n}
                            href={`/learn/course/${c.course_id}/lesson/${n}`}
                            className="rounded-full bg-accent px-2.5 py-0.5 text-xs text-accent-foreground tabular transition-colors hover:bg-primary hover:text-primary-foreground"
                          >
                            <Mono text={t("lesson_number", { number: n })} />
                          </Link>
                        ))
                      ) : (
                        <span className="text-xs text-subtle-foreground">{t("course_organization")}</span>
                      )}
                      {c.annotations > 0 && (
                        // 日历只给了划线的数量、没有每条的 id，没法带到具体那一条；点它去「我的笔记」，已经按这门课筛好
                        <Link
                          href={`/me/notes?course=${c.course_id}`}
                          className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground tabular transition-colors hover:bg-primary hover:text-primary-foreground"
                        >
                          {t("asks_badge", { count: c.annotations })}
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="flex min-h-52 flex-col items-center justify-center text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-muted text-subtle-foreground">
                <CalendarDays className="size-5" aria-hidden="true" />
              </span>
              <p className="mt-3 text-sm text-muted-foreground">
                {selected ? t("no_activity") : calendar.days.length ? t("pick_day") : t("never")}
              </p>
              <p className="mt-1 text-xs text-subtle-foreground">{t("legend_hint")}</p>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title={t("footprint")}
        action={
          footprintDays !== null && (
            <span className="text-xs text-subtle-foreground">
              {t("footprint_summary", { weeks, count: footprintDays })}
            </span>
          )
        }
      >
        <div>
          <div
            role="group"
            aria-label={t("footprint")}
            className="grid grid-flow-col grid-rows-7 gap-1"
            style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: weeks * 7 }, (_, i) => {
              const cell = grid?.[Math.floor(i / 7)]?.[i % 7];
              if (cell?.future) return <span key={i} />;
              const day = cell ? dayMap[cell.key] : undefined;
              const name = cell ? `${cell.key}${day ? ` · ${t("lesson_count", { count: day.lessons_read })}` : ""}` : undefined;

              return (
                <button
                  key={i}
                  type="button"
                  disabled={!day}
                  onClick={() => day && cell && select(cell.key)}
                  aria-label={name}
                  title={name}
                  className={cn(
                    "aspect-square rounded-[3px]",
                    HEAT_CELL[level(day?.event_count ?? 0)],
                    day ? "hover:ring-1 hover:ring-foreground/40" : "cursor-default",
                    cell && cell.key === selected && "ring-2 ring-ring ring-offset-1 ring-offset-card"
                  )}
                />
              );
            })}
          </div>
        </div>
      </Panel>
    </div>
  );
}
