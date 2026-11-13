"use client";



import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FlaskConical,
  Lightbulb,
  Link2,
  ScanText,
  Upload,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import WebCourseFields from "@/components/learn/web-course-fields";
import { type WebPreview, webArticleFilename, webArticleMarkdown } from "@/lib/learn/web-import";
import { ExperimentalBadge } from "@/components/learn/badges";
import CreatingDialog, { type UploadProgress } from "@/components/learn/creating-dialog";
import { ErrorBar, WorkingBar } from "@/components/learn/shell";
import { useLearnError } from "@/components/learn/use-learn-error";
import { useMaterialEstimate } from "@/components/learn/use-material-estimate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import { useRouter } from "@/i18n/navigation";
import {
  createCourse,
  createCourseFromMaterials,
  createProjectCourse,
  createPdfReadingCourse,
  clarifyCourseGoal,
  type GoalAnalysis,
  type GoalAnswer,
  type LearningIntent,
} from "@/lib/learn/api";
import { isUnconfirmedCreate } from "@/lib/learn/create-outcome";
import {
  PDF_READING_MAX_FILES,
  PDF_READING_MAX_PAGES,
  filesFromDataTransfer,
  formatFileSize,
  isPdfFile,
  isReferenceFile,
} from "@/lib/learn/files";
import {
  LANGUAGE_NAMES,
  courseLanguageOf,
  languagesFor,
} from "@/lib/learn/language";
import { type PendingCourse, type PendingKind, runningWithName } from "@/lib/learn/pending-courses";
import type {
  Course,
  CourseLanguage,
  LearningDepth,
} from "@/lib/learn/types";
import { cn } from "@/lib/utils";
import { MATERIAL_MAX_FILES } from "@/lib/learn/material-chunks";

const LEARNING_DEPTHS: LearningDepth[] = ["simple", "standard", "deep"];
// 学习目标的长度上限（后端目标分析不限长，这是界面给的上限）：超了明确提示、不能继续，不悄悄截断
const GOAL_MAX_CHARS = 2000;
// 后端课名最多 200 字：跳过目标分析时课名取目标的第一行，截到这么长
const COURSE_NAME_MAX_CHARS = 200;
// 只有主题课（不带文件）的粘贴资料有上限：后端 schemas.py 的 CreateCourseRequest.reference max_length（按字符数，emoji 算一个）
const REFERENCE_MAX_CHARS = 50000;

export type CreateMode = "topic" | "project" | "web" | "pdf";

// pdf：PDF 阅读版，实验性功能——卡片上带「实验性」标记，和主题一样占满一行
const MODES = [
  { mode: "topic", Icon: Lightbulb, label: "modeTopic", desc: "modeTopicDesc" },
  { mode: "project", Icon: FolderOpen, label: "modeProject", desc: "modeProjectDesc" },
  { mode: "web", Icon: Link2, label: "modeWeb", desc: "modeWebDesc" },
  { mode: "pdf", Icon: ScanText, label: "modePdf", desc: "modePdfDesc" },
] as const;

// 选项按钮（学习深度、课程语言）：选中是翠绿描边 + 浅底
const option = (selected: boolean) =>
  cn(
    "rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50",
    selected
      ? "border-ring bg-accent text-accent-foreground"
      : "border-border bg-card text-foreground hover:border-primary/40"
  );

// 文件选择框是 sr-only 的 <input>：键盘聚焦时看不见它，所以由整块拖放区画出焦点轮廓（和全站的焦点样式一致）
const dropZone = (active: boolean) =>
  cn(
    "flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-3.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
    active
      ? "border-ring bg-accent"
      : "border-input bg-muted/50 hover:bg-muted"
  );

// 新建课程：桌面是对话框，手机是全屏页。顶部三张开始方式的卡，选中后下面是对应的表单；
// 点了提交才开始生成。创建中换成等待弹窗（钟形曲线描线）。
export default function NewCourseDialog({
  open,
  onOpenChange,
  initialMode = "topic",
  initialName,
  initialUrl,
  pendingItems = [],
  onStart,
  onFinish,
  onCreated,
  onUnconfirmed,
  fallbackFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: CreateMode;
  // 「重新创建」带来的课名（只在打开时用一次）
  initialName?: string;
  // 网页原文要导入的地址（?new=web&url= 带来，只在打开时用一次）
  initialUrl?: string;
  // 正在生成的课程：同名的在生成时，课名下面提示一句
  pendingItems?: PendingCourse[];
  // 点了创建、请求发出之前记一条「正在生成」（返回它的 id）；请求有了明确结果（成功、明确失败）就 onFinish 去掉，
  // 结果未确认（没收到应答）的留着，由「我的课程」顶部的卡片接着跟
  onStart?: (entry: { name: string; kind: PendingKind }) => string;
  onFinish?: (id: string) => void;
  onCreated: (course: Course) => void;
  // pendingId：这次建课记的「正在生成」记录（没有就是没记），结果未确认时用它标出来；reason 是没收到确认的具体原因
  onUnconfirmed: (pendingId?: string, reason?: string) => void;
  // 没有记下打开它的控件时（由 ?new= 直接打开、建课结果未确认后关闭），焦点改送到这里，不落到 body
  fallbackFocus?: () => HTMLElement | null;
}) {
  const t = useTranslations("learn");
  const locale = useLocale();
  const router = useRouter();
  const report = useLearnError();
  const [mode, setMode] = useState<CreateMode>(initialMode);
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [checkingGoal, setCheckingGoal] = useState(false);
  // 目标分析开始的时刻（显示已等多久），以及是不是从「先按现有信息设计」点进来的（转圈放在被点的那个按钮上）
  const [checkingSince, setCheckingSince] = useState<number | null>(null);
  const [skipChecking, setSkipChecking] = useState(false);
  const questionsRef = useRef<HTMLFieldSetElement>(null);
  const [goalReview, setGoalReview] = useState<{ key: string; data: GoalAnalysis; answers: GoalAnswer[] } | null>(null);
  const [goalAnswers, setGoalAnswers] = useState<string[]>([]);
  const goalCheckVersion = useRef(0);
  const clarifyAbort = useRef<AbortController | null>(null);
  // 目标分析失败时的输入（goalKey）：输入没变就给「按我填写的内容继续」，不让分析失败挡住建课
  const [clarifyFailedKey, setClarifyFailedKey] = useState("");
  const [goalNotice, setGoalNotice] = useState("");
  // 项目导入成功但有文件读不了被跳过：留在对话框里说清楚是哪几个，学生点「打开课程」再过去
  const [imported, setImported] = useState<Course | null>(null);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [depth, setDepth] = useState<LearningDepth>("standard");
  const [language, setLanguage] = useState<CourseLanguage>(
    courseLanguageOf(locale)
  );
  const [projectFiles, setProjectFiles] = useState<File[]>([]);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [pdfDrag, setPdfDrag] = useState(false);
  const [webUrl, setWebUrl] = useState("");
  const [webPreview, setWebPreview] = useState<WebPreview | null>(null);
  const [pageDrag, setPageDrag] = useState(false);
  const [referenceDrag, setReferenceDrag] = useState(false);
  const [projectDrag, setProjectDrag] = useState(false);
  const [creating, setCreating] = useState(false);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const modesRef = useRef<HTMLDivElement>(null);
  // 打开它的那个控件（Radix 的 Dialog 没有 Trigger，关闭时焦点要自己送回去）。
  // 建课中表单会先卸载再重新出现，所以记录只在真正关闭、焦点送回去之后才清掉
  const openerRef = useRef<HTMLElement | null>(null);
  const creatingRef = useRef(false);
  creatingRef.current = creating || checkingGoal;
  const openRef = useRef(open);
  openRef.current = open;
  // 建课要等几十秒，用户可能已经离开这一页：课程建好了就只清掉「正在生成」记录，不把人拖回来
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clarifyAbort.current?.abort();
    };
  }, []);

  const focusSelectedMode = () =>
    modesRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });

  // 关闭后把焦点送回打开它的控件；它不在了（或从来没记下），送到兜底落点
  const restoreFocus = () => {
    const target = openerRef.current?.isConnected ? openerRef.current : fallbackFocus?.();
    target?.focus({ preventScroll: true });
    openerRef.current = null;
  };

  useEffect(() => {
    if (!open) {
      goalCheckVersion.current++;
      // 关掉对话框就不再等目标分析：请求一并取消
      clarifyAbort.current?.abort();
      setCheckingGoal(false);
    }
    if (open) {
      setImported(null);
      setMode(initialMode);
      setError("");
      setGoalNotice("");
      if (initialName !== undefined) setName(initialName);
      if (initialUrl !== undefined) {
        setWebUrl(initialUrl);
        setWebPreview(null);
      }
    }
  }, [open, initialMode, initialName, initialUrl]);

  const withMaterials = mode === "topic" && referenceFiles.length > 0;
  const estimate = useMaterialEstimate(referenceFiles, open);
  const goalTooLong = mode === "topic" && name.trim().length > GOAL_MAX_CHARS;
  // 超了明确提示、不能提交：不先跑一遍目标分析再收到后端的 422
  const referenceChars = mode === "topic" && !referenceFiles.length && reference.length > REFERENCE_MAX_CHARS
    ? Array.from(reference.trim()).length
    : 0;
  const referenceTooLong = referenceChars > REFERENCE_MAX_CHARS;

  const sameNameRunning = runningWithName(
    pendingItems,
    mode === "topic" ? name.trim() || referenceFiles[0]?.name?.replace(/\.[^.]+$/, "") || "" : name
  );

  const goalKey = JSON.stringify([name, reference, depth, language, referenceFiles.map(f => [f.name, f.size, f.lastModified])]);
  const goalQuestions = goalReview?.key === goalKey ? goalReview.data.questions : [];

  // 追问出现在提交按钮上方的滚动区里：滚过去并把焦点放上去，读屏也会读到，不然点完只看到按钮文字变了
  const questionsShown = mode === "topic" && goalQuestions.length > 0;
  useEffect(() => {
    if (!questionsShown) return;
    questionsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    questionsRef.current?.focus({ preventScroll: true });
  }, [questionsShown]);

  // skipClarify：目标分析失败后学生选了「按我填写的内容继续」，不再分析，直接按原话建课
  const handleCreate = async (e?: React.FormEvent, skipQuestions = false, skipClarify = false) => {
    e?.preventDefault();
    if (creating || checkingGoal || goalTooLong || referenceTooLong || imported) return;
    const referenceName = referenceFiles[0]?.name?.replace(/\.[^.]+$/, "") || "";
    let topicName = name.trim() || referenceName;
    if (mode === "topic" && !topicName) {
      setError(t("dashboard.errors.topicRequired"));
      return;
    }
    if (mode === "project" && projectFiles.length === 0) {
      setError(t("dashboard.errors.projectRequired"));
      return;
    }
    if (mode === "pdf" && pdfFiles.length === 0) {
      setError(t("dashboard.errors.pdfRequired"));
      return;
    }
    if (mode === "web" && !webPreview) return;
    let learningIntent: LearningIntent | undefined;
    if (mode === "topic") {
      const answers = goalReview?.key === goalKey && !goalReview.data.questions.length
        ? goalReview.answers
        : goalQuestions.flatMap((q, i) => goalAnswers[i]?.trim()
          ? [{ question: q.question, answer: goalAnswers[i].trim() }] : []);
      if (skipClarify) {
        // 完整的目标原话作为学习意图交给后端；课名取第一行（后端课名最多 200 字）
        learningIntent = { goal: topicName, summary: topicName, assumptions: [], answers };
        topicName = Array.from(topicName.split("\n")[0].trim()).slice(0, COURSE_NAME_MAX_CHARS).join("");
      } else {
        const checkVersion = ++goalCheckVersion.current;
        setError("");
        setClarifyFailedKey("");
        setCheckingGoal(true);
        setCheckingSince(Date.now());
        setSkipChecking(skipQuestions);
        const controller = new AbortController();
        clarifyAbort.current = controller;
        const timeout = AbortSignal.timeout(35_000);
        const signal = AbortSignal.any([controller.signal, timeout]);
        try {
          // 澄清问题已经给学生看过（都是选填）：再提交时不管填没填都不再追问，否则一个都没填会被同样的问题再问一遍
          const analysis = goalReview?.key === goalKey && !goalReview.data.questions.length
            ? goalReview.data
            : await clarifyCourseGoal({
                goal: topicName, learning_depth: depth, language, reference_excerpt: reference.slice(0, 3000),
                material_names: referenceFiles.map(f => f.name), answers, skip_questions: skipQuestions || goalQuestions.length > 0,
              }, signal);
          if (!mountedRef.current || !openRef.current || goalCheckVersion.current !== checkVersion) return;
          setGoalReview({ key: goalKey, data: analysis, answers });
          if (analysis.questions.length) {
            setGoalAnswers(analysis.questions.map(() => ""));
            return;
          }
          learningIntent = { goal: topicName, summary: analysis.summary, assumptions: analysis.assumptions, answers };
          topicName = analysis.title;
        } catch (err) {
          // 连不上澄清模型、或网关超时时直接按原话建课。关掉对话框造成的取消不往下走。
          const status = err instanceof ApiError ? err.status : 0;
          const timedOut = (err instanceof Error && err.name === "TimeoutError")
            || status === 503
            || status === 504
            || (err instanceof Error && err.name !== "AbortError" && /超时|timed out|timeout|ConnectTimeout|没能连接模型|无法连接模型/i.test(err.message));
          if (timedOut && mountedRef.current && openRef.current && goalCheckVersion.current === checkVersion) {
            learningIntent = { goal: topicName, summary: topicName, assumptions: [], answers };
            topicName = Array.from(topicName.split("\n")[0].trim()).slice(0, COURSE_NAME_MAX_CHARS).join("");
            setGoalNotice(t("dashboard.form.goalSkipped"));
          } else {
            if (mountedRef.current && openRef.current && goalCheckVersion.current === checkVersion) {
              setError(report(err));
              setClarifyFailedKey(goalKey);
            }
            return;
          }
        } finally {
          if (mountedRef.current && goalCheckVersion.current === checkVersion) setCheckingGoal(false);
        }
      }
    }
    setError("");
    setClarifyFailedKey("");
    setCreating(true);
    setUpload(null);
    const onProgress = (sent: number, total: number) => setUpload({ sent, total });
    const kind: PendingKind = mode === "pdf" ? "pdf" : mode === "project" || mode === "web" ? "project" : withMaterials ? "materials" : "topic";
    const pendingId = onStart?.({
      name: mode === "topic" ? topicName : name.trim() || (mode === "web" ? webPreview!.title : ""),
      kind,
    });
    try {
      let course: Course;
      if (mode === "web") {
        const article = webPreview!;
        const file = new File([webArticleMarkdown(article, t("dashboard.web.source"))], webArticleFilename(article.title), { type: "text/markdown" });
        course = await createProjectCourse(name.trim() || article.title, [file], language, onProgress);
      } else if (mode === "project") {
        course = await createProjectCourse(name.trim(), projectFiles, language, onProgress);
      } else if (mode === "pdf") {
        course = await createPdfReadingCourse(name.trim(), pdfFiles, language, onProgress);
      } else if (referenceFiles.length > 0) {
        course = await createCourseFromMaterials(
          topicName,
          reference.trim(),
          referenceFiles,
          depth,
          language,
          learningIntent,
          onProgress,
        );
      } else {
        course = await createCourse(topicName, reference.trim(), depth, language, learningIntent);
      }
      if (pendingId) onFinish?.(pendingId);
      if (!mountedRef.current) return;
      onCreated(course);
      if (course.skipped_files?.length) {
        setImported(course);
        setCreating(false);
        return;
      }
      onOpenChange(false);
      // 成功后保持 creating（等待弹窗挡住整页），直到页面跳走；router.push 是异步的，
      // 此时放开会让用户在跳转完成前再点一次，重复建课
      // 网页和只有一篇的项目直接打开那一篇；多个文件先看文件列表
      router.push(mode === "web" || (course.is_project && course.lesson_count === 1)
        ? `/learn/course/${course.id}/lesson/1`
        : course.is_project ? `/learn/course/${course.id}` : `/learn/course/${course.id}/syllabus`);
    } catch (err) {
      if (isUnconfirmedCreate(err)) {
        onUnconfirmed(pendingId, report(err));
        onOpenChange(false);
      } else {
        if (pendingId) onFinish?.(pendingId);
        setError(report(err));
      }
      setCreating(false);
    }
  };

  const addReferenceFiles = (incoming: FileList | File[] | null) => {
    const all = Array.from(incoming || []);
    const accepted = all.filter(isReferenceFile);
    if (accepted.length < all.length) setError(t("dashboard.errors.referenceType"));
    const key = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
    const existing = new Set(referenceFiles.map(key));
    const merged = [...referenceFiles, ...accepted.filter((file) => !existing.has(key(file)))];
    // 超出的文件不悄悄丢：说清楚最多几个、忽略了几个
    if (merged.length > MATERIAL_MAX_FILES) {
      setError(t("dashboard.errors.tooManyFiles", { max: MATERIAL_MAX_FILES, ignored: merged.length - MATERIAL_MAX_FILES }));
    }
    setReferenceFiles(merged.slice(0, MATERIAL_MAX_FILES));
  };

  const handleReferenceDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setReferenceDrag(false);
    addReferenceFiles(await filesFromDataTransfer(e.dataTransfer));
  };

  // PDF 阅读版只收 PDF，最多 PDF_READING_MAX_FILES 个；别的文件、多出来的都明确说出来，不悄悄丢
  const addPdfFiles = (incoming: FileList | File[] | null) => {
    const all = Array.from(incoming || []);
    const accepted = all.filter(isPdfFile);
    if (accepted.length < all.length) setError(t("dashboard.errors.pdfType"));
    const key = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
    const existing = new Set(pdfFiles.map(key));
    const merged = [...pdfFiles, ...accepted.filter((file) => !existing.has(key(file)))];
    if (merged.length > PDF_READING_MAX_FILES) {
      setError(t("dashboard.errors.tooManyPdfs", { max: PDF_READING_MAX_FILES, ignored: merged.length - PDF_READING_MAX_FILES }));
    }
    setPdfFiles(merged.slice(0, PDF_READING_MAX_FILES));
  };

  const handleProjectDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setProjectDrag(false);
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) setProjectFiles(files);
  };

  // Window capture receives files anywhere, including the backdrop and nested inputs.
  // Stop propagation so the small upload zones cannot process the same drop twice.
  const pageDropRef = useRef<(data: DataTransfer) => Promise<void>>(async () => {});
  pageDropRef.current = async (data) => {
    if (mode === "web") return;
    const files = await filesFromDataTransfer(data);
    if (!mountedRef.current || !openRef.current || creatingRef.current) return;
    if (mode === "topic") {
      setMaterialsOpen(true);
      addReferenceFiles(files);
    } else if (mode === "pdf") {
      addPdfFiles(files);
    } else if (files.length) {
      setProjectFiles(files);
    }
  };

  useEffect(() => {
    if (!open || creating || mode === "web") return;
    let depth = 0;
    const isFileDrag = (event: DragEvent) =>
      event.dataTransfer?.types.includes("Files") ?? false;
    const reset = () => {
      depth = 0;
      setPageDrag(false);
    };
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depth += 1;
      setPageDrag(true);
    };
    const over = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = "copy";
      setPageDrag(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setPageDrag(false);
    };
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      reset();
      void pageDropRef.current(event.dataTransfer!).catch(() => {
        if (mountedRef.current && openRef.current) {
          setError(t("dashboard.errors.fileRead"));
        }
      });
    };
    window.addEventListener("dragenter", enter, { capture: true });
    window.addEventListener("dragover", over, { capture: true });
    window.addEventListener("dragleave", leave, { capture: true });
    window.addEventListener("drop", drop, { capture: true });
    window.addEventListener("dragend", reset, { capture: true });
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", enter, { capture: true });
      window.removeEventListener("dragover", over, { capture: true });
      window.removeEventListener("dragleave", leave, { capture: true });
      window.removeEventListener("drop", drop, { capture: true });
      window.removeEventListener("dragend", reset, { capture: true });
      window.removeEventListener("blur", reset);
      reset();
    };
  }, [open, creating, mode, t]);

  const modeDescription = (_mode: CreateMode, desc: string) => t(`dashboard.form.${desc}`);

  return (
    <>
      <Dialog open={open && !creating} onOpenChange={onOpenChange}>
        <DialogContent
          // 打开时焦点落在当前选中的开始方式上，而不是第一张卡；同时记下是谁打开的
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const active = document.activeElement;
            if (
              !openerRef.current &&
              active instanceof HTMLElement &&
              active !== document.body
            ) {
              openerRef.current = active;
            }
            focusSelectedMode();
          }}
          // 关闭（Esc、取消、X）后焦点回到打开它的控件；开始建课时由等待弹窗接手焦点，这里不动
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (creatingRef.current) return;
            restoreFocus();
          }}
          // 桌面上高度固定（矮屏幕由 max-h 收住）：切换开始方式、展开资料区时，对话框不上下跳，内容多了在里面滚
          className="flex flex-col gap-0 overflow-hidden p-0 sm:h-[46rem] sm:max-w-2xl max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0"
        >
          {pageDrag && (
            <div
              role="status"
              className="pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-ring bg-background/95 p-6 text-center"
            >
              <Upload className="size-10 text-accent-foreground" aria-hidden="true" />
              <p className="text-lg font-medium">{t("dashboard.form.dropAnywhere")}</p>
              <p className="text-sm text-muted-foreground">
                {t(mode === "project" ? "dashboard.form.projectDrop" : mode === "pdf" ? "dashboard.form.pdfDrop" : "dashboard.form.dropReference")}
              </p>
            </div>
          )}
          <form onSubmit={handleCreate} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="px-6 pb-4 pt-6 pr-12 text-left">
              <DialogTitle className="text-xl">{t("dashboard.form.title")}</DialogTitle>
              <DialogDescription>{t("dashboard.form.description")}</DialogDescription>
            </DialogHeader>

            {/* scroll-py-1：聚焦时控件滚到离滚动区边缘 4px，放得下聚焦轮廓。
                onFocus：焦点环绕（Tab 到最后一个再回到第一个）时，Radix 的焦点陷阱用 preventScroll 聚焦，控件可能在可视区外，这里补一次滚动。
                只在键盘聚焦时补：鼠标 / 触摸点一个只露出一截的按钮，不能把它从手指下滚走（点击会落空） */}
            <div
              onFocus={(e) => {
                if (e.target.matches(":focus-visible")) e.target.scrollIntoView({ block: "nearest" });
              }}
              className="min-h-0 flex-1 scroll-py-1 space-y-5 overflow-y-auto px-6 pb-6 pt-1"
            >
              <div
                ref={modesRef}
                role="group"
                aria-label={t("dashboard.form.modeLabel")}
                className="grid grid-cols-2 gap-2"
              >
                {MODES.map(({ mode: m, Icon, label, desc }) => {
                  const selected = mode === m;

                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={selected}
                      disabled={creating || checkingGoal}
                      onClick={() => { setMode(m); setError(""); }}
                      className={cn(
                        "flex flex-col gap-1.5 rounded-lg border p-3.5 text-left transition-colors",
                        (m === "topic" || m === "pdf") && "col-span-2",
                        selected
                          ? "border-ring bg-accent"
                          : "border-border bg-card hover:border-primary/40"
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <Icon
                          className={cn(
                            "size-4 shrink-0",
                            selected ? "text-accent-foreground" : "text-muted-foreground"
                          )}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                        <span className="text-sm font-semibold">
                          {t(`dashboard.form.${label}`)}
                        </span>
                        {m === "pdf" && <ExperimentalBadge label={t("common.experimental")} />}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {modeDescription(m, desc)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 项目文件和网页原文直接导入成页、不调用模型：只有主题课要选教学模型 */}
              {mode === "web" && <WebCourseFields url={webUrl} onUrlChange={setWebUrl} preview={webPreview} onPreview={setWebPreview} />}
              <div className="space-y-1.5">
                <label htmlFor="course-name" className="text-sm font-medium">
                  {mode === "topic" ? t("dashboard.form.nameTopic") : t("dashboard.form.name")}
                </label>
                {mode === "topic" ? <Textarea
                  id="course-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t(referenceFiles.length ? "dashboard.form.namePlaceholderTopicWithFiles" : "dashboard.form.goalPlaceholder")}
                  rows={3}
                  disabled={creating || checkingGoal}
                  aria-invalid={goalTooLong}
                  aria-describedby="course-goal-hint"
                  className="resize-y text-base leading-relaxed"
                /> : <Input
                  id="course-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={mode === "web" ? webPreview?.title || t("dashboard.web.namePlaceholder") : t("dashboard.form.namePlaceholderFile")}
                  disabled={creating || checkingGoal}
                />}
                {mode === "topic" && <p id="course-goal-hint" className="text-xs leading-relaxed text-muted-foreground">{t("dashboard.form.goalHint")}</p>}
                {goalTooLong && (
                  <p role="alert" className="text-xs text-destructive">
                    {t("dashboard.form.goalTooLong", { max: GOAL_MAX_CHARS, count: name.trim().length })}
                  </p>
                )}
                {sameNameRunning && (
                  <p role="status" className="text-xs text-warning">
                    {t("dashboard.form.sameNameRunning", { name: sameNameRunning.name })}
                  </p>
                )}
              </div>

              {mode === "topic" && goalQuestions.length > 0 && (
                <fieldset ref={questionsRef} tabIndex={-1} className="scroll-mt-2 space-y-5 rounded-lg bg-accent/60 p-5" aria-label={t("dashboard.form.goalQuestions")}>
                  <legend className="sr-only">{t("dashboard.form.goalQuestions")}</legend>
                  <div>
                    <h3 className="text-sm font-semibold text-accent-foreground">{t("dashboard.form.goalQuestions")}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{goalReview?.data.summary}</p>
                  </div>
                  {goalQuestions.map((question, index) => (
                    <div key={question.question} className="space-y-2">
                      <label htmlFor={`course-goal-answer-${index}`} className="block text-sm font-medium">{question.question}</label>
                      <div className="flex flex-wrap gap-2">
                        {question.options.map(value => <button key={value} type="button"
                          disabled={checkingGoal || creating} aria-pressed={goalAnswers[index] === value}
                          className={cn(option(goalAnswers[index] === value), "min-h-10 text-sm motion-safe:active:scale-[0.98]")}
                          onClick={() => setGoalAnswers(old => goalQuestions.map((_, i) => i === index ? value : old[i] || ""))}>
                          {value}
                        </button>)}
                      </div>
                      <Textarea id={`course-goal-answer-${index}`} value={goalAnswers[index] || ""}
                        onChange={e => setGoalAnswers(old => goalQuestions.map((_, i) => i === index ? e.target.value : old[i] || ""))}
                        rows={2} maxLength={1000} disabled={checkingGoal || creating}
                        placeholder={t("dashboard.form.goalAnswerPlaceholder")} />
                    </div>
                  ))}
                  <button type="button" disabled={checkingGoal || creating || referenceTooLong} aria-busy={checkingGoal && skipChecking}
                    // 被点的这个按钮在等时保持原样、带转圈，不跟着变淡
                    className={cn("flex min-h-10 items-center gap-2 text-sm text-muted-foreground underline underline-offset-4", !(checkingGoal && skipChecking) && "disabled:opacity-50")}
                    onClick={() => void handleCreate(undefined, true)}>
                    {checkingGoal && skipChecking && <Spinner className="text-primary-text" />}
                    {t("dashboard.form.goalSkip")}
                  </button>
                </fieldset>
              )}

              {mode === "topic" && (
                <div className="space-y-3">
                  <button
                    type="button"
                    aria-expanded={materialsOpen}
                    onClick={() => setMaterialsOpen((v) => !v)}
                    className="flex items-center gap-1.5 rounded-sm text-sm font-medium text-accent-foreground transition-colors hover:text-primary-text"
                  >
                    <ChevronDown
                      className={cn(
                        "size-4 transition-transform",
                        materialsOpen && "rotate-180"
                      )}
                      aria-hidden="true"
                    />
                    {t("dashboard.form.materialsToggle")}
                    <span className="font-normal text-muted-foreground">
                      {referenceFiles.length > 0
                        ? t("dashboard.form.projectSelected", {
                            count: referenceFiles.length,
                          })
                        : t("common.optional")}
                    </span>
                  </button>

                  {materialsOpen && (
                    <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
                      <div className="space-y-1.5">
                        <label htmlFor="course-reference" className="text-xs font-medium text-muted-foreground">
                          {t("dashboard.form.reference")}
                        </label>
                        <Textarea
                          id="course-reference"
                          value={reference}
                          onChange={(e) => setReference(e.target.value)}
                          placeholder={t("dashboard.form.referencePlaceholder")}
                          className="h-24 resize-none bg-card"
                          disabled={creating || checkingGoal}
                          aria-invalid={referenceTooLong}
                        />
                      </div>

                      <label
                        onDragOver={(e) => {
                          e.preventDefault();
                          setReferenceDrag(true);
                        }}
                        onDragLeave={() => setReferenceDrag(false)}
                        onDrop={handleReferenceDrop}
                        className={dropZone(referenceDrag)}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                            <Upload className="size-5" strokeWidth={1.6} aria-hidden="true" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">
                              {t("dashboard.form.dropReference")}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {t("dashboard.form.dropReferenceHint")}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-medium text-accent-foreground">
                          {t("dashboard.form.chooseFile")}
                        </span>
                        <input
                          type="file"
                          multiple
                          accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown,text/x-markdown"
                          className="sr-only"
                          disabled={creating || checkingGoal}
                          onChange={(e) => {
                            addReferenceFiles(e.target.files);
                            e.target.value = "";
                          }}
                        />
                      </label>

                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("dashboard.form.referenceNote")}
                      </p>

                      {referenceFiles.length > 0 && (
                        <ul className="space-y-1.5" aria-live="polite">
                          {referenceFiles.map((file, index) => (
                            <li
                              key={`${file.name}:${file.size}:${file.lastModified}`}
                              className="flex min-h-11 items-center gap-3 rounded-lg border bg-card pl-3 pr-1"
                            >
                              <span className="font-mono text-[11px] font-medium text-accent-foreground">
                                {/\.pdf$/i.test(file.name) ? "PDF" : /\.txt$/i.test(file.name) ? "TXT" : "MD"}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm">
                                {file.name}
                              </span>
                              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                {formatFileSize(file.size)}
                              </span>
                              <button
                                type="button"
                                disabled={creating || checkingGoal}
                                onClick={() =>
                                  setReferenceFiles((files) =>
                                    files.filter((_, i) => i !== index)
                                  )
                                }
                                className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                aria-label={t("dashboard.form.removeFile", {
                                  name: file.name,
                                })}
                              >
                                <X className="size-4" aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* 文件读取与校验状态：读出来之前、PDF、读不了、空文件各有各的说法 */}
                      {referenceFiles.length > 0 && (
                        <p
                          aria-live="polite"
                          className={cn(
                            "text-[13px] font-medium leading-relaxed",
                            estimate.state === "unreadable" || estimate.state === "empty" || estimate.state === "failed"
                              ? "text-warning"
                              : "text-foreground"
                          )}
                        >
                          {estimate.state === "failed" ? t("dashboard.form.estimateFailed", { name: estimate.file })
                            : estimate.state === "unreadable" ? t("dashboard.form.estimateUnreadable")
                            : estimate.state === "empty" ? t("dashboard.form.estimateEmpty")
                            : estimate.state === "reading" ? t("dashboard.form.estimateReading")
                            : estimate.state === "pdf" ? t("dashboard.form.estimatePdf")
                            : t("dashboard.form.estimateReady")}
                        </p>
                      )}
                    </div>
                  )}
                  {/* 放在折叠区外面：资料区收起时也看得见为什么不能提交 */}
                  {referenceTooLong && (
                    <p role="alert" className="text-xs text-destructive">
                      {t("dashboard.form.referenceTooLong", { max: REFERENCE_MAX_CHARS, count: referenceChars })}
                    </p>
                  )}
                </div>
              )}

              {mode === "project" && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">
                    {t("dashboard.form.projectLabel")}
                  </span>
                  <label
                    onDragOver={(e) => {
                      e.preventDefault();
                      setProjectDrag(true);
                    }}
                    onDragLeave={() => setProjectDrag(false)}
                    onDrop={handleProjectDrop}
                    className={cn(
                      dropZone(projectDrag),
                      "flex-col justify-center gap-1.5 px-4 py-7 text-center"
                    )}
                  >
                    <Upload className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
                    <span className="text-sm">
                      {projectFiles.length
                        ? t("dashboard.form.projectSelected", { count: projectFiles.length })
                        : t("dashboard.form.projectDrop")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("dashboard.form.projectFolderHint")}
                    </span>
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      disabled={creating || checkingGoal}
                      onChange={(e) => setProjectFiles(Array.from(e.target.files || []))}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard.form.projectNote")}
                  </p>
                </div>
              )}

              {mode === "pdf" && (
                <div className="space-y-3">
                  {/* 实验性：说清楚它做什么、会差在哪、要多久 */}
                  <div role="note" className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm leading-relaxed">
                    <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{t("dashboard.form.pdfExperimentalTitle")}</p>
                      <p className="text-muted-foreground">{t("dashboard.form.pdfExperimentalBody")}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-sm font-medium">{t("dashboard.form.pdfLabel")}</span>
                    <label
                      onDragOver={(e) => {
                        e.preventDefault();
                        setPdfDrag(true);
                      }}
                      onDragLeave={() => setPdfDrag(false)}
                      onDrop={async (e) => {
                        e.preventDefault();
                        setPdfDrag(false);
                        addPdfFiles(await filesFromDataTransfer(e.dataTransfer));
                      }}
                      className={cn(dropZone(pdfDrag), "flex-col justify-center gap-1.5 px-4 py-7 text-center")}
                    >
                      <Upload className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
                      <span className="text-sm">
                        {pdfFiles.length ? t("dashboard.form.projectSelected", { count: pdfFiles.length }) : t("dashboard.form.pdfDrop")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t("dashboard.form.pdfLimits", { files: PDF_READING_MAX_FILES, pages: PDF_READING_MAX_PAGES })}
                      </span>
                      <input
                        type="file"
                        multiple
                        accept=".pdf,application/pdf"
                        className="sr-only"
                        disabled={creating || checkingGoal}
                        onChange={(e) => {
                          addPdfFiles(e.target.files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  {pdfFiles.length > 0 && (
                    <ul className="space-y-1.5" aria-live="polite">
                      {pdfFiles.map((file, index) => (
                        <li
                          key={`${file.name}:${file.size}:${file.lastModified}`}
                          className="flex min-h-11 items-center gap-3 rounded-lg border bg-card pl-3 pr-1"
                        >
                          <span className="font-mono text-[11px] font-medium text-accent-foreground">PDF</span>
                          <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                            {formatFileSize(file.size)}
                          </span>
                          <button
                            type="button"
                            disabled={creating || checkingGoal}
                            onClick={() => setPdfFiles((files) => files.filter((_, i) => i !== index))}
                            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t("dashboard.form.removeFile", { name: file.name })}
                          >
                            <X className="size-4" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs leading-relaxed text-muted-foreground">{t("dashboard.form.pdfNote")}</p>
                </div>
              )}

              {mode !== "project" && mode !== "web" && mode !== "pdf" && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">{t("dashboard.form.depth")}</span>
                  <div role="group" aria-label={t("dashboard.form.depth")} className="grid gap-2 sm:grid-cols-3">
                    {LEARNING_DEPTHS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={depth === value}
                        disabled={creating || checkingGoal}
                        onClick={() => setDepth(value)}
                        className={option(depth === value)}
                      >
                        <span className="block text-sm font-medium">
                          {t(`depth.${value}.label`)}
                        </span>
                        <span
                          className={cn(
                            "mt-0.5 block text-xs leading-relaxed",
                            depth === value ? "text-accent-foreground" : "text-muted-foreground"
                          )}
                        >
                          {t(`depth.${value}.hint`)}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("dashboard.form.depthNote")}</p>

                </div>
              )}

              <div className="space-y-1.5">
                <span className="text-sm font-medium">{t(mode === "web" ? "dashboard.web.language" : "dashboard.form.language")}</span>
                <div
                  role="group"
                  aria-label={t("dashboard.form.language")}
                  className="grid grid-cols-2 gap-1 rounded-lg border bg-muted p-1"
                >
                  {languagesFor(locale).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={language === value}
                      disabled={creating || checkingGoal}
                      onClick={() => setLanguage(value)}
                      className={cn(
                        "rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50",
                        language === value
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {LANGUAGE_NAMES[value]}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(mode === "web" ? "dashboard.web.languageHint" : "dashboard.form.languageHint")}
                </p>
              </div>
            </div>

            {/* 页脚固定在滚动区外面：出错的提示条放在这里，不会落在滚动区看不到的地方 */}
            <div className="space-y-3 border-t bg-card px-6 py-4">
              {checkingGoal && (
                <WorkingBar title={t("dashboard.form.goalCheckingTitle")} expect={t("dashboard.form.goalCheckingExpect")} startedAt={checkingSince} />
              )}
              {goalNotice && (
                <p role="status" className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-foreground">
                  {goalNotice}
                </p>
              )}
              {error && <ErrorBar message={error} onClose={() => setError("")} />}
              {imported && (
                <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
                  {t("dashboard.form.skippedFiles", {
                    count: imported.skipped_files!.length,
                    // 每一项带着跳过原因（原因里可能有顿号、逗号），用分号隔开
                    names: imported.skipped_files!.slice(0, 5).join(locale.startsWith("zh") ? "；" : "; "),
                  })}
                </p>
              )}
              <div className="flex flex-wrap-reverse items-center justify-end gap-3 max-sm:[&>button]:flex-1">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {imported ? t("common.close") : t("common.cancel")}
                </Button>
                {imported ? (
                  <Button type="button" onClick={() => { onOpenChange(false); router.push(imported.lesson_count === 1 ? `/learn/course/${imported.id}/lesson/1` : `/learn/course/${imported.id}`); }}>
                    {t("generating.open")}
                  </Button>
                ) : (
                  <>
                    {mode === "topic" && clarifyFailedKey === goalKey && !checkingGoal && (
                      // 目标分析失败不挡建课：按学生写下的原话直接建
                      <Button type="button" variant="outline" disabled={creating || referenceTooLong} onClick={() => void handleCreate(undefined, false, true)}>
                        {t("dashboard.form.goalFallback")}
                      </Button>
                    )}
                    <Button type="submit" loading={checkingGoal && !skipChecking} disabled={creating || checkingGoal || goalTooLong || referenceTooLong || (mode === "web" && !webPreview)}>
                      {checkingGoal
                        ? t("dashboard.form.goalChecking")
                        : creating
                          ? t("dashboard.form.creating")
                          : mode === "web" ? t("dashboard.web.submit")
                            : mode === "topic"
                              ? t(goalQuestions.length ? "dashboard.form.goalContinue" : "dashboard.form.goalDesign")
                              : t("dashboard.form.submit")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <CreatingDialog
        open={creating}
        upload={upload}
        kind={mode === "pdf" ? "pdf" : withMaterials ? "materials" : mode === "project" || mode === "web" ? "project" : "topic"}
        // 等待弹窗关闭后焦点要有去处：失败后表单会重新出现（open 仍为真），送到当前选中的开始方式上，
        // 和表单打开时一样；建课结果未确认、表单也不再回来时，送回打开它的控件或兜底落点；成功时页面会跳走，这里没有影响
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (openRef.current) focusSelectedMode();
          else restoreFocus();
        }}
      />
    </>
  );
}
