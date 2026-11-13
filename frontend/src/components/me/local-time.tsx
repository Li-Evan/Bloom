"use client";

import { useLocale } from "next-intl";
import { useSyncExternalStore } from "react";

import Mono from "@/components/brand/mono";
import { type TimeStyle, timeFormatOptions } from "@/lib/me/time-style";

const subscribe = () => () => {};

// 时间按浏览器所在时区显示（Intl.DateTimeFormat）。服务端不知道用户在哪个时区，
// 所以服务端渲染与首次水合用 UTC，水合之后立刻换成本地时区，两次渲染一致，不报水合错误。
export function useFormattedTime() {
  const locale = useLocale();
  const local = useSyncExternalStore(subscribe, () => true, () => false);

  return (iso: string, style: TimeStyle = "datetime") =>
    new Intl.DateTimeFormat(locale, timeFormatOptions(style, iso, { timeZone: local ? undefined : "UTC" })).format(new Date(iso));
}

export default function LocalTime({
  iso,
  style = "datetime",
  className,
  mono = false,
}: {
  iso: string;
  style?: TimeStyle;
  className?: string;
  // 只让日期里的数字用等宽字体（汉字「月」「日」仍是正文字体）；外层本来就是等宽的地方不用开
  mono?: boolean;
}) {
  const format = useFormattedTime();
  const text = format(iso, style);

  return (
    <time dateTime={iso} className={className}>
      {mono ? <Mono text={text} /> : text}
    </time>
  );
}
