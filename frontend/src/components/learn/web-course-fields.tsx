"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link2 } from "lucide-react";
import Markdown from "@/components/learn/markdown";
import { useLearnError } from "@/components/learn/use-learn-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { type WebPreview, webArticleMarkdown } from "@/lib/learn/web-import";

export default function WebCourseFields({ url, onUrlChange, preview, onPreview }: {
  url: string;
  onUrlChange: (url: string) => void;
  preview: WebPreview | null;
  onPreview: (preview: WebPreview | null) => void;
}) {
  const t = useTranslations("learn.dashboard.web");
  const report = useLearnError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (preview) previewRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [preview]);

  const extract = async () => {
    if (busy) return;
    try {
      const target = new URL(url.trim());
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error();
    } catch {
      setError(t("invalidUrl"));
      return;
    }
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    onPreview(null);
    try {
      const article = await api<WebPreview>("/api/web-import/preview", {
        method: "POST", json: { url: url.trim() }, signal: abort.signal,
      });
      if (!abort.signal.aborted) onPreview(article);
    } catch (err) {
      if (!abort.signal.aborted) setError(report(err));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };

  return <div className="space-y-3">
    <div className="space-y-1.5">
      <label htmlFor="course-web-url" className="text-sm font-medium">{t("urlLabel")}</label>
      <div className="flex gap-2 max-sm:flex-col">
        <Input id="course-web-url" type="url" value={url} maxLength={4096} placeholder="https://…"
          autoComplete="off" spellCheck={false} aria-describedby="course-web-hint"
          onChange={(event) => {
            controller.current?.abort();
            setBusy(false);
            setError("");
            onPreview(null);
            onUrlChange(event.target.value);
          }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void extract(); } }} />
        <Button type="button" variant="outline" loading={busy} disabled={busy || !url.trim()} onClick={() => void extract()}>
          {!busy && <Link2 className="mr-2 size-4" aria-hidden="true" />}{busy ? t("extracting") : t("extract")}
        </Button>
      </div>
      <p id="course-web-hint" className="text-xs leading-relaxed text-muted-foreground">{t("hint")}</p>
    </div>
    {busy && <p role="status" className="text-sm text-muted-foreground">{t("working")}</p>}
    {error && <div role="alert" className="space-y-1 text-sm text-destructive"><p>{error}</p><p>{t("fallback")}</p></div>}
    {preview && <section ref={previewRef} aria-label={t("preview")} className="min-w-0 space-y-2">
      <p role="status" className="text-sm font-medium text-accent-foreground">{t("ready", { count: preview.characters })}</p>
      <div tabIndex={0} aria-label={t("preview")} className="prose bloom-prose prose-sm dark:prose-invert max-h-80 max-w-none overflow-auto rounded-lg bg-muted/40 p-4 [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <Markdown restoreBold>{webArticleMarkdown(preview, t("source"))}</Markdown>
      </div>
      <p className="text-xs text-muted-foreground">{t("checkPreview")}</p>
    </section>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t("free")}</p>
  </div>;
}
