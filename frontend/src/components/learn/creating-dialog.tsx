"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import BellCurve from "@/components/brand/bell-curve";
import { useWaited } from "@/components/learn/shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// 建课是阻塞式的：后端一次请求做完，前端拿不到真实进度（上传文件那一段除外，见 upload）。所以按建课方式给一组阶段文案，
// 按这种方式的常见耗时排开（at：每一步从第几毫秒开始，走到最后一步就停着），进度条按常见耗时（typical）趋近 92%——
// 只表示「在往前走」，不承诺具体时间点；过了常见耗时的上限（slowAfter）改口说「比平时久，仍在进行」。
// 各方式做的事和耗时不一样：主题要研究目标再写大纲（约 20–60 秒），资料要先读资料（1–3 分钟），
// 项目文件只是读取（几秒）。
const FLOWS = {
  topic: { steps: ["analyze", "syllabus", "finish"], at: [0, 15_000, 45_000], typical: 30_000, slowAfter: 75_000, hint: "hintTopic" },
  materials: { steps: ["parse", "merge", "syllabus"], at: [0, 40_000, 100_000], typical: 90_000, slowAfter: 200_000, hint: "hintMaterials" },
  project: { steps: ["read", "finish"], at: [0, 4_000], typical: 4_000, slowAfter: 20_000, hint: "hintProject" },
  // PDF 阅读版逐页看图转换，几页同时转：一篇 15 页的论文约 40–60 秒
  pdf: { steps: ["render", "convert", "finish"], at: [0, 5_000, 50_000], typical: 50_000, slowAfter: 180_000, hint: "hintPdf" },
} as const;

export type CreatingKind = keyof typeof FLOWS;

// 上传进度（字节）：带文件建课时先上传，这一段有真实进度
export type UploadProgress = { sent: number; total: number };

// since：开始等的时刻（弹窗打开）；processingSince：文件传完、后端开始处理的时刻，阶段和进度条从这里算
function useCreatingProgress(active: boolean, kind: CreatingKind, uploading: boolean) {
  const [since, setSince] = useState<number | null>(null);
  const [processingSince, setProcessingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setSince(active ? Date.now() : null);
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    setProcessingSince(active && !uploading ? Date.now() : null);
  }, [active, uploading]);

  const { at, typical, slowAfter } = FLOWS[kind];
  const elapsed = processingSince == null ? 0 : Math.max(0, now - processingSince);

  return {
    since,
    step: at.filter((ms) => elapsed >= ms).length - 1,
    progress: processingSince == null ? 0 : 92 * (1 - Math.exp(-elapsed / typical)),
    slow: elapsed > slowAfter,
  };
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

// 建课等待弹窗：钟形曲线一遍遍描线，下面是步骤清单（做完的打勾、正在做的高亮）和进度条。不能被关掉；成功后保持打开，直到页面跳走，
// 免得用户在跳转完成前再点一次，重复建课。
export default function CreatingDialog({
  open,
  kind,
  upload,
  onCloseAutoFocus,
  adding = false,
}: {
  open: boolean;
  kind: CreatingKind;
  upload?: UploadProgress | null;
  onCloseAutoFocus?: (event: Event) => void;
  // 往已有的课里添加资料：标题和「比平时久」的说法换掉（不是建课，完成后也不跳走）
  adding?: boolean;
}) {
  const t = useTranslations("learn");
  const uploading = !!upload && upload.sent < upload.total;
  const { since, step, progress, slow } = useCreatingProgress(open, kind, uploading);
  const waited = useWaited(since);
  const { steps, hint } = FLOWS[kind];
  // 上传中：第一步写上传了多少，进度条是真实的上传比例
  const label = (name: string, i: number) =>
    upload && uploading && i === 0
      ? t("dashboard.creating.uploading", { sent: mb(upload.sent), total: mb(upload.total) })
      : t(`dashboard.creating.${kind}.${name}`);
  const percent = upload && uploading ? (upload.sent / upload.total) * 100 : progress;

  return (
    <Dialog open={open}>
      <DialogContent
        showClose={false}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="max-w-sm gap-0 p-8 text-center"
      >
        <BellCurve
          tone="auto"
          loop
          annotated={false}
          className="mx-auto mb-6 w-44"
        />
        <DialogTitle className="mb-2 text-lg leading-snug">
          {t(adding ? "dashboard.creating.addingTitle" : "dashboard.creating.title")}
        </DialogTitle>
        <DialogDescription className="sr-only" aria-live="polite">
          {uploading ? t("dashboard.creating.uploadingShort") : label(steps[step], step)}
        </DialogDescription>
        <ol className="mx-auto mb-6 w-fit space-y-1.5 text-left text-sm">
          {steps.map((name, i) => (
            <li
              key={name}
              aria-hidden="true"
              className={cn(
                "flex items-center gap-2.5 transition-colors duration-300",
                i < step && "text-muted-foreground",
                i === step && "font-medium text-foreground",
                i > step && "text-subtle-foreground"
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border",
                  i < step && "border-primary bg-primary text-primary-foreground",
                  i === step && "border-ring",
                  i > step && "border-border"
                )}
              >
                {i < step ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : i === step ? (
                  <span className="size-1.5 animate-pulse rounded-full bg-ring" />
                ) : null}
              </span>
              <span className="tabular-nums">{label(name, i)}</span>
            </li>
          ))}
        </ol>
        <div
          role="progressbar"
          aria-label={t(adding ? "dashboard.creating.addingTitle" : "dashboard.creating.title")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-border"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${Math.round(percent)}%` }}
          />
        </div>
        <p className="text-[13px] text-subtle-foreground">
          {t(`dashboard.creating.${hint}`)}
        </p>
        {waited && <p aria-hidden="true" className="mt-2 text-[13px] tabular-nums text-muted-foreground">{waited}</p>}
        {slow && <p role="status" className="mt-1 text-[13px] font-medium text-foreground">{t(adding ? "dashboard.creating.addingSlow" : "dashboard.creating.slow")}</p>}
      </DialogContent>
    </Dialog>
  );
}
