// 学习区和用户中心共用的日期写法，只有两种：
// 日期：今年 10月14日 / Oct 14，别的年份 2025年10月14日 / Oct 14, 2025；
// 要带时间：今年 10月14日 16:09 / Oct 14, 4:09 PM，别的年份 2025年10月14日 16:09 / Oct 14, 2025, 4:09 PM。
// 不带年份只在今年内用，不然一年前的记录和昨天的记录看起来一样。date 与 day、full 与 datetime 是同一种写法的别名。
const DAY = { month: "short", day: "numeric" } as const;
const DATETIME = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } as const;

export const TIME_STYLES = {
  datetime: DATETIME,
  full: DATETIME,
  day: DAY,
  date: DAY,
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type TimeStyle = keyof typeof TIME_STYLES;

const yearOf = (date: Date, timeZone?: string) =>
  new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(date);

export function timeFormatOptions(
  style: TimeStyle,
  iso: string,
  { now = new Date(), timeZone }: { now?: Date; timeZone?: string } = {}
): Intl.DateTimeFormatOptions {
  const options: Intl.DateTimeFormatOptions = { ...TIME_STYLES[style] };
  if (timeZone) {
    options.timeZone = timeZone;
  }
  const date = new Date(iso);
  if (yearOf(date, timeZone) !== yearOf(now, timeZone)) {
    options.year = "numeric";
  }

  return options;
}
