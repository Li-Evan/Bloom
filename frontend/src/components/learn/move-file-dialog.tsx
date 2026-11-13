"use client";

import { useEffect, useState } from "react";
import { Check, FolderOpen, FolderPlus } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { getCourses, moveLesson } from "@/lib/learn/api";
import type { Course } from "@/lib/learn/types";
import { cn } from "@/lib/utils";

// 后端课名最多 200 字（按字符数，emoji 算一个）
const NAME_MAX_CHARS = 200;
const NEW = "new";

export type MovedFile = { course_id: number; course_name: string; number: number };

const choice = (selected: boolean) =>
  cn(
    "flex min-h-12 w-full items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors",
    selected ? "border-ring bg-accent" : "border-border bg-card hover:border-primary/40"
  );

// 把资料类课程里的一个文件移到另一门资料类课程，或者新建一门放进去。只列能移入的课：自己的资料类课程，
// 不含 AI 按主题生成的课（后端同样拒绝）。划线、提问、已读记录跟着文件走。file 为空就是关着。
export default function MoveFileDialog({
  courseId,
  file,
  onClose,
  onMoved,
}: {
  courseId: number;
  file: { number: number; name: string } | null;
  onClose: () => void;
  onMoved: (moved: MovedFile) => void;
}) {
  const t = useTranslations("learn");
  const report = useLearnError();
  const [folders, setFolders] = useState<Course[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<number | typeof NEW | null>(null);
  const [newName, setNewName] = useState("");
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file) return;
    setFolders(null);
    setLoadError("");
    setError("");
    setSelected(null);
    setNewName("");
    let alive = true;
    getCourses(true).then(
      (list) => {
        if (!alive) return;
        const options = list.filter((c) => c.is_project && c.id !== courseId);
        setFolders(options);
        // 没有别的资料类课程时，只能新建一门
        if (!options.length) setSelected(NEW);
      },
      (err) => alive && setLoadError(report(err))
    );
    return () => {
      alive = false;
    };
  }, [file, courseId, report]);

  const tidyName = newName.split(/\s+/).filter(Boolean).join(" ");
  const nameTooLong = selected === NEW && Array.from(tidyName).length > NAME_MAX_CHARS;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || moving || selected === null || nameTooLong) return;
    setMoving(true);
    setError("");
    try {
      const moved = await moveLesson(
        courseId,
        file.number,
        selected === NEW ? { new_course_name: tidyName } : { target_course_id: selected }
      );
      onMoved(moved);
      onClose();
    } catch (err) {
      setError(report(err));
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && !moving && onClose()}>
      <DialogContent className="flex max-h-[min(40rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="px-6 pb-4 pt-6 pr-12 text-left">
            <DialogTitle>{t("course.move.title")}</DialogTitle>
            <DialogDescription className="text-pretty break-words">
              {file && t("course.move.description", { name: file.name })}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 pb-4">
            {loadError ? (
              <ErrorBar message={loadError} onClose={() => setLoadError("")} />
            ) : folders === null ? (
              <div aria-busy="true" aria-label={t("common.loading")} className="space-y-2">
                {[0, 1].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
              </div>
            ) : (
              <div role="radiogroup" aria-label={t("course.move.targetLabel")} className="space-y-2">
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    role="radio"
                    aria-checked={selected === folder.id}
                    disabled={moving}
                    onClick={() => setSelected(folder.id)}
                    className={choice(selected === folder.id)}
                  >
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{folder.name}</span>
                      <span className="block text-xs text-muted-foreground">{t("course.fileCount", { count: folder.lesson_count })}</span>
                    </span>
                    {selected === folder.id && <Check className="size-4 shrink-0 text-accent-foreground" aria-hidden="true" />}
                  </button>
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected === NEW}
                  disabled={moving}
                  onClick={() => setSelected(NEW)}
                  className={choice(selected === NEW)}
                >
                  <FolderPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-sm font-medium">{t("course.move.newFolder")}</span>
                  {selected === NEW && <Check className="size-4 shrink-0 text-accent-foreground" aria-hidden="true" />}
                </button>
                {selected === NEW && (
                  <div className="space-y-1.5 pt-1">
                    <label htmlFor="move-new-folder" className="text-sm font-medium">
                      {t("dashboard.form.name")}
                    </label>
                    <Input
                      id="move-new-folder"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("course.move.newFolderPlaceholder")}
                      disabled={moving}
                      aria-invalid={nameTooLong || undefined}
                      autoComplete="off"
                    />
                    {nameTooLong && (
                      <p role="alert" className="text-xs text-destructive">
                        {t("course.rename.tooLong", { max: NAME_MAX_CHARS, count: Array.from(tidyName).length })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
            <p className="pt-1 text-xs leading-relaxed text-muted-foreground">{t("course.move.note")}</p>
          </div>

          <div className="space-y-3 border-t px-6 py-4">
            {error && <ErrorBar message={error} onClose={() => setError("")} />}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={onClose} disabled={moving}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={moving} disabled={selected === null || nameTooLong || !!loadError}>
                {moving ? t("course.move.moving") : t("course.move.submit")}
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
