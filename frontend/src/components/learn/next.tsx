"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import CreatingDialog from "@/components/learn/creating-dialog";
import RecommendationPanel from "@/components/learn/recommendation-panel";
import { DoneBar, ErrorBar, LearnPage, QuietNotice, WorkingBar, useFlash } from "@/components/learn/shell";
import { PageHead } from "@/components/page-head";
import { useLearnError } from "@/components/learn/use-learn-error";
import { usePendingCourses } from "@/components/learn/use-pending-courses";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/contexts/app";
import { useRouter } from "@/i18n/navigation";
import {
  createCourse,
  dismissRecommendation,
  getCourses,
  loadNextData,
  refreshRecommendations,
  removeSavedRecommendation,
  restoreRecommendation,
  saveRecommendation,
  startRecommendation,
} from "@/lib/learn/api";
import { isUnconfirmedCreate } from "@/lib/learn/create-outcome";
import { courseLanguageOf } from "@/lib/learn/language";
import { newRequestKey } from "@/lib/learn/request-key";
import { recommendationIntent } from "@/lib/learn/recommendation-intent";
import { startRecommendationCourse } from "@/lib/learn/start-recommendation";
import type { Recommendation } from "@/lib/learn/types";

type ItemAction = "save" | "remove" | "dismiss" | "restore";

// 下一步学习：从已学内容长出来的三个主题。刷新和开始学习（建课）都要调模型，只在点击时发生。
export default function NextPage() {
  const t = useTranslations("learn");
  const locale = useLocale();
  const router = useRouter();
  const report = useLearnError();
  const { user } = useAppContext();
  // 开课前先记一条「正在生成」：没收到确认就离开这一页时，「我的课程」顶部的卡片接着跟
  const pending = usePendingCourses(user?.uuid);

  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [savedRecommendations, setSavedRecommendations] = useState<
    Recommendation[]
  >([]);
  const [loading, setLoading] = useState(true);
  // 首次读推荐失败：不能显示成「还没有推荐」+「刷新推荐」；at 让每次失败的提示重新出现一次
  const [loadError, setLoadError] = useState<{ message: string; at: number } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  // 用户已有的课程名：推荐卡片上「因为你学过《…》」对照用（取不到就不显示这一行）
  const [courseNames, setCourseNames] = useState<string[]>([]);
  // 课程列表没取到：推荐卡片上少了「因为你学过《…》」这一行，轻提示说一声
  const [coursesError, setCoursesError] = useState("");
  const courseIds = useRef<number[]>([]);
  const courseIdsLoaded = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);
  // 刷新推荐开始的时刻（WorkingBar 的「已等」）；null 就是没在刷新
  const [refreshSince, setRefreshSince] = useState<number | null>(null);
  const refreshing = refreshSince !== null;
  const [refreshed, flashRefreshed, clearRefreshed] = useFlash();
  // 收藏 / 移出待学清单 / 不感兴趣 / 撤销：正在处理哪一条（那一条的按钮转圈），没成功的原因写在那一条旁边（清单常在视口外，页顶的提示条看不到）
  const [itemBusy, setItemBusy] = useState<{ id: number; action: ItemAction } | null>(null);
  const [itemError, setItemError] = useState<{ id: number; action: ItemAction; message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [startingId, setStartingId] = useState<number | null>(null);
  const startedRecommendations = useRef(new Set<number>()).current;

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        const data = await loadNextData();
        if (cancelled) return;
        setRecommendations(data.recommendations);
        setSavedRecommendations(data.saved);
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
    getCourses().then(
      (courses) => {
        if (cancelled) return;
        setCourseNames(courses.map((c) => c.name));
        setCoursesError("");
        courseIds.current = courses.map((c) => c.id);
        courseIdsLoaded.current = true;
      },
      (err) => {
        if (!cancelled) setCoursesError(t("recs.coursesFailed", { message: report(err) }));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, report, t]);

  async function handleRefreshRecommendations() {
    if (refreshing || creating) return;
    setError("");
    clearRefreshed();
    setRefreshSince(Date.now());
    const replacing = recommendations.length > 0;
    try {
      const data = await refreshRecommendations(courseLanguageOf(locale));
      setRecommendations(data.recommendations || []);
      setSavedRecommendations(data.saved || []);
      // 三张卡片整块换掉，不一定看得出来：明确说一句。第一次生成时卡片从无到有，一眼就看得见，不用再说
      if (replacing && data.recommendations?.length) flashRefreshed(t("recs.refreshed"));
    } catch (err) {
      setError(report(err));
    } finally {
      setRefreshSince(null);
    }
  }

  const runItem = async (item: Recommendation, action: ItemAction, work: () => Promise<void>) => {
    setItemBusy({ id: item.id, action });
    setItemError(null);
    try {
      await work();
    } catch (err) {
      setItemError({ id: item.id, action, message: report(err) });
    } finally {
      setItemBusy(null);
    }
  };

  // 收藏后卡片还留在原位（面板里换成「已加入待学清单」的占位），清单里多一条
  const handleSaveRecommendation = (item: Recommendation) =>
    runItem(item, "save", async () => {
      const saved = await saveRecommendation(item.id);
      setSavedRecommendations((prev) => [
        saved,
        ...prev.filter((rec) => rec.id !== item.id),
      ]);
    });

  const handleRemoveSavedRecommendation = (item: Recommendation) =>
    runItem(item, "remove", async () => {
      await removeSavedRecommendation(item.id);
      setSavedRecommendations((prev) =>
        prev.filter((rec) => rec.id !== item.id)
      );
      setRecommendations((prev) => prev.filter((rec) => rec.id !== item.id));
    });

  // 不感兴趣：卡片原位换成可以撤销的占位（面板按 status 画），下次打开就没有了
  const setStatus = (id: number, status: string) =>
    setRecommendations((prev) => prev.map((rec) => (rec.id === id ? { ...rec, status } : rec)));

  const handleDismissRecommendation = (item: Recommendation) =>
    runItem(item, "dismiss", async () => {
      await dismissRecommendation(item.id);
      setStatus(item.id, "dismissed");
    });

  const handleRestoreRecommendation = (item: Recommendation) =>
    runItem(item, "restore", async () => {
      const restored = await restoreRecommendation(item.id);
      setStatus(item.id, restored.status);
    });

  const handleStartRecommendation = async (item: Recommendation) => {
    if (creating || refreshing) return;
    setError("");
    setStartingId(item.id);
    setCreating(true);
    const pendingId = newRequestKey();
    pending.add({
      id: pendingId,
      name: item.title,
      kind: "topic",
      startedAt: Date.now(),
      known: courseIds.current,
      // 课程列表还没回来就开课：known 是空的，先不结算，等「我的课程」加载完列表再补
      knownReady: courseIdsLoaded.current,
    });
    try {
      const result = await startRecommendationCourse({
        item,
        started: startedRecommendations,
        // 课程语言取推荐的语言：后端的 start 接口不改课程语言，只能在建课时定
        create: () =>
          createCourse(
            item.title,
            "",
            "standard",
            item.language,
            recommendationIntent(item)
          ),
        link: startRecommendation,
      });
      pending.remove(pendingId);
      if (result) pending.addKnown(result.course.id);
      // 建课要等几十秒，用户可能已经离开这一页：课程建好了，不把人拖回来
      if (!mounted.current) return;
      if (!result) {
        setCreating(false);
        setStartingId(null);
        return;
      }

      // 课程已建好：推荐移出列表，之后不会再有「同一条推荐再建一门」的路径
      setRecommendations((prev) => prev.filter((rec) => rec.id !== item.id));
      setSavedRecommendations((prev) =>
        prev.filter((rec) => rec.id !== item.id)
      );
      if (result.linkError) {
        // 只有「标记已开始」失败：留在本页，课程已经建好，错误只是提示
        setError(report(result.linkError));
        setCreating(false);
        setStartingId(null);
      } else {
        // 成功后不放开，直到页面跳走：router.push 是异步的，此时放开会让用户再点一次，重复建课。
        // 建课是「先出大纲」：和新建课程对话框一样去大纲页
        router.push(`/learn/course/${result.course.id}/syllabus`);
      }
    } catch (err) {
      if (isUnconfirmedCreate(err)) {
        // 课程可能仍在生成：去「我的课程」，那里会提示并在接下来的一分钟里自动刷新列表。
        // 和成功时一样不放开，直到页面跳走，免得再点一次重复建课。
        pending.patch(pendingId, { unconfirmed: true, reason: report(err) });
        router.push("/learn?unconfirmed=1");
      } else {
        pending.remove(pendingId);
        setError(report(err));
        setCreating(false);
        setStartingId(null);
      }
    }
  };

  return (
    <LearnPage>
      <PageHead
        eyebrow={t("recs.eyebrow")}
        title={t("recs.title")}
        description={t("recs.subtitle")}
        actions={
          // 还没有推荐时，「生成推荐」只留空状态卡片里那一个；页头的按钮只在有推荐可换（或正在刷新）时出现
          !loading &&
          (recommendations.length > 0 || refreshing) && (
            <Button
              variant="outline"
              className="max-sm:w-full"
              onClick={handleRefreshRecommendations}
              loading={refreshing}
              disabled={creating}
            >
              {!refreshing && <RefreshCw aria-hidden="true" />}
              {refreshing
                ? t("recs.refreshing")
                : recommendations.length
                  ? t("recs.another")
                  : t("recs.generate")}
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
      {coursesError && <QuietNotice className="mb-6" message={coursesError} onClose={() => setCoursesError("")} />}
      {/* 刷新是一次要等十几秒到一分钟的生成：挂在卡片区正上方（从空状态点的也在原处），说清在做什么、一般多久、已等多久 */}
      {refreshing && (
        <WorkingBar
          className="mb-6"
          title={t("recs.refreshWorking")}
          expect={t("recs.refreshExpect")}
          startedAt={refreshSince}
        />
      )}
      {refreshed && <DoneBar className="mb-6" message={refreshed} onClose={clearRefreshed} />}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-3" aria-busy="true" aria-label={t("common.loading")}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : loadError ? (
        // 没读到：只说没读到并给「重新加载」，不显示「还没有推荐」和要调模型的「刷新推荐」
        <div
          key={loadError.at}
          role="alert"
          className="flex flex-col gap-4 rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive ann-in sm:flex-row sm:items-center sm:justify-between sm:p-6"
        >
          <div className="min-w-0">
            <p className="font-medium">{t("recs.loadFailed")}</p>
            {loadError.message && <p className="mt-1 text-pretty">{loadError.message}</p>}
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            loading={reloading}
            onClick={() => {
              setReloading(true);
              setLoadAttempt((n) => n + 1);
            }}
          >
            {reloading ? t("recs.reloading") : t("recs.reload")}
          </Button>
        </div>
      ) : (
        <div className="min-w-0">
        <RecommendationPanel
          courseNames={courseNames}
          recommendations={recommendations}
          savedRecommendations={savedRecommendations}
          refreshing={refreshing}
          startingId={startingId}
          itemBusy={itemBusy}
          itemError={itemError}
          onRefresh={handleRefreshRecommendations}
          onSave={handleSaveRecommendation}
          onRemove={handleRemoveSavedRecommendation}
          onDismiss={handleDismissRecommendation}
          onRestore={handleRestoreRecommendation}
          onStart={handleStartRecommendation}
        />
        </div>
      )}

      <CreatingDialog open={creating} kind="topic" />
    </LearnPage>
  );
}
