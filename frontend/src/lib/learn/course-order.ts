import type { Calendar, Course, LastLesson } from "@/lib/learn/types";

// 每门课「最近学习」的时间：last_lesson 那门课有精确的打开时间；其余的只能从学习日历里取最近有活动的那一天（打开课文或划线提问）。
export interface Studied {
  // 精确时间（ISO），或只知道是哪一天（本地日期 YYYY-MM-DD）
  at: string;
  exact: boolean;
  // 排序用：精确时间取毫秒数，只知道日期的取当天零点（同一天里精确的排在前面）
  sortKey: number;
}

const dayStart = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);

  return new Date(y, (m || 1) - 1, d || 1).getTime();
};

export function studiedByCourse(calendar: Calendar | null, lastLesson: LastLesson | null | undefined): Map<number, Studied> {
  const map = new Map<number, Studied>();
  for (const day of calendar?.days ?? []) {
    for (const course of day.courses) {
      const sortKey = dayStart(day.date);
      const known = map.get(course.course_id);
      if (!known || sortKey > known.sortKey) map.set(course.course_id, { at: day.date, exact: false, sortKey });
    }
  }
  if (lastLesson) {
    const sortKey = Date.parse(lastLesson.opened_at);
    if (Number.isFinite(sortKey)) map.set(lastLesson.course_id, { at: lastLesson.opened_at, exact: true, sortKey });
  }

  return map;
}

// 学过的排在前面，按最近学习的先后；没学过的在后面，按创建时间（新的在前）
export function orderCourses(courses: Course[], studied: Map<number, Studied>): Course[] {
  const created = (course: Course) => Date.parse(course.created_at) || 0;

  return [...courses].sort((a, b) => {
    const sa = studied.get(a.id);
    const sb = studied.get(b.id);
    if (sa && sb && sa.sortKey !== sb.sortKey) return sb.sortKey - sa.sortKey;
    if (sa && !sb) return -1;
    if (!sa && sb) return 1;

    return created(b) - created(a) || b.id - a.id;
  });
}
