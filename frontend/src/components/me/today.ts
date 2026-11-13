"use client";

import { useSyncExternalStore } from "react";

import { dateKey } from "@/lib/me/activity";

const subscribe = () => () => {};

// 浏览器本地的「今天」（YYYY-MM-DD）。服务端不知道用户的时区，所以服务端与首次水合返回 null，水合后才有值。
export function useTodayKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const now = new Date();
      return dateKey(now.getFullYear(), now.getMonth(), now.getDate());
    },
    () => null
  );
}
