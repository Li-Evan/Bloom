import { timeFormatOptions } from "@/lib/me/time-style";

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

// 「3 小时前」「yesterday」这种说法，按界面语言。不到一分钟（或时钟略有偏差落在未来）返回 null，由调用方写「刚刚」。
export function relativeTime(
  iso: string,
  locale: string,
  now = Date.now()
): string | null {
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return null;

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of STEPS) {
    if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit);
  }

  return null;
}

// 课程卡上的「最近学习 X」：今天写「今天 09:15」（只知道是哪天就写「今天」），昨天写「昨天」，更早写日期——同一个列表里
// 不再一张写「1小时前」、一张写「10月15日」（后一张其实也是今天）。at 是精确时间（ISO）或本地日期（YYYY-MM-DD），exact 说明是哪一种
export function studiedLabel(studied: { at: string; exact: boolean; sortKey: number }, locale: string, now = new Date()): string {
  const when = new Date(studied.exact ? studied.at : studied.sortKey);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(when)) / 86_400_000);
  if (days !== 0 && days !== 1) return formatDay(when.toISOString(), locale, now);

  const day = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day");
  if (!studied.exact) return day;

  return `${day} ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(when)}`;
}

// 本地时区的日期，和用户中心同一种写法（lib/me/time-style.ts）：今年 10月14日，别的年份带年份
export function formatDay(iso: string, locale: string, now = new Date()): string {
  return new Intl.DateTimeFormat(locale, timeFormatOptions("day", iso, { now })).format(new Date(iso));
}
