"use client";

import { PencilLine } from "lucide-react";
import { useTranslations } from "next-intl";

import { ChaptersButton } from "@/components/learn/lesson-nav";
import { CrumbBar } from "@/components/learn/shell";
import TextSizeMenu from "@/components/learn/text-size-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// 全站顶栏下面的面包屑条：「我的课程 / 课程名 / 第 N 篇」+ 课文按钮（小屏打开课文抽屉）。
// 和课程页、大纲页是同一条（CrumbBar）；这里让它吸顶，往下滚时收起，往上滚时出现（hidden 由课文页根据滚动方向给）。
export default function LessonBar({
  courseId,
  courseName,
  label,
  badge,
  hidden = false,
  onReveal,
  onOpenNav,
  navOpen,
  onEdit,
  textSize = true,
}: {
  courseId: string;
  courseName?: string;
  label?: string;
  badge?: string;
  hidden?: boolean;
  // 键盘焦点落进条里时要让它出现
  onReveal?: () => void;
  // 课文还在加载时不给：「课文」按钮先禁用
  onOpenNav?: () => void;
  navOpen: boolean;
  // 资料类课程的文件：在课文页上改正文和文件名
  onEdit?: () => void;
  // 「字号」按钮：PDF 篇不给（PDF 有自己的缩放，正文字号管不到它）
  textSize?: boolean;
}) {
  const t = useTranslations("learn");

  return (
    <CrumbBar
      sticky
      hidden={hidden}
      onFocusCapture={onReveal}
      items={[
        { label: t("dashboard.title"), href: "/learn" },
        {
          label: courseName ?? <Skeleton className="h-4 w-32" />,
          href: courseName === undefined ? undefined : `/learn/course/${courseId}`,
        },
        { label: label ?? <Skeleton className="h-4 w-14" /> },
      ]}
      actions={
        <>
          {badge && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {badge}
            </Badge>
          )}
          {onEdit && (
            <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
              <PencilLine className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("lesson.edit.button")}</span>
              <span className="sr-only sm:hidden">{t("lesson.edit.button")}</span>
            </Button>
          )}
          {textSize && <TextSizeMenu />}
          <ChaptersButton onClick={onOpenNav} expanded={navOpen} />
        </>
      }
    />
  );
}
