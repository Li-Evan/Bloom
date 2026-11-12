"use client";

import { Download } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useBackendError } from "@/hooks/use-backend-error";
import { attachConversations, buildNotesMarkdown, downloadText, fetchAllNotes } from "@/lib/me/export";
import { localePath } from "@/lib/locale-path";

// 「导出为 Markdown」：把自己所有的划线笔记按课程分组存成一个 .md 文件。点了才开始取数据，只读。
// 「我的笔记」页头和设置页各放一个。笔记多时要几秒到几十秒：按钮转圈，字上写进度（先是取了多少条笔记，再是取到第几篇课文的完整对话）
export default function ExportNotes({ variant = "outline" }: { variant?: "outline" | "default" }) {
  const t = useTranslations("me.notes");
  const locale = useLocale();
  const backendError = useBackendError();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setProgress("");
    try {
      const notes = await fetchAllNotes((count) => setProgress(t("export_progress_notes", { count })));
      if (notes.length === 0) {
        toast.info(t("export_empty"));
        return;
      }
      const items = await attachConversations(notes, (done, total) => setProgress(t("export_progress_lessons", { done, total })));
      const today = new Date();
      const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const markdown = buildNotesMarkdown(items, {
        origin: window.location.origin,
        localePath: (path) => localePath(locale, path),
        labels: {
          title: t("export_title"),
          exported: t("export_header", { date, count: notes.length }),
          lesson: (number) => t("lesson_n", { number }),
          summary: t("summary_lesson"),
          question: t("export_q"),
          answer: t("export_a"),
          open: t("open_lesson"),
          truncated: t("export_truncated"),
        },
      });
      downloadText(`bloom-notes-${date}.md`, markdown);
      toast.success(t("export_done", { count: notes.length }));
    } catch (e) {
      toast.error(`${t("export_failed")} ${backendError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant={variant} onClick={run} loading={busy}>
      {!busy && <Download aria-hidden="true" />}
      {busy ? progress || t("exporting") : t("export")}
    </Button>
  );
}
