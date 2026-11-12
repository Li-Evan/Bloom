"use client";

import { ArrowRight, ChevronDown } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef, useState } from "react";

import Mono from "@/components/brand/mono";
import AnswerPreview from "@/components/me/answer-preview";
import LocalTime from "@/components/me/local-time";
import Marked from "@/components/me/marked";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import type { Message } from "@/lib/learn/types";
import { fullConversation, previewText } from "@/lib/me/annotations";
import { zhTypography } from "@/lib/learn/lesson-text";
import { displayLessonTitle } from "@/lib/learn/lessons";
import { clipExcerpt, followUps, plainExcerpt } from "@/lib/me/notes";
import type { NoteItem } from "@/lib/me/types";
import { cn } from "@/lib/utils";

// 一条划线笔记：原文摘录、我的问题、回答摘要，底下是出处和「回到课文」（带 ?annotation=，课文页会滚到那处划线并打开这条问答）。
// 回答摘要截断了就补省略号；「展开全文」取这条的完整对话（提问、回答、追问）。
// 整张卡不做成链接，方便选中文字复制；跳转只靠底部的链接。

// 完整对话只在点「展开全文」之后才渲染：Markdown 渲染器（连同 KaTeX）按需加载，不进笔记列表的首屏包
const Markdown = dynamic(() => import("@/components/learn/markdown"));

export default function NoteCard({
  note,
  query = "",
  showCourse = true,
  className,
}: {
  note: NoteItem;
  query?: string;
  showCourse?: boolean;
  className?: string;
}) {
  const t = useTranslations("me.notes");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const [full, setFull] = useState<Message[] | null>(null);
  const again = followUps(note.message_count);
  const lesson =
    note.lesson_number > 0 ? t("lesson_n", { number: note.lesson_number }) : t("summary_lesson");
  const title = displayLessonTitle(note.lesson_title);
  const preview = previewText(note.answer_preview);
  // 中文排版：课文原文里直引号 / 半角冒号渲染时已经换成中文的，笔记里的摘录和回答摘要同样（提问是用户自己写的，不动）
  // 太长的摘录按句子边界截断（搜索命中在后面就从命中那句开始），不在半句话里被切断
  const excerpt = clipExcerpt(zhTypography(plainExcerpt(note.original_text)), 220, query);
  const answerText = zhTypography(preview.text);
  // 提问和回答摘要在折起时各只显示两行（line-clamp-2）：真被折住了（量出来 scrollHeight > clientHeight，随卡片宽度变）才算有更多可看
  const questionRef = useRef<HTMLElement>(null);
  const answerRef = useRef<HTMLElement>(null);
  const [clamped, setClamped] = useState(false);
  // 只有确实有更多可看的才出现「展开全文」：回答被后端截断了、追问过，或者提问 / 回答在卡片上被折住了
  const canExpand = preview.cut || note.message_count > 2 || clamped;

  // 展开后折叠样式去掉了，量不出来；保留展开前量到的结果，按钮才不会在展开时消失
  useLayoutEffect(() => {
    if (open) return;
    const els = [questionRef.current, answerRef.current].filter((el): el is HTMLElement => !!el);
    const measure = () => setClamped(els.some((el) => el.scrollHeight > el.clientHeight + 1));
    measure();
    const observer = new ResizeObserver(measure);
    els.forEach((el) => observer.observe(el));
    // 折住的元素高度是固定的两行，字体换了、折行变了它的尺寸不一定变，ResizeObserver 不会响；字体加载完再量一次
    let live = true;
    document.fonts?.ready.then(() => live && measure());

    return () => {
      live = false;
      observer.disconnect();
    };
  }, [open, note.question, answerText, query]);

  // 第一次展开要先取完整对话：取的时候按钮转圈写「正在加载…」，取到了（或取失败、先展开摘要）才变成「收起」
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (state === "loading") return;
    if (!full) {
      setState("loading");
      try {
        const messages = await fullConversation(note);
        setFull(messages);
        setState(messages ? "idle" : "failed");
      } catch {
        setState("failed");
      }
    }
    setOpen(true);
  };
  const loading = state === "loading";

  return (
    <article className={cn("rounded-lg border bg-card p-5", className)}>
      <blockquote className="line-clamp-4 border-l-2 border-primary/50 pl-3.5 text-[15px] leading-relaxed text-foreground/90">
        <Marked text={excerpt} query={query} />
      </blockquote>

      {open && full ? (
        <div className="mt-4 space-y-3 text-sm leading-relaxed">
          {full.map((message, i) =>
            message.role === "user" ? (
              <p key={i} className="flex gap-3 font-medium">
                <span className="mt-px w-4 shrink-0 text-[13px] text-accent-foreground"><Mono text={t("q")} /></span>
                <span className="min-w-0 whitespace-pre-wrap break-words">{message.content}</span>
              </p>
            ) : (
              <div key={i} className="flex gap-3">
                <span className="mt-px w-4 shrink-0 text-[13px] text-subtle-foreground"><Mono text={t("a")} /></span>
                <div className="prose prose-bloom prose-compact min-w-0 max-w-none text-muted-foreground [&>:first-child]:mt-0 [&>:last-child]:mb-0">
                  <Markdown typography>{message.content}</Markdown>
                </div>
              </div>
            )
          )}
        </div>
      ) : (
        <dl className="mt-4 space-y-2 text-sm leading-relaxed">
          <div className="flex gap-3">
            <dt className="mt-px w-4 shrink-0 text-[13px] text-accent-foreground"><Mono text={t("q")} /></dt>
            <dd ref={questionRef} className={cn("font-medium", !open && "line-clamp-2")}>
              <Marked text={note.question} query={query} />
            </dd>
          </div>
          {note.answer_preview && (
            <div className="flex gap-3 text-muted-foreground">
              <dt className="mt-px w-4 shrink-0 text-[13px] text-subtle-foreground"><Mono text={t("a")} /></dt>
              <dd ref={answerRef} className={cn(!open && "line-clamp-2")}>
                <AnswerPreview text={answerText} cut={preview.cut} query={query} />
                {preview.cut && "…"}
              </dd>
            </div>
          )}
        </dl>
      )}

      <span role="status" className="sr-only">
        {loading ? t("expanding") : ""}
      </span>
      {open && state === "failed" && (
        <p role="status" className="mt-3 text-xs text-warning">
          {t("full_failed")}
        </p>
      )}
      {canExpand && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          // 取的时候不禁用（禁用会把键盘焦点丢到页面开头），重复点由 toggle 挡掉
          aria-busy={loading || undefined}
          // 点击区高 40px（上下各撑 10px，用负外边距抵掉，版面不变）
          className={cn(
            "-mb-2.5 mt-0.5 inline-flex items-center gap-1 rounded-sm py-2.5 text-sm font-medium text-accent-foreground underline-offset-4 hover:underline",
            loading && "cursor-wait hover:no-underline"
          )}
        >
          {loading && <Spinner className="size-3.5" />}
          {loading ? t("expand_loading") : open ? t("collapse") : t("expand")}
          {!loading && <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />}
        </button>
      )}

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3.5 text-xs text-subtle-foreground">
        <p className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-2 gap-y-0.5">
          {showCourse && (
            <span className="truncate font-medium text-muted-foreground">
              <Marked text={note.course_name} query={query} />
            </span>
          )}
          <span className="truncate">
            {lesson}
            {title && (
              <>
                {" · "}
                <Marked text={title} query={query} />
              </>
            )}
          </span>
          <span aria-hidden="true">·</span>
          <LocalTime iso={note.created_at} style="day" />
          {again > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("follow_ups", { count: again })}</span>
            </>
          )}
        </p>
        <Link
          href={`/learn/course/${note.course_id}/lesson/${note.lesson_number}?annotation=${note.id}`}
          className="-my-2.5 inline-flex shrink-0 items-center gap-1 py-2.5 text-sm font-medium text-accent-foreground underline-offset-4 hover:underline"
        >
          {t("open_lesson")}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </footer>
    </article>
  );
}
