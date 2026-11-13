"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ErrorBar } from "@/components/learn/shell";
import { useLearnError } from "@/components/learn/use-learn-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { renameCourse } from "@/lib/learn/api";
import type { Course } from "@/lib/learn/types";

// 后端课名最多 200 字（按字符数，emoji 算一个）
const NAME_MAX_CHARS = 200;

// 改课程名：课程页标题旁的铅笔、「我的课程」卡片的「更多」菜单都打开它。course 为空就是关着。
// 课名只有一行，换行和连续空白在提交前并成一个空格（后端同样处理）；保存失败时原因写在对话框里，可以直接再存一次。
export default function RenameCourseDialog({
  course,
  opener,
  onClose,
  onRenamed,
}: {
  course: Pick<Course, "id" | "name"> | null;
  // 打开它的控件（菜单关闭后焦点已经不在它上面，由调用方告诉对话框）
  opener?: HTMLElement | null;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const t = useTranslations("learn");
  const report = useLearnError();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const captured = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!course) return;
    setName(course.name);
    setError("");
  }, [course]);

  const tidy = name.split(/\s+/).filter(Boolean).join(" ");
  const tooLong = Array.from(tidy).length > NAME_MAX_CHARS;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!course || saving) return;
    if (!tidy) {
      setError(t("course.rename.empty"));
      return;
    }
    if (tooLong) return;
    if (tidy === course.name) {
      onClose();
      return;
    }
    setSaving(true);
    setError("");
    try {
      const renamed = await renameCourse(course.id, tidy);
      onRenamed(renamed.name);
      onClose();
    } catch (err) {
      setError(report(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!course} onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          captured.current = opener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (captured.current?.isConnected) captured.current.focus({ preventScroll: true });
        }}
      >
        <form onSubmit={save} className="space-y-4">
          <DialogHeader className="text-left">
            <DialogTitle>{t("course.rename.title")}</DialogTitle>
            <DialogDescription className="text-pretty">{t("course.rename.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="rename-course" className="text-sm font-medium">
              {t("dashboard.form.name")}
            </label>
            <Input
              id="rename-course"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              onFocus={(e) => e.target.select()}
              disabled={saving}
              aria-invalid={tooLong || undefined}
              autoComplete="off"
            />
            {tooLong && (
              <p role="alert" className="text-xs text-destructive">
                {t("course.rename.tooLong", { max: NAME_MAX_CHARS, count: Array.from(tidy).length })}
              </p>
            )}
          </div>
          {error && <ErrorBar message={error} onClose={() => setError("")} />}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={saving} disabled={tooLong}>
              {saving ? t("course.rename.saving") : t("course.rename.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
