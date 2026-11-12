"use client";

import { useEffect, useRef, useState } from "react";
import { FlaskConical, FolderOpen, Link2, ScanText, Upload, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ExperimentalBadge } from "@/components/learn/badges";
import CreatingDialog, { type UploadProgress } from "@/components/learn/creating-dialog";
import { ErrorBar } from "@/components/learn/shell";
import { useLearnError } from "@/components/learn/use-learn-error";
import WebCourseFields from "@/components/learn/web-course-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { addCourseMaterials } from "@/lib/learn/api";
import {
  PDF_READING_MAX_FILES,
  PDF_READING_MAX_PAGES,
  filesFromDataTransfer,
  formatFileSize,
  isPdfFile,
} from "@/lib/learn/files";
import type { Course } from "@/lib/learn/types";
import { type WebPreview, webArticleFilename, webArticleMarkdown } from "@/lib/learn/web-import";
import { cn } from "@/lib/utils";

export type AddMode = "files" | "web" | "pdf";

const MODES = [
  { mode: "files", Icon: FolderOpen, label: "modeProject" },
  { mode: "web", Icon: Link2, label: "modeWeb" },
  { mode: "pdf", Icon: ScanText, label: "modePdf" },
] as const;

const dropZone = (active: boolean) =>
  cn(
    "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-7 text-center transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
    active ? "border-ring bg-accent" : "border-input bg-muted/50 hover:bg-muted"
  );

// 往项目文件、网页原文、PDF 阅读版建的课里再加资料：三种方式和新建课程时一样处理，新课文接在已有文件后面。
// 课文语言跟着这门课走，不再选。处理中换成等待弹窗；有文件读不了被跳过时留在对话框里说清楚是哪几个。
export default function AddMaterialsDialog({
  open,
  onOpenChange,
  course,
  initialMode = "files",
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  course: Pick<Course, "id">;
  initialMode?: AddMode;
  // 请求结束就调用（成功时带上新课文的编号）：没收到应答时也可能已经加上了，由课程页重新取一次列表
  onAdded: (added: number[] | null) => void;
}) {
  const t = useTranslations("learn");
  const locale = useLocale();
  const report = useLearnError();
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [files, setFiles] = useState<File[]>([]);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [webUrl, setWebUrl] = useState("");
  const [webPreview, setWebPreview] = useState<WebPreview | null>(null);
  const [adding, setAdding] = useState(false);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState<string[] | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setFiles([]);
    setPdfFiles([]);
    setWebUrl("");
    setWebPreview(null);
    setError("");
    setSkipped(null);
  }, [open, initialMode]);

  const addPdfFiles = (incoming: FileList | File[] | null) => {
    const all = Array.from(incoming || []);
    const accepted = all.filter(isPdfFile);
    if (accepted.length < all.length) setError(t("dashboard.errors.pdfType"));
    const key = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
    const existing = new Set(pdfFiles.map(key));
    const merged = [...pdfFiles, ...accepted.filter((file) => !existing.has(key(file)))];
    if (merged.length > PDF_READING_MAX_FILES) {
      setError(t("dashboard.errors.tooManyPdfs", { max: PDF_READING_MAX_FILES, ignored: merged.length - PDF_READING_MAX_FILES }));
    }
    setPdfFiles(merged.slice(0, PDF_READING_MAX_FILES));
  };

  const ready = mode === "files" ? files.length > 0 : mode === "pdf" ? pdfFiles.length > 0 : !!webPreview;

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (adding || skipped) return;
    if (!ready) {
      if (mode !== "web") setError(t(mode === "pdf" ? "dashboard.errors.pdfRequired" : "dashboard.errors.projectRequired"));
      return;
    }
    setError("");
    setAdding(true);
    setUpload(null);
    let added: number[] | null = null;
    try {
      const chosen = mode === "web"
        ? [new File([webArticleMarkdown(webPreview!, t("dashboard.web.source"))], webArticleFilename(webPreview!.title), { type: "text/markdown" })]
        : mode === "pdf" ? pdfFiles : files;
      const result = await addCourseMaterials(course.id, mode, chosen, (sent, total) => setUpload({ sent, total }));
      added = result.added;
      if (!mountedRef.current) return;
      if (result.skipped_files.length) setSkipped(result.skipped_files);
      else onOpenChange(false);
    } catch (err) {
      if (mountedRef.current) setError(report(err));
    } finally {
      if (mountedRef.current) setAdding(false);
      onAdded(added);
    }
  };

  return (
    <>
      <Dialog open={open && !adding} onOpenChange={(next) => !adding && onOpenChange(next)}>
        <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(46rem,calc(100dvh-2rem))] sm:max-w-2xl max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0">
          <form onSubmit={handleAdd} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="px-6 pb-4 pt-6 pr-12 text-left">
              <DialogTitle className="text-xl">{t("course.add.title")}</DialogTitle>
              <DialogDescription>{t("course.add.description")}</DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6 pt-1">
              <div role="group" aria-label={t("course.add.modeLabel")} className="grid grid-cols-3 gap-2">
                {MODES.map(({ mode: m, Icon, label }) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    disabled={!!skipped}
                    onClick={() => { setMode(m); setError(""); }}
                    className={cn(
                      "flex min-h-11 items-center justify-center gap-2 rounded-lg border px-2 py-2.5 text-sm font-semibold transition-colors max-sm:flex-col max-sm:gap-1 max-sm:text-xs disabled:opacity-50",
                      mode === m ? "border-ring bg-accent" : "border-border bg-card hover:border-primary/40"
                    )}
                  >
                    <Icon
                      className={cn("size-4 shrink-0", mode === m ? "text-accent-foreground" : "text-muted-foreground")}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    {t(`dashboard.form.${label}`)}
                  </button>
                ))}
              </div>

              {mode === "files" && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">{t("dashboard.form.projectLabel")}</span>
                  <label
                    onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                    onDragLeave={() => setDrag(false)}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setDrag(false);
                      const dropped = await filesFromDataTransfer(e.dataTransfer);
                      if (dropped.length) setFiles(dropped);
                    }}
                    className={dropZone(drag)}
                  >
                    <Upload className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
                    <span className="text-sm">
                      {files.length ? t("dashboard.form.projectSelected", { count: files.length }) : t("dashboard.form.projectDrop")}
                    </span>
                    <span className="text-xs text-muted-foreground">{t("dashboard.form.projectFolderHint")}</span>
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      disabled={!!skipped}
                      onChange={(e) => setFiles(Array.from(e.target.files || []))}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">{t("course.add.filesNote")}</p>
                </div>
              )}

              {mode === "web" && <WebCourseFields url={webUrl} onUrlChange={setWebUrl} preview={webPreview} onPreview={setWebPreview} />}

              {mode === "pdf" && (
                <div className="space-y-3">
                  <div role="note" className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm leading-relaxed">
                    <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                    <div className="space-y-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                        {t("dashboard.form.pdfExperimentalTitle")}
                        <ExperimentalBadge label={t("common.experimental")} />
                      </p>
                      <p className="text-muted-foreground">{t("dashboard.form.pdfExperimentalBody")}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-sm font-medium">{t("dashboard.form.pdfLabel")}</span>
                    <label
                      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                      onDragLeave={() => setDrag(false)}
                      onDrop={async (e) => {
                        e.preventDefault();
                        setDrag(false);
                        addPdfFiles(await filesFromDataTransfer(e.dataTransfer));
                      }}
                      className={dropZone(drag)}
                    >
                      <Upload className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
                      <span className="text-sm">
                        {pdfFiles.length ? t("dashboard.form.projectSelected", { count: pdfFiles.length }) : t("dashboard.form.pdfDrop")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t("dashboard.form.pdfLimits", { files: PDF_READING_MAX_FILES, pages: PDF_READING_MAX_PAGES })}
                      </span>
                      <input
                        type="file"
                        multiple
                        accept=".pdf,application/pdf"
                        className="sr-only"
                        disabled={!!skipped}
                        onChange={(e) => {
                          addPdfFiles(e.target.files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  {pdfFiles.length > 0 && (
                    <ul className="space-y-1.5" aria-live="polite">
                      {pdfFiles.map((file, index) => (
                        <li
                          key={`${file.name}:${file.size}:${file.lastModified}`}
                          className="flex min-h-11 items-center gap-3 rounded-lg border bg-card pl-3 pr-1"
                        >
                          <span className="font-mono text-[11px] font-medium text-accent-foreground">PDF</span>
                          <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{formatFileSize(file.size)}</span>
                          <button
                            type="button"
                            onClick={() => setPdfFiles((list) => list.filter((_, i) => i !== index))}
                            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t("dashboard.form.removeFile", { name: file.name })}
                          >
                            <X className="size-4" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs leading-relaxed text-muted-foreground">{t("course.add.pdfNote")}</p>
                </div>
              )}
            </div>

            <div className="space-y-3 border-t bg-card px-6 py-4">
              {error && <ErrorBar message={error} onClose={() => setError("")} />}
              {skipped && (
                <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
                  {t("course.add.skippedFiles", { count: skipped.length, names: skipped.slice(0, 5).join(locale.startsWith("zh") ? "；" : "; ") })}
                </p>
              )}
              <div className="flex flex-wrap-reverse items-center justify-end gap-3 max-sm:[&>button]:flex-1">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {skipped ? t("common.close") : t("common.cancel")}
                </Button>
                {!skipped && (
                  <Button type="submit" disabled={!ready}>
                    {mode === "web" ? t("dashboard.web.submit") : mode === "pdf" ? t("course.add.submitPdf") : t("course.add.submit")}
                  </Button>
                )}
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <CreatingDialog open={adding} upload={upload} kind={mode === "pdf" ? "pdf" : "project"} adding />
    </>
  );
}
