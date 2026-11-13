"use client";

import { useSyncExternalStore } from "react";

// 概览的小热力图和学习记录的「学习足迹」是同一件事，用同一个时间窗口：最近 26 周（半年）；手机上放不下这么多格，两处都收成最近 13 周。
// 以前是各按卡片宽度算，概览写「近 19 周」、学习记录写「近 32 周」，同一个人看到两个窗口、两个天数。
export const HEAT_WEEKS = 26;
export const HEAT_WEEKS_PHONE = 13;

const PHONE = "(max-width: 639px)";
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", notify);

  return () => query.removeEventListener("change", notify);
};

// 服务端渲染和水合用 26（手机在水合之后立刻换成 13）
export function useHeatWeeks(): number {
  const phone = useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches, () => false);

  return phone ? HEAT_WEEKS_PHONE : HEAT_WEEKS;
}
