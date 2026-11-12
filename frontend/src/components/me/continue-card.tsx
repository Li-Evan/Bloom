import { ArrowRight, Sprout } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EmptyAction } from "@/components/learn/empty-state";
import Mono from "@/components/brand/mono";
import LocalTime from "@/components/me/local-time";
import { CARD_TITLE } from "@/components/me/page-head";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { courseProgress } from "@/lib/learn/progress";
import { displayLessonTitle } from "@/lib/learn/lessons";
import type { CourseBrief, LastLesson } from "@/lib/me/types";

// 概览最上面的大卡片：上次读到哪，一键接着读。没有读过的课文时，引导去建第一门课。
export default async function ContinueCard({
  last,
  course,
  hasCourses,
}: {
  last: LastLesson | null;
  course: CourseBrief | undefined;
  hasCourses: boolean;
}) {
  const t = await getTranslations("me.overview");

  if (!last) {
    return (
      <EmptyAction
        title={hasCourses ? t("continue_none_title") : t("empty_title")}
        text={hasCourses ? t("continue_none_text") : t("empty_text")}
      >
        <Button asChild>
          {/* 还没有课程：直接打开新建课程对话框（/learn?new=1），有课程但没读过：回我的课程 */}
          <Link href={hasCourses ? "/learn" : "/learn?new=1"}>
            {hasCourses ? t("open_courses") : t("new_course")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </EmptyAction>
    );
  }

  // 课程已完结：继续学习去课程页（总结在那里），而不是回到最后一篇课文
  const lessonHref = last.course_completed
    ? `/learn/course/${last.course_id}`
    : `/learn/course/${last.course_id}/lesson/${last.lesson_number}`;
  // 数字只用后端的 mastery_covered / mastery_total；已完结的课写「已完成」，不编造「total / total」
  const progress = course ? courseProgress(course) : null;
  const label = course?.is_project ? t("progress_read") : t("mastery");

  return (
    <section className="relative overflow-hidden rounded-xl border border-primary/25 bg-accent/60 p-6 sm:p-8">
      <h2 className={CARD_TITLE}>{t("continue_eyebrow")}</h2>
      <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Sprout className="size-4 shrink-0 text-primary-text" aria-hidden="true" />
        <span className="truncate" title={last.course_name}>{last.course_name}</span>
      </p>
      <h3
        title={displayLessonTitle(last.lesson_title) || undefined}
        className="mt-1.5 line-clamp-2 text-balance text-2xl font-bold tracking-tight sm:text-[1.75rem] sm:leading-tight"
      >
        {displayLessonTitle(last.lesson_title) || t("lesson_n", { number: last.lesson_number })}
      </h3>
      {/* 整行不用等宽字体（汉字会落到系统黑体、数字两边被拉开）：只让数字和拉丁字母用等宽（Mono） */}
      <p className="mt-3 text-xs text-subtle-foreground">
        <Mono text={t("lesson_n", { number: last.lesson_number })} />
        {course ? <Mono text={` · ${t("of_lessons", { count: course.lesson_count })}`} /> : ""}
        {" · "}
        <Mono text={t("last_opened")} /> <LocalTime iso={last.opened_at} mono />
      </p>

      {progress && (
        <div className="mt-5 max-w-sm">
          <div className="flex items-baseline justify-between text-xs text-muted-foreground">
            <span>{label}</span>
            {progress.completed ? (
              <span className="font-medium text-accent-foreground">{t("completed")}</span>
            ) : (
              <span className="font-mono tabular">{progress.percent}%</span>
            )}
          </div>
          <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.completed ? 100 : progress.percent}
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-primary/15"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${progress.completed ? 100 : progress.percent}%` }}
            />
          </div>
          {!progress.completed && progress.total > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t(course?.is_project ? "progress_read_detail" : "mastery_detail", {
                covered: progress.covered,
                total: progress.total,
              })}
            </p>
          )}
        </div>
      )}

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <Button asChild size="lg">
          <Link href={lessonHref}>
            {t("continue")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href={`/learn/course/${last.course_id}`}>{t("open_course")}</Link>
        </Button>
      </div>
    </section>
  );
}
