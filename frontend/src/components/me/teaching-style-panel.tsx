"use client";

import { Check, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Panel } from "@/components/me/page-head";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useBackendError } from "@/hooks/use-backend-error";
import { ApiError } from "@/lib/api-client";
import { getTeachingStyle, saveTeachingStyle, TEACHING_STYLES, MAX_STYLE_LENGTH, type TeachingStyle } from "@/lib/me/teaching-style";
import { cn } from "@/lib/utils";

export default function TeachingStylePanel({ onSaved, onSavingChange }: { onSaved?: () => void; onSavingChange?: (saving: boolean) => void } = {}) {
  const t = useTranslations("me.teaching");
  const backendError = useBackendError();
  const [saved, setSaved] = useState<TeachingStyle | null>(null);
  const [draft, setDraft] = useState<TeachingStyle | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    getTeachingStyle().then((style) => {
      if (active) { setSaved(style); setDraft(style); }
    }).catch((e) => { if (active) setLoadError(e); });
    return () => { active = false; };
  }, [attempt]);

  if (!draft || !saved) {
    return loadError ? (
      <Panel>
        <p role="alert" className="mb-4 text-sm text-destructive">{backendError(loadError)}</p>
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t("retry")}</Button>
      </Panel>
    ) : <div aria-label={t("loading")} aria-busy="true" className="space-y-4"><Skeleton className="h-64 w-full" /><Skeleton className="h-40 w-full" /></div>;
  }

  const trimmed = draft.custom_instructions.trim();
  const dirty = draft.preset !== saved.preset || trimmed !== saved.custom_instructions;
  const missingCustom = draft.preset === "custom" && !trimmed;
  const tooLong = Array.from(draft.custom_instructions).length > MAX_STYLE_LENGTH;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (missingCustom || tooLong || saving || !dirty) return;
    setSaving(true);
    onSavingChange?.(true);
    setError("");
    try {
      const updated = await saveTeachingStyle({ ...draft, custom_instructions: trimmed });
      setSaved(updated);
      setDraft(updated);
      toast.success(t("saved"));
      window.dispatchEvent(new Event("bloom:style-change"));
      try { localStorage.setItem("bloom:style-change", String(Date.now())); } catch { /* Saved on the server. */ }
      onSaved?.();
    } catch (e) {
      // 页底的红字离顶部的「确认使用」很远，点上面那个的人看不到：同时弹一条提示
      const message = e instanceof ApiError && e.status === 422 ? t("invalid") : backendError(e);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-6">
      <Panel title={t("choose")} action={<div className="flex flex-wrap items-center gap-3"><span className="text-xs text-subtle-foreground">{t("savedStyle", { name: t(`styles.${saved.preset}.name`) })}</span><Button type="submit" size="sm" disabled={!dirty || missingCustom || tooLong} loading={saving}>{saving ? t("saving") : t("save")}</Button></div>}>
        <p role="status" className="mb-4 text-xs text-muted-foreground">{dirty ? t("unsaved") : t("upToDate")}</p>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <fieldset disabled={saving} className="min-w-0 space-y-1">
            <legend className="sr-only">{t("choose")}</legend>
            {TEACHING_STYLES.map((id) => (
              <label key={id} className={cn(
                "relative flex cursor-pointer items-start gap-3 rounded-md p-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
                draft.preset === id ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                saving && "cursor-wait opacity-70"
              )}>
                <input type="radio" name="teaching-style" value={id} checked={draft.preset === id}
                  onChange={() => { setDraft({ ...draft, preset: id }); setError(""); }} className="peer sr-only" />
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-current/40" aria-hidden="true">
                  {draft.preset === id && <Check className="size-3.5" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{t(`styles.${id}.name`)}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t(`styles.${id}.description`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="min-w-0 rounded-lg bg-muted p-5 sm:p-6" aria-live="polite" aria-atomic="true">
            <p className="text-xs font-medium text-primary-text">{t("exampleLabel")}</p>
            <h3 className="mt-3 text-lg font-semibold tracking-tight">{draft.preset === "custom" ? t("customExampleTitle") : t("exampleTitle")}</h3>
            <p className="mt-1 text-xs text-subtle-foreground">{t(draft.preset === "custom" ? "customExampleHint" : "exampleHint")}</p>
            <p className="mt-6 whitespace-pre-line text-sm leading-7">{t(`styles.${draft.preset}.example`)}</p>
            {draft.preset === "custom" && (
              <Button type="button" variant="outline" disabled={saving} className="mt-5 motion-safe:active:scale-95"
                onClick={() => { setDraft({ ...draft, custom_instructions: t("customTemplate") }); setError(""); }}>
                {t("useTemplate")}
              </Button>
            )}
          </div>
        </div>
      </Panel>

      <Panel title={t("customTitle")}>
        <Label htmlFor="teaching-instructions">{t(draft.preset === "custom" ? "customRequired" : "customOptional")}</Label>
        <p id="teaching-instructions-hint" className="mb-3 mt-1 text-sm leading-relaxed text-muted-foreground">{t("customHint")}</p>
        <Textarea id="teaching-instructions" rows={5} value={draft.custom_instructions} disabled={saving}
          placeholder={t("placeholder")} aria-invalid={tooLong || undefined}
          aria-describedby="teaching-instructions-hint teaching-instructions-count"
          onChange={(e) => { setDraft({ ...draft, custom_instructions: e.target.value }); setError(""); }} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className={cn("text-subtle-foreground", tooLong && "text-destructive")} id="teaching-instructions-count">
            {t("count", { count: Array.from(draft.custom_instructions).length, max: MAX_STYLE_LENGTH })}
          </span>
          {missingCustom && <span className="text-muted-foreground">{t("customEmpty")}</span>}
        </div>
      </Panel>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm leading-relaxed text-muted-foreground">
          <p>{t("scope")}</p>
          <p className="mt-1 text-xs">{t("priority")}</p>
          {/* 读屏已经从提示里听到了，这里不再 role="alert" 念第二遍 */}
          {error && <p className="mt-2 text-destructive">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" disabled={saving || (draft.preset === "balanced" && !draft.custom_instructions)}
            onClick={() => { setDraft({ preset: "balanced", custom_instructions: "" }); setError(""); }}>
            <RotateCcw className="size-4" aria-hidden="true" />{t("reset")}
          </Button>
          <Button type="submit" disabled={!dirty || missingCustom || tooLong} loading={saving} className="motion-safe:active:scale-95">
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </div>
      {/* 和顶部那句一样，读屏只念顶部那个 */}
      <p aria-hidden="true" className="text-xs text-subtle-foreground">{dirty ? t("unsaved") : t("upToDate")}</p>
    </form>
  );
}
