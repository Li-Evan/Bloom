import { displayFileName } from "@/lib/learn/files";
import { zhTypography } from "@/lib/learn/lesson-text";
import type { Course, Lesson, LessonItem } from "@/lib/learn/types";

// 模型写的课文标题常带编号前缀（「02 · …」「第 2 篇：…」「Lesson 2: …」）。列表里编号单独显示，标题里去掉免得重复。
// 只认真的编号写法，宁可漏掉也不能误伤标题本身（「1-on-1 tutoring」「10 ways to remember」「1.5 million users」「3:2 odds」）：
// - 第 N 篇 / 课 / 节 / 章，后面可跟标点
// - Lesson / Chapter / Part N 加标点（. · : ： 、）
// - 一到三位数字 + 标点（. · : ： 、 ｜ | )），标点后面不能紧跟数字（1.5、3:30）；「04｜过度自信」是模型常写的格式
// - 数字 + 前后带空格的破折号（「01 - xx」「01 — xx」）
// - 补零的两位数字 + 空格（「01 xx」）：不补零的「3 things」「10 ways」是标题的一部分，不动
const NUMBER_PREFIX = new RegExp(
  "^\\s*(?:" +
    [
      "第\\s*\\d{1,3}\\s*[篇课节章]\\s*[.·:：、\\-—–]?\\s*",
      "(?:lesson|chapter|part)\\s*\\d{1,3}\\s*(?:[.·:：、](?!\\d)|\\s[\\-—–])\\s*",
      "\\d{1,3}\\s*(?:[.·:：、｜|](?!\\d)|\\))\\s*",
      "\\d{1,3}\\s+[\\-—–]\\s+",
      "0\\d\\s+(?=\\S)",
    ].join("|") +
    ")",
  "i"
);

export function lessonTitle(title: string | null | undefined): string {
  const text = (title ?? "").trim();
  const stripped = text.replace(NUMBER_PREFIX, "").trim();

  return stripped || text;
}

// 列表、导航、继续学习卡、笔记里显示的课文标题：去掉编号之后，和课文里的 H1 一样做中文排版（直引号换弯引号），
// 到处看到的是同一个标题。搜索、导出用不带排版的 lessonTitle（用户搜索时敲的是直引号）。
export const displayLessonTitle = (title: string | null | undefined): string => zhTypography(lessonTitle(title));

type Translate = (key: string, values?: Record<string, string | number>) => string;

// 浏览器标签页上的课文标题（不带「| Bloom」）：资料课写文件名，课文写「第 N 篇：标题」，目录里还没有标题时只写编号。
// t 是 learn 命名空间的翻译。课文页（DocumentTitle）和服务端的页面元数据用同一条规则，水合前后标题一致
export function lessonTabTitle(
  t: Translate,
  number: number,
  { lesson, course, lessons }: { lesson: Lesson | null; course: Course | null; lessons: LessonItem[] | null }
): string {
  const numberLabel = t("common.lessonNumber", { number });
  if (course?.is_project) return displayFileName(lesson?.source_filename ?? "") || numberLabel;
  const title = lessons?.find((l) => l.number === number)?.title;

  return title ? t("lesson.tabTitle", { number, title: displayLessonTitle(title) || "" }) : numberLabel;
}

export type SortBy = "name" | "time";
export type SortDir = "asc" | "desc";

// 项目课的文件列表：可以按名称或时间排。序号按排好之后的位置编（课程页里的 ordinal），不沿用后端的 number。
export function sortProjectLessons(
  lessons: LessonItem[],
  sortBy: SortBy,
  sortDir: SortDir,
  locale: string
): LessonItem[] {
  const name = (l: LessonItem) => l.source_filename || l.title || "";

  return [...lessons].sort((a, b) => {
    const cmp =
      sortBy === "time"
        ? new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
          a.number - b.number
        : name(a).localeCompare(name(b), locale, { numeric: true });

    return sortDir === "asc" ? cmp : -cmp;
  });
}

// 「继续学习」去哪一篇：按编号顺序第一篇没读的；都读过就回到最后一篇。
// 项目课的文件列表可以按名称 / 时间重排，继续目标不跟着排序变：一律按后端的编号算，和后端 last_lesson 同一条规则
// （项目课 = 第一个没读的文件）。全读完时后端落在「最近打开的那个文件」，列表接口没有打开时间，这里落在编号最后一个。
export function continueLesson(lessons: LessonItem[]): LessonItem | undefined {
  const ordered = [...lessons].sort((a, b) => a.number - b.number);

  return ordered.find((l) => !l.is_read) ?? ordered[ordered.length - 1];
}
