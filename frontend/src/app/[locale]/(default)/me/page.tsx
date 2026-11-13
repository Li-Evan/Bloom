import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Flame } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EmptyHint } from "@/components/learn/empty-state";
import StatStrip from "@/components/learn/stat-strip";
import Greeting from "@/components/me/greeting";
import ContinueCard from "@/components/me/continue-card";
import LoadError from "@/components/me/load-error";
import MiniHeatmap, { type DayCounts } from "@/components/me/mini-heatmap";
import NoteCard from "@/components/me/note-card";
import { PageHead, Panel, PanelLink } from "@/components/me/page-head";
import { Link } from "@/i18n/navigation";
import { backendErrorText } from "@/lib/backend-error-server";
import type { Calendar, RecommendationDashboard } from "@/lib/learn/types";
import { meFetch } from "@/lib/me/server";
import type { CourseBrief, MeStats, NotesPage } from "@/lib/me/types";
import { privatePageMetadata } from "@/lib/page-metadata";
import type { Me } from "@/types/user";

export async function generateMetadata() {
  return privatePageMetadata("header.menu_items.center");
}

// 辅助信息取不到不拖垮整页，但也不冒充「没有」：那一块显示加载失败和重试
function settle<T>(request: Promise<T>): Promise<T | Error> {
  return request.catch((e: Error) => {
    console.error("me overview: section unavailable:", e);
    return e;
  });
}

async function SectionError({ title, error }: { title: string; error: Error }) {
  return (
    <Panel title={title}>
      <LoadError message={await backendErrorText(error)} className="p-4" />
    </Panel>
  );
}

export default async function MeOverviewPage() {
  const t = await getTranslations("me.overview");
  const tStats = await getTranslations("learn.dashboard.stats");

  const coreRequest = Promise.all([meFetch<Me>("/api/me"), meFetch<MeStats>("/api/stats")]).catch((e: Error) => e);
  const calendar = settle(meFetch<Calendar>("/api/calendar"));
  const courses = settle(meFetch<CourseBrief[]>("/api/courses"));
  const notes = settle(meFetch<NotesPage>("/api/me/annotations?page=1&limit=3"));
  const recs = settle(meFetch<RecommendationDashboard>("/api/recommendations"));
  const core = await coreRequest;

  if (core instanceof Error) {
    return (
      <>
        <PageHead eyebrow={t("eyebrow")} title={t("title")} />
        <LoadError message={await backendErrorText(core)} />
      </>
    );
  }

  const [me, stats] = core;
  const name = me.nickname || t("default_name");

  return (
    <>
      <PageHead
        eyebrow={t("eyebrow")}
        title={<Greeting name={name} />}
        actions={
          <p className="inline-flex items-center gap-2 rounded-full border bg-card px-3.5 py-1.5 text-sm">
            <Flame
              className={stats.current_streak > 0 ? "size-4 text-primary-text" : "size-4 text-subtle-foreground"}
              aria-hidden="true"
            />
            {stats.current_streak > 0 ? (
              <span className="font-medium">{t("streak", { count: stats.current_streak })}</span>
            ) : (
              <span className="text-muted-foreground">{t("streak_none")}</span>
            )}
          </p>
        }
      />

      <div className="space-y-6">
        <Suspense fallback={<ContinueCard last={stats.last_lesson} course={undefined} hasCourses={stats.total_courses > 0} />}>
          <ContinuePanel data={courses} stats={stats} />
        </Suspense>

        <StatStrip
          columns={4}
          items={[
            {
              key: "courses",
              value: stats.total_courses,
              label: t("stat_courses"),
              hint: t("stat_courses_hint", { active: stats.active_courses, done: stats.completed_courses }),
            },
            { key: "lessons", value: stats.total_lessons_read, label: t("stat_lessons"), info: tStats("lessonsReadHint") },
            { key: "asks", value: stats.total_annotations, label: t("stat_asks") },
            {
              key: "longest",
              value: stats.longest_streak,
              label: t("stat_longest"),
              hint: t("stat_longest_hint", { count: stats.current_streak }),
            },
          ]}
        />

        <Suspense fallback={<Panel title={t("heatmap_title")}><Skeleton className="h-28" /></Panel>}>
          <CalendarPanel data={calendar} />
        </Suspense>

        <Suspense fallback={<Panel title={t("notes_title")}><Skeleton className="h-24" /></Panel>}>
          <NotesPanel data={notes} />
        </Suspense>

        <Suspense fallback={null}><SavedPanel data={recs} /></Suspense>
      </div>
    </>
  );
}


// 课程列表只用来补进度条：取不到时卡片照常显示上次读到哪，只是不画进度
async function ContinuePanel({ data, stats }: { data: Promise<CourseBrief[] | Error>; stats: MeStats }) {
  const courses = await data;
  const course = courses instanceof Error ? undefined : courses.find((c) => c.id === stats.last_lesson?.course_id);
  return <ContinueCard last={stats.last_lesson} course={course} hasCourses={stats.total_courses > 0} />;
}

async function CalendarPanel({ data }: { data: Promise<Calendar | Error> }) {
  const calendar = await data;
  const t = await getTranslations("me.overview");
  if (calendar instanceof Error) return <SectionError title={t("heatmap_title")} error={calendar} />;
  const counts: DayCounts = Object.fromEntries(calendar.days.map((d) => [d.date, d.event_count]));
  return (
          <Panel title={t("heatmap_title")} action={<PanelLink href="/me/activity">{t("see_activity")}</PanelLink>}>
            <MiniHeatmap counts={counts} />
          </Panel>
  );
}

async function NotesPanel({ data }: { data: Promise<NotesPage | Error> }) {
  const notes = await data;
  const t = await getTranslations("me.overview");
  if (notes instanceof Error) return <SectionError title={t("notes_title")} error={notes} />;
  return (
        <Panel
          title={t("notes_title")}
          action={notes.total > 0 ? <PanelLink href="/me/notes">{t("see_notes", { count: notes.total })}</PanelLink> : undefined}
        >
          {notes.items.length > 0 ? (
            <div className="divide-y">
              {notes.items.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  className="rounded-none border-0 bg-transparent p-0 py-5 first:pt-0 last:pb-0"
                />
              ))}
            </div>
          ) : (
            <EmptyHint>{t("notes_empty")}</EmptyHint>
          )}
        </Panel>
  );
}

async function SavedPanel({ data }: { data: Promise<RecommendationDashboard | Error> }) {
  const recs = await data;
  const t = await getTranslations("me.overview");
  if (recs instanceof Error) return <SectionError title={t("saved_title")} error={recs} />;
  const saved = recs.saved.slice(0, 3);
  return <>
        {saved.length > 0 && (
          <Panel title={t("saved_title")} action={<PanelLink href="/learn/next">{t("see_saved")}</PanelLink>}>
            <ul className="divide-y">
              {saved.map((rec) => (
                <li key={rec.id}>
                  <Link href="/learn/next" className="group block py-3 first:pt-0 last:pb-0">
                    <p className="font-medium group-hover:text-accent-foreground">{rec.title}</p>
                    <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground" title={rec.rationale}>{rec.rationale}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
  </>;
}
