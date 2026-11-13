"use client";

import dynamic from "next/dynamic";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import Markdown from "@/components/learn/markdown";
import { getLessons, getLesson } from "@/lib/learn/api";
import { splitForDisplay } from "@/lib/learn/progressive-text";
import type { Lesson } from "@/lib/learn/types";
import { useLearnError } from "@/components/learn/use-learn-error";

// 原文正在加载：转圈 + 文字 + 几行骨架，不留一块空白
function SourceLoading() {
  const t = useTranslations("learn.outlineSetup");

  return (
    <div className="space-y-3 py-4">
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="text-primary-text" />
        {t("loading")}
      </p>
      <div aria-hidden="true" className="space-y-2.5">
        {["w-full", "w-11/12", "w-full", "w-4/5", "w-2/3"].map((w, i) => <Skeleton key={i} className={`h-3.5 ${w}`} />)}
      </div>
    </div>
  );
}

const PdfViewer = dynamic(() => import("@/components/learn/pdf-viewer"), { ssr: false, loading: () => <SourceLoading /> });

// 长原文分段显示：先渲染第一段，末尾的哨兵进入滚动区下方 1500px 以内就接上下一段（lib/learn/progressive-text.ts）
function Progressive({ parts, render }: { parts: string[]; render: (part: string) => ReactNode }) {
  const t = useTranslations("learn.outlineSetup");
  const [shown, setShown] = useState(1);
  const sentinel = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShown((n) => n + 1);
      },
      { root: el.closest("[data-reference-scroll]"), rootMargin: "0px 0px 1500px 0px" }
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, [shown]);

  return (
    <>
      {parts.slice(0, shown).map((part, i) => <Fragment key={i}>{render(part)}</Fragment>)}
      {/* 用 span：纯文本原文放在 <pre> 里，里面不能有 <p> */}
      {shown < parts.length && <span ref={sentinel} role="status" className="flex items-center gap-2 py-4 font-sans text-sm text-muted-foreground"><Spinner />{t("loadingMore")}</span>}
    </>
  );
}

// onOpenChange：课文页要知道面板开没开（桌面上面板占了右半屏、右栏被隐藏，划线提问卡片改放到左半屏底部）
export default function SourceMaterial({ courseId, onOpenChange }: { courseId: string; onOpenChange?: (open: boolean) => void }) {
  const t = useTranslations("learn.outlineSetup");
  const common = useTranslations("learn.common");
  const report = useLearnError();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);
  const [source, setSource] = useState<Lesson | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function show() {
    setOpen(true);
    if (source || loading) return;
    setLoading(true);
    setError("");
    try {
      const items = await getLessons(courseId);
      const item = items.find((l) => l.is_source);
      if (!item) { setError(t("sourceMissing")); return; }
      setSource(await getLesson(courseId, item.number));
    } catch (err) { setError(report(err)); }
    finally { setLoading(false); }
  }
  const pdf = source?.source_filename?.toLowerCase().endsWith(".pdf");
  const txt = source?.source_filename?.toLowerCase().endsWith(".txt");
  const parts = useMemo(() => (source && !pdf ? splitForDisplay(source.content, !txt) : []), [source, pdf, txt]);
  return <>
    <Button variant="outline" onClick={show}><BookOpen className="size-4" />{t("source")}</Button>
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetContent data-reference-panel onInteractOutside={(e) => e.preventDefault()} className="h-dvh w-full overflow-hidden p-4 sm:max-w-none lg:w-[50vw] lg:max-w-[50vw]">
        <SheetHeader className="shrink-0"><SheetTitle>{t("source")}</SheetTitle><SheetDescription>{t("sourceHint")}</SheetDescription></SheetHeader>
        <div data-reference-scroll tabIndex={0} role="region" aria-label={t("source")} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          {loading && <SourceLoading />}
          {error && (
            <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <span className="min-w-0 text-pretty">{error}</span>
              <Button variant="outline" size="sm" className="shrink-0" onClick={show}>{common("retry")}</Button>
            </div>
          )}
          {source && (pdf ? <PdfViewer courseId={courseId} lessonNum={String(source.number)} /> : txt
            ? <pre className="whitespace-pre-wrap break-words font-sans"><Progressive parts={parts} render={(part) => <>{part}{"\n"}</>} /></pre>
            : <div className="prose prose-bloom max-w-none"><Progressive parts={parts} render={(part) => <Markdown restoreBold>{part}</Markdown>} /></div>)}
        </div>
      </SheetContent>
    </Sheet>
  </>;
}
