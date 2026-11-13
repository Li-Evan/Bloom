"use client";

import { useEffect, useState } from "react";
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
import { editLesson } from "@/lib/learn/api";
import { displayFileName, splitFileName } from "@/lib/learn/files";

// 后端文件名最多 200 字（不含扩展名）
const NAME_MAX_CHARS = 200;

// 给资料类课程里的一个文件改名：课程页和课文页文件列表的「更多」菜单打开它。只改名字，扩展名和所在文件夹不变，
// 和别的文件重名时后端加「 (2)」。file 为空就是关着；保存失败时原因写在对话框里，可以直接再存一次。
export default function RenameFileDialog({
  courseId,
  file,
  onClose,
  onRenamed,
}: {
  courseId: string | number;
  file: { number: number; filename: string } | null;
  onClose: () => void;
  onRenamed: (renamed: { number: number; source_filename: string | null }) => void;
}) {
  const t = useTranslations("learn");
  const report = useLearnError();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parts = splitFileName(file?.filename ?? "");
  // 和文件列表一样不显示 .md：notes.md 不提扩展名，paper.pdf.md 显示 .pdf
  const suffix = displayFileName(parts.suffix);

  useEffect(() => {
    if (!file) return;
    setName(splitFileName(file.filename).stem);
    setError("");
  }, [file]);

  const tidy = name.split(/\s+/).filter(Boolean).join(" ");
  const tooLong = Array.from(tidy).length > NAME_MAX_CHARS;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || saving || tooLong) return;
    if (!tidy) {
      setError(t("course.renameFile.empty"));
      return;
    }
    if (tidy === parts.stem) {
      onClose();
      return;
    }
    setSaving(true);
    setError("");
    try {
      onRenamed(await editLesson(courseId, file.number, { name: tidy }));
      onClose();
    } catch (err) {
      setError(report(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="space-y-4">
          <DialogHeader className="text-left">
            <DialogTitle>{t("course.renameFile.title")}</DialogTitle>
            <DialogDescription className="text-pretty">
              {suffix ? t("course.renameFile.description", { suffix }) : t("course.renameFile.descriptionPlain")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="rename-file" className="text-sm font-medium">
              {t("course.renameFile.label")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="rename-file"
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
              {suffix && <span className="shrink-0 font-mono text-sm text-muted-foreground">{suffix}</span>}
            </div>
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
