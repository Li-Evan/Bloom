"use client";

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { ArrowRight, BookOpen, Check, ChevronRight, RefreshCw, Search, Sprout, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useAppContext } from "@/contexts/app";
import { LearnPage, QuietNotice } from "@/components/learn/shell";
import Markdown from "@/components/learn/markdown";
import { PageHead } from "@/components/page-head";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLearnError } from "@/components/learn/use-learn-error";
import { stepCoordinate } from "@/lib/learn/coordinate";
import {
  coordinateTree, getCoordinateOverview, matchesCourse, placeCourses, type CoordinateOverview, type MapCourse, type TreeNode,
} from "@/lib/learn/coordinate-map";
import { focusRefreshDue, getKnowledgeMap, syncKnowledgeChunk, syncKnowledgeMap, type KnowledgeMap as MapData } from "@/lib/learn/knowledge";
import { courseKnowledgeMap, courseTopicCount, type CourseKnowledgeNode } from "@/lib/learn/knowledge-courses";
import { cn } from "@/lib/utils";

// 课程详情：在知识树上的位置、相邻方向（进过课程页才有），以及从已读课文里整理出的已学内容。
// 宽屏时详情固定在右侧、不超过一屏高，滚到底也不带着整页滚：屏幕够高（xl-tall）时只有已学内容在自己的框里滚，
// 上面的课名、位置、相邻方向不动；屏幕矮时整张详情卡一起滚。主题不多（≤3 个）时不压缩，免得留出空白
function CoursePanel({ course, area, node, onClose }: {
  course: MapCourse; area: string; node: CourseKnowledgeNode | undefined; onClose: () => void;
}) {
  const t = useTranslations("learn.map");
  const course_id = String(course.course_id);
  const topics = node?.topics ?? [];
  return (
    <aside aria-label={t("detail")} className="flex flex-col rounded-2xl bg-card p-5 shadow-md sm:p-6 xl:max-h-[calc(100dvh-7.5rem)] xl:overflow-y-auto xl:overscroll-contain">
      <div className="mb-4 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-medium text-primary-text">{t("courseLabel")}</p>
          <h2 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{course.name}</h2>
          <span className="mt-1.5 block text-xs text-subtle-foreground">
            {t(`learned.${course.learned ?? "unread"}`)}{node?.readLessons != null && ` · ${t("lessonsRead", { count: node.readLessons })}`}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="shrink-0" onClick={onClose} aria-label={t("close")}><X className="size-4" /></Button>
      </div>
      <Button asChild className="w-full shrink-0"><Link href={`/learn/course/${course.course_id}` as any}>{t("openCourse")}<ArrowRight className="size-4" /></Link></Button>
      <section className="mt-6 shrink-0">
        <h3 className="mb-2 text-sm font-medium">{t("where")}</h3>
        {course.here ? <>
          <p className="break-words text-[13px] leading-snug text-muted-foreground">{[area, ...course.path.map((p) => p.label)].join(" › ")}</p>
          <p className="mt-0.5 break-words text-lg font-semibold leading-snug">{course.here.label}</p>
          {course.also.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t("also")}</span>
            {course.also.map((a) => <Badge key={a.node_id} variant="outline">{a.label}</Badge>)}
          </div>}
        </> : <p className="text-sm text-muted-foreground">{t(`unplaced.${course.state}`)}</p>}
      </section>
      {course.here && (course.directions.length > 0 || course.directions_pending) && <section className="mt-6 shrink-0">
        <h3 className="mb-2 text-sm font-medium">{t("directions")}</h3>
        {course.directions.length > 0 ? <ul className="space-y-3">
          {course.directions.map((d) => <li key={d.id}>
            <p className="font-medium leading-snug">{d.label}</p>
            <p className="mt-0.5 text-pretty text-sm leading-relaxed text-muted-foreground">{d.question}</p>
          </li>)}
        </ul> : <p className="text-sm text-muted-foreground">{t("directionsPending")}</p>}
      </section>}
      {topics.length > 0 ? <section className={cn("mt-6 flex flex-col", topics.length > 3 ? "xl-tall:min-h-48" : "shrink-0")}>
        <h3 className="mb-3 shrink-0 text-sm font-medium">{t("topicsInside", { count: topics.length })}</h3>
        <div key={course_id} className="space-y-2 xl-tall:-mr-3 xl-tall:min-h-0 xl-tall:flex-1 xl-tall:overflow-y-auto xl-tall:overscroll-contain xl-tall:pr-3">
          {topics.map((topic) => <details key={topic.id} className="rounded-lg bg-muted/60 px-3 py-1">
            <summary className="cursor-pointer rounded-md py-2 text-sm">{topic.label}</summary>
            <p className="mb-3 text-xs leading-6 text-muted-foreground">{topic.summary}</p>
            {topic.sources.map((source) => <div key={`${source.course_id}-${source.lesson_number}`} className="mb-4">
            <Link href={`/learn/course/${source.course_id}/lesson/${source.lesson_number}` as any}
              className="group flex items-start gap-2 rounded-md text-sm font-medium hover:text-primary-text">
              <BookOpen className="mt-0.5 size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">{source.lesson_title}</span>
              <ArrowRight className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            </Link>
            <div className="prose prose-sm prose-bloom prose-compact mt-3 max-w-none break-words rounded-lg bg-muted/70 px-3 py-2 text-muted-foreground [overflow-wrap:anywhere] [&_blockquote]:my-0 [&_blockquote]:border-0 [&_blockquote]:pl-0 [&_blockquote]:not-italic [&_p]:my-2 [&_p]:text-xs [&_p]:leading-6"><Markdown>{source.quote}</Markdown></div>
            </div>)}
          </details>)}
        </div>
      </section> : course.read && <p className="mt-6 text-sm leading-7 text-muted-foreground">{t("courseTopicsPending")}</p>}
    </aside>
  );
}

// 树上的一门课：实心点是读过课文的，空心点是还没读的
function CourseRow({ course, active, status, onChoose }: {
  course: MapCourse; active: boolean; status: React.ReactNode; onChoose: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button type="button" onClick={onChoose} aria-pressed={active} title={course.name}
      className={cn("flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors", active ? "bg-accent text-accent-foreground" : "hover:bg-muted")}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", course.read ? "bg-primary" : "border border-primary/60")} />
      <span className="min-w-0 flex-1 truncate text-sm">{course.name}</span>
      <span className="shrink-0 text-xs text-subtle-foreground">{status}</span>
      <ChevronRight className="size-4 shrink-0 text-subtle-foreground rtl:rotate-180" aria-hidden="true" />
    </button>
  );
}

// 这一门课所在的节点之上被并进来的几级（只有一条路往下的）淡色写在前面；几门课共用的节点标出「N 门课在这里相连」
function Branch({ node, selectedId, onChoose }: {
  node: TreeNode; selectedId: number | null; onChoose: (event: MouseEvent<HTMLButtonElement>, course: MapCourse) => void;
}) {
  const t = useTranslations("learn.map");
  const meets = node.count >= 2 && node.courses.length + node.children.length >= 2;
  return (
    <li>
      <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 py-1 text-sm leading-snug">
        {node.trail.length > 0 && <span className="text-muted-foreground">{node.trail.join(" › ")} ›</span>}
        <span className="font-medium">{node.label}</span>
        {meets && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">{t("meet", { count: node.count })}</span>}
      </p>
      {node.courses.length > 0 && <div className="mb-1 space-y-0.5">
        {node.courses.map((course) => <CourseRow key={course.course_id} course={course} active={selectedId === course.course_id}
          status={t(`learned.${course.learned ?? "unread"}`)} onChoose={(event) => onChoose(event, course)} />)}
      </div>}
      {node.children.length > 0 && <ul className="ml-1 space-y-1 border-l border-border pl-3">
        {node.children.map((child) => <Branch key={child.id} node={child} selectedId={selectedId} onChoose={onChoose} />)}
      </ul>}
    </li>
  );
}

// 这一轮要整理的分块数：别处正在整理的算在里面，失败后等着后端重试的不算（这一轮不会碰）
const toSync = (map: MapData) => map.pending_count - map.failed_count;

export default function KnowledgeMapPage() {
  const t = useTranslations("learn.map");
  const locale = useLocale();
  const report = useLearnError();
  const { user, userLoadFailed, reloadUser } = useAppContext();
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  // 用户点了「更新地图」、还在跑；run 是这一轮的中止开关（离开页面或换了人就停）
  const [updating, setUpdating] = useState(false);
  const run = useRef<AbortController | null>(null);
  const [syncing, setSyncing] = useState(false);
  // 开始整理时要整理多少块：和剩下的块数一减，就是整理进度
  const [syncTotal, setSyncTotal] = useState(0);
  // 这一轮在整理几篇课文；整理完新增了几个主题
  const [syncLessons, setSyncLessons] = useState(0);
  const [added, setAdded] = useState(0);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [retrying, setRetrying] = useState(false);
  // 地图是哪个用户的：换了人才清空重来，「重试」时已经显示的地图留着，拿到新的再换
  const loadedFor = useRef<string | null>(null);
  // 每门课在共享知识树上的位置；placing 是正在定位的那门课
  const [overview, setOverview] = useState<CoordinateOverview | null>(null);
  const [placing, setPlacing] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const unplacedHeading = useId();

  useEffect(() => { setQuery(""); setAdded(0); }, [user?.uuid]);

  // 进页面只读已经存下的地图和课程位置，不调模型；整理新读的课文、给新课定位都等用户点「更新地图」
  useEffect(() => {
    if (!user?.uuid) { setData(null); setLoading(true); loadedFor.current = null; return; }
    const controller = new AbortController();
    let stopped = false;
    let lastRead = 0;
    if (loadedFor.current !== user.uuid) {
      loadedFor.current = user.uuid;
      setData(null);
      setOverview(null);
      setLoading(true);
      setSelectedId(null);
    }
    // 两条读请求同时发，会合成一次 /api/batch。读到了才收起上一次的错误（「重试」时错误和转圈的按钮一直留到这时）
    const read = async () => {
      lastRead = Date.now();
      const [map, places] = await Promise.allSettled([getKnowledgeMap(controller.signal), getCoordinateOverview(locale, controller.signal)]);
      if (stopped) return;
      if (map.status === "fulfilled") setData(map.value);
      if (places.status === "fulfilled") setOverview(places.value);
      const failed = [map, places].find((result) => result.status === "rejected");
      setError(failed ? report(failed.reason) : "");
      setRetrying(false);
      setLoading(false);
    };
    // 切回窗口：距上次读满一分钟、也没在更新时才重新读，看有没有新读的课文要整理
    const onFocus = () => { if (!run.current && focusRefreshDue(lastRead)) void read(); };
    void read();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      controller.abort();
      run.current?.abort();
      run.current = null;
      setUpdating(false); setSyncing(false); setPlacing(null);
      window.removeEventListener("focus", onFocus);
    };
  }, [user?.uuid, revision, report, locale]);

  // 「更新地图」：还没定位的课逐门定位一次，新读的课文逐块整理进已学内容，每一步都是一次模型调用。
  // 两件事先后跑，同一时间只占一路模型调用；定位失败也照样接着整理课文，最后一起报错
  const update = async () => {
    if (!data || !overview || run.current) return;
    const controller = new AbortController();
    run.current = controller;
    const stopped = () => controller.signal.aborted;
    const first = data;
    const lessons = new Set(first.queue.map((chunk) => chunk.lesson_id));
    let latest = first;
    let failure: unknown = null;
    setUpdating(true);
    setAdded(0);
    setError("");
    try {
      await placeCourses(overview, {
        step: (courseId) => stepCoordinate(courseId, locale),
        load: () => getCoordinateOverview(locale, controller.signal),
        onOverview: (next) => { if (!stopped()) setOverview(next); },
        onPlacing: (courseId) => { if (!stopped()) setPlacing(courseId); },
        stopped,
      });
    } catch (err) {
      failure = err;
    }
    if (stopped()) return;
    setPlacing(null); // 定位途中重读总览失败时 placeCourses 不会自己清掉
    if (first.queue.length > 0) {
      setSyncing(true);
      setSyncTotal(toSync(first));
      setSyncLessons(lessons.size);
      try {
        await syncKnowledgeMap(first, {
          load: () => getKnowledgeMap(controller.signal),
          sync: (chunk) => syncKnowledgeChunk(chunk, controller.signal),
          onMap: (map) => {
            latest = map;
            setData(map);
            // 整理途中又读了新课文：总数跟着变大
            setSyncTotal((n) => Math.max(n, toSync(map)));
            map.queue.forEach((chunk) => lessons.add(chunk.lesson_id));
            setSyncLessons(lessons.size);
          },
          stopped,
        });
      } catch (err) {
        failure ??= err;
      }
      if (stopped()) return;
      setSyncing(false);
      setAdded(courseTopicCount(latest) - courseTopicCount(first));
    }
    run.current = null;
    setUpdating(false);
    if (failure) setError(report(failure));
  };

  const graph = useMemo(() => courseKnowledgeMap(data ?? { courses: [], nodes: [] }), [data]);
  const topicsOf = useMemo(() => new Map(graph.nodes.map((node) => [node.courseId, node])), [graph]);
  const courses = overview?.courses ?? [];
  const filtered = courses.filter((course) => matchesCourse(course, query, topicsOf.get(course.course_id)?.topics.map((topic) => topic.label)));
  const areas = coordinateTree({ band: overview?.band ?? [], courses: filtered });
  const unplaced = filtered.filter((course) => course.state !== "placed");
  const areaLabel = new Map((overview?.band ?? []).map((b) => [b.node_id, b.label]));
  const selected = filtered.find((course) => course.course_id === selectedId) ?? null;
  const choose = (event: MouseEvent<HTMLButtonElement>, course: MapCourse) => {
    opener.current = event.currentTarget;
    const opening = selectedId !== course.course_id;
    setSelectedId(opening ? course.course_id : null);
  };
  useEffect(() => {
    if (!selectedId || window.matchMedia("(min-width: 1280px)").matches) return;
    const frame = requestAnimationFrame(() => {
      detail.current?.focus({ preventScroll: true });
      detail.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId]);
  const closeDetail = () => {
    setSelectedId(null);
    opener.current?.focus({ preventScroll: true });
    if (!window.matchMedia("(min-width: 1280px)").matches) opener.current?.scrollIntoView({ block: "center" });
  };
  // 用户资料自动重试用完还是没取到：不能一直转圈，说一句并给重试
  const userFailed = !user && userLoadFailed;
  // 整理进度按百分比显示（数字随每块变，不让读屏每块都播报一次）
  const progress = syncing && data && syncTotal > 0 && (
    <span aria-hidden="true" className="tabular-nums">· {Math.round(100 * Math.max(0, syncTotal - toSync(data)) / syncTotal)}%</span>
  );
  const organizing = <>{t("updating", { count: Math.max(1, syncLessons) })}{progress}</>;
  const toPlace = overview?.needs.length ?? 0;
  // 点「更新地图」会处理的：待整理的新读课文（别的窗口正在整理的不算）和还没定位的课
  const toOrganize = data ? new Set(data.queue.map((chunk) => chunk.lesson_id)).size : 0;
  // 地图没读到时按钮不可点（上面有报错和重试），免得点了没反应
  const canUpdate = data != null && (toOrganize > 0 || toPlace > 0);
  const pending = [toOrganize > 0 && t("pendingLessons", { count: toOrganize }), toPlace > 0 && t("pendingCourses", { count: toPlace })].filter(Boolean).join(" · ");
  const status = (course: MapCourse) => course.course_id === placing
    ? <span className="flex items-center gap-1.5 text-primary-text"><Spinner className="size-3.5" />{t("unplaced.placing")}</span>
    : t(`unplaced.${course.state === "placed" ? "pending" : course.state}`);

  return (
    <LearnPage>
      <PageHead eyebrow={t("eyebrow")} title={t("title")} description={t("subtitle")}
        actions={<Button variant="outline" asChild><Link href="/learn">{t("courses")}<ArrowRight className="size-4" /></Link></Button>} />

      {(error || userFailed) && <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <span>{userFailed ? t("userFailed") : error}</span>
        <Button size="sm" variant="outline" loading={retrying}
          onClick={() => { if (userFailed) { reloadUser(); return; } setRetrying(true); setRevision((n) => n + 1); }}>
          {retrying ? t("retrying") : t("retry")}
        </Button>
      </div>}

      {data && data.failed_count > 0 && <QuietNotice className="mb-6" message={t("failedChunks", { count: data.failed_count })} />}

      {/* 没读到地图（overview 为空）时只留上面的错误和重试，不显示成「还没有课」的空状态 */}
      {loading ? !userFailed && <div aria-busy="true" className="flex min-h-96 items-center justify-center gap-3 text-sm text-muted-foreground"><Spinner className="size-5" />{t("loading")}</div> : !overview ? null : courses.length === 0 ? (
        <div className="relative overflow-hidden rounded-2xl bg-card px-6 py-16 shadow-sm sm:py-24">
          <div className="mx-auto max-w-sm text-center">
            <div className="mx-auto mb-7 flex size-16 items-center justify-center rounded-full bg-accent text-accent-foreground"><Sprout className="size-7" strokeWidth={1.4} aria-hidden="true" /></div>
            <h2 className="text-2xl font-semibold tracking-tight">{t("emptyTitle")}</h2>
            <p className="mb-7 mt-3 text-sm leading-7 text-muted-foreground">{t("emptyBody")}</p>
            <Button asChild><Link href="/learn">{t("start")}<ArrowRight className="size-4" /></Link></Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground"><span>{t("courseCount", { count: courses.length })}</span><span className="text-border" aria-hidden="true">/</span><span>{t("read", { count: data?.read_lessons ?? 0 })}</span>
              {placing != null ? <span role="status" className="flex items-center gap-2 text-xs text-primary-text"><Spinner className="size-3.5" />{t("placing", { count: Math.max(1, toPlace) })}</span>
                : syncing ? <span role="status" className="flex items-center gap-2 text-xs text-primary-text"><Spinner className="size-3.5" />{organizing}</span>
                : added > 0 ? <span role="status" className="flex items-center gap-1.5 text-xs text-primary-text"><Check className="size-3.5" aria-hidden="true" />{t("added", { count: added })}</span>
                : !updating && (canUpdate
                  ? <span role="status" className="text-xs text-primary-text">{pending}</span>
                  : <span role="status" className="text-xs text-subtle-foreground">{t("upToDate")}</span>)}
            </p>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <label className="relative min-w-0 flex-1 sm:w-56"><span className="sr-only">{t("search")}</span><Search className="pointer-events-none absolute left-3 top-3 size-4 text-subtle-foreground" aria-hidden="true" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm" /></label>
              <Button variant={canUpdate ? "default" : "outline"} className="h-10" loading={updating} disabled={!canUpdate} onClick={() => void update()}>
                {!updating && <RefreshCw className="size-4" aria-hidden="true" />}{updating ? t("updatingButton") : t("update")}
              </Button>
            </div>
          </div>

          {/* 全景：骨架的全部顶层，固定顺序；有课的标课数，读过的点亮。不给全局百分比 */}
          <nav aria-label={t("areas")} className="mb-6">
            <ul className="flex flex-wrap gap-1.5">
              {overview.band.map((b) => {
                const chip = cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs",
                  b.courses ? "bg-primary text-primary-foreground" : b.placed ? "bg-accent text-accent-foreground" : "bg-muted text-subtle-foreground");
                return <li key={b.node_id}>{b.placed > 0
                  ? <a href={`#area-${b.node_id}`} className={cn(chip, "hover:opacity-90")}>{b.label}<span className="tabular-nums opacity-80">{b.placed}</span></a>
                  : <span className={chip}>{b.label}</span>}</li>;
              })}
            </ul>
            <p className="mt-2 text-xs text-subtle-foreground">{t("areasHint")}</p>
          </nav>

          <div className={cn("grid items-start gap-5", selected && "xl:grid-cols-[minmax(0,1fr)_288px]")}>
            <div className="min-w-0 space-y-4">
              {filtered.length === 0 && <p className="rounded-2xl bg-card px-6 py-16 text-center text-sm text-muted-foreground shadow-sm">{t("noMatch")}</p>}
              {areas.map(({ area, nodes, count }) => (
                <section key={area.node_id} id={`area-${area.node_id}`} aria-labelledby={`area-title-${area.node_id}`} className="scroll-mt-24 rounded-2xl bg-card p-4 shadow-sm sm:p-5">
                  <h2 id={`area-title-${area.node_id}`} className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="text-base font-semibold tracking-tight">{area.label}</span>
                    <span className="shrink-0 text-xs text-subtle-foreground">{t("areaCourses", { count })}</span>
                  </h2>
                  <ul className="space-y-1">
                    {nodes.map((node) => <Branch key={node.id} node={node} selectedId={selectedId} onChoose={choose} />)}
                  </ul>
                </section>
              ))}
              {unplaced.length > 0 && <section aria-labelledby={unplacedHeading} className="rounded-2xl bg-card p-4 shadow-sm sm:p-5">
                <h2 id={unplacedHeading} className="text-base font-semibold tracking-tight">{t("unplacedTitle")}</h2>
                <p className="mb-2 mt-1 text-sm text-muted-foreground">{t("unplacedHint")}</p>
                <div className="space-y-0.5">
                  {unplaced.map((course) => <CourseRow key={course.course_id} course={course} active={selectedId === course.course_id}
                    status={status(course)} onChoose={(event) => choose(event, course)} />)}
                </div>
              </section>}
            </div>
            {selected && <div ref={detail} tabIndex={-1} className="min-w-0 scroll-mt-24 rounded-2xl [overflow-wrap:anywhere] xl:sticky xl:top-24">
              <CoursePanel course={selected} area={selected.area ? areaLabel.get(selected.area) ?? "" : ""} node={topicsOf.get(selected.course_id)} onClose={closeDetail} />
            </div>}
          </div>
        </>
      )}
    </LearnPage>
  );
}
