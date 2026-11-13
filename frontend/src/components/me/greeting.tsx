"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { dayPart } from "@/lib/me/activity";

const subscribe = () => () => {};

// 「晚上好」要按浏览器本地时间。服务端不知道几点，所以服务端与首次水合用中性的「你好」，水合之后换成按时段的问候。
export default function Greeting({ name }: { name: string }) {
  const t = useTranslations("me.overview");
  const hour = useSyncExternalStore(
    subscribe,
    () => new Date().getHours(),
    () => null
  );

  return <>{t(`greeting_${hour === null ? "neutral" : dayPart(hour)}`, { name })}</>;
}
