"use client";

import { Archive, ArchiveRestore, Check, ChevronDown, Ellipsis, Highlighter, Languages, List, ListChecks, MessageSquareText, PencilLine, TableOfContents, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { EYEBROW_CLASS } from "@/components/brand/eyebrow";
import Mono from "@/components/brand/mono";
import { OutlineItems } from "@/components/learn/lesson-outline";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";
import { displayFileName } from "@/lib/learn/files";
import { readLessonNavExpanded, saveLessonNavExpanded, subscribeLessonNav } from "@/lib/learn/lesson-nav";
import { displayLessonTitle } from "@/lib/learn/lessons";
import type { OutlineEntry } from "@/lib/learn/outline";
import { splitMeaning } from "@/lib/learn/translation-meaning";
import type { LessonItem } from "@/lib/learn/types";
import { cn } from "@/lib/utils";

// 本篇的一条划线问答（右栏「N 个划线提问」展开的列表里的一行）
export interface SessionRow {
  id: number | string;
  comment: string;
  original_text: string;
}

// 本篇已保存的一条划线标记（只划线、没提问）：点它滚到正文里那一段
export interface MarkRow {
  id: number;
  original_text: string;
}

// 本篇保存下来的一条划线翻译：点它滚到正文里那一段并打开译文
export interface TranslationRow {
  id: number;
  original_text: string;
  translation: string;
}

interface ListProps {
  courseId: string;
  currentNum: number;
  allLessons: LessonItem[];
  isProject: boolean;
  // 本篇的划线问答；点一条打开那条（桌面在右栏出卡片，手机是底部抽屉）
  sessions: SessionRow[];
  onOpenSession: (id: number | string) => void;
  // 本篇的划线标记：点一条滚到正文里那一段，行尾的 × 直接删（大纲页没有标记，不传就不显示这一组）
  marks?: MarkRow[];
  onJumpMark?: (id: number) => void;
  onRemoveMark?: (id: number) => void;
  // 本篇的划线翻译（只有自己的）：点一条滚到那一段、打开译文卡片（大纲页没有，不传就不显示这一组）
  translations?: TranslationRow[];
  onOpenTranslation?: (id: number) => void;
  // 本篇目录（标题列表）：宽屏（xl 起）在正文左边一栏，这里就不再列；窄一点时是右栏里的一组，手机在抽屉里。
  // activeSection、onJumpSection 是课文页的 useSections。大纲页没有，不传就不显示这一组
  outline?: OutlineEntry[];
  activeSection?: string | null;
  onJumpSection?: (id: string) => void;
  // 目录这一组一开始就展开（手机抽屉：打开抽屉多半就是想跳到某一节）
  outlineOpen?: boolean;
  // 点了某一项之后（抽屉里用来关抽屉）
  onNavigate?: () => void;
  // 列表所在的滚动容器（桌面是右侧栏、小屏是抽屉里的 <nav>），篇数多时把当前篇滚到它的中间
  scrollRef?: React.RefObject<HTMLElement | null>;
  // 列表现在看得见吗（桌面打开提问卡片时导航让位）；看不见就不滚，再出现时重新滚
  visible?: boolean;
  // 大纲页里用这份列表时，「课程大纲」那一行是当前页
  onSyllabus?: boolean;
  // 资料类课程每个文件的「更多」菜单：改名、删除。不传就没有菜单
  onRenameFile?: (lesson: LessonItem) => void;
  onDeleteFile?: (lesson: LessonItem) => void;
  // 归档 / 取消归档这个文件（菜单里排在删除前面）
  onArchiveFile?: (lesson: LessonItem) => void;
  // 桌面右栏把课文 / 文件列表收起来了：只留下面的划线提问、标记、翻译几组；listId 给展开按钮的 aria-controls
  lessonsHidden?: boolean;
  listId?: string;
  // 桌面右栏列表上面「文件 / 课文」那一行：和列表包在同一块里，右栏滚动时它吸顶只吸到列表结束，再往下由下一组的标题接上
  head?: React.ReactNode;
}

// 章节列表：桌面是正文右侧的粘性侧栏，手机 / 平板放进抽屉。已读打勾、当前篇高亮、本篇的划线提问数。
export function ChapterList({
  courseId,
  currentNum,
  allLessons,
  isProject,
  sessions,
  onOpenSession,
  marks = [],
  onJumpMark,
  onRemoveMark,
  translations = [],
  onOpenTranslation,
  outline = [],
  activeSection = null,
  onJumpSection,
  outlineOpen = false,
  onNavigate,
  scrollRef,
  visible = true,
  onSyllabus = false,
  onRenameFile,
  onDeleteFile,
  onArchiveFile,
  lessonsHidden = false,
  listId,
  head,
}: ListProps) {
  const t = useTranslations("learn");
  const listRef = useRef<HTMLUListElement>(null);

  // 只滚传进来的那个容器，不动页面；display:none 的那个实例（小屏上的桌面侧栏）量不出尺寸，直接跳过
  useEffect(() => {
    const list = listRef.current;
    const box = scrollRef?.current;
    if (!visible || !list || !box || !list.getClientRects().length) return;
    const active = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    const a = active.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    box.scrollTop += a.top - b.top - (b.height - a.height) / 2;
  }, [currentNum, allLessons.length, visible, scrollRef]);

  const row =
    "group flex items-start gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
  const idle = "text-muted-foreground hover:bg-muted hover:text-foreground";

  return (
    <>
      <div>
        {head}
        {!lessonsHidden && (
          <ul ref={listRef} id={listId} className="space-y-0.5">
            {!isProject && (
              <li>
                <Link
                  href={`/learn/course/${courseId}/syllabus`}
                  onClick={onNavigate}
                  aria-current={onSyllabus ? "page" : undefined}
                  className={cn(row, "items-center", onSyllabus ? "bg-accent font-medium text-accent-foreground" : idle)}
                >
                  <ListChecks className="size-4 shrink-0" aria-hidden="true" />
                  <span>{t("lesson.syllabus")}</span>
                </Link>
              </li>
            )}

            {allLessons.filter((l) => isProject || !l.is_source).map((l) => {
              const active = l.number === currentNum;
              const title =
                (isProject && l.source_filename && displayFileName(l.source_filename)) ||
                displayLessonTitle(l.title) ||
                t("common.lessonNumber", { number: l.number });
              const tags = [
                l.is_source && t("common.source"),
                l.is_archived && t("course.archive.badge"),
                l.is_evaluation && t("lesson.evaluation"),
                l.has_feedback && t("common.feedbackDone"),
              ].filter(Boolean);

              const menu = Boolean(isProject && onRenameFile && onDeleteFile);

              return (
                <li key={l.id} className={cn(menu && "group/file relative")}>
                  <Link
                    href={`/learn/course/${courseId}/lesson/${l.number}`}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      row,
                      menu && "pr-10",
                      active ? "bg-accent text-accent-foreground" : idle
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 shrink-0 font-mono text-xs tabular-nums",
                        active ? "text-accent-foreground" : "text-subtle-foreground"
                      )}
                    >
                      {String(l.number).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        title={title}
                        className={cn(
                          "line-clamp-2 text-balance leading-snug",
                          active && "font-medium"
                        )}
                      >
                        {title}
                      </span>
                      {tags.length > 0 && (
                        <span className="mt-1 block text-[11px] text-subtle-foreground">
                          {tags.join(" · ")}
                        </span>
                      )}
                    </span>
                    {l.is_read && (
                      <Check
                        className="mt-0.5 size-4 shrink-0 text-primary-text"
                        aria-label={t("common.read")}
                      />
                    )}
                  </Link>
                  {/* 链接里不能套按钮：菜单按钮叠在这一行右上角 */}
                  {menu && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t("course.move.menuLabel", { name: title })}
                          className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-md text-muted-foreground transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:bg-muted data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/file:opacity-100"
                        >
                          <Ellipsis className="size-4" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onRenameFile!(l)}>
                          <PencilLine aria-hidden="true" />
                          {t("course.renameFile.item")}
                        </DropdownMenuItem>
                        {onArchiveFile && (
                          <DropdownMenuItem onSelect={() => onArchiveFile(l)}>
                            {l.is_archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
                            {l.is_archived ? t("course.archive.restore") : t("course.archive.item")}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem variant="destructive" onSelect={() => onDeleteFile!(l)}>
                          <Trash2 aria-hidden="true" />
                          {t("course.deleteFile.item")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {outline.length > 0 && onJumpSection && (
        <RailGroup
          className="xl:hidden"
          defaultOpen={outlineOpen}
          icon={<TableOfContents className="size-4 shrink-0 text-accent-foreground" aria-hidden="true" />}
          label={t("lesson.outline")}
        >
          <OutlineItems
            entries={outline}
            active={activeSection}
            onJump={(id) => {
              onJumpSection(id);
              onNavigate?.();
            }}
          />
        </RailGroup>
      )}

      {sessions.length > 0 && (
        <RailGroup
          icon={<MessageSquareText className="size-4 shrink-0 text-accent-foreground" aria-hidden="true" />}
          label={t("lesson.highlightCount", { count: sessions.length })}
        >
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  onOpenSession(s.id);
                  onNavigate?.();
                }}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              >
                <span className="line-clamp-2 break-words" title={s.comment}>{s.comment}</span>
                <span className="mt-0.5 line-clamp-1 break-words text-xs text-subtle-foreground" title={s.original_text}>
                  {s.original_text}
                </span>
              </button>
            </li>
          ))}
        </RailGroup>
      )}

      {marks.length > 0 && (
        <RailGroup
          icon={<Highlighter className="size-4 shrink-0 text-accent-foreground" aria-hidden="true" />}
          label={t("lesson.markedPassages", { count: marks.length })}
        >
          {marks.map((m) => (
            <li key={m.id} className="relative">
              <button
                type="button"
                onClick={() => {
                  onJumpMark?.(m.id);
                  onNavigate?.();
                }}
                className="block w-full rounded-lg py-2 pl-3 pr-9 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span className="line-clamp-2 break-words" title={m.original_text}>{m.original_text}</span>
              </button>
              {onRemoveMark && (
                <button
                  type="button"
                  onClick={() => onRemoveMark(m.id)}
                  disabled={m.id < 0}
                  aria-label={t("lesson.unmark")}
                  title={t("lesson.unmark")}
                  className="absolute right-1 top-1.5 flex size-7 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:text-destructive disabled:opacity-40"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </RailGroup>
      )}

      {translations.length > 0 && (
        <RailGroup
          icon={<Languages className="size-4 shrink-0 text-accent-foreground" aria-hidden="true" />}
          label={t("lesson.translatedPassages", { count: translations.length })}
        >
          {translations.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  onOpenTranslation?.(item.id);
                  onNavigate?.();
                }}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              >
                <span className="line-clamp-1 break-words" title={item.original_text}>{item.original_text}</span>
                {/* 列表里只放译文，后面那句「在这里的意思」不占地方 */}
                <span className="mt-0.5 line-clamp-2 break-words text-xs text-subtle-foreground" title={splitMeaning(item.translation).translation}>
                  {splitMeaning(item.translation).translation}
                </span>
              </button>
            </li>
          ))}
        </RailGroup>
      )}
    </>
  );
}

// 右栏里可折叠的一组：「目录」「N 个划线提问」「我的标记（N）」「我的翻译（N）」用同一个壳（展开箭头、缩进、分隔线）。
// 标题行带 rail-head：桌面右栏滚动时吸在右栏顶上，这一组滚完了被下一组顶走（learn.css）
function RailGroup({
  icon,
  label,
  defaultOpen = false,
  className,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // 桌面右栏和手机抽屉各有一份列表：id 不能重复
  const id = useId();

  return (
    <div className={cn("mt-4 border-t pt-3", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="rail-head flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted"
      >
        {icon}
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-subtle-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && <ul id={id} className="mt-1 space-y-0.5">{children}</ul>}
    </div>
  );
}

// 面包屑条右边的「课文」按钮（< lg 才有）：打开课文抽屉。课文页和大纲页用同一个；高 40px，够得着。
// 没有 onClick（课文还在加载，抽屉还没有）就禁用，不做一个点了没反应的按钮
export function ChaptersButton({ onClick, expanded }: { onClick?: () => void; expanded: boolean }) {
  const t = useTranslations("learn");

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      className="inline-flex h-10 items-center gap-1.5 rounded-md border border-foreground/20 px-3.5 text-[13px] font-medium transition-colors hover:border-foreground/30 hover:bg-muted lg:hidden disabled:pointer-events-none disabled:opacity-50"
    >
      <List className="size-4" aria-hidden="true" />
      {t("lesson.chapters")}
    </button>
  );
}

// 桌面右栏里问答卡片打开时的课文目录：收成一行「课文 · 第 N 篇 ▾」，点开在右栏里原位展开（列表有最大高度、自己滚动），
// 下面的问答卡片被往下推、按原来的规则重新定位（lesson.tsx 量这一组的高度，把卡片的吸附线让出来），不再有任何东西盖在卡片上
// （选一篇就跳过去，点别处或按 Esc 收起）。目录整块消失会让页面像跳了一下，读者也找不到课文列表了
export function CollapsedNav(props: Omit<ListProps, "onNavigate" | "scrollRef" | "visible">) {
  const t = useTranslations("learn");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const label = props.isProject ? t("lesson.files") : t("lesson.chapters");
  const current = props.isProject
    ? (displayFileName(props.allLessons.find((l) => l.number === props.currentNum)?.source_filename ?? "") || t("common.lessonNumber", { number: props.currentNum }))
    : t("common.lessonNumber", { number: props.currentNum });

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);

    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <div
      ref={wrap}
      onKeyDown={(event) => {
        // 列表开着时 Esc 只收起列表，不顺带关掉问答卡片
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border bg-card px-3 text-sm shadow-sm transition-colors hover:bg-muted"
      >
        <span className="flex min-w-0 items-center gap-2">
          <List className="size-4 shrink-0 text-accent-foreground" aria-hidden="true" />
          {/* 标签不收缩、不换行：文件名再长也只截文件名，「文件」不会被挤成竖排两行 */}
          <span className="shrink-0 whitespace-nowrap font-medium">{label}</span>
          <span className="min-w-0 truncate text-muted-foreground">· {current}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-subtle-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          className="mt-1 max-h-[min(14rem,30dvh)] overflow-y-auto overscroll-contain rounded-lg border bg-card p-2"
        >
          <ChapterList {...props} scrollRef={list} onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// 桌面右侧栏里的章节导航：列表默认收起，点「文件 / 课文」这一行展开、收起（下面的划线提问、标记、翻译几组不跟着收），展开了记在本机（lib/learn/lesson-nav.ts）。
// 服务端渲染时不知道本机展没展开，照展开渲染出列表；learn.css 在 <html> 没有 data-lesson-nav="expanded" 时藏起紧跟在这一行后面的列表、箭头朝下，
// 刷新时两种状态都不闪；React 接管后收着就不渲染列表。这一行和列表包在一块里（ChapterList 的 head），右栏滚动时吸顶到列表结束
export function LessonNav({ visible = true, ...props }: Omit<ListProps, "onNavigate">) {
  const t = useTranslations("learn");
  const collapsed = !useSyncExternalStore(subscribeLessonNav, readLessonNavExpanded, () => true);
  const listId = useId();
  const label = props.isProject ? t("lesson.files") : t("lesson.chapters");

  const head = (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-controls={collapsed ? undefined : listId}
      onClick={() => saveLessonNavExpanded(collapsed)}
      className="lesson-nav-toggle rail-head -mt-1 mb-2 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-1 text-left transition-colors hover:bg-muted"
    >
      <span className={cn(EYEBROW_CLASS, "text-primary-text")}><Mono text={label} /></span>
      <ChevronDown className={cn("size-4 shrink-0 text-subtle-foreground transition-transform", !collapsed && "rotate-180")} aria-hidden="true" />
    </button>
  );

  return (
    <nav aria-label={label}>
      {/* 收起后列表不渲染、也不滚到当前篇；再展开时当前篇重新滚到右栏中间 */}
      <ChapterList {...props} head={head} listId={listId} lessonsHidden={collapsed} visible={visible && !collapsed} />
    </nav>
  );
}

// 手机 / 平板：从右侧滑出的章节抽屉
export function ChapterDrawer({
  open,
  onOpenChange,
  ...props
}: Omit<ListProps, "onNavigate" | "scrollRef" | "visible"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("learn");
  const label = props.isProject ? t("lesson.files") : t("lesson.chapters");
  const boxRef = useRef<HTMLElement>(null);
  // 抽屉里点了目录的一条：先关抽屉，等它关完（焦点本来要回到「课文」按钮的那一刻）再跳过去、焦点落到那个标题上。
  // 抽屉开着时页面锁着滚动、焦点也出不去
  const pendingSection = useRef<string | null>(null);
  const { onJumpSection } = props;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0"
        onCloseAutoFocus={(event) => {
          const id = pendingSection.current;
          if (!id || !onJumpSection) return;
          pendingSection.current = null;
          event.preventDefault();
          onJumpSection(id);
        }}
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="text-lg">{label}</SheetTitle>
          <SheetDescription className="sr-only">
            {t("lesson.openNav")}
          </SheetDescription>
        </SheetHeader>
        <nav
          ref={boxRef}
          aria-label={label}
          className="min-h-0 flex-1 scroll-py-1 overflow-y-auto p-3"
        >
          <ChapterList
            {...props}
            outlineOpen
            onJumpSection={onJumpSection && ((id) => { pendingSection.current = id; })}
            scrollRef={boxRef}
            onNavigate={() => onOpenChange(false)}
          />
        </nav>
      </SheetContent>
    </Sheet>
  );
}
