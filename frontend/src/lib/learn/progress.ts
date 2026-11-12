// 课程进度各处（课程页右栏、大纲页、课程卡、用户中心概览）统一的口径：
// 数字只用后端给的 mastery_covered / mastery_total / mastery_progress，不在前端编造；
// 已完结的课显示「已完成」，不写「total / total」（完结不等于每个要点都「讲到」了，比如评估篇生成了总结就算完结）。
export interface Progress {
  completed: boolean;
  percent: number;
  covered: number;
  total: number;
}

export function courseProgress(course: {
  status: string;
  mastery_progress: number;
  mastery_covered?: number;
  mastery_total?: number;
}): Progress {
  const total = Math.max(0, course.mastery_total ?? 0);
  const covered = Math.min(Math.max(0, course.mastery_covered ?? 0), total);

  return {
    completed: course.status === "completed",
    percent: Math.round(course.mastery_progress * 100),
    covered,
    total,
  };
}
