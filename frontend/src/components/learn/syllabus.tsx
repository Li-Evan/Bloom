"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ListChecks } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import DocumentTitle from "@/components/brand/document-title";
import Eyebrow from "@/components/brand/eyebrow";
import { ProgressBar } from "@/components/learn/badges";
import LearnColumns from "@/components/learn/columns";
import Markdown from "@/components/learn/markdown";
import { ChapterDrawer, ChaptersButton } from "@/components/learn/lesson-nav";
import { CrumbBar, DoneBar, LearnPage, ErrorBar, WorkingBar, useFlash } from "@/components/learn/shell";
import LearnStatus, { isNotFound } from "@/components/learn/status-page";
import TextSizeMenu from "@/components/learn/text-size-menu";
import { useLearnError } from "@/components/learn/use-learn-error";
import Words from "@/components/learn/words";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import SourceMaterial from "@/components/learn/source-material";
import { generateFirstLesson, regenerateSyllabus, updateSyllabus, getCourse, getLessons } from "@/lib/learn/api";
import { displayLessonTitle } from "@/lib/learn/lessons";
import { courseProgress } from "@/lib/learn/progress";
import { prepareSyllabus } from "@/lib/learn/syllabus";
import { type SyllabusJob, readSyllabusJob, writeSyllabusJob } from "@/lib/learn/syllabus-job";
import { formatDay } from "@/lib/learn/time";
import type { Course, LessonItem } from "@/lib/learn/types";
import { PAGE_TITLE } from "@/lib/page-title";
import { cn } from "@/lib/utils";

// 「修改想法」的上限，和后端 regenerate_syllabus 一致：超了明确提示、不能重新生成，不悄悄截断
const IDEAS_MAX_CHARS = 20000;
// 直接编辑的大纲上限，和后端 update_syllabus 一致（超了 400）：同样提示并禁用保存，不用 maxLength 悄悄截掉
const OUTLINE_MAX_CHARS = 50000;

export default function SyllabusPage({ courseId }: { courseId: string }) {
  const t = useTranslations("learn");
  const report = useLearnError();
  const setup = useTranslations("learn.outlineSetup");
  const router = useRouter();
  const [busy, setBusy] = useState<"" | "save" | "regenerate" | "start">("");
  const [busySince, setBusySince] = useState<number | null>(null);
  // 大纲整份换掉这种结果，读者可能正看着别处：提示多留一会儿
  const [done, flashDone, clearDone] = useFlash(20000);
  // 离开前发起、还没结束的长操作（见 syllabus-job.ts）
  const [resumed, setResumed] = useState<SyllabusJob | null>(null);
  const [actionError, setActionError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [ideas, setIdeas] = useState("");
  const ideasTooLong = ideas.length > IDEAS_MAX_CHARS;
  const draftTooLong = draft.length > OUTLINE_MAX_CHARS;
  // 「开始学习」要等第一篇生成完（几十秒）：读者已经离开这一页就不再把他拽回来
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<LessonItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [showNav, setShowNav] = useState(false);

  useEffect(() => {
    Promise.all([getCourse(courseId), getLessons(courseId)])
      .then(([c, l]) => {
        setCourse(c);
        setLessons(l.filter((x) => x.number > 0 && !x.is_source));
      })
      .catch((err) => {
        setNotFound(isNotFound(err));
        setError(report(err));
      })
      .finally(() => setLoading(false));
    const job = readSyllabusJob(courseId);
    if (job?.done || job?.error) {
      // 离开期间已经结束：直接说结果
      writeSyllabusJob(courseId, null);
      if (job.error) setActionError(job.error);
      else flashDone(setup("regenerated"));
    } else setResumed(job);
  }, [courseId, report, flashDone, setup]);

  // 回到页面时还有离开前发起的长操作：马上看一眼，之后每隔几秒再看，直到结果出来
  useEffect(() => {
    if (!resumed) return;
    let active = true;
    const check = async () => {
      const job = readSyllabusJob(courseId);
      if (job?.error) {
        writeSyllabusJob(courseId, null);
        setResumed(null);
        setActionError(job.error);
        return;
      }
      try {
        const [c, l] = await Promise.all([getCourse(courseId, true), getLessons(courseId, true)]);
        if (!active) return;
        const first = l.find((x) => x.number > 0 && !x.is_source);
        if (resumed.action === "start" && first) {
          writeSyllabusJob(courseId, null);
          router.push(`/learn/course/${courseId}/lesson/${first.number}`);
          return;
        }
        const rewritten = resumed.action === "regenerate" && c.syllabus_content !== resumed.syllabus;
        if (rewritten || !job) {
          // 没有结果但记录已经没了（超时、或已在别处处理）：不再显示进行中，页面换成最新数据
          writeSyllabusJob(courseId, null);
          setResumed(null);
          setCourse(c);
          setLessons(l.filter((x) => x.number > 0 && !x.is_source));
          if (rewritten) flashDone(setup("regenerated"));
        }
      } catch { /* 网络抖动：下一轮再看 */ }
    };
    void check();
    const timer = setInterval(check, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [resumed, courseId, router, flashDone, setup]);

  const progressEmpty = t("syllabus.progressEmpty");
  const locale = useLocale();
  const syllabus = useMemo(
    () =>
      prepareSyllabus(course?.syllabus_content, {
        emptyProgress: progressEmpty,
        // 旧课程进度表里的日期是 2026-10-15：换成全站统一的写法（今年 10月15日，别的年份带年份）
        formatDate: (year, month, day) => formatDay(new Date(year, month - 1, day).toISOString(), locale),
      }),
    [course?.syllabus_content, progressEmpty, locale]
  );

  async function act(action: "save" | "regenerate" | "start") {
    if (busy || resumed) return;
    const startedAt = Date.now();
    const job = action === "save" ? null : { action, startedAt, syllabus: course?.syllabus_content || "" };
    setBusy(action);
    setBusySince(startedAt);
    setActionError("");
    clearDone();
    if (job) writeSyllabusJob(courseId, job);
    let leaving = false;
    try {
      if (action === "start") {
        const lesson = await generateFirstLesson(courseId);
        writeSyllabusJob(courseId, null);
        if (mountedRef.current) {
          // 一直保持「生成中」直到跳走，免得跳转前按钮又能点
          leaving = true;
          router.push(`/learn/course/${courseId}/lesson/${lesson.number}`);
        }
      } else {
        const result = action === "save" ? await updateSyllabus(courseId, draft) : await regenerateSyllabus(courseId, ideas);
        // 读者已经离开：记下「好了」，回到这一页时再说
        writeSyllabusJob(courseId, job && !mountedRef.current ? { ...job, done: true } : null);
        setCourse((c) => c ? { ...c, syllabus_content: result.content } : c);
        setEditing(false);
        if (action === "regenerate") setIdeas("");
        flashDone(setup(action === "save" ? "saved" : "regenerated"));
      }
    } catch (err) {
      const message = report(err);
      // 读者已经离开：把原因留给下次回到这一页时显示
      if (job && !mountedRef.current) writeSyllabusJob(courseId, { ...job, error: message });
      else writeSyllabusJob(courseId, null);
      setActionError(message);
    } finally {
      if (!leaving) { setBusy(""); setBusySince(null); }
    }
  }

  // 本页发起的请求和离开前发起、还没结束的请求，界面上一样对待
  const working = busy || resumed?.action || "";
  const workingSince = busy ? busySince : resumed?.startedAt ?? null;

  if (loading) {
    return (
      <>
        <CrumbBar
          items={[
            { label: t("dashboard.title"), href: "/learn" },
            { label: <Skeleton className="h-4 w-32" /> },
          ]}
        />
        <LearnPage aria-busy="true">
          <LearnColumns
            rail={<Skeleton className="hidden h-64 rounded-xl lg:block" />}
            head={
              <div className="mb-8">
                <Skeleton className="mb-3 h-4 w-24" />
                <Skeleton className="h-10 w-2/5" />
              </div>
            }
          >
            <Skeleton className="h-96 rounded-xl" />
          </LearnColumns>
        </LearnPage>
      </>
    );
  }

  if (error || !course) {
    return <LearnStatus kind="course" notFound={notFound} message={error} />;
  }

  // 数字用后端的 mastery_covered / mastery_total（和课程页、课程卡同一口径）；后端没给总数时才退回按大纲里的勾选框数；已完结写「已完成」
  const progress = courseProgress(course);
  const fromBackend = lessons.length > 0 && progress.total > 0;
  const total = fromBackend ? progress.total : syllabus.total;
  const covered = fromBackend ? progress.covered : syllabus.mastered;
  const percent = fromBackend ? progress.percent : total > 0 ? Math.round((covered / total) * 100) : 0;
  const label = t("course.progress.course");
  const titleOf = (lesson: LessonItem) =>
    displayLessonTitle(lesson.title) || t("common.lessonNumber", { number: lesson.number });

  return (
    <>
      <DocumentTitle title={`${t("syllabus.crumb")} · ${course.name} | Bloom`} />
      <CrumbBar
        items={[
          { label: t("dashboard.title"), href: "/learn" },
          { label: course.name, href: `/learn/course/${courseId}` },
          { label: t("syllabus.crumb") },
        ]}
        // 手机 / 平板上课文目录收进顶部的「课文」按钮和抽屉（和课文页一样），不再掉在整页最底下
        actions={<><TextSizeMenu /><ChaptersButton onClick={() => setShowNav(true)} expanded={showNav} /></>}
      />
      <LearnPage>
        <LearnColumns
          railOnMobile="after"
          rail={
            // 桌面才有这一栏（手机上是上面的「课文」抽屉）
            <div className="learn-rail max-lg:hidden">
              <nav aria-label={t("syllabus.lessons")}>
                <Eyebrow className="mb-3 px-3">{t("syllabus.lessons")}</Eyebrow>
                <ul className="space-y-0.5">
                  <li>
                    <span
                      aria-current="page"
                      className="flex items-center gap-2.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
                    >
                      <ListChecks className="size-4 shrink-0" aria-hidden="true" />
                      {t("syllabus.crumb")}
                    </span>
                  </li>
                  {lessons.map((lesson) => (
                    <li key={lesson.id}>
                      <Link
                        href={`/learn/course/${courseId}/lesson/${lesson.number}`}
                        className={cn(
                          "flex items-start gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <span className="mt-0.5 shrink-0 font-mono text-xs tabular-nums text-subtle-foreground">
                          {String(lesson.number).padStart(2, "0")}
                        </span>
                        <span className="line-clamp-2 min-w-0 flex-1 leading-snug" title={titleOf(lesson)}>
                          {titleOf(lesson)}
                        </span>
                        {lesson.is_evaluation && (
                          <Badge variant="secondary" className="px-1.5 text-[10px]">
                            {t("course.evaluation")}
                          </Badge>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          }
          head={
            <header className="mb-8">
              <Eyebrow>{t("syllabus.title")}</Eyebrow>
              <h1 className={cn(PAGE_TITLE, "mt-2 break-words")}>
                <Words text={course.name} />
              </h1>
              {total > 0 && (
                <div className="mt-6">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    {progress.completed ? (
                      <span className="flex items-center gap-1 font-medium text-accent-foreground">
                        <Check className="size-4" aria-hidden="true" />
                        {t("common.completed")}
                      </span>
                    ) : (
                      <span className="font-mono text-muted-foreground tabular-nums">{percent}%</span>
                    )}
                  </div>
                  <ProgressBar value={progress.completed ? 1 : percent / 100} label={label} className="h-2" />
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    {!progress.completed && (
                      <>
                        {t("course.progress.detail", { covered, total })}
                        <span aria-hidden="true"> · </span>
                      </>
                    )}
                    {t("syllabus.hint")}
                  </p>
                </div>
              )}
            </header>
          }
        >
          <section className="mb-6 space-y-4 rounded-xl bg-muted/50 p-4 sm:p-6">
            {lessons.length === 0 && <>
              <h2 className="font-semibold">{setup("title")}</h2>
              <p className="text-sm text-muted-foreground">{setup("hint")}</p>
              {!editing && <>
                <label className="block text-sm font-medium" htmlFor="outline-ideas">{setup("ideas")}</label>
                <Textarea id="outline-ideas" value={ideas} onChange={(e) => setIdeas(e.target.value)} aria-invalid={ideasTooLong} disabled={!!working} placeholder={setup("placeholder")} />
                {ideasTooLong && <p role="alert" className="text-xs text-destructive">{setup("ideasTooLong", { max: IDEAS_MAX_CHARS, count: ideas.length })}</p>}
              </>}
              <div className="flex flex-wrap gap-3">
                {editing ? <>
                  <Button loading={working === "save"} disabled={!!working || !draft.trim() || draftTooLong} onClick={() => act("save")}>{setup(working === "save" ? "saving" : "save")}</Button>
                  <Button variant="outline" disabled={!!working} onClick={() => setEditing(false)}>{setup("cancel")}</Button>
                </> : <>
                  <Button loading={working === "start"} disabled={!!working || !!ideas.trim()} onClick={() => act("start")}>{setup(working === "start" ? "startBusy" : "start")}</Button>
                  <Button variant="outline" loading={working === "regenerate"} disabled={!!working || !ideas.trim() || ideasTooLong} onClick={() => act("regenerate")}>{setup(working === "regenerate" ? "regenerateBusy" : "regenerate")}</Button>
                  <Button variant="ghost" disabled={!!working} onClick={() => { setDraft(course.syllabus_content || ""); setEditing(true); }}>{setup("edit")}</Button>
                </>}
              </div>
              {ideas.trim() && !editing && !working && <p className="text-sm text-muted-foreground">{setup("applyFirst")}</p>}
            </>}
            {course.mode === "source" && <SourceMaterial courseId={courseId} />}
            {editing && draftTooLong && <p role="alert" className="text-xs text-destructive">{setup("outlineTooLong", { max: OUTLINE_MAX_CHARS, count: draft.length })}</p>}
            {working === "start" && <WorkingBar title={setup("starting")} expect={setup("startingExpect")} startedAt={workingSince} />}
            {working === "regenerate" && <WorkingBar title={setup("working")} expect={setup("workingExpect")} startedAt={workingSince} />}
            {done && <DoneBar message={done} onClose={clearDone} />}
            {actionError && <ErrorBar message={actionError} onClose={() => setActionError("")} />}
          </section>
          {editing ? <Textarea aria-label={setup("edit")} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!!working} aria-invalid={draftTooLong} className="min-h-[60vh] font-mono text-sm" /> : <article
            aria-busy={working === "regenerate"}
            className={cn(
              "relative rounded-xl border bg-card px-4 py-6 sm:p-10",
              // 刚换成新大纲：边框亮一下，和上面的「已更新」对上
              done && "done-flash"
            )}
          >
            {/* 重写期间：旧大纲压暗，顶上挂一条「正在重写」，说明这里马上会被换掉 */}
            {working === "regenerate" && (
              <div className="sticky top-[calc(var(--header-height)+1rem)] z-10 -mt-2 mb-4 flex justify-center sm:-mt-4">
                <span className="flex items-center gap-2 rounded-full border border-primary/30 bg-background px-3.5 py-1.5 text-[13px] font-medium shadow-sm">
                  <Spinner className="text-primary-text" />
                  {setup("rewriting")}
                </span>
              </div>
            )}
            <div className={cn("prose prose-bloom syllabus-prose max-w-none transition-opacity duration-300", working === "regenerate" && "opacity-40")}>
              <Markdown typography>{syllabus.content}</Markdown>
            </div>
          </article>}
        </LearnColumns>
      </LearnPage>

      <ChapterDrawer
        courseId={courseId}
        currentNum={0}
        allLessons={lessons}
        isProject={false}
        sessions={[]}
        onOpenSession={() => {}}
        onSyllabus
        open={showNav}
        onOpenChange={setShowNav}
      />
    </>
  );
}
