"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { ErrorBar } from "@/components/learn/shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Course } from "@/lib/learn/types";

// 删除课程的确认（应用内对话框，不用 window.confirm）。course 为空就是关着。
// 删除失败时对话框留着，原因写在对话框里（页顶的提示条这时可能在视口外），可以直接再点一次「删除」。
export default function DeleteCourseDialog({
  course,
  opener: openerProp,
  deleting,
  error,
  onClearError,
  onCancel,
  onConfirm,
  fallbackFocus,
}: {
  course: Course | null;
  // 打开它的控件（课程卡片上的「更多」按钮）：菜单关闭时焦点已经不在它上面了，所以由卡片明确告诉对话框
  opener?: HTMLElement | null;
  deleting: boolean;
  error: string;
  onClearError: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  // 打开它的控件随课程一起没了（删除成功）时，焦点改送到这里
  fallbackFocus?: () => HTMLElement | null;
}) {
  const t = useTranslations("learn");
  // Radix 的 Dialog 没有 Trigger，关闭时焦点要自己送回打开它的控件
  const captured = useRef<HTMLElement | null>(null);
  // 关闭的淡出动画里还要显示课程名，所以记住最后一个
  const last = useRef(course);
  if (course) last.current = course;
  const shown = course ?? last.current;

  return (
    <Dialog open={!!course} onOpenChange={(open) => !open && !deleting && onCancel()}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          captured.current =
            openerProp ?? (active instanceof HTMLElement && active !== document.body ? active : null);
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = captured.current?.isConnected
            ? captured.current
            : fallbackFocus?.();
          target?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="text-left">
          <DialogTitle>{t("dashboard.deleteDialog.title")}</DialogTitle>
          <DialogDescription className="text-pretty break-words">
            {shown && t("dashboard.deleteDialog.body", { name: shown.name })}
          </DialogDescription>
        </DialogHeader>
        {error && <ErrorBar message={error} onClose={onClearError} />}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} loading={deleting}>
            {deleting ? t("dashboard.deleteDialog.deleting") : t("dashboard.deleteDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
