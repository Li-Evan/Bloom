import { cache } from "react";
import { backendFetch } from "@/lib/backend";
import type { Course, Lesson, LessonItem, LessonStart } from "@/lib/learn/types";

// 后端冷启动要 4～6 秒：等得起；再久就不等了，交给浏览器照原样再取
const START_TIMEOUT_MS = 10_000;

// 课文页首屏：服务端渲染时就把正文、课程（面包屑、是不是资料课）和课文目录取好，随页面一起到浏览器，
// 不用等 JS 下载、水合、换令牌之后再请求一轮。三条读请求在服务端合成一次 /api/batch（lib/backend.ts）。
// 划线问答、标记、译文、反馈不在这里：正文出来之后浏览器再取。
// 取不到正文（404、后端出错或超时）返回 null，课文页按原来的方式自己取、自己报错。
// 同一次渲染里页面和页面标题（generateMetadata）共用这一次请求
export const lessonStart = cache(async (courseId: string, lessonNum: string): Promise<LessonStart | null> => {
  const signal = AbortSignal.timeout(START_TIMEOUT_MS);
  const read = <T>(path: string) => backendFetch<T>(path, { signal }).catch(() => null);
  const [lesson, course, lessons] = await Promise.all([
    read<Lesson>(`/api/courses/${courseId}/lessons/${lessonNum}`),
    read<Course>(`/api/courses/${courseId}`),
    read<LessonItem[]>(`/api/courses/${courseId}/lessons`),
  ]);

  return lesson ? { lesson, course, lessons } : null;
});
