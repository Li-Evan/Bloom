"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Ellipsis,
  FolderInput,
  ListChecks,
  Pencil,
  PencilLine,
  Plus,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import AddMaterialsDialog from "@/components/learn/add-materials-dialog";
import DeleteFileDialog from "@/components/learn/delete-file-dialog";
import MoveFileDialog, { type MovedFile } from "@/components/learn/move-file-dialog";
import DocumentTitle from "@/components/brand/document-title";
import Eyebrow from "@/components/brand/eyebrow";
import Mono from "@/components/brand/mono";
import { CourseBadges, ProgressBar, courseKind } from "@/components/learn/badges";
import LearnColumns from "@/components/learn/columns";
import Markdown from "@/components/learn/markdown";
import RenameCourseDialog from "@/components/learn/rename-course-dialog";
import RenameFileDialog from "@/components/learn/rename-file-dialog";
import { CrumbBar, DoneBar, ErrorBar, LearnPage, QuietNotice } from "@/components/learn/shell";
import CoordinateCard, { useCoordinate } from "@/components/learn/coordinate-card";
import SourceMaterial from "@/components/learn/source-material";
import LearnStatus, { isNotFound } from "@/components/learn/status-page";
import { useLearnError } from "@/components/learn/use-learn-error";
import Words from "@/components/learn/words";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api-client";
import { displayFileName } from "@/lib/learn/files";
import { getCourse, getLessons, getSummary, setLessonArchived } from "@/lib/learn/api";
import {
  continueLesson,
  displayLessonTitle,
  sortProjectLessons,
  type SortBy,
  type SortDir,
} from "@/lib/learn/lessons";
import { courseProgress } from "@/lib/learn/progress";
import { formatDay } from "@/lib/learn/time";
import type { Course, LessonItem } from "@/lib/learn/types";
import { PAGE_TITLE } from "@/lib/page-title";
import { cn } from "@/lib/utils";

// 时间线上的一行（课文或大纲）：左边是编号圆点压在竖线上，右边是整行可点的卡片。
// menu：卡片右侧的「更多」菜单（资料类课程的文件），压在卡片上、排在箭头前面，不在链接里面
function TimelineRow({
  node,
  active,
  read,
  href,
  label,
  menu,
  children,
}: {
  node: React.ReactNode;
  active?: boolean;
  read?: boolean;
  href: string;
  // 链接的名字：整张卡片都能点，链接盖在内容上，内容里的按钮（文件名旁的铅笔）浮在链接上面
  label: string;
  menu?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="group/row relative pl-14">
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border font-mono text-xs font-medium tabular-nums",
          active
            ? "border-primary bg-primary text-primary-foreground"
            : read
              ? "border-ring bg-accent text-accent-foreground"
              : "border-border bg-card text-muted-foreground"
        )}
      >
        {node}
      </span>
      <div className="group relative flex items-center gap-3 rounded-lg border bg-card px-4 py-3.5 transition-[border-color,box-shadow] duration-150 hover:border-primary/40 hover:shadow-sm">
        <Link href={href as any} aria-label={label} className="absolute inset-0 z-[1] rounded-lg" />
        {children}
        {menu && <span aria-hidden="true" className="size-9 shrink-0" />}
        <ChevronRight
          className="size-4 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5 rtl:rotate-180"
          aria-hidden="true"
        />
      </div>
      {menu && <div className="absolute right-11 top-1/2 z-10 -translate-y-1/2">{menu}</div>}
    </li>
  );
}

// 手机 / 平板上的进度：压成一行（百分比 + 进度条 + 「开始 / 继续」），排在页头和课文列表之间，
// 不再用整张进度卡把课文列表挤到第二屏；桌面上是右栏里的完整进度卡（ProgressCard）
function ProgressStrip({
  course,
  courseId,
  target,
  started,
}: {
  course: Course;
  courseId: string;
  target: LessonItem | undefined;
  started: boolean;
}) {
  const t = useTranslations("learn");
  const label = course.is_project ? t("course.progress.read") : t("course.progress.course");
  const progress = courseProgress(course);
  const detail =
    !progress.completed && progress.total > 0
      ? t(course.is_project ? "course.progress.detailFiles" : "course.progress.detail", {
          covered: progress.covered,
          total: progress.total,
        })
      : undefined;

  return (
    <section aria-label={label} title={detail} className="flex items-center gap-3 rounded-xl border bg-card p-3 pl-4 lg:hidden">
      {progress.completed ? (
        <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent-foreground">
          <Check className="size-4" aria-hidden="true" />
          {t("common.completed")}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-lg font-medium tabular-nums">{progress.percent}%</span>
      )}
      <ProgressBar value={progress.completed ? 1 : progress.percent / 100} label={detail ?? label} className="h-2 flex-1" />
      {target && (
        <Button asChild className="shrink-0">
          <Link href={`/learn/course/${courseId}/lesson/${target.number}`}>
            {started ? t("course.continue") : t("course.start")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      )}
    </section>
  );
}

// 右栏：课程进度（百分比、已讲到几个要点）和「开始 / 继续学习」，下面是知识坐标卡片（children）。只在桌面上出现（手机上是 ProgressStrip，坐标卡片排在课文列表后面）
function ProgressCard({
  course,
  courseId,
  target,
  started,
  children,
}: {
  course: Course;
  courseId: string;
  target: LessonItem | undefined;
  started: boolean;
  children?: React.ReactNode;
}) {
  const t = useTranslations("learn");
  const label = course.is_project ? t("course.progress.read") : t("course.progress.course");
  // 数字只用后端的 mastery_covered / mastery_total；已完结的课写「已完成」，不编造「total / total」
  const progress = courseProgress(course);

  return (
    <div className="learn-rail mb-8 max-lg:hidden">
      <section aria-label={label} className="rounded-xl border bg-card p-5">
        <Eyebrow>{label}</Eyebrow>
        {progress.completed ? (
          <p className="mt-3 flex items-center gap-2 text-3xl font-bold leading-[2.5rem]">
            <Check className="size-7 text-accent-foreground" aria-hidden="true" />
            {t("common.completed")}
          </p>
        ) : (
          <p className="mt-3 font-mono text-4xl font-medium tabular-nums">{progress.percent}%</p>
        )}
        <ProgressBar
          value={progress.completed ? 1 : progress.percent / 100}
          label={label}
          className="mt-3 h-2"
        />
        {!progress.completed && progress.total > 0 && (
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            {t(course.is_project ? "course.progress.detailFiles" : "course.progress.detail", {
              covered: progress.covered,
              total: progress.total,
            })}
          </p>
        )}
        <div className="mt-5 flex flex-col gap-2.5">
          {target && (
            <Button asChild size="lg" className="w-full">
              <Link href={`/learn/course/${courseId}/lesson/${target.number}`}>
                {started ? t("course.continue") : t("course.start")}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          )}
          {course.syllabus_content && (
            <Button asChild size="lg" variant="outline" className="w-full">
              <Link href={`/learn/course/${courseId}/syllabus`}>{t("course.viewSyllabus")}</Link>
            </Button>
          )}
        </div>
      </section>
      {children}
    </div>
  );
}

export default function CoursePage({ courseId }: { courseId: string }) {
  const t = useTranslations("learn");
  const locale = useLocale();
  const report = useLearnError();
  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<LessonItem[]>([]);
  const [summary, setSummary] = useState<{ content: string } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [renaming, setRenaming] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // 这次添加的课文（编号）：列表里标「新添加」，页面上说一声加了几个
  const [added, setAdded] = useState<number[]>([]);
  // 要移动的文件（编号、显示名），以及刚移到了哪门课
  const [moveTarget, setMoveTarget] = useState<{ number: number; name: string } | null>(null);
  const [movedTo, setMovedTo] = useState<MovedFile | null>(null);
  // 知识坐标卡片的数据：和课程一起读（同一批请求），手机、桌面两处卡片共用
  const coordinate = useCoordinate(courseId);
  // 要删除的文件，以及刚删掉的文件名
  const [deleteTarget, setDeleteTarget] = useState<{ number: number; name: string } | null>(null);
  const [deletedName, setDeletedName] = useState("");
  const [renameTarget, setRenameTarget] = useState<{ number: number; filename: string } | null>(null);
  // 「已归档」那一组展开了没有；刚归档 / 取消归档的文件（提示里能撤销）；没改成的原因
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archiveNote, setArchiveNote] = useState<{ number: number; name: string; archived: boolean } | null>(null);
  const [archiveError, setArchiveError] = useState("");

  const loadSummary = useCallback(() => {
    setSummaryLoading(true);
    setSummaryError("");
    getSummary(courseId)
      .then(setSummary, (err) => {
        // 项目课程完结时没有总结篇，404 是正常情况
        if (!(err instanceof ApiError && err.status === 404)) setSummaryError(report(err));
      })
      .finally(() => setSummaryLoading(false));
  }, [courseId, report]);

  useEffect(() => {
    Promise.all([getCourse(courseId), getLessons(courseId)])
      .then(([c, l]) => {
        setCourse(c);
        setLessons(l);
        // 网页剪藏是一篇篇随手存进来的：默认最新的在上面
        if (c.is_clippings) {
          setSortBy("time");
          setSortDir("desc");
        }
        if (c.status === "completed") loadSummary();
      })
      .catch((err) => {
        setNotFound(isNotFound(err));
        setError(report(err));
      })
      .finally(() => setLoading(false));
  }, [courseId, report, loadSummary]);

  const reload = () =>
    Promise.all([getCourse(courseId, true), getLessons(courseId, true)]).then(([c, l]) => {
      setCourse(c);
      setLessons(l);
    }, (err) => setSummaryError(report(err)));

  // 添加资料的请求结束就重取课程和课文（没收到应答时也可能已经加上了）
  const handleAdded = (numbers: number[] | null) => {
    if (numbers) {
      setAdded(numbers);
      setMovedTo(null);
      setArchiveNote(null);
    }
    reload();
  };

  const handleMoved = (moved: MovedFile) => {
    setMovedTo(moved);
    setAdded([]);
    setDeletedName("");
    setArchiveNote(null);
    reload();
  };

  const handleDeleted = (file: { number: number; name: string }) => {
    setDeleteTarget(null);
    setDeletedName(file.name);
    // 先在本地拿掉，不等重取：提示「已删除」时列表里就不该还有它
    setLessons((current) => current.filter((lesson) => lesson.number !== file.number));
    setAdded([]);
    setMovedTo(null);
    setArchiveNote(null);
    reload();
  };

  if (loading) {
    return (
      <>
        <CrumbBar items={[{ label: t("dashboard.title"), href: "/learn" }, { label: <Skeleton className="h-4 w-32" /> }]} />
        <LearnPage aria-busy="true">
          <LearnColumns
            rail={<Skeleton className="hidden h-56 rounded-xl lg:block" />}
            head={
              <div className="mb-8">
                <Skeleton className="mb-4 h-5 w-32 rounded-full" />
                <Skeleton className="h-10 w-3/5" />
              </div>
            }
          >
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="mb-3 ml-14 h-16 rounded-lg" />
            ))}
          </LearnColumns>
        </LearnPage>
      </>
    );
  }

  if (error || !course) {
    return <LearnStatus kind="course" notFound={notFound} message={error} />;
  }

  const normalLessons = lessons.filter((l) => l.number > 0 && (course.is_project || !l.is_source));
  // 归档的文件不在上面的列表里，不算篇数和「继续学习」，收在列表最下面的「已归档」里
  const listed = normalLessons.filter((l) => !l.is_archived);
  const shown = course.is_project
    ? sortProjectLessons(listed, sortBy, sortDir, locale)
    : listed;
  const archived = sortProjectLessons(normalLessons.filter((l) => l.is_archived), sortBy, sortDir, locale);
  const isCompleted = course.status === "completed";
  // 继续目标按编号算，不跟着项目课的排序走（lib/learn/lessons.ts）
  const target = continueLesson(listed);
  const started = normalLessons.some((l) => l.is_read);
  // 资料类课程像文件夹，文件可以移到别的资料类课程；AI 按主题生成的课不行（后端同样拒绝）
  const canMove = course.is_project;
  const lessonHref = (l: LessonItem) =>
    `/learn/course/${courseId}/lesson/${l.number}`;

  // 归档 / 取消归档：列表先变，不等后端；没改成就退回去并说原因。改成了用返回的状态和进度更新进度卡，坐标卡片重读一次（「接着学」可能换了）
  const setArchived = async (file: { number: number; name: string }, archive: boolean) => {
    const flip = (value: boolean) =>
      setLessons((current) => current.map((l) => (l.number === file.number ? { ...l, is_archived: value } : l)));
    flip(archive);
    setArchiveNote({ ...file, archived: archive });
    setArchiveError("");
    setAdded([]);
    setMovedTo(null);
    setDeletedName("");
    try {
      const result = await setLessonArchived(course.id, file.number, archive);
      setCourse((current) => current && {
        ...current,
        status: result.status,
        mastery_covered: result.mastery_covered,
        mastery_total: result.mastery_total,
        mastery_progress: result.mastery_progress,
      });
      coordinate.refresh();
    } catch (err) {
      flip(!archive);
      setArchiveNote(null);
      setArchiveError(report(err));
    }
  };

  // 文件的「更多」菜单：改名、移动、归档、删除。共同学习的课不能动文件，只能把以前归档的取消归档（后端同样拒绝）
  const fileMenu = (lesson: LessonItem, title: string) => {
    if (!canMove && !(course.is_project && lesson.is_archived)) return undefined;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("course.move.menuLabel", { name: title })}
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:bg-muted data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100"
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canMove && (
            <DropdownMenuItem onSelect={() => setRenameTarget({ number: lesson.number, filename: lesson.source_filename || `${lesson.number}.md` })}>
              <PencilLine aria-hidden="true" />
              {t("course.renameFile.item")}
            </DropdownMenuItem>
          )}
          {canMove && (
            <DropdownMenuItem onSelect={() => setMoveTarget({ number: lesson.number, name: title })}>
              <FolderInput aria-hidden="true" />
              {t("course.move.item")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void setArchived({ number: lesson.number, name: title }, !lesson.is_archived)}>
            {lesson.is_archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
            {lesson.is_archived ? t("course.archive.restore") : t("course.archive.item")}
          </DropdownMenuItem>
          {canMove && (
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget({ number: lesson.number, name: title })}>
              <Trash2 aria-hidden="true" />
              {t("course.deleteFile.item")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // 一个文件 / 一篇课文的一行；node 是左边圆点里的内容（序号，归档的是归档图标）
  const lessonRow = (lesson: LessonItem, node: React.ReactNode) => {
    const title =
      (course.is_project && lesson.source_filename && displayFileName(lesson.source_filename)) ||
      displayLessonTitle(lesson.title) ||
      t("common.lessonNumber", { number: lesson.number });

    return (
      <TimelineRow
        key={lesson.id}
        node={node}
        active={lesson.id === target?.id && !lesson.is_read}
        read={lesson.is_read}
        href={lessonHref(lesson)}
        label={title}
        menu={fileMenu(lesson, title)}
      >
        <div className="min-w-0 flex-1">
          <span className="flex min-w-0 items-start gap-1">
            <span className="min-w-0 line-clamp-2 break-words font-medium" title={title}>{title}</span>
            {/* 文件名旁的铅笔：直接改名（菜单里也有「改名」） */}
            {canMove && (
              <button
                type="button"
                onClick={() => setRenameTarget({ number: lesson.number, filename: lesson.source_filename || `${lesson.number}.md` })}
                aria-label={t("course.renameFile.pencil", { name: title })}
                title={t("course.renameFile.item")}
                className="relative z-[2] -my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100"
              >
                <PencilLine className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              <Mono text={formatDay(lesson.created_at, locale)} />
            </span>
            {course.is_project && added.includes(lesson.number) && (
              <Badge>{t("course.add.newBadge")}</Badge>
            )}
            {lesson.is_source && !course.is_project && (
              <Badge variant="outline">{t("course.uploadedSource")}</Badge>
            )}
            {lesson.is_evaluation && (
              <Badge variant="secondary">{t("course.evaluation")}</Badge>
            )}
            {lesson.has_feedback && <span>{t("common.feedbackDone")}</span>}
          </span>
        </div>
        {lesson.is_read && (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-accent-foreground">
            <Check className="size-4" aria-hidden="true" />
            {t("common.read")}
          </span>
        )}
      </TimelineRow>
    );
  };

  return (
    <>
      <DocumentTitle title={`${course.name} | Bloom`} />
      <CrumbBar
        items={[
          { label: t("dashboard.title"), href: "/learn" },
          { label: course.name },
        ]}
      />
      <RenameCourseDialog
        course={renaming ? course : null}
        onClose={() => setRenaming(false)}
        onRenamed={(name) => setCourse((current) => (current ? { ...current, name } : current))}
      />
      {course.is_project && (
        <MoveFileDialog courseId={course.id} file={moveTarget} onClose={() => setMoveTarget(null)} onMoved={handleMoved} />
      )}
      {course.is_project && (
        <RenameFileDialog
          courseId={course.id}
          file={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={(renamed) =>
            setLessons((current) => current.map((l) => (l.number === renamed.number ? { ...l, source_filename: renamed.source_filename } : l)))
          }
        />
      )}
      {course.is_project && (
        <DeleteFileDialog courseId={course.id} file={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={handleDeleted} />
      )}
      {course.is_project && (
        <AddMaterialsDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          course={course}
          initialMode={courseKind(course) === "pdf" ? "pdf" : "files"}
          onAdded={handleAdded}
        />
      )}
      <LearnPage>
        <LearnColumns
          railOnMobile="after"
          // 右栏（进度卡 + 知识坐标卡片）比页头高：第二行吃掉右栏多出来的高度，页头和课文列表之间不留空
          className="lg:grid-rows-[auto_1fr]"
          rail={
            <ProgressCard
              course={course}
              courseId={courseId}
              target={target}
              started={started}
            >
              <CoordinateCard state={coordinate} courseId={courseId} continueNumber={target?.number} className="mt-4" />
            </ProgressCard>
          }
          head={
            <header className="mb-8">
              <Eyebrow>{t("course.eyebrow")}</Eyebrow>
              <div className="mt-2 flex items-start gap-1.5">
                <h1 className={cn(PAGE_TITLE, "min-w-0 break-words")}>
                  <Words text={course.name} />
                </h1>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground sm:mt-1"
                  aria-label={t("course.rename.title")}
                  title={t("course.rename.title")}
                  onClick={() => setRenaming(true)}
                >
                  <Pencil aria-hidden="true" />
                </Button>
              </div>
              {/* 状态和开始方式的徽标、篇数、创建日期排在标题下面一行（页头统一：小标签、标题、说明） */}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
                <CourseBadges
                  course={course}
                  className="flex flex-wrap items-center gap-1.5"
                  lead={
                    isCompleted ? (
                      <Badge variant="solid">
                        <Check aria-hidden="true" />
                        {t("common.completed")}
                      </Badge>
                    ) : (
                      <Badge>{t("course.status.learning")}</Badge>
                    )
                  }
                />
                <p>
                  {course.is_project
                    ? t("course.fileCount", { count: listed.length })
                    : t("course.lessonCount", { count: listed.length })}
                  <span aria-hidden="true"> · </span>
                  {t("course.createdOn", { date: formatDay(course.created_at, locale) })}
                </p>
              </div>
              {course.is_clippings && (
                <p className="mt-3 max-w-2xl text-pretty text-sm text-muted-foreground">{t("course.clippingsHint")}</p>
              )}
              <div className="mt-6 lg:hidden">
                <ProgressStrip course={course} courseId={courseId} target={target} started={started} />
              </div>
            </header>
          }
        >
          {course.mode === "source" && !course.is_project && <div className="mb-6"><SourceMaterial courseId={courseId} /></div>}

          <section className="mb-10">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <Eyebrow>
                {course.is_project ? t("course.files") : t("course.contents")}
              </Eyebrow>
              {course.is_project && (
                <div className="flex flex-wrap items-center gap-1.5">
                <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  <Plus aria-hidden="true" />
                  {t("course.add.button")}
                </Button>
                <div
                  role="group"
                  aria-label={t("course.sortLabel")}
                  className="flex items-center gap-1.5"
                >
                  <div className="inline-flex rounded-lg border bg-muted p-0.5">
                    {(["name", "time"] as const).map((by) => (
                      <button
                        key={by}
                        type="button"
                        aria-pressed={sortBy === by}
                        onClick={() => setSortBy(by)}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                          sortBy === by
                            ? "bg-card text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {by === "name" ? t("course.sortName") : t("course.sortTime")}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                    className="inline-flex items-center gap-1 rounded-lg border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {sortDir === "asc" ? (
                      <ArrowUp className="size-3.5" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="size-3.5" aria-hidden="true" />
                    )}
                    {sortDir === "asc" ? t("course.sortAsc") : t("course.sortDesc")}
                  </button>
                </div>
                </div>
              )}
            </div>

            {added.length > 0 && (
              <DoneBar className="mb-4" message={t("course.add.done", { count: added.length })} onClose={() => setAdded([])} />
            )}
            {deletedName && (
              <DoneBar className="mb-4" message={t("course.deleteFile.done", { name: deletedName })} onClose={() => setDeletedName("")} />
            )}
            {movedTo && (
              <DoneBar className="mb-4" message={t("course.move.done", { name: movedTo.course_name })} onClose={() => setMovedTo(null)}>
                <Link href={`/learn/course/${movedTo.course_id}`} className="font-medium text-primary-text underline underline-offset-2">
                  {t("course.move.open")}
                </Link>
              </DoneBar>
            )}
            {archiveNote && (
              <DoneBar
                className="mb-4"
                message={t(archiveNote.archived ? "course.archive.done" : "course.archive.restored", { name: archiveNote.name })}
                onClose={() => setArchiveNote(null)}
              >
                <button
                  type="button"
                  className="font-medium text-primary-text underline underline-offset-2"
                  onClick={() => void setArchived(archiveNote, !archiveNote.archived)}
                >
                  {t("course.archive.undo")}
                </button>
              </DoneBar>
            )}
            {archiveError && <ErrorBar className="mb-4" message={archiveError} onClose={() => setArchiveError("")} />}

            {normalLessons.length === 0 && !course.syllabus_content ? (
              <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
                {course.is_clippings ? t("course.clippingsEmpty") : t("course.noLessons")}
              </p>
            ) : shown.length === 0 && !course.syllabus_content ? (
              <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                {t("course.archive.allArchived")}
              </p>
            ) : (
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="absolute bottom-8 left-[17px] top-8 w-px bg-border"
                />
                <ol className="relative space-y-3">
                  {course.syllabus_content && (
                    <TimelineRow
                      node={<ListChecks className="size-4" aria-hidden="true" />}
                      href={`/learn/course/${courseId}/syllabus`}
                      label={t("course.syllabus")}
                    >
                      <div className="min-w-0 flex-1">
                        <span className="block font-medium">{t("course.syllabus")}</span>
                        <span className="block text-sm text-muted-foreground">
                          {t("course.syllabusHint")}
                        </span>
                      </div>
                    </TimelineRow>
                  )}

                  {/* 项目课的序号按现在排出来的顺序编，换了排序序号跟着变；课文课就是课文自己的篇号 */}
                  {shown.map((lesson, index) =>
                    lessonRow(lesson, String(course.is_project ? index + 1 : lesson.number).padStart(2, "0"))
                  )}
                </ol>
              </div>
            )}

            {/* 归档的文件：默认收着，点开是同样的一行行，照常能打开，菜单里能取消归档 */}
            {archived.length > 0 && (
              <div className="mt-6">
                <button
                  type="button"
                  aria-expanded={archivedOpen}
                  aria-controls="archived-files"
                  onClick={() => setArchivedOpen((open) => !open)}
                  className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ChevronRight className={cn("size-4 transition-transform", archivedOpen && "rotate-90")} aria-hidden="true" />
                  <Archive className="size-4" aria-hidden="true" />
                  {t("course.archive.section", { count: archived.length })}
                </button>
                {archivedOpen && (
                  <div id="archived-files" className="mt-3">
                    <p className="mb-3 text-pretty text-xs text-muted-foreground">{t("course.archive.hint")}</p>
                    <ol className="space-y-3">
                      {archived.map((lesson) => lessonRow(lesson, <Archive className="size-4" aria-hidden="true" />))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </section>

          <CoordinateCard state={coordinate} courseId={courseId} continueNumber={target?.number} className="mb-10 lg:hidden" />

          {/* 总结在课程数据之后才读：读的时候先占住位置（项目课没有总结，不占），没读到就地说一句并给重试 */}
          {(summary || summaryError || (summaryLoading && !course.is_project)) && (
            <section aria-busy={summaryLoading || undefined}>
              <Eyebrow className="mb-4">{t("course.summary")}</Eyebrow>
              {summary ? (
                <div className="rounded-xl border border-primary/30 bg-card px-4 py-6 sm:p-8">
                  <div className="prose prose-bloom max-w-none">
                    <Markdown typography>{summary.content}</Markdown>
                  </div>
                </div>
              ) : summaryLoading ? (
                <Skeleton className="h-48 rounded-xl" />
              ) : (
                <QuietNotice message={t("course.summaryFailed", { message: summaryError })}>
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={loadSummary}>
                    {t("common.retry")}
                  </button>
                </QuietNotice>
              )}
            </section>
          )}
        </LearnColumns>
      </LearnPage>
    </>
  );
}
