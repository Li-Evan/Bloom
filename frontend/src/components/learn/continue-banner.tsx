"use client";

import { ArrowRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Eyebrow from "@/components/brand/eyebrow";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { displayLessonTitle } from "@/lib/learn/lessons";
import { relativeTime } from "@/lib/learn/time";
import type { LastLesson } from "@/lib/learn/types";

// 「继续学习」横幅：最近打开的那一篇（来自 /api/stats 的 last_lesson），一键回到上次停下的地方。
export default function ContinueBanner({ lesson }: { lesson: LastLesson }) {
  const t = useTranslations("learn");
  const locale = useLocale();
  const number = String(lesson.lesson_number);
  const ago =
    relativeTime(lesson.opened_at, locale) ?? t("common.justNow");

  return (
    <section
      aria-label={t("dashboard.continue.eyebrow")}
      className="mb-6 flex flex-col gap-5 rounded-xl border border-primary/30 bg-accent p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
    >
      <div className="min-w-0">
        <Eyebrow>{t("dashboard.continue.eyebrow")}</Eyebrow>
        <h2
          title={displayLessonTitle(lesson.lesson_title) || undefined}
          className="mt-2 line-clamp-2 break-words text-xl sm:text-2xl"
        >
          {displayLessonTitle(lesson.lesson_title) ||
            t("common.lessonNumber", { number })}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          <span className="break-words font-medium text-foreground">
            {lesson.course_name}
          </span>
          <span aria-hidden="true"> · </span>
          {t("common.lessonNumber", { number })}
          <span aria-hidden="true"> · </span>
          {t("dashboard.continue.last", { time: ago })}
        </p>
      </div>
      <Button asChild size="lg" className="shrink-0">
        <Link
          // 课程已完结：继续学习去课程页（总结在那里），而不是回到最后一篇课文
          href={
            lesson.course_completed
              ? `/learn/course/${lesson.course_id}`
              : `/learn/course/${lesson.course_id}/lesson/${lesson.lesson_number}`
          }
          // 课程已完结时链接去课程页，读屏读出的名字要和链接目标一致
          aria-label={
            lesson.course_completed
              ? t("dashboard.continue.ariaCompleted", { course: lesson.course_name })
              : t("dashboard.continue.aria", {
                  course: lesson.course_name,
                  number: lesson.lesson_number,
                })
          }
        >
          {t("dashboard.continue.cta")}
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}
