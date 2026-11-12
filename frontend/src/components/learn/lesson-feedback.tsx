"use client";

import { Check, ChevronRight, X } from "lucide-react";
import { forwardRef, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import Eyebrow, { LABEL_CLASS } from "@/components/brand/eyebrow";
import Markdown from "@/components/learn/markdown";
import { useWaited } from "@/components/learn/shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// 课文页下半部分：写反馈（卡片）→ 下一步（单独一块，主按钮）→ 生成下一篇时的流式预览。
// 这里只管样子；保存、生成等动作和它们的状态都在 lesson.tsx 里，按钮只调用传进来的 on* 回调。

export function FeedbackCard({
  content,
  onContentChange,
  thoughts,
  onThoughtsChange,
  showThoughts,
  saved,
  saving,
  disabled,
  onSave,
  children,
}: {
  content: string;
  onContentChange: (value: string) => void;
  thoughts: string;
  onThoughtsChange: (value: string) => void;
  showThoughts: boolean;
  saved: boolean;
  saving: boolean;
  disabled: boolean;
  onSave: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations("learn");

  return (
    <section
      aria-labelledby="lesson-feedback-title"
      className="rounded-xl border bg-card p-5 sm:p-6"
    >
      <h2 id="lesson-feedback-title" className="text-lg">
        {t("lesson.feedback.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("lesson.feedback.hint")}
      </p>
      <Textarea
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        disabled={disabled}
        placeholder={t("lesson.feedback.placeholder")}
        aria-labelledby="lesson-feedback-title"
        className="mt-4 min-h-32 resize-y"
      />
      {showThoughts && (
        <details className="group mt-4">
          <summary className="flex w-fit cursor-pointer select-none items-center gap-1 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight
              className="size-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            {t("lesson.feedback.thoughts")}
          </summary>
          <Textarea
            value={thoughts}
            onChange={(e) => onThoughtsChange(e.target.value)}
            disabled={disabled}
            placeholder={t("lesson.feedback.thoughtsPlaceholder")}
            aria-label={t("lesson.feedback.thoughts")}
            className="mt-3 min-h-24 resize-y"
          />
        </details>
      )}
      {children}
      <div className="mt-4 flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onSave}
          loading={saving}
          disabled={disabled}
        >
          {saving ? t("lesson.feedback.saving") : t("lesson.feedback.save")}
        </Button>
        {saved && (
          <span
            role="status"
            className="inline-flex items-center gap-1 text-sm font-medium text-accent-foreground"
          >
            <Check className="size-4" aria-hidden="true" />
            {t("lesson.feedback.saved")}
          </span>
        )}
      </div>
    </section>
  );
}

// 课文页上的错误条：可关闭；需要的话在关闭按钮前面放别的动作（比如「重试」）。不给 onClose 就没有关闭按钮（只能重试的）
export function LessonNotice({
  message,
  onClose,
  children,
}: {
  message: string;
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  const t = useTranslations("learn");

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <span className="min-w-0 text-pretty">{message}</span>
      <div className="flex shrink-0 items-center gap-3">
        {children}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-sm p-0.5 transition-colors hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function NextStepFrame({
  hint,
  children,
}: {
  hint?: ReactNode;
  children: React.ReactNode;
}) {
  const t = useTranslations("learn");

  return (
    <section
      aria-label={t("lesson.nextStep.label")}
      className="flex flex-col gap-4 rounded-xl border border-primary/30 bg-accent/50 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-6"
    >
      <div className="min-w-0">
        <Eyebrow>{t("lesson.nextStep.label")}</Eyebrow>
        {hint && (
          <p className="mt-1.5 max-w-md text-balance text-sm text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </section>
  );
}

const wide = "h-auto min-h-12 w-full whitespace-normal py-3 text-center sm:w-auto";

// 最后一篇：读完、生成下一篇。blockedReason：暂时不能生成（划线回答还在写），按钮禁用、原因替换掉说明文字
export function GenerateStep({
  label,
  onReadDone,
  blockedReason,
}: {
  label: string;
  onReadDone: () => void;
  blockedReason?: string;
}) {
  const t = useTranslations("learn");

  return (
    <NextStepFrame hint={blockedReason ?? t("lesson.nextStep.generateHint")}>
      <Button type="button" size="lg" onClick={onReadDone} disabled={Boolean(blockedReason)} className={wide}>
        {label}

      </Button>
    </NextStepFrame>
  );
}

// 回看更早的课文：免费跳到下一篇
export function GoNextStep({ href }: { href: string }) {
  const t = useTranslations("learn");

  return (
    <NextStepFrame hint={t("lesson.nextStep.goHint")}>
      <Button asChild size="lg" variant="outline" className={wide}>
        <Link href={href}>
          {t("lesson.next.goNext")}
        </Link>
      </Button>
    </NextStepFrame>
  );
}

// 项目文件：标记已读。hint：开着「读完立刻归档」时，读之前说会归档，读完说已归档并给撤销
export function MarkReadStep({
  read,
  marking,
  onMarkRead,
  hint,
}: {
  read: boolean;
  marking: boolean;
  onMarkRead: () => void;
  hint?: ReactNode;
}) {
  const t = useTranslations("learn");

  return (
    <NextStepFrame hint={hint}>
      <Button
        type="button"
        size="lg"
        variant={read ? "outline" : "default"}
        onClick={onMarkRead}
        loading={marking}
        disabled={read}
        className={cn(wide, read && "disabled:opacity-100")}
      >
        {read ? (
          <>
            <Check aria-hidden="true" />
            {t("common.read")}
          </>
        ) : marking ? (
          t("lesson.marking")
        ) : (
          t("lesson.markRead")
        )}
      </Button>
    </NextStepFrame>
  );
}

// 正文已经出来、又这么久没有新字：当成写完了，后端在核对、保存（最长一分多钟）。后端没有阶段事件，只能这样判断
const SETTLE_MS = 5000;

// 生成下一篇时：流式写出来的内容就摆在这里。最小高度让它的开头可以滚到屏幕顶部，不管已经写了多少。
// 首字之前后端要先排教学计划（最长约 45 秒），正文写完还要核对、保存（最长约 80 秒）：顶上写已等多久；
// 正文末尾跟一条状态行（吸在屏幕底部），读者读到哪儿都看得见还在进行、进行到哪一步
export const GeneratingCard = forwardRef<HTMLElement, { content: string }>(
  function GeneratingCard({ content }, ref) {
    const t = useTranslations("learn");
    // 开始生成时挂上、跳到新课文时卸掉：挂上的时刻就是开始等的时刻
    const [startedAt] = useState(() => Date.now());
    const waited = useWaited(startedAt);
    const [settled, setSettled] = useState("");
    useEffect(() => {
      if (!content) return;
      const timer = setTimeout(() => setSettled(content), SETTLE_MS);
      return () => clearTimeout(timer);
    }, [content]);
    const phase = !content
      ? t("lesson.next.planning")
      : settled === content
        ? t("lesson.next.saving")
        : t("lesson.next.writing");

    return (
      <section
        ref={ref}
        className="min-h-[calc(100dvh-8rem)] rounded-xl border border-primary/30 bg-card p-5 sm:p-8"
      >
        <div className="mb-1 flex items-center gap-2.5">
          <Spinner className="text-primary-text" />
          {/* 不用 <h2>：中文标题的字距被 globals.css 压成 0，盖掉小标签的字距；role + aria-level 保留标题语义 */}
          <p role="heading" aria-level={2} className={cn(LABEL_CLASS, "text-accent-foreground")}>
            {t("lesson.next.generating")}
          </p>
        </div>
        <p className="mb-8 text-sm text-muted-foreground">
          {t("lesson.next.generatingHint")}
        </p>
        {content && (
          // aria-busy 只包正文，不包下面的状态行：包进去的话读屏要等写完才播报，那时提示已经没了
          <div aria-busy="true" className="prose prose-bloom prose-lesson max-w-none">
            <Markdown lesson typography streaming>
              {content}
            </Markdown>
          </div>
        )}
        <p
          role="status"
          className="sticky bottom-4 mt-6 flex w-fit max-w-full items-start gap-2 rounded-lg border bg-card px-3.5 py-2 text-[13px] text-foreground shadow-sm"
        >
          <Spinner className="mt-px text-primary-text" />
          <span className="min-w-0 text-pretty">
            {phase}
            <span aria-hidden="true" className="tabular-nums text-muted-foreground"> · {waited}</span>
          </span>
        </p>
      </section>
    );
  }
);
