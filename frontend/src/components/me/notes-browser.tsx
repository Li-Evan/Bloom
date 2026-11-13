"use client";

import { ChevronDown, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import Mono from "@/components/brand/mono";
import { EmptyHint } from "@/components/learn/empty-state";
import Marked from "@/components/me/marked";
import NoteCard from "@/components/me/note-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { getNotesPage } from "@/lib/me/api";
import { filterNotes, groupByCourse, noteCourses } from "@/lib/me/notes";
import type { NoteItem, NotesPage } from "@/lib/me/types";
import { cn } from "@/lib/utils";

const PAGE = 100;
// 最多自动载入 1000 条：搜索与筛选都在已载入的笔记里做
const MAX_PAGES = 10;
const STEP = 20;
const ALL = "all";
const subscribe = () => () => {};

type View = "course" | "time";

export default function NotesBrowser({ initial, initialCourse }: { initial: NotesPage; initialCourse: number | null }) {
  const t = useTranslations("me.notes");
  const [notes, setNotes] = useState<NoteItem[]>(initial.items);
  const [loading, setLoading] = useState(initial.total > initial.items.length);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [courseId, setCourseId] = useState<number | null>(
    initialCourse !== null && initial.items.some((n) => n.course_id === initialCourse) ? initialCourse : null
  );
  const [view, setView] = useState<View>("course");
  const [visible, setVisible] = useState(STEP);
  // 后台补齐中途失败、点了「重试」：从已经载入的那些接着往后取，不从头再来（列表不会先缩回去）
  const [resume, setResume] = useState<NoteItem[] | null>(null);
  // Radix 的下拉自带 useId，开发模式下偶尔会因为顶栏的加载时机和服务端渲染的 id 对不上。
  // 服务端与水合之前先画一个同样大小的静态框，挂载后再换成真正的下拉
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);

  // 第一页由服务端给出，剩下的在后台按页补齐
  useEffect(() => {
    if (initial.total <= (resume ?? initial.items).length) return;
    let cancelled = false;
    (async () => {
      let all = resume ?? initial.items;
      try {
        for (let page = Math.floor(all.length / PAGE) + 1; all.length < initial.total && page <= MAX_PAGES; page++) {
          const next = await getNotesPage(page, PAGE);
          if (cancelled || next.items.length === 0) return;
          all = [...all, ...next.items];
          setNotes(all);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initial, resume]);

  const retry = () => {
    setFailed(false);
    setLoading(true);
    setResume(notes);
  };

  useEffect(() => setVisible(STEP), [query, courseId, view]);

  const courses = useMemo(() => noteCourses(notes), [notes]);
  const filtered = useMemo(() => filterNotes(notes, query, courseId), [notes, query, courseId]);
  const shown = filtered.slice(0, visible);
  const groups = useMemo(() => groupByCourse(shown), [shown]);
  const searching = query.trim() !== "" || courseId !== null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search_placeholder")}
            aria-label={t("search_label")}
            className="pl-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("clear_search")}
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-subtle-foreground hover:bg-card hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        {courses.length > 1 &&
          (mounted ? (
            <Select value={courseId === null ? ALL : String(courseId)} onValueChange={(v) => setCourseId(v === ALL ? null : Number(v))}>
              <SelectTrigger aria-label={t("filter_course")} className="w-full min-w-0 sm:w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("all_courses")}</SelectItem>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name} ({c.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div
              aria-hidden="true"
              className="flex h-10 w-full items-center justify-between gap-2 rounded-md border bg-muted px-3 text-sm sm:w-60"
            >
              <span className="truncate">{courseId === null ? t("all_courses") : courses.find((c) => c.id === courseId)?.name}</span>
              <ChevronDown className="size-4 opacity-50" />
            </div>
          ))}

        <div role="group" aria-label={t("view_label")} className="flex h-10 shrink-0 rounded-md border bg-muted p-0.5 text-sm">
          {(["course", "time"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                "rounded-[calc(var(--radius-md)-3px)] px-3 transition-colors",
                view === v ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(`view_${v}`)}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
        {searching
          ? notes.length < initial.total
            ? // 还没载入完（或超过 1000 条的载入上限）：搜索只覆盖已载入的最近这些，说清楚
              t("count_filtered_partial", { shown: filtered.length, loaded: notes.length, total: initial.total })
            : t("count_filtered", { shown: filtered.length, total: initial.total })
          : t("count_all", { count: initial.total })}
        {loading && !failed && (
          <span className="text-subtle-foreground">
            {" · "}
            <Spinner className="inline size-3.5 align-[-2px]" /> {t("loading_more")}
          </span>
        )}
        {failed && (
          <span className="text-warning">
            {" · "}
            {t("load_more_failed")}{" "}
            <button
              type="button"
              onClick={retry}
              className="font-medium text-accent-foreground underline underline-offset-4 hover:decoration-2"
            >
              {t("retry")}
            </button>
          </span>
        )}
      </p>

      {filtered.length === 0 ? (
        <EmptyHint
          className="mt-6"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setCourseId(null);
              }}
            >
              {t("clear_filters")}
            </Button>
          }
        >
          <strong className="font-medium text-foreground">{t("no_results_title")}</strong>
          {" · "}
          {t("no_results_text")}
        </EmptyHint>
      ) : view === "course" ? (
        <div className="mt-6 space-y-10">
          {groups.map((group) => (
            <section key={group.courseId} aria-labelledby={`course-${group.courseId}`}>
              <h2 id={`course-${group.courseId}`} className="mb-3 flex items-baseline justify-between gap-3">
                <Link
                  href={`/learn/course/${group.courseId}`}
                  title={group.courseName}
                  className="min-w-0 truncate text-lg font-semibold tracking-tight underline-offset-4 hover:text-accent-foreground hover:underline"
                >
                  <Marked text={group.courseName} query={query} />
                </Link>
                <span className="shrink-0 text-xs text-subtle-foreground">
                  <Mono text={t("course_count", { count: filtered.filter((n) => n.course_id === group.courseId).length })} />
                </span>
              </h2>
              <div className="space-y-3">
                {group.notes.map((note) => (
                  <NoteCard key={note.id} note={note} query={query} showCourse={false} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {shown.map((note) => (
            <NoteCard key={note.id} note={note} query={query} />
          ))}
        </div>
      )}

      {filtered.length > shown.length && (
        <div className="mt-8 flex justify-center">
          <Button variant="outline" onClick={() => setVisible((v) => v + STEP)}>
            {t("show_more", { count: filtered.length - shown.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
