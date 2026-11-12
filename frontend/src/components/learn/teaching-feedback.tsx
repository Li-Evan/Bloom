"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api-client";
import { useBackendError } from "@/hooks/use-backend-error";
import { Button } from "@/components/ui/button";

export type FeedbackScope = "auto" | "next" | "course";
type RecordItem = { id: number; lesson_number: number; content: string; scope: string; unresolved: boolean; last_applied_lesson: number | null };

export default function TeachingFeedback({ courseId, scope, onScopeChange, refreshKey, disabled }: {
  courseId: string; scope: FeedbackScope; onScopeChange: (scope: FeedbackScope) => void;
  refreshKey: boolean; disabled: boolean;
}) {
  const t = useTranslations("learn.teaching");
  const errorText = useBackendError();
  const [items, setItems] = useState<RecordItem[]>([]);
  const [error, setError] = useState("");
  // 正在改哪一条、点的是「我已理解」（resolve）还是「停止使用」
  const [busy, setBusy] = useState<{ id: number; resolve: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ items: RecordItem[] }>(`/api/courses/${courseId}/teaching-feedback`)
      .then((data) => { if (live) { setItems(data.items); setError(""); } })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [courseId, refreshKey, revision, errorText]);
  // 改完接着重取列表，列表换上之后才放开按钮：两次请求之间不留「按钮已经能点、列表还没变」的空档
  const change = async (id: number, resolve: boolean) => {
    setBusy({ id, resolve }); setError("");
    try {
      await api(`/api/courses/${courseId}/teaching-feedback/${id}${resolve ? "/resolve" : ""}`, { method: resolve ? "POST" : "DELETE" });
      const data = await api<{ items: RecordItem[] }>(`/api/courses/${courseId}/teaching-feedback`);
      setItems(data.items);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  };
  return <div className="mt-4 space-y-3 border-t pt-4">
    <label className="flex flex-wrap items-center gap-3 text-sm">
      <span>{t("scopeLabel")}</span>
      <select aria-label={t("scopeLabel")} value={scope} disabled={disabled}
        onChange={(e) => onScopeChange(e.target.value as FeedbackScope)}
        className="rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <option value="auto">{t("auto")}</option><option value="next">{t("next")}</option><option value="course">{t("course")}</option>
      </select>
    </label>
    {/* 只有「自动识别」需要解释怎么判断；选了「仅下一篇 / 之后每一篇」，选项本身已经说清楚了 */}
    {scope === "auto" && <p className="text-xs text-muted-foreground">{t("hint")}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" onClick={() => setRevision((n) => n + 1)}>{t("retry")}</Button></p>}
    {items.length > 0 && <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{t("records", { count: items.length })}</summary>
      <ul className="mt-2 divide-y">
        {items.map((item) => <li key={item.id} className="space-y-2 py-3">
          <p className="whitespace-pre-wrap break-words text-sm">{item.content}</p>
          <p className="text-xs text-muted-foreground">{t("source", { number: item.lesson_number })} · {t(`state.${item.scope}`)}{item.unresolved && item.scope !== "unresolved" && ` · ${t("state.unresolved")}`}
            {item.last_applied_lesson !== null && ` · ${item.last_applied_lesson === 0 ? t("usedSummary") : t("used", { number: item.last_applied_lesson })}`}
          </p>
          <div className="flex flex-wrap gap-2">
            {item.unresolved && <Button size="sm" variant="outline" loading={busy?.id === item.id && busy.resolve} disabled={disabled || busy !== null} onClick={() => change(item.id, true)}>{t("resolved")}</Button>}
            <Button size="sm" variant="ghost" loading={busy?.id === item.id && !busy.resolve} disabled={disabled || busy !== null} onClick={() => change(item.id, false)}>{t("cancel")}</Button>
          </div>
        </li>)}
      </ul>
    </details>}
  </div>;
}
