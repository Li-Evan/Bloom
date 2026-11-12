"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";

import { useLearnError } from "@/components/learn/use-learn-error";
import { Button } from "@/components/ui/button";
import { getLessonFile } from "@/lib/learn/api";

// PDF 阅读版（实验）的课文顶部：说明这是自动转换的、可能和原文有出入，附「查看原 PDF」（原 PDF 和课文存在一起）
export default function PdfReadingNotice({ courseId, lessonNum }: { courseId: string; lessonNum: string }) {
  const t = useTranslations("learn.pdfReading");
  const report = useLearnError();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");

  const openOriginal = async () => {
    // 先开空窗口再填地址：等文件下载完再 window.open 会被浏览器当成弹窗拦掉
    const win = window.open("", "_blank");
    setOpening(true);
    setError("");
    try {
      const data = await getLessonFile(courseId, lessonNum);
      const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
      if (win) win.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      setError(report(e));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div role="note" className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-pretty leading-relaxed text-foreground">{t("notice")}</p>
        <Button type="button" variant="outline" size="sm" loading={opening} onClick={() => void openOriginal()}>
          {t("original")}
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    </div>
  );
}
