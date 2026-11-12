"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Bookmark, BookOpen, Check, EyeOff, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Eyebrow from "@/components/brand/eyebrow";
import { EmptyAction, EmptyHint } from "@/components/learn/empty-state";
import Words from "@/components/learn/words";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cardInteractive } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { LANGUAGE_NAMES, foreignLanguage } from "@/lib/learn/language";
import { listCourses, studiedCourses } from "@/lib/learn/recommendation-source";
import type { Recommendation } from "@/lib/learn/types";
import { cn } from "@/lib/utils";

// 模型给每条推荐标的分类（补地基 / 做连接 / 向外长）；没有分类的（旧推荐）不贴标签，不按位置猜
type Lane = "foundation" | "connect" | "explore";
type RankedRecommendation = Recommendation & { kind?: Lane | null };
type ItemAction = "save" | "remove" | "dismiss" | "restore";

// 收藏 / 移出等待时的小图标按钮：图标换成转圈，颜色不跟着禁用变淡（和 Button 的 loading 一致），一眼看出点的是它
const ITEM_LOADING = "disabled:pointer-events-none disabled:opacity-50 data-loading:disabled:opacity-100";
const CARD_ACTION = "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground";

// 「因为你学过《课程名》」：只列得出对应课程名的主题（见 lib/learn/recommendation-source.ts）
function Source({ topics, courseNames }: { topics?: string[]; courseNames: string[] }) {
  const t = useTranslations("learn.recs");
  const locale = useLocale();
  const courses = studiedCourses(topics, courseNames);
  if (!courses.length) return null;

  return (
    <p className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-muted-foreground">
      <BookOpen className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {t("because", { courses: listCourses(courses, locale) })}
      </span>
    </p>
  );
}

function LanguageTag({ item }: { item: Recommendation }) {
  const locale = useLocale();
  const language = foreignLanguage(item.language, locale);

  return language ? (
    <Badge variant="outline" className="ml-2">
      {LANGUAGE_NAMES[language]}
    </Badge>
  ) : null;
}

// 收藏之后卡片原位置换成这块占位，而不是留一个空洞
function SavedSlot({ item }: { item: Recommendation }) {
  const t = useTranslations("learn.recs");

  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-5 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Check className="size-4" aria-hidden="true" />
      </span>
      <p role="status" className="text-sm font-medium">
        {t("saved")}
      </p>
      <p className="line-clamp-2 text-sm text-muted-foreground" title={item.title}>{item.title}</p>
      <p className="text-xs text-subtle-foreground">{t("savedHint")}</p>
    </div>
  );
}

// 点了「不感兴趣」：卡片原位置换成这块占位，可以撤销；下次打开这一页就没有了
function DismissedSlot({
  item,
  onRestore,
  restoring,
  error,
  busy,
}: {
  item: Recommendation;
  onRestore: (item: Recommendation) => void;
  restoring: boolean;
  error?: string;
  busy: boolean;
}) {
  const t = useTranslations("learn.recs");

  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-5 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <EyeOff className="size-4" aria-hidden="true" />
      </span>
      <p role="status" className="text-sm font-medium">
        {t("dismissed")}
      </p>
      <p className="line-clamp-2 text-sm text-muted-foreground" title={item.title}>{item.title}</p>
      <p className="text-xs text-subtle-foreground">{t("dismissedHint")}</p>
      <Button variant="outline" size="sm" className="mt-1" onClick={() => onRestore(item)} disabled={busy} loading={restoring}>
        {t("undo")}
      </Button>
      {error && <p role="alert" className="text-pretty text-[13px] text-destructive">{t("restoreFailed", { message: error })}</p>}
    </div>
  );
}

// 待学清单里的说明：折起来只显示两行，真被折住了才出现「展开」，点开看全文（以前被「…」截断后没有办法读到后面）
function Rationale({ text }: { text: string }) {
  const t = useTranslations("learn.recs");
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);

  // 展开后折叠样式去掉了，量不出来；保留展开前量到的结果，按钮才不会在展开时消失
  useLayoutEffect(() => {
    const el = ref.current;
    if (open || !el) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => observer.disconnect();
  }, [open, text]);

  return (
    <>
      <p ref={ref} className={cn("mt-2 text-pretty text-sm text-muted-foreground", !open && "line-clamp-2")}>
        {text}
      </p>
      {(clamped || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          // 点击区高 40px（上下各撑 10px，用负外边距抵掉，版面不变）
          className="-my-2.5 mr-auto inline-flex items-center rounded-sm py-2.5 text-[13px] font-medium text-accent-foreground underline-offset-4 hover:underline"
        >
          {open ? t("collapse") : t("expand")}
        </button>
      )}
    </>
  );
}

function RecommendationCard({
  item,
  lane,
  courseNames,
  onSave,
  onDismiss,
  onStart,
  starting,
  saving,
  dismissing,
  error,
  busy,
}: {
  item: Recommendation;
  lane?: Lane | null;
  courseNames: string[];
  onSave: (item: Recommendation) => void;
  onDismiss: (item: Recommendation) => void;
  onStart: (item: Recommendation) => void;
  starting: boolean;
  saving: boolean;
  dismissing: boolean;
  error?: string;
  busy: boolean;
}) {
  const t = useTranslations("learn.recs");

  return (
    <article className={cn("@container flex flex-col rounded-xl border bg-card p-5", cardInteractive)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-y-1">
          {lane && <Eyebrow>{t(`lane.${lane}`)}</Eyebrow>}
          <LanguageTag item={item} />
        </div>
        <div className="-mr-2 -mt-1.5 flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => onDismiss(item)}
            disabled={busy}
            aria-busy={dismissing || undefined}
            data-loading={dismissing || undefined}
            aria-label={t("dismissLabel", { name: item.title })}
            title={t("dismissLabel", { name: item.title })}
            className={cn(CARD_ACTION, ITEM_LOADING)}
          >
            {dismissing ? <Spinner /> : <EyeOff className="size-4" strokeWidth={1.8} aria-hidden="true" />}
            {/* 卡片窄（三栏刚排开、英文分类名长）时只留图标，悬停有提示，不把左边的分类挤歪 */}
            <span className="@max-[18rem]:sr-only">{t("dismiss")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSave(item)}
            disabled={busy}
            aria-busy={saving || undefined}
            data-loading={saving || undefined}
            aria-label={t("save")}
            title={t("save")}
            className={cn(CARD_ACTION, ITEM_LOADING)}
          >
            {saving ? <Spinner /> : <Bookmark className="size-4" strokeWidth={1.8} aria-hidden="true" />}
            {t("saveShort")}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-pretty text-[13px] text-destructive">{error}</p>}

      <h2 className="mt-3 break-words text-xl leading-snug">
        <Words text={item.title} />
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {item.rationale}
      </p>
      <Source topics={item.source_topics} courseNames={courseNames} />

      <div className="mt-auto pt-6">
        <Button
          className="w-full"
          onClick={() => onStart(item)}
          disabled={busy}
        >
          {starting ? t("starting") : t("start")}

        </Button>
      </div>
    </article>
  );
}

function WishlistRow({
  item,
  courseNames,
  onRemove,
  onStart,
  starting,
  removing,
  error,
  busy,
}: {
  item: Recommendation;
  courseNames: string[];
  onRemove: (item: Recommendation) => void;
  onStart: (item: Recommendation) => void;
  starting: boolean;
  removing: boolean;
  error?: string;
  busy: boolean;
}) {
  const t = useTranslations("learn.recs");

  return (
    <article className="flex h-full flex-col rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="break-words text-base font-semibold leading-snug">
          {item.title}
          <LanguageTag item={item} />
        </h3>
        <button
          type="button"
          onClick={() => onRemove(item)}
          // 刷新进行中也不能移出：刷新回来的待学清单会把刚移出的这条带回来
          disabled={busy}
          aria-busy={removing || undefined}
          data-loading={removing || undefined}
          aria-label={t("remove")}
          title={t("remove")}
          className={cn("-m-1 flex size-8 shrink-0 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:bg-destructive/10 hover:text-destructive", ITEM_LOADING)}
        >
          {removing ? <Spinner /> : <X className="size-4" aria-hidden="true" />}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-pretty text-[13px] text-destructive">{t("removeFailed", { message: error })}</p>}
      <Rationale text={item.rationale} />
      <Source topics={item.source_topics} courseNames={courseNames} />
      {/* 按钮沉到卡片底部：同一行的卡片等高（栅格默认拉伸），「开始学习」在同一条线上，不管上面的说明是一行还是三行、有没有「因为你学过」 */}
      <div className="mt-auto pt-4">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => onStart(item)}
          disabled={busy}
        >
          {starting ? t("starting") : t("enter")}

        </Button>
      </div>
    </article>
  );
}

export default function RecommendationPanel({
  courseNames,
  recommendations,
  savedRecommendations,
  refreshing,
  startingId,
  itemBusy,
  itemError,
  onRefresh,
  onSave,
  onRemove,
  onDismiss,
  onRestore,
  onStart,
}: {
  // 用户已有的课程名：推荐卡片上「因为你学过《…》」用它对照
  courseNames: string[];
  recommendations: RankedRecommendation[];
  savedRecommendations: Recommendation[];
  refreshing: boolean;
  startingId: number | null;
  // 正在收藏 / 移出的那一条，和上一次没成功的那一条（原因写在它旁边）
  itemBusy: { id: number; action: ItemAction } | null;
  itemError: { id: number; action: ItemAction; message: string } | null;
  onRefresh: () => void;
  onSave: (item: Recommendation) => void;
  onRemove: (item: Recommendation) => void;
  onDismiss: (item: Recommendation) => void;
  onRestore: (item: Recommendation) => void;
  onStart: (item: Recommendation) => void;
}) {
  const t = useTranslations("learn.recs");
  const savedIds = new Set(savedRecommendations.map((r) => r.id));
  // 刷新或建课进行中：旧的卡片先别动（刷新会作废没收藏的推荐，建课已经开始）；
  // 收藏 / 移出等一条的应答时（通常不到一秒），别的也先别点，免得几次应答交错把清单改乱
  const busy = startingId !== null || refreshing || itemBusy !== null;
  const doing = (item: Recommendation, action: ItemAction) => itemBusy?.id === item.id && itemBusy.action === action;
  const failed = (item: Recommendation, action: ItemAction) =>
    itemError?.id === item.id && itemError.action === action ? itemError.message : undefined;
  // 推荐卡片上没成功的那一下：收藏或不感兴趣（同一时间只会有一条）
  const cardError = (item: Recommendation) =>
    itemError?.id === item.id && (itemError.action === "save" || itemError.action === "dismiss")
      ? t(`${itemError.action}Failed`, { message: itemError.message })
      : undefined;

  return (
    <>
      {refreshing && recommendations.length === 0 ? (
        <div className="grid gap-4 md:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : recommendations.length > 0 ? (
        <div
          aria-busy={refreshing}
          className={cn("grid gap-4 transition-opacity md:grid-cols-3", refreshing && "opacity-60")}
        >
          {recommendations.map((item) =>
            savedIds.has(item.id) ? (
              <SavedSlot key={item.id} item={item} />
            ) : item.status === "dismissed" ? (
              <DismissedSlot
                key={item.id}
                item={item}
                onRestore={onRestore}
                restoring={doing(item, "restore")}
                error={failed(item, "restore")}
                busy={busy}
              />
            ) : (
              <RecommendationCard
                key={item.id}
                item={item}
                lane={item.kind}
                courseNames={courseNames}
                onSave={onSave}
                onDismiss={onDismiss}
                onStart={onStart}
                starting={startingId === item.id}
                saving={doing(item, "save")}
                dismissing={doing(item, "dismiss")}
                error={cardError(item)}
                busy={busy}
              />
            )
          )}
        </div>
      ) : savedRecommendations.length > 0 ? (
        // 三个推荐都收进了待学清单：不是「没有推荐」，换一组是可选的（要调一次模型）
        <EmptyAction title={t("allSaved")} text={t("allSavedHint")}>
          <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
            {t("another")}

          </Button>
        </EmptyAction>
      ) : (
        <EmptyAction title={t("empty")} text={t("emptyHint")}>
          <Button onClick={onRefresh} disabled={refreshing}>
            {t("generate")}

          </Button>
        </EmptyAction>
      )}

      <section className="mt-12">
        <div className="mb-4 flex items-baseline gap-3">
          <Eyebrow>{t("wishlist")}</Eyebrow>
          <span className="font-mono text-xs text-subtle-foreground tabular-nums">
            {savedRecommendations.length}
          </span>
        </div>
        {savedRecommendations.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {savedRecommendations.map((item) => (
              <WishlistRow
                key={item.id}
                item={item}
                courseNames={courseNames}
                onRemove={onRemove}
                onStart={onStart}
                starting={startingId === item.id}
                removing={doing(item, "remove")}
                error={failed(item, "remove")}
                busy={busy}
              />
            ))}
          </div>
        ) : (
          <EmptyHint>{t("wishlistEmpty")}</EmptyHint>
        )}
      </section>
    </>
  );
}
