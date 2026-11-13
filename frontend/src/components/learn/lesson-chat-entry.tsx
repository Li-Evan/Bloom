"use client";

import { MessageCircleQuestion } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

// 「问这篇」的入口。桌面（lg 起）放在右栏最上面，样子像一个输入框，点了在右栏打开对话卡片；
// 手机 / 平板右栏不显示，换成右下角的悬浮按钮（PDF 篇往上让出缩放按钮的位置）。
// 参考原文面板开着时桌面的右栏也被让掉了，悬浮按钮在桌面上也出现（desktop）。
export default function LessonChatEntry({
  variant,
  onOpen,
  started = false,
  raised = false,
  desktop = false,
}: {
  variant: "rail" | "fab";
  onOpen: () => void;
  // 这一篇已经问过：入口写「接着问」
  started?: boolean;
  raised?: boolean;
  desktop?: boolean;
}) {
  const t = useTranslations("learn");

  if (variant === "rail") {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("lesson.chatButton")}
        className="flex w-full items-center gap-2.5 rounded-xl border bg-card px-3.5 py-3 text-left text-sm text-muted-foreground shadow-xs transition-colors hover:border-primary/50 hover:text-foreground"
      >
        <MessageCircleQuestion className="size-4 shrink-0 text-primary-text" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{started ? t("lesson.chatEntryContinue") : t("lesson.chatEntry")}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ bottom: `calc(${raised ? "4.75rem" : "1rem"} + env(safe-area-inset-bottom))` }}
      className={cn(
        "fixed right-4 z-30 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-md transition-colors hover:bg-primary-hover",
        !desktop && "lg:hidden"
      )}
    >
      <MessageCircleQuestion className="size-4" aria-hidden="true" />
      {t("lesson.chatButton")}
    </button>
  );
}
