// 课文页底部的按钮：后端永远是在「最后一篇」之后生成下一篇，所以只有最后一篇上才能给生成按钮；
// 回看更早的课文只给免费的跳转；课程完结后最后一篇上什么都不给。课文列表没加载出来时也不给。
export type NextAction =
  | { kind: "generate" }
  | { kind: "go"; lessonNumber: number }
  | { kind: "none" };

export function nextAction(
  currentNum: number,
  lessons: { number: number }[],
  courseCompleted: boolean
): NextAction {
  if (currentNum < 1 || lessons.length === 0) {
    return { kind: "none" };
  }

  const later = lessons.map((l) => l.number).filter((n) => n > currentNum);
  if (later.length > 0) {
    return { kind: "go", lessonNumber: Math.min(...later) };
  }

  return courseCompleted ? { kind: "none" } : { kind: "generate" };
}
