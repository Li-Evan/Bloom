"use client";

import { useRef } from "react";
import { Check, Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { CourseBadges, ProgressBar } from "@/components/learn/badges";
import { cardInteractive } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";
import { courseProgress } from "@/lib/learn/progress";
import type { Studied } from "@/lib/learn/course-order";
import { formatDay, studiedLabel } from "@/lib/learn/time";
import type { Course } from "@/lib/learn/types";
import { cn } from "@/lib/utils";

// 课程卡片：整张卡是一个链接（标题上的拉伸链接），右上角的「更多」菜单压在它上面，改名和删除收在菜单里（删除仍走确认对话框）。
// 菜单按钮在能悬停的设备上悬停或键盘聚焦时才出现；触屏上一直可见（不用悬停就看不到、也不会一碰就误删）。
export default function CourseCard({
  course,
  studied: lastStudied,
  onRename,
  onDelete,
}: {
  course: Course;
  // 这门课最近学习的时间（精确到时刻，或只知道是哪一天）；没学过就没有
  studied?: Studied;
  // opener：菜单按钮，关掉改名 / 取消删除后焦点送回它
  onRename: (course: Course, opener: HTMLElement | null) => void;
  onDelete: (course: Course, opener: HTMLElement | null) => void;
}) {
  const t = useTranslations("learn");
  const locale = useLocale();
  const more = useRef<HTMLButtonElement>(null);
  const progress = courseProgress(course);
  const completed = progress.completed;
  const percent = progress.percent;
  // 学过的写「最近学习 X」（今天「今天 09:15」、只知道哪一天就「今天」，昨天「昨天」，更早写日期，同一个列表里写法一致），没学过的写「创建于 X」
  const studied = lastStudied ? studiedLabel(lastStudied, locale) : null;
  const nameId = `course-name-${course.id}`;
  // 进度条悬停时说明这个数怎么来的：已讲到几个要点（项目课：已读几个文件）；已完成的课不写数字
  const progressTitle =
    !completed && progress.total > 0
      ? t(
          course.is_project
            ? "dashboard.card.progressFilesTitle"
            : "dashboard.card.progressTitle",
          { covered: progress.covered, total: progress.total }
        )
      : undefined;

  return (
    <article
      className={cn(
        "group relative flex min-w-0 flex-col rounded-xl border bg-card p-5",
        cardInteractive
      )}
    >
      <CourseBadges
        course={course}
        className="flex flex-wrap items-center gap-1.5 pr-9"
      />
      <h2 className="mt-4 line-clamp-2 min-h-[3.25rem] break-words text-lg leading-snug">
        <Link
          id={nameId}
          href={`/learn/course/${course.id}`}
          // 整张卡是这个链接的 ::after 拉伸出来的：轮廓画在整卡上（::after），链接自己（标题文字）不再画第二圈
          className="rounded-sm after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
        >
          {course.name}
        </Link>
      </h2>

      <div className="mt-5 flex items-center gap-3" title={progressTitle}>
        <ProgressBar
          value={completed ? 1 : course.mastery_progress}
          label={progressTitle ?? course.name}
        />
        {completed ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-accent-foreground">
            <Check className="size-3.5" aria-hidden="true" />
            {t("common.completed")}
          </span>
        ) : (
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {percent}%
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {course.is_project
          ? t("course.fileCount", { count: course.lesson_count })
          : t("common.lessonCount", { count: course.lesson_count })}
        <span aria-hidden="true"> · </span>
        {studied
          ? t("dashboard.card.lastStudied", { time: studied })
          : t("dashboard.card.createdOn", {
              date: formatDay(course.created_at, locale),
            })}
      </p>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={more}
            type="button"
            // 名字只写「更多操作」，课名用 aria-describedby 关联：读屏仍然知道是哪一门，按名字找控件时不会把这个按钮当成课名
            aria-label={t("dashboard.card.moreLabel")}
            aria-describedby={nameId}
            className="absolute right-2.5 top-2.5 z-10 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:bg-muted data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onRename(course, more.current)}>
            <Pencil aria-hidden="true" />
            {t("dashboard.card.renameItem")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onDelete(course, more.current)}
          >
            <Trash2 aria-hidden="true" />
            {t("dashboard.card.deleteItem")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  );
}
