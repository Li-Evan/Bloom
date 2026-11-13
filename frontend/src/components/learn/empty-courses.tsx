"use client";

import { FolderOpen, Lightbulb, Link2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import BellCurve from "@/components/brand/bell-curve";
import Eyebrow from "@/components/brand/eyebrow";
import { EmptyAction } from "@/components/learn/empty-state";
import { Button } from "@/components/ui/button";
import type { CreateMode } from "@/components/learn/new-course-dialog";
import { cardInteractive } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const WAYS = [
  { mode: "topic", Icon: Lightbulb, label: "modeTopic", desc: "modeTopicDesc" },
  { mode: "project", Icon: FolderOpen, label: "modeProject", desc: "modeProjectDesc" },
  { mode: "web", Icon: Link2, label: "modeWeb", desc: "modeWebDesc" },
] as const;

// 还没有课程：「有行动」的空状态（小号钟形曲线只给这一页）+ 新建课程按钮——整页唯一的那一个，页头不再放第二个；
// 下面是三种开始方式（点哪张就以哪种方式打开新建课程）。
export default function EmptyCourses({
  onStart,
  buttonRef,
}: {
  onStart: (mode: CreateMode) => void;
  // 对话框关闭后焦点没处去时送到这个按钮（页头的按钮此时不存在）
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const t = useTranslations("learn");

  return (
    <>
      <EmptyAction
        art={<BellCurve tone="auto" className="mx-auto w-56 sm:w-64" />}
        title={t("dashboard.empty.title")}
        text={t("dashboard.empty.hint")}
        className="sm:py-14 [&_h2]:mt-8"
      >
        <Button ref={buttonRef} size="lg" onClick={() => onStart("topic")}>
          <Plus aria-hidden="true" />
          {t("dashboard.newCourse")}
        </Button>
      </EmptyAction>

      <section className="mt-10">
        <Eyebrow className="mb-4">{t("dashboard.empty.ways")}</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-3">
          {WAYS.map(({ mode, Icon, label, desc }) => (
            <button
              key={mode}
              type="button"
              onClick={() => onStart(mode)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border bg-card p-4 text-left",
                cardInteractive
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Icon className="size-4 text-accent-foreground" strokeWidth={1.8} aria-hidden="true" />
                  {t(`dashboard.form.${label}`)}
                </span>
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {t(`dashboard.form.${desc}`)}
              </span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
