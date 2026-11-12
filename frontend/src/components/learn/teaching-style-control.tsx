"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useLearnError } from "@/components/learn/use-learn-error";
import TeachingStylePanel from "@/components/me/teaching-style-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { getTeachingStyle, type TeachingStyle } from "@/lib/me/teaching-style";

export default function TeachingStyleControl({ disabled = false, prominent = false, onBusy }: { disabled?: boolean; prominent?: boolean; onBusy?: (busy: boolean) => void }) {
  const t = useTranslations("me.teaching");
  const report = useLearnError();
  const [style, setStyle] = useState<TeachingStyle | null>(null);
  // 读取失败的原因（后端 detail 或网络错误）；空串表示没有错误
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    let version = 0;
    const refresh = () => {
      const current = ++version;
      getTeachingStyle().then(value => {
        if (active && current === version) { setStyle(value); setError(""); }
      }).catch(err => { if (active && current === version) setError(report(err)); });
    };
    const stored = (event: StorageEvent) => { if (event.key === "bloom:style-change") refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("bloom:style-change", refresh);
    window.addEventListener("storage", stored);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("bloom:style-change", refresh);
      window.removeEventListener("storage", stored);
    };
  }, [report]);
  const changeOpen = (value: boolean) => { if (saving) return; setOpen(value); onBusy?.(value); };
  return (
    <div className={prominent ? "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-accent p-4 text-sm font-medium text-accent-foreground" : "flex flex-wrap items-center gap-2 text-xs text-muted-foreground"}>
      <span>{error ? t("styleUnavailable", { message: error }) : style ? t("currentStyle", { name: t(`styles.${style.preset}.name`) }) : t("loading")}</span>
      {style?.custom_instructions && <span>· {t("styleWithNotes")}</span>}
      <Button type="button" variant={prominent ? "outline" : "ghost"} size="sm" disabled={disabled} onClick={() => changeOpen(true)}>{t("changeStyle")}</Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("choose")}</DialogTitle>
            <DialogDescription>{t("scope")}</DialogDescription>
          </DialogHeader>
          <TeachingStylePanel onSavingChange={setSaving} onSaved={() => { setOpen(false); onBusy?.(false); }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
