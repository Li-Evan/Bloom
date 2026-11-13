"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import Eyebrow from "@/components/brand/eyebrow";
import ContinueBanner from "@/components/learn/continue-banner";
import CourseCard from "@/components/learn/course-card";
import DeleteCourseDialog from "@/components/learn/delete-course-dialog";
import RenameCourseDialog from "@/components/learn/rename-course-dialog";
import EmptyCourses from "@/components/learn/empty-courses";
import GeneratingCourses, { type FinishedCourse } from "@/components/learn/generating-courses";
import NewCourseDialog, {
  type CreateMode,
} from "@/components/learn/new-course-dialog";
import { DoneBar, ErrorBar, LearnPage, QuietNotice, useFlash } from "@/components/learn/shell";
import { PageHead } from "@/components/page-head";
import StatStrip from "@/components/learn/stat-strip";
import { useLearnError } from "@/components/learn/use-learn-error";
import { usePendingCourses } from "@/components/learn/use-pending-courses";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/contexts/app";
import { useRouter } from "@/i18n/navigation";
import {
  deleteCourse,
  getCalendar,
  getCourses,
  getGlobalStats,
} from "@/lib/learn/api";
import { orderCourses, studiedByCourse } from "@/lib/learn/course-order";
import { POLL_RUNNING_MS, type PendingCourse, pendingState, pollIntervalMs, settlePending } from "@/lib/learn/pending-courses";
import { newRequestKey } from "@/lib/learn/request-key";
import type { Calendar, Course, GlobalStats } from "@/lib/learn/types";

const CREATE_MODES: CreateMode[] = ["topic", "project", "web", "pdf"];

// 我的课程。/learn?new=1（或 new=project）会直接打开新建课程，别的页面里的「新建课程」入口用它；旧链接 new=source 落到主题。
export default function Dashboard() {
  const t = useTranslations("learn");
  const router = useRouter();
  const searchParams = useSearchParams();
  const report = useLearnError();
  const { user } = useAppContext();

  const [courses, setCourses] = useState<Course[]>([]);
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [loading, setLoading] = useState(true);
  // 首次读课程列表失败：at 让每次失败的提示重新出现一次（读屏重新播报），看得出「重试了、还是没成功」
  const [loadError, setLoadError] = useState<{ message: string; at: number } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  // 后台请求（统计 / 日历、自动刷新课程列表）失败：不挡操作，但要让人看到哪一项没成功、为什么
  const [statsError, setStatsError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("topic");
  const [createName, setCreateName] = useState<string | undefined>(undefined);
  // 带着网页地址打开：?new=web&url=…，打开网页原文并填好
  const [createUrl, setCreateUrl] = useState<string | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Course | null>(null);
  const [deleteOpener, setDeleteOpener] = useState<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ course: Course; opener: HTMLElement | null } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleted, flashDeleted, clearDeleted] = useFlash();
  const newCourseButton = useRef<HTMLButtonElement>(null);

  // 正在生成的课程：提交建课时记一条，课程出现在列表里就清掉（lib/learn/pending-courses.ts）
  const pending = usePendingCourses(user?.uuid);
  const [finished, setFinished] = useState<FinishedCourse[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const hasPending = pending.items.length > 0;
  const unconfirmedFlag = useRef(false);
  // 课程列表加载完了吗：没加载完就提交建课，记录里的 known 是空的（见 pending-courses.ts 的 knownReady）
  const listLoaded = useRef(false);
  const lastPoll = useRef(0);

  const reloadStats = useCallback(() => {
    getGlobalStats().then(
      (value) => {
        setStats(value);
        setStatsError("");
      },
      (err) => setStatsError(t("dashboard.statsFailed", { message: report(err) }))
    );
  }, [report, t]);

  // 拿到新的课程列表后对一遍：有记录对上了就去掉，并告诉用户「生成好了」
  const reconcile = useCallback(
    (list: Course[]) => {
      const { current, replaceAll } = pendingRef.current;
      const { remaining, settled } = settlePending(current(), list);
      // 列表没加载完就提交的记录，这时才补上 known（settlePending 里），要存下来
      if (settled.length === 0) {
        if (current().some((item) => item.knownReady === false)) replaceAll(remaining);
        return;
      }
      replaceAll(remaining);
      setFinished((prev) => [
        ...prev,
        ...settled
          .filter(({ pending: item }) => !prev.some((done) => done.key === item.id))
          .map(({ pending: item, courseId }) => ({
            key: item.id,
            name: list.find((course) => course.id === courseId)?.name ?? item.name,
            courseId,
          })),
      ]);
      // 已读、划线这些统计和新课程无关，但「继续学习」可能受影响，顺手重取
      reloadStats();
    },
    [reloadStats]
  );
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  // 不走缓存取一次列表：取到了返回 null，没取到返回原因。
  // 自动刷新失败只给一行轻提示（下一次轮询还会再试，成功了提示自己消失）；手动点的（manual）由点的那张卡片就近显示原因
  const reloadCourses = useCallback((manual = false) => {
    lastPoll.current = Date.now();
    return getCourses(true).then((list) => {
      listLoaded.current = true;
      setCourses(list);
      setLoadError(null);
      setRefreshError("");
      reconcileRef.current(list);
      return null;
    }, (err) => {
      const message = report(err);
      if (!manual) setRefreshError(t("dashboard.refreshFailed", { message }));
      return message;
    });
  }, [report, t]);

  // 记录和课程列表都加载好了：对一遍（刷新、离开再回来之后，课程多半已经出现了）；
  // 从推荐开课没收到确认被送到这里（?unconfirmed=1）却没有任何记录时（浏览器禁用了存储），退回到一条提示
  // 列表没读到时不对（拿空列表对，会给列表加载前提交的记录补出空的 known）
  useEffect(() => {
    if (loading || loadError || !pending.loaded) return;
    reconcileRef.current(courses);
    if (unconfirmedFlag.current) {
      unconfirmedFlag.current = false;
      if (pending.items.length === 0) setError(t("errors.createUnconfirmed"));
    }
  }, [loading, loadError, pending.loaded, courses, pending.items.length, t]);

  // 「已等多久」每秒走一格：只有还有卡片在「正在生成」时才走；都变成「结果未确认」（卡片上不再显示时间）或没有卡片时停掉。
  // 新提交的记录 startedAt 比停住的 now 晚，算出来是「正在生成」，定时器会重新开起来
  const hasRunning = pending.items.some((item) => pendingState(item, now) === "running");
  useEffect(() => {
    if (loading || !hasRunning) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, [loading, hasRunning]);

  // 有课程在生成：在生成时每 5 秒看一次列表；「等得有点久」之后每 60 秒、最多再查 30 分钟，之后不再查
  // （卡片和重试入口还留着，见 pollIntervalMs）。标签页在后台时不查，回到前台立刻查一次
  useEffect(() => {
    if (loading || !hasPending) return;
    const poll = setInterval(() => {
      const every = pollIntervalMs(pendingRef.current.current());
      if (every !== null && !document.hidden && Date.now() - lastPoll.current >= every - 100) reloadCourses();
    }, POLL_RUNNING_MS);
    const onVisible = () => {
      if (!document.hidden && pollIntervalMs(pendingRef.current.current()) !== null) reloadCourses();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loading, hasPending, reloadCourses]);

  // 「生成好了」提示留一会儿再收起
  useEffect(() => {
    if (finished.length === 0) return;
    const timer = setTimeout(() => setFinished((prev) => prev.slice(1)), 12_000);

    return () => clearTimeout(timer);
  }, [finished]);

  // 建课结果未确认（没收到后端应答，或 409）：课程可能仍在生成，记录还在，卡片接着跟（标成「不知道扣没扣」，写出原因）；立刻看一次列表
  const followUnconfirmedCreate = useCallback(
    (pendingId?: string, reason?: string) => {
      if (pendingId) pendingRef.current.patch(pendingId, { unconfirmed: true, reason });
      reloadCourses();
    },
    [reloadCourses]
  );

  // 别的页面带来的指令：?new=…（打开新建课程）、?unconfirmed=1（从推荐开课时没收到确认）。处理完把它们从地址栏去掉
  useEffect(() => {
    const wanted = searchParams.get("new");
    const unconfirmed = searchParams.get("unconfirmed");
    if (!wanted && !unconfirmed) return;
    if (wanted) {
      const mode = CREATE_MODES.find((item) => item === wanted) ?? "topic";
      setCreateMode(mode);
      setCreateName(undefined);
      setCreateUrl(mode === "web" ? searchParams.get("url") ?? undefined : undefined);
      setCreateOpen(true);
    }
    if (unconfirmed) unconfirmedFlag.current = true;
    router.replace("/learn");
  }, [searchParams, router]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      const statsFailed = (err: unknown) => { if (!cancelled) setStatsError(t("dashboard.statsFailed", { message: report(err) })); };
      // 统计（「继续学习」横幅、统计条）和日历都影响课程卡片的位置和先后（orderCourses）：等它们也回来（或失败）再一起显示，
      // 已经显示的卡片不会被后到的横幅往下推，也不会按后到的日历重新排序、让人点错。它们卡住时最多再等 3 秒，不让整页一直停在骨架
      const extras = Promise.all([
        getGlobalStats().then(value => { if (!cancelled) setStats(value); }, statsFailed),
        getCalendar().then(value => { if (!cancelled) setCalendar(value); }, statsFailed),
      ]);
      try {
        const list = await getCourses();
        await Promise.race([extras, new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (cancelled) return;
        listLoaded.current = true;
        setCourses(list);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError({ message: report(err), at: Date.now() });
      } finally {
        if (!cancelled) {
          setLoading(false);
          setReloading(false);
        }
      }
    }

    loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, report, t]);

  const retryLoad = () => {
    setReloading(true);
    setStatsError("");
    setLoadAttempt((n) => n + 1);
  };

  const openCreate = (mode: CreateMode = "topic", name?: string) => {
    setCreateMode(mode);
    setCreateName(name);
    setCreateOpen(true);
  };

  const startPending = (entry: Pick<PendingCourse, "name" | "kind">) => {
    const id = newRequestKey();
    // 课程列表还没加载完就提交（?new=1 直接开对话框）：known 是空的，先不结算，等列表加载完再补（settlePending）
    pending.add({ id, ...entry, startedAt: Date.now(), known: courses.map((course) => course.id), knownReady: listLoaded.current });

    return id;
  };

  // 「重新创建」：先不走缓存看一次最新的课程列表——课程其实已经建好的话这条记录会被认领、卡片变成「生成好了」，不再让人重建、重复扣费；
  // 确认还没有才去掉这条记录，打开新建对话框并带上课名（资料课要重新选文件）
  const retryPending = async (item: PendingCourse) => {
    // 列表没取到就确认不了，停在这里（原因写在卡片上）
    const failure = await reloadCourses(true);
    if (failure !== null) return failure;
    if (pendingRef.current.current().some((p) => p.id === item.id)) {
      pending.remove(item.id);
      openCreate(item.kind === "project" || item.kind === "pdf" ? item.kind : "topic", item.name);
    }
    return null;
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    const { id, name } = deleteTarget;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteCourse(id);
      setCourses((prev) => prev.filter((c) => c.id !== id));
      // 「继续学习」指着被删的课就先在本地去掉，不等统计重取成功
      setStats((prev) =>
        prev?.last_lesson?.course_id === id ? { ...prev, last_lesson: null } : prev
      );
      // 统计（已读课文、划线、已完成课程）也和这门课有关，删完立刻重取
      reloadStats();
      setDeleteTarget(null);
      flashDeleted(t("dashboard.deleted", { name }));
    } catch (err) {
      // 失败时对话框不关，原因写在对话框里
      setDeleteError(report(err));
    } finally {
      setDeleting(false);
    }
  };

  const lastLesson = stats?.last_lesson ?? null;
  // 学过的在前、按最近学习排序，没学过的按创建时间排在后面
  const studied = studiedByCourse(calendar, lastLesson);
  const ordered = orderCourses(courses, studied);

  return (
    <LearnPage>
      <PageHead
        eyebrow={t("dashboard.eyebrow")}
        title={t("dashboard.title")}
        description={t("dashboard.subtitle")}
        actions={
          // 一门课都没有时，「新建课程」只留空状态卡片里那一个（EmptyCourses），页头不再放第二个
          !loading && courses.length > 0 && (
            <Button
              ref={newCourseButton}
              size="lg"
              className="max-sm:w-full"
              onClick={() => openCreate()}
            >
              <Plus aria-hidden="true" />
              {t("dashboard.newCourse")}
            </Button>
          )
        }
      />

      {error && (
        <ErrorBar
          className="mb-6"
          message={error}
          onClose={() => setError("")}
        />
      )}

      {refreshError && <QuietNotice className="mb-4" message={refreshError} onClose={() => setRefreshError("")} />}
      {statsError && <QuietNotice className="mb-6" message={statsError} onClose={() => setStatsError("")} />}

      {!loading && (
        <GeneratingCourses
          items={pending.items}
          finished={finished}
          now={now}
          onRefresh={() => reloadCourses(true)}
          onRetry={retryPending}
          onDismiss={(item) => pending.remove(item.id)}
          onDismissFinished={(key) => setFinished((prev) => prev.filter((course) => course.key !== key))}
        />
      )}

      {loading ? (
        // 横幅、统计条、课程网格的位置都先占住，三样数据到齐后一起换上
        <div aria-busy="true" aria-label={t("common.loading")}>
          <Skeleton className="mb-6 h-36 w-full rounded-xl" />
          <Skeleton className="mb-10 h-24 w-full rounded-xl" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        </div>
      ) : loadError ? (
        // 列表没读到不能显示成「还没有课程」（有课的人会以为课全没了），说清楚并给重试
        <div
          key={loadError.at}
          role="alert"
          className="flex flex-col gap-4 rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive ann-in sm:flex-row sm:items-center sm:justify-between sm:p-6"
        >
          <div className="min-w-0">
            <p className="font-medium">{t("dashboard.loadFailed")}</p>
            {loadError.message && <p className="mt-1 text-pretty">{loadError.message}</p>}
          </div>
          <Button variant="outline" className="shrink-0" loading={reloading} onClick={retryLoad}>
            {reloading ? t("dashboard.reloading") : t("common.retry")}
          </Button>
        </div>
      ) : courses.length === 0 ? (
        <>
          {deleted && <DoneBar className="mb-6" message={deleted} onClose={clearDeleted} />}
          <EmptyCourses onStart={openCreate} buttonRef={newCourseButton} />
        </>
      ) : (
        <>
          {lastLesson && <ContinueBanner lesson={lastLesson} />}
          {stats && stats.total_courses > 0 && (
            <StatStrip
              className="mb-10"
              columns={4}
              items={[
                {
                  key: "lessonsRead",
                  value: stats.total_lessons_read,
                  label: t("dashboard.stats.lessonsRead"),
                  // 「已读」是读完的口径（点了「我读完了」），和学习记录里日历数的「打开」区分开
                  info: t("dashboard.stats.lessonsReadHint"),
                },
                { key: "annotations", value: stats.total_annotations, label: t("dashboard.stats.annotations") },
                { key: "streak", value: stats.current_streak, label: t("dashboard.stats.streak") },
                { key: "completed", value: stats.completed_courses, label: t("dashboard.stats.completed") },
              ]}
            />
          )}

          <section>
            <div className="mb-4 flex items-baseline gap-3">
              <Eyebrow>{t("dashboard.list.heading")}</Eyebrow>
              <span className="font-mono text-xs text-subtle-foreground tabular-nums">
                {courses.length}
              </span>
            </div>
            {deleted && <DoneBar className="mb-4" message={deleted} onClose={clearDeleted} />}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {ordered.map((course) => (
                <CourseCard
                  key={course.id}
                  course={course}
                  studied={studied.get(course.id)}
                  onRename={(target, opener) => setRenameTarget({ course: target, opener })}
                  onDelete={(target, opener) => {
                    setDeleteOpener(opener);
                    setDeleteTarget(target);
                  }}
                />
              ))}
            </div>
          </section>
        </>
      )}

      <NewCourseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialMode={createMode}
        initialName={createName}
        initialUrl={createUrl}
        pendingItems={pending.items}
        onStart={startPending}
        onFinish={pending.remove}
        onCreated={(course) => {
          pending.addKnown(course.id);
          setCourses((prev) => [course, ...prev]);
        }}
        onUnconfirmed={followUnconfirmedCreate}
        fallbackFocus={() => newCourseButton.current}
      />
      <RenameCourseDialog
        course={renameTarget?.course ?? null}
        opener={renameTarget?.opener}
        onClose={() => setRenameTarget(null)}
        onRenamed={(name) => {
          const id = renameTarget?.course.id;
          setCourses((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
          // 「继续学习」横幅也写着课名
          setStats((prev) =>
            prev?.last_lesson && prev.last_lesson.course_id === id
              ? { ...prev, last_lesson: { ...prev.last_lesson, course_name: name } }
              : prev
          );
        }}
      />
      <DeleteCourseDialog
        course={deleteTarget}
        opener={deleteOpener}
        deleting={deleting}
        error={deleteError}
        onClearError={() => setDeleteError("")}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError("");
        }}
        onConfirm={handleDelete}
        fallbackFocus={() => newCourseButton.current}
      />
    </LearnPage>
  );
}
