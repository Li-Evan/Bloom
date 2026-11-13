"use client";

import { useRef, useState } from "react";
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
import { deleteLesson } from "@/lib/learn/api";

// 删掉资料类课程里一个文件的确认。file 为空就是关着；失败时对话框留着，原因写在里面，可以直接再点一次。
export default function DeleteFileDialog({
  courseId,
  file,
  onClose,
  onDeleted,
}: {
  courseId: number;
  file: { number: number; name: string } | null;
  onClose: () => void;
  onDeleted: (file: { number: number; name: string }) => void;
}) {
  const t = useTranslations("learn");
  const report = useLearnError();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  // 关闭的淡出动画里还要显示文件名
  const last = useRef(file);
  if (file) last.current = file;
  const shown = file ?? last.current;

  const close = () => {
    if (deleting) return;
    setError("");
    onClose();
  };

  const confirm = async () => {
    if (!file || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await deleteLesson(courseId, file.number);
      onDeleted(file);
    } catch (err) {
      setError(report(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>{t("course.deleteFile.title")}</DialogTitle>
          <DialogDescription className="text-pretty break-words">
            {shown && t("course.deleteFile.body", { name: shown.name })}
          </DialogDescription>
        </DialogHeader>
        {error && <ErrorBar message={error} onClose={() => setError("")} />}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={close} disabled={deleting}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} loading={deleting}>
            {deleting ? t("course.deleteFile.deleting") : t("course.deleteFile.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
