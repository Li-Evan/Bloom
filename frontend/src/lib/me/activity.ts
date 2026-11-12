const pad = (n: number) => String(n).padStart(2, "0");

// month 是 0 基月份，和 Date 一致
export const dateKey = (year: number, month: number, day: number) => `${year}-${pad(month + 1)}-${pad(day)}`;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

// 当天的活动量 → 强度 0–4（0 是没有活动）
export function level(count: number): 0 | 1 | 2 | 3 | 4 {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 7) return 3;
  return 4;
}

// 月历：周一开头，前面补空格，再接 1..本月天数
export function monthCells(year: number, month: number): (number | null)[] {
  const days = new Date(year, month + 1, 0).getDate();
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const cells: (number | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  return cells;
}

export interface HeatCell {
  key: string;
  future: boolean;
}

// 热力图：最近 weeks 周，最后一列是今天所在的那一周（周一对齐），今天之后的格子标成 future
export function heatWeeks(today: Date, weeks: number): HeatCell[][] {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(end.getDate() - ((end.getDay() + 6) % 7) - (weeks - 1) * 7);

  const columns: HeatCell[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const column: HeatCell[] = [];
    for (let i = 0; i < 7; i++) {
      column.push({ key: dateKey(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()), future: cursor > end });
      cursor.setDate(cursor.getDate() + 1);
    }
    columns.push(column);
  }

  return columns;
}

// 一天的问候：按浏览器本地时间。5–11 点早上，11–13 点中午，13–18 点下午，18–23 点晚上，其余（23 点到凌晨 5 点）夜深了
export type DayPart = "morning" | "noon" | "afternoon" | "evening" | "night";

export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 13) return "noon";
  if (hour >= 13 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}
