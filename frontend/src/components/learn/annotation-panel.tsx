"use client";

import { Check, Square, Trash2, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { useTranslations } from "next-intl";

import { LABEL_CLASS } from "@/components/brand/eyebrow";
import Markdown from "@/components/learn/markdown";
import { DoneBar, useWaited } from "@/components/learn/shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { zhTypography } from "@/lib/learn/lesson-text";
import type { ChatTurn } from "@/lib/learn/lesson-chat";
import { saveShowMeaning, splitMeaning, useShowMeaning } from "@/lib/learn/translation-meaning";
import type { Session } from "@/lib/learn/types";
import { cn } from "@/lib/utils";

// 划线提问的卡片：新建提问（compose）、已有的多轮问答（session）和划线翻译（translate）共用一个壳。
// 桌面（lg 起）：放在正文右侧栏里，顶部对齐被问的那一段（位置由 lesson.tsx 算好，卡片前面放一块占位撑出来），
// 滚动时吸在视口里：sticky 的上下两边都有吸附线（顶栏下面、视口底边上面），max-h 正好是两条线之间的高度，内容在卡片内滚动；
// 卡片所在的区域向上下各伸出页面容器的内边距（lesson.tsx 的负外边距），页面滚到最顶 / 最底时吸附线还在区域里，所以始终完整在视口内；
// 手机 / 平板：固定在屏幕底部的抽屉（不遮罩，课文仍可滚动、可选字）。打开时不自动聚焦（触屏一聚焦就弹键盘，把卡片和课文都挡住），
// 读者点输入框才弹；键盘开着时抽屉抬到键盘上面（useAboveKeyboard）。
// docked：桌面上右栏被「参考原文」面板让掉了（learn.css 在面板打开时隐藏右栏），卡片改成左半屏底部的抽屉，照样能提问、追问。
// 卡片内保留紧凑模型选择；讲解风格仍放在课文页，手机空间留给对话。
// 「提问 / 发送」暂时不能点时，按钮旁边写明原因；只有点按钮才会调模型（调用在 lesson.tsx 的 handle* 里）。
// 提问 / 追问没成功：问题放回输入框，原因红字写在按钮上方。
// 「问这篇」（chat）也用这个壳：不引原文，整篇课文随问题一起发；对话只存在本机，能清空。

// 输入框还是空的时候，「提问 / 发送」要一眼看出点不了：半透明 + 不可点的光标（Button 自带的禁用样式是 muted 底灰字，像一个可点的次按钮）。
// Button 默认 pointer-events-none，光标样式出不来，这里放开；禁用的按钮不会触发点击，按下也不缩放
const DISABLED_ASK = "disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100";

interface Common {
  // 现在不能提问 / 追问的原因（另一条回答还在写、正在生成下一篇、正在切换讲解风格）：按钮禁用、回车无效，原因写在按钮旁边
  busyReason?: string;
  // 这次提问 / 追问没成功的原因：红字写在按钮上方（问题已经放回输入框）
  error?: string;
  docked?: boolean;
  onClose: () => void;
  // 引文是课文里的字：做中文排版；原文篇（学生自己的资料）里的不做
  quoteTypography?: boolean;
}

export interface ComposeProps extends Common {
  kind: "compose";
  quote: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}

export interface SessionProps extends Common {
  kind: "session";
  session: Session;
  // 回答正在往这一条里流式写入（别的问答在写时，这里是 false、streamText 是空的）
  streaming: boolean;
  streamText: string;
  // 停止之后回答还在后台写（或者等了两分钟没等到）：写在对话下面的一行说明
  notice?: string;
  // 还在等后台写完：从什么时候开始等的（说明前面转圈、写已等多久）；等满两分钟不再等了就不传
  noticeSince?: number | null;
  // 后台写完的完整回答刚换上来：说一句，几秒后收起
  updated?: boolean;
  followDraft: string;
  onFollowDraftChange: (value: string) => void;
  // 不能追问的原因（这条回答没存下来）：追问框禁用，原因写在框上面
  followUpBlocked?: string;
  onFollowUp: () => void;
  onStop: () => void;
  // 点了停止、正在存已经收到的半截回答：「停止」换成转圈的「正在停止…」，不能再点
  stopping?: boolean;
  // 不能删的原因（回答正在写、还在等后台写完）：删除按钮变灰，悬停看得到原因
  deleteBlocked?: string;
  // 删除：返回失败的原因（成功返回空串，被挡住时什么也不做）
  onDelete: () => Promise<string | undefined>;
}

export interface TranslateProps extends Common {
  kind: "translate";
  quote: string;
  // 译文：流式写入时是已经收到的部分
  translation: string;
  translating: boolean;
  // 译成中文时做中文排版
  typography: boolean;
  // 没成功（error 写着原因）时可以重试
  onRetry?: () => void;
  // 看完译文接着问这一段
  onAsk: () => void;
  // 已经存下来的译文才能删：删掉后正文里这一段的虚线和页边圆点一起消失（不用确认，再翻一次就回来）
  onDelete?: () => void;
  deleting?: boolean;
}

export interface ChatProps extends Common {
  kind: "chat";
  turns: ChatTurn[];
  // 回答正在写：streamText 是已经收到的部分
  streaming: boolean;
  streamText: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClear: () => void;
}

const QUOTE_MAX = 140;

// 回车发送；Shift+回车换行；输入法选字时的回车不算
function submitOnEnter(submit: () => void, enabled: boolean) {
  return (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (enabled) submit();
    }
  };
}

// 手机键盘弹起时浏览器只缩小可视区域（visualViewport），页面本身不变：贴在页面底部的抽屉整个落到键盘后面。
// 键盘开着时把抽屉抬到可视区域底边（--kb-bottom）、高度收进可视区域（--kb-room）；键盘收起（或页面被双指放大）就去掉，回到贴底。
// 可视区域只比页面矮几十像素以内的是滚动条、取整，不是键盘。直接写在元素上不走 React 状态：键盘开着滚动页面时每帧都会触发
function useAboveKeyboard(panel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = panel.current;
    if (!vv || !el) return;
    const update = () => {
      const covered = vv.scale < 1.01 && window.innerHeight - vv.height > 40;
      el.toggleAttribute("data-keyboard", covered);
      if (covered) {
        el.style.setProperty("--kb-bottom", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
        el.style.setProperty("--kb-room", `${Math.floor(vv.height) - 8}px`);
      } else {
        el.style.removeProperty("--kb-bottom");
        el.style.removeProperty("--kb-room");
      }
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [panel]);
}

// blockedReason：暂时不能点，原因放进悬停提示和读屏的说明里。不用 disabled——禁用的按钮收不到悬停，提示出不来
function IconButton({
  label,
  onClick,
  blockedReason,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  blockedReason?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={blockedReason ? undefined : onClick}
      aria-disabled={blockedReason ? true : undefined}
      aria-label={label}
      // 有 aria-label 时 title 是读屏念的补充说明：被挡住时就是原因
      title={blockedReason ?? label}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        blockedReason ? "cursor-not-allowed opacity-40 hover:bg-transparent" : className
      )}
    >
      {children}
    </button>
  );
}

const AnnotationPanel = forwardRef<HTMLElement, ComposeProps | SessionProps | TranslateProps | ChatProps>(function AnnotationPanel(props, ref) {
  const t = useTranslations("learn");
  const panelRef = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => panelRef.current as HTMLElement, []);
  useAboveKeyboard(panelRef);
  // 有鼠标 / 触控板时打开就能直接打字；触屏上不自动聚焦（见文件开头）
  const [focusOnOpen] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isSession = props.kind === "session";
  const isChat = props.kind === "chat";
  const thread = isSession ? props.session.messages : isChat ? props.turns : [];
  // 只数读者自己发的问题：回答写完、存下来时多出来的那条回答不算，免得读者正翻看着回答的开头，被一下子拽到底
  const askedCount = thread.filter((m) => m.role === "user").length;
  const streamText = isSession || isChat ? props.streamText : "";
  const waited = useWaited(isSession ? props.noticeSince ?? null : null);
  // 翻译卡片：译文后面那句「在这里的意思」和词根拆解显示不显示（和设置里的是同一个开关）
  const showMeaning = useShowMeaning();
  const translated = props.kind === "translate" ? props.translation : "";
  const shownTranslation = showMeaning ? translated.trim() : splitMeaning(translated).translation;

  // 删除先确认：点垃圾桶，卡片顶上出一条确认条；删除中转圈、不能再点，失败的原因写在确认条里
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const remove = async () => {
    if (props.kind === "chat") {
      props.onClear();
      setConfirmDelete(false);
      return;
    }
    if (props.kind !== "session") return;
    setDeleting(true);
    setDeleteError("");
    const failed = await props.onDelete();
    setDeleting(false);
    setDeleteError(failed ?? "");
  };

  // 发了新问题：滚到最底下，看见自己的提问和即将出现的回答（刚打开已有问答时停在开头）
  const seenCount = useRef(askedCount);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && askedCount > seenCount.current) el.scrollTop = el.scrollHeight;
    seenCount.current = askedCount;
  }, [askedCount]);

  // 回答流式写入：读者停在底部附近时跟着滚；往上翻看的时候不抢滚动位置
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !streamText) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 140) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamText]);

  // 回答写完：读者一直跟在底部（没有自己往上翻过）时，把回答的开头滚回可见的位置——流式时一路跟到底，停下来时开头已经在视野外了，
  // 读者要自己往上翻才能从头读。回答本来就整段看得见（短回答）就不动；读者自己翻过的更不抢
  const following = useRef(true);
  const wasStreaming = useRef(false);
  const streaming = isSession || isChat ? props.streaming : false;
  useEffect(() => {
    if (streaming) {
      if (!wasStreaming.current) following.current = true;
      wasStreaming.current = true;
      return;
    }
    if (!wasStreaming.current) return;
    wasStreaming.current = false;
    if (!following.current) return;
    // 存下来的回答换掉流式的那一段要等下一次渲染
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      const answers = body?.querySelectorAll<HTMLElement>("[data-answer]");
      const answer = answers?.[answers.length - 1];
      if (!body || !answer) return;
      const delta = answer.getBoundingClientRect().top - body.getBoundingClientRect().top;
      if (delta < 0 || delta > body.clientHeight - 24) body.scrollTop += delta - 12;
    });

    return () => cancelAnimationFrame(frame);
  }, [streaming]);

  const title = isSession
    ? t("lesson.sessionTitle")
    : isChat
      ? t("lesson.chatTitle")
      : props.kind === "translate"
        ? t("lesson.translationTitle")
        : t("lesson.composerTitle");
  const quoteSource = isSession ? props.session.original_text : isChat ? "" : props.quote;
  const clipped = quoteSource.length > QUOTE_MAX ? quoteSource.slice(0, QUOTE_MAX) + "…" : quoteSource;
  const quote = props.quoteTypography === false ? clipped : zhTypography(clipped);
  const errorLine = props.error && (
    <p role="alert" className="text-pretty text-[13px] text-destructive">{props.error}</p>
  );
  // 不能提问的原因写在按钮左边；正在写回答的这一条显示的是「停止」，不能追问的这一条框上面已经写了原因，都不用再说
  const busyLine = props.busyReason && !(isSession && (props.streaming || props.followUpBlocked)) && (
    <p id="ask-busy" className="min-w-0 flex-1 text-pretty text-[13px] text-muted-foreground">{props.busyReason}</p>
  );

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-label={title}
      data-annotation-panel
      className={cn(
        "ann-in fixed inset-x-0 bottom-[var(--kb-bottom,0px)] z-40 flex flex-col rounded-t-2xl border bg-card pb-[env(safe-area-inset-bottom)] text-card-foreground shadow-md data-keyboard:pb-0",
        props.docked
          ? "lg:right-auto lg:w-[50vw]"
          : "lg:sticky lg:inset-x-auto lg:bottom-4 lg:top-[calc(var(--header-height)+var(--rail-offset,0px)+1rem+var(--panel-offset,0px))] lg:z-auto lg:max-h-[calc(100dvh-var(--header-height)-var(--rail-offset,0px)-2rem-var(--panel-offset,0px)-var(--panel-slack,0px))] lg:rounded-xl lg:pb-0",
        // 手机：已有的问答和译文最多占 60% 屏高，课文至少还能看到 40%；新建提问框内容少，上限宽一些；键盘开着时不超过键盘上面那块
        props.kind === "compose" || isChat ? "max-h-[min(78dvh,36rem,var(--kb-room,100dvh))]" : "max-h-[min(60dvh,var(--kb-room,100dvh))]"
      )}
    >
      <div
        aria-hidden="true"
        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border lg:hidden"
      />
      <header className="flex shrink-0 items-center justify-between gap-2 border-b py-1.5 pl-4 pr-2 lg:py-2">
        {/* 不用 <h2>：globals.css 把中文标题的字距压成 0，会盖掉小标签的字距（LABEL_CLASS）；role + aria-level 保留标题语义 */}
        <div className="flex min-w-0 items-center gap-2">
          <p role="heading" aria-level={2} className={cn(LABEL_CLASS, "text-accent-foreground")}>
            {title}
          </p>
          {props.kind === "translate" && (
            <button
              type="button"
              aria-pressed={showMeaning}
              onClick={() => saveShowMeaning(!showMeaning)}
              title={t("lesson.meaningToggleHint")}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
                showMeaning ? "border-primary/40 bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {showMeaning && <Check className="size-3" aria-hidden="true" />}
              {t("lesson.meaningToggle")}
            </button>
          )}
        </div>
        <div className="flex items-center">
          {isSession && (
            <IconButton
              // 删除中：垃圾桶换成转圈；再点只是确认条已经开着，不会再发一次
              label={deleting ? t("lesson.deleting") : t("lesson.deleteSession")}
              onClick={() => setConfirmDelete(true)}
              // 回答还在写（这条可能还没存下来），或者停止之后还在等后台写完（删了，后台写完会再出现）
              blockedReason={props.deleteBlocked}
              className="hover:text-destructive"
            >
              {deleting ? <Spinner /> : <Trash2 className="size-4" aria-hidden="true" />}
            </IconButton>
          )}
          {isChat && thread.length > 0 && (
            <IconButton
              label={t("lesson.chatClear")}
              onClick={() => setConfirmDelete(true)}
              blockedReason={props.streaming ? t("lesson.chatClearBlocked") : undefined}
              className="hover:text-destructive"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </IconButton>
          )}
          {props.kind === "translate" && props.onDelete && (
            <IconButton
              label={props.deleting ? t("lesson.deleting") : t("lesson.deleteTranslation")}
              onClick={props.deleting ? () => {} : props.onDelete}
              className="hover:text-destructive"
            >
              {props.deleting ? <Spinner /> : <Trash2 className="size-4" aria-hidden="true" />}
            </IconButton>
          )}
          <IconButton
            label={isSession || isChat ? t("lesson.minimize") : t("common.close")}
            onClick={props.onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      </header>

      {(isSession || isChat) && confirmDelete && (
        <div role="group" aria-label={isChat ? t("lesson.chatClear") : t("lesson.deleteSession")} className="shrink-0 space-y-2 border-b bg-muted/50 px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-pretty text-[13px] text-foreground">{isChat ? t("lesson.chatClearConfirm") : t("lesson.deleteConfirm")}</p>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={deleting}
                onClick={() => {
                  setConfirmDelete(false);
                  setDeleteError("");
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                loading={deleting}
                disabled={isSession ? Boolean(props.deleteBlocked) : isChat && props.streaming}
                title={isSession ? props.deleteBlocked : undefined}
                onClick={remove}
              >
                {isChat ? t("lesson.chatClearButton") : deleting ? t("lesson.deleting") : t("lesson.deleteConfirmButton")}
              </Button>
            </div>
          </div>
          {deleteError && <p role="alert" className="text-pretty text-[13px] text-destructive">{deleteError}</p>}
        </div>
      )}

      <div
        ref={bodyRef}
        // 读者自己往上翻过（离底部远了）就记下来，回答写完时不再替他滚
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
        }}
        // 手机抽屉：从对话里开始的滑动只滚对话，滚到头也不带着后面的课文走
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 max-lg:overscroll-contain"
      >
        {!isChat && (
          <blockquote className="mb-3 text-balance border-l-2 border-primary/60 pl-3 text-[13px] leading-relaxed text-muted-foreground">
            {quote}
          </blockquote>
        )}

        {props.kind === "translate" ? (
          shownTranslation ? (
            <p className="whitespace-pre-wrap text-pretty text-sm leading-relaxed text-foreground">
              {props.typography ? zhTypography(shownTranslation) : shownTranslation}
            </p>
          ) : (
            props.translating && (
              <div role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner className="size-3.5 text-primary-text" />
                {t("lesson.translating")}
              </div>
            )
          )
        ) : props.kind === "compose" ? (
          <Textarea
            value={props.draft}
            onChange={(e) => props.onDraftChange(e.target.value)}
            onKeyDown={submitOnEnter(props.onSubmit, Boolean(props.draft.trim()) && !props.busyReason)}
            placeholder={t("lesson.composerPlaceholder")}
            aria-label={t("lesson.composerPlaceholder")}
            autoFocus={focusOnOpen}
            className="min-h-24 resize-none"
          />
        ) : (
          <div className="space-y-3">
            {isChat && thread.length === 0 && !props.streaming && (
              <p className="text-pretty text-[13px] leading-relaxed text-muted-foreground">{t("lesson.chatIntro")}</p>
            )}
            {thread.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-muted px-3 py-2 text-sm text-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} data-answer>
                  <div className="prose prose-bloom prose-compact max-w-none">
                    <Markdown typography>{m.content}</Markdown>
                  </div>
                  {(m as ChatTurn).partial === true && (
                    <p className="mt-1.5 text-pretty text-xs text-subtle-foreground">{t("lesson.chatPartial")}</p>
                  )}
                </div>
              )
            )}
            {props.streaming &&
              (props.streamText ? (
                <div data-answer className="prose prose-bloom prose-compact max-w-none">
                  <Markdown typography streaming>{props.streamText}</Markdown>
                </div>
              ) : (
                <div
                  role="status"
                  className="flex items-center gap-2 text-[13px] text-muted-foreground"
                >
                  <Spinner className="size-3.5 text-primary-text" />
                  {t("lesson.answering")}
                </div>
              ))}
            {isSession && props.notice && (
              <div role="status" className="flex items-start gap-2 text-[13px] leading-relaxed text-muted-foreground">
                {waited && <Spinner className="mt-[3px] size-3.5 text-primary-text" />}
                <div className="min-w-0">
                  <p className="text-pretty">{props.notice}</p>
                  {waited && <p aria-hidden="true" className="tabular-nums">{waited}</p>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t px-3 py-2.5">
        {props.kind === "translate" ? (
          <div className="space-y-2">
            {errorLine}
            <div className="flex items-center justify-end gap-2">
              {props.onRetry && (
                <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
                  {t("lesson.translateRetry")}
                </Button>
              )}
              <Button type="button" size="sm" onClick={props.onAsk}>
                {t("lesson.askThis")}
              </Button>
            </div>
          </div>
        ) : props.kind === "chat" ? (
          <div className="space-y-2">
            <Textarea
              value={props.draft}
              onChange={(e) => props.onDraftChange(e.target.value)}
              onKeyDown={submitOnEnter(props.onSend, Boolean(props.draft.trim()) && !props.busyReason && !props.streaming)}
              placeholder={t("lesson.chatPlaceholder")}
              aria-label={t("lesson.chatPlaceholder")}
              maxLength={8000}
              autoFocus={focusOnOpen}
              rows={2}
              className="max-h-28 min-h-16 resize-none"
            />
            {errorLine}
            <div className="flex items-center justify-end gap-2">
              {busyLine}
              <Button
                type="button"
                size="sm"
                onClick={props.onSend}
                loading={props.streaming}
                aria-describedby={busyLine ? "ask-busy" : undefined}
                disabled={!props.draft.trim() || Boolean(props.busyReason) || props.streaming}
                className={DISABLED_ASK}
              >
                {t("common.send")}
              </Button>
            </div>
          </div>
        ) : props.kind === "compose" ? (
          <div className="space-y-2">
            {errorLine}
            <div className="flex items-center justify-end gap-2">
              {busyLine}
              <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={props.onSubmit}
                disabled={!props.draft.trim() || Boolean(props.busyReason)}
                aria-describedby={busyLine ? "ask-busy" : undefined}
                className={DISABLED_ASK}
              >
                {t("common.ask")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {props.updated && <DoneBar message={t("lesson.answerUpdated")} className="px-3 py-2 text-[13px]" />}
            {props.followUpBlocked && (
              <p id="follow-up-blocked" className="text-pretty text-[13px] text-muted-foreground">{props.followUpBlocked}</p>
            )}
            <Textarea
              value={props.followDraft}
              onChange={(e) => props.onFollowDraftChange(e.target.value)}
              onKeyDown={submitOnEnter(
                props.onFollowUp,
                Boolean(props.followDraft.trim()) && !props.busyReason && !props.followUpBlocked
              )}
              placeholder={t("lesson.followUpPlaceholder")}
              aria-label={t("lesson.followUpPlaceholder")}
              aria-describedby={props.followUpBlocked ? "follow-up-blocked" : undefined}
              disabled={Boolean(props.followUpBlocked)}
              rows={2}
              className="max-h-28 min-h-16 resize-none"
            />
            {errorLine}
            <div className="flex items-center justify-end gap-2">
              {busyLine}
              {props.streaming ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={props.onStop}
                  loading={props.stopping}
                >
                  {!props.stopping && <Square className="size-3 fill-current" aria-hidden="true" />}
                  {props.stopping ? t("lesson.stopping") : t("common.stop")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={props.onFollowUp}
                  aria-describedby={busyLine ? "ask-busy" : undefined}
                  disabled={!props.followDraft.trim() || Boolean(props.busyReason) || Boolean(props.followUpBlocked)}
                  className={DISABLED_ASK}
                >
                  {t("common.send")}
                </Button>
              )}
            </div>
          </div>
        )}
      </footer>
    </section>
  );
});

export default AnnotationPanel;
