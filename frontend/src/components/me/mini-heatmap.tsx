"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { useHeatWeeks } from "@/components/me/use-heat-weeks";
import { heatWeeks, level } from "@/lib/me/activity";
import { cn } from "@/lib/utils";

const subscribe = () => () => {};

// 强度 0–4 → 底色。全部是令牌：亮暗主题自动换
export const HEAT_CELL = [
  "bg-muted",
  "bg-primary/20",
  "bg-primary/40",
  "bg-primary/70",
  "bg-primary",
] as const;

export type DayCounts = Record<string, number>;

// 近期活动的小热力图：格子按卡片宽度等分铺满，放几周和「学习记录」里的足迹一样（use-heat-weeks.ts）。
// 「今天」是浏览器本地的日期，服务端不知道，所以水合之前画一张空网格（同样的尺寸，不会跳），水合之后再按本地日期着色。
export default function MiniHeatmap({ counts }: { counts: DayCounts }) {
  const t = useTranslations("me.overview");
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const weeks = useHeatWeeks();
  const grid = mounted ? heatWeeks(new Date(), weeks) : null;
  const active = grid ? grid.flat().filter((cell) => !cell.future && counts[cell.key]).length : null;

  return (
    <div>
      <div>
        <div
          role="img"
          aria-label={active === null ? t("heatmap_label_loading") : t("heatmap_label", { weeks, count: active })}
          className="grid grid-flow-col grid-rows-7 gap-1"
          style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: weeks * 7 }, (_, i) => {
            const cell = grid?.[Math.floor(i / 7)]?.[i % 7];
            const count = cell && !cell.future ? (counts[cell.key] ?? 0) : 0;

            return (
              <span
                key={i}
                title={cell && !cell.future && count ? cell.key : undefined}
                className={cn(
                  "aspect-square rounded-[3px]",
                  cell?.future ? "bg-transparent" : HEAT_CELL[level(count)]
                )}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-subtle-foreground">
        <span>{active === null ? " " : t("heatmap_summary", { weeks, count: active })}</span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          {t("heatmap_less")}
          {HEAT_CELL.map((c) => (
            <span key={c} className={cn("size-3 rounded-[3px]", c)} />
          ))}
          {t("heatmap_more")}
        </span>
      </div>
    </div>
  );
}
