// 用推荐建课再标记「已开始」。建课成功之后，标记失败不能让同一次点击退回到「还能再建一门」的状态：
// 返回已建好的课程和标记的错误，由调用方把课程放进列表、把推荐移出列表，错误只作提示。
// started 记着已经建过课的推荐（建课开始时就记，建课本身失败才撤销），同一条推荐不会建第二次；
// 返回 null 表示这条推荐已经在处理或已建过课。
export async function startRecommendationCourse<C extends { id: number }>({
  item,
  started,
  create,
  link,
}: {
  item: { id: number };
  started: Set<number>;
  create: () => Promise<C>;
  link: (recommendationId: number, courseId: number) => Promise<unknown>;
}): Promise<{ course: C; linkError?: unknown } | null> {
  if (started.has(item.id)) {
    return null;
  }

  started.add(item.id);
  let course: C;
  try {
    course = await create();
  } catch (err) {
    started.delete(item.id);
    throw err;
  }

  try {
    await link(item.id, course.id);
  } catch (linkError) {
    return { course, linkError };
  }

  return { course };
}
