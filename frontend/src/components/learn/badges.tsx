"use client";

import { FileText, FlaskConical, FolderOpen, Lightbulb, ScanText, Scissors } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { isPdfReadingName } from "@/lib/learn/files";
import { LANGUAGE_NAMES, foreignLanguage } from "@/lib/learn/language";
import type { Course, LearningDepth } from "@/lib/learn/types";

const DEPTHS: LearningDepth[] = ["simple", "standard", "deep"];

// 主题 / 资料 / 项目 / PDF 阅读版：上传原文建的课、带着资料文件建的课（有 source_filename）都算「资料」；
// PDF 阅读版是项目课，文件名是 xxx.pdf.md；网页剪藏也是项目课，单独标出来
export function courseKind(
  course: Pick<Course, "is_project" | "mode"> & { source_filename?: string | null; is_clippings?: boolean }
) {
  if (course.is_clippings) return "clippings";
  if (course.is_project) return isPdfReadingName(course.source_filename) ? "pdf" : "project";

  return course.mode === "source" || course.source_filename ? "source" : "topic";
}

const KIND_ICON = {
  topic: Lightbulb,
  source: FileText,
  project: FolderOpen,
  pdf: ScanText,
  clippings: Scissors,
} as const;

// 实验性功能的标记（PDF 阅读版）：琥珀色描边，和正式功能区分开
export function ExperimentalBadge({ label }: { label: string }) {
  return (
    <Badge variant="outline" className="border-warning/50 text-warning">
      <FlaskConical aria-hidden="true" />
      {label}
    </Badge>
  );
}

// 课程的小徽标：开始方式（主题 / 资料 / 项目）、学习深度（项目课没有）、课程语言（只在和界面语言不同时）
export function CourseBadges({
  course,
  className,
  lead,
}: {
  course: Pick<
    Course,
    "is_project" | "mode" | "learning_depth" | "language" | "source_filename" | "is_clippings"
  >;
  className?: string;
  // 排在最前面的徽标（课程页放学习状态）
  lead?: React.ReactNode;
}) {
  const t = useTranslations("learn");
  const locale = useLocale();
  const kind = courseKind(course);
  const Icon = KIND_ICON[kind];
  const depth = DEPTHS.includes(course.learning_depth as LearningDepth)
    ? course.learning_depth
    : "standard";
  const language = foreignLanguage(course.language, locale);

  return (
    <div className={className ?? "flex flex-wrap items-center gap-1.5"}>
      {lead}
      <Badge variant="secondary">
        <Icon aria-hidden="true" />
        {t(`common.modes.${kind}`)}
      </Badge>
      {kind === "pdf" && <ExperimentalBadge label={t("common.experimental")} />}
      {kind !== "project" && kind !== "pdf" && kind !== "clippings" && (
        <Badge variant="outline">{t(`depth.${depth}.label`)}</Badge>
      )}
      {language && <Badge variant="outline">{LANGUAGE_NAMES[language]}</Badge>}
    </div>
  );
}

// 进度条：role=progressbar，颜色全走令牌
export function ProgressBar({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-border ${className ?? ""}`}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
