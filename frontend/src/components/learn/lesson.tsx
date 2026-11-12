"use client";

import TeachingStyleControl from "@/components/learn/teaching-style-control";
import { ApiError, api } from "@/lib/api-client";
import { displayFileName, isPdfReadingName } from "@/lib/learn/files";
import PdfReadingNotice from "@/components/learn/pdf-reading-notice";
import type { LessonStart, PassageHighlight, PassageTranslation } from "@/lib/learn/types";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { useLocale, useTranslations } from "next-intl";

import DocumentTitle from "@/components/brand/document-title";
import AnnotationPanel from "@/components/learn/annotation-panel";
import AskHint from "@/components/learn/ask-hint";
import LearnColumns from "@/components/learn/columns";
import {
  FeedbackCard,
  GenerateStep,
  GeneratingCard,
  GoNextStep,
  LessonNotice,
  MarkReadStep,
} from "@/components/learn/lesson-feedback";
import DeleteFileDialog from "@/components/learn/delete-file-dialog";
import LessonBar from "@/components/learn/lesson-bar";
import LessonChatEntry from "@/components/learn/lesson-chat-entry";
import LessonEditor from "@/components/learn/lesson-editor";
import LessonOutline from "@/components/learn/lesson-outline";
import RenameFileDialog from "@/components/learn/rename-file-dialog";
import { ChapterDrawer, CollapsedNav, LessonNav } from "@/components/learn/lesson-nav";
import Markdown from "@/components/learn/markdown";
import type { PdfHighlight } from "@/components/learn/pdf-viewer";
import ReadingTime from "@/components/learn/reading-time";
import TeachingFeedback, { type FeedbackScope } from "@/components/learn/teaching-feedback";
import SourceMaterial from "@/components/learn/source-material";
import { QuietNotice, useFlash } from "@/components/learn/shell";
import LearnStatus, { isNotFound } from "@/components/learn/status-page";
import { useBarHidden } from "@/components/learn/use-bar-hidden";
import { useFrameText } from "@/components/learn/use-frame-text";
import { useLearnError } from "@/components/learn/use-learn-error";
import { useLessonChat } from "@/components/learn/use-lesson-chat";
import { readingAnchor } from "@/lib/learn/lesson-chat";
import { lessonMarkdownOptions, outlineOf, type OutlineEntry } from "@/lib/learn/outline";
import { useSections } from "@/components/learn/use-sections";
import { usePanelTop } from "@/components/learn/use-panel-top";
import HideFooter from "@/components/site/footer/hide-footer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { X } from "lucide-react";
import { useAppContext } from "@/contexts/app";
import { Link, useRouter } from "@/i18n/navigation";
import {
  addAnnotationMessage,
  createAnnotation,
  deleteAnnotation,
  generateNextLesson,
  getAnnotations,
  getCourse,
  getFeedback,
  getLesson,
  getLessons,
  markLessonCompleted,
  recordLessonOpened,
  setLessonArchived,
  saveInterruptedAnnotation,
  submitFeedback,
  createTranslation,
  deleteTranslation,
  getTranslations,
} from "@/lib/learn/api";
import {
  BACKGROUND_CHECK_MS,
  BACKGROUND_WAIT_MS,
  type BackgroundWait,
  answerAfter,
  countQuestion,
  settledAnswer,
} from "@/lib/learn/background-answer";
import { type BubblePlacement, type Box, placeBubble } from "@/lib/learn/bubble";
import { spreadDots } from "@/lib/learn/dots";
import { courseLanguageOf, isForeignText } from "@/lib/learn/language";
import { contextAround } from "@/lib/learn/translation-context";
import { lessonTabTitle } from "@/lib/learn/lessons";
import { nextAction } from "@/lib/learn/next-action";
import {
  draftOf,
  shouldCloseOnEscape,
  withDraft,
  type FollowDrafts,
} from "@/lib/learn/panel-keys";
import { saveFeedbackThenGenerate } from "@/lib/learn/read-done";
import { newRequestKey } from "@/lib/learn/request-key";
import {
  type Run,
  appendRun,
  finishRun,
  livePage,
  noRuns,
  readRuns,
  registerPage,
  startRun,
  stopRun,
  subscribeRuns,
} from "@/lib/learn/running";
import { StreamError } from "@/lib/learn/stream";
import { forgetLessonAnnotations } from "@/lib/me/annotations";
import {
  HIGHLIGHT_CSS,
  charOffset,
  highlightsSupported,
  locateOffsets,
  markBadgeAt,
  markLines,
  markedLineAt,
  nearBadge,
  rangeFromOffsets,
} from "@/lib/learn/highlight";
import type {
  Annotation,
  Course,
  Lesson,
  LessonItem,
  NextLessonDone,
  PdfPosition,
  Session,
} from "@/lib/learn/types";
import { cn } from "@/lib/utils";

// 后端对划线原文的上限（highlights.py 和 schemas.py 里 original_text 的 max_length）
const QUOTE_MAX_CHARS = 50000;
// 后端划线翻译一次收的上限（translate.py 的 MAX_CHARS）
const TRANSLATE_MAX_CHARS = 4000;
// 气泡里有「翻译」时更宽：水平居中时两边各留 80px（英文的 Translate 最宽）
const TRANSLATE_HALF_WIDTH = 80;
// 存下来的译文在页边圆点、PDF 高亮里用的 id 前缀（和问答的数字 id、标记的 highlight- 分开）
const TRANSLATION_PREFIX = "translation-";
// 保存的标记在 sessions 里用的 id 前缀：问答的 id 也是数字，靠前缀区分「只是标记」和「划线提问」
const MARK_PREFIX = "highlight-";
// 新课文比学生要求的字数长（done 事件的 length_exceeded）：跳到新课文之前记下来，新课文页打开时提示一句
const LONGER_NOTE_KEY = "bloom:lesson-longer";


// pdf.js 只能在浏览器里加载
const PdfViewer = dynamic(() => import("@/components/learn/pdf-viewer"), {
  ssr: false,
});

interface Marker {
  // 选区第一行的顶部（相对 <article>）：右栏的卡片对齐它
  top: number;
  // 「提问」气泡放哪儿（lib/learn/bubble.ts）：紧挨着选中的字，默认在上方，被顶栏挡住就放下方
  bubble: BubblePlacement;
  selectedText: string;
  start: number;
  end: number;
  pdfPosition?: PdfPosition;
  // 选中的这段主要不是界面语言写的：气泡里多一个「翻译」
  foreign?: boolean;
  // 选区前后的文字（课文是所在的块加前后各一块，PDF 是这一页）：翻译时带给模型，按语境翻
  context?: string;
}

// 划线翻译的卡片：和提问卡片同一个位置。开着的是存下来的一条（savedId）、还在写的一条（runKey，译文从 lib/learn/running.ts 里流进来），
// 或者没成功的一条（写原因、可以重试，text 是断之前收到的）。卡片收起、换成别的都不打断还在写的
interface Translation {
  marker: Marker;
  // 已经存下来的那条（正文里有虚线和页边圆点，能删）
  savedId?: number;
  runKey?: string;
  text?: string;
  error?: string;
}

// 翻译写完的结果：存好的那条，或没成功的原因（error 写在卡片里，reason 写在屏幕底部的提示里）和断之前收到的字
interface TranslateOutcome {
  row?: PassageTranslation;
  error?: string;
  reason?: string;
  text?: string;
}

type Place = NonNullable<Run["place"]>;
// 同一处选区：原文、起止位置一样，都是（或都不是）PDF 里的
const samePlace = (a: Place) => (b: Place) =>
  b.original_text === a.original_text && b.position_start === a.position_start && b.position_end === a.position_end &&
  Boolean(b.pdf_position) === Boolean(a.pdf_position);

// 挂在某一篇上的课文页：写完的翻译、回答交给它换上（lib/learn/running.ts 的 registerPage / livePage）
interface LessonPage {
  translationFinished: (key: string, place: Place, outcome: TranslateOutcome) => void;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setOpenId: Dispatch<SetStateAction<number | string | null>>;
  setCardError: Dispatch<SetStateAction<{ id: number | string; message: string } | null>>;
  setStreamingId: Dispatch<SetStateAction<number | string | null>>;
  setStopping: Dispatch<SetStateAction<boolean>>;
  setComposer: Dispatch<SetStateAction<Composer | null>>;
  setFollowDrafts: Dispatch<SetStateAction<FollowDrafts>>;
  waitForBackground: (wait: BackgroundWait) => void;
}

// 那时挂着这一篇的课文页：一直在这一篇就是发起的这个页面；中途换到别的一篇再回来的，是新挂上的页面；都不在就不用换
function pageAt(route: string): LessonPage {
  const page = () => livePage<LessonPage>(route, "lesson");
  return {
    translationFinished: (key, place, outcome) => page()?.translationFinished(key, place, outcome),
    setSessions: (value) => page()?.setSessions(value),
    setOpenId: (value) => page()?.setOpenId(value),
    setCardError: (value) => page()?.setCardError(value),
    setStreamingId: (value) => page()?.setStreamingId(value),
    setStopping: (value) => page()?.setStopping(value),
    setComposer: (value) => page()?.setComposer(value),
    setFollowDrafts: (value) => page()?.setFollowDrafts(value),
    waitForBackground: (wait) => page()?.waitForBackground(wait),
  };
}

// 问答换成存下来的那一条：页面上还有原来那条（临时 id）就原地换；没有（换篇回来、列表取回来时它已经存好了）就补上，不重复
const swapSession = (list: Session[], id: number | string, next: Session) =>
  list.some((s) => s.id === id) ? list.map((s) => (s.id === id ? next : s)) : [...list.filter((s) => s.id !== next.id), next];

interface Composer extends Marker {
  draft: string;
  // 上一次用这个问题提问没成功（没被受理）的原因：问题放回了框里，原因写在卡片里
  error?: string;
}

// 屏幕顶上被顶栏（和面包屑条）盖住到哪儿：气泡往上放时不能钻到它们下面去
function topSafe(): number {
  return (document.querySelector(".lesson-page > .sticky")?.getBoundingClientRect().bottom ?? 64) + 8;
}

// 选区第一行 / 最后一行被选中的部分：取选区里第一个 / 最后一个真有字的文本节点。三击选段、跨段选区的 Range 常常结束在
// 「下一块的开头」（endContainer 是下一块的文本，endOffset 是 0），气泡不能跟着跑到下一块去，要看真正选到字的地方。
// 不直接用 range.getClientRects()：整块被选中的元素会多出一个整块大小的框
function edgeLine(range: Range, edge: "first" | "last"): Box | null {
  const root = range.commonAncestorContainer;
  const nodes: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) nodes.push(root as Text);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  }
  if (edge === "last") nodes.reverse();
  for (const node of nodes) {
    if (!range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (end <= start || !node.data.slice(start, end).trim()) continue;
    const part = document.createRange();
    part.setStart(node, start);
    part.setEnd(node, end);
    const lines = [...part.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const line = edge === "last" ? lines[lines.length - 1] : lines[0];
    if (line) return line;
  }

  return null;
}

// 划线翻译取上下文时认的块：段落 / 列表项 / 标题 / 代码块 / 块级公式
const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, pre, dt, dd, .math-scroll";

// 划线翻译带的上下文：选区碰到的块，加上前后各一块（只选了标题里的一个词时，下面那段才说得清它在讲什么），截成以选区为中心的一段
function selectionContext(range: Range, root: HTMLElement, text: string): string {
  const blocks = [...root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter((el) => !el.querySelector(BLOCK_SELECTOR));
  const hit = blocks.flatMap((el, i) => (range.intersectsNode(el) ? [i] : []));
  if (!hit.length) return "";

  return contextAround(blocks.slice(Math.max(0, hit[0] - 1), hit[hit.length - 1] + 2).map((el) => el.innerText).join("\n\n"), text);
}

// 没有目录时的空列表：引用不变，读节位置的 hook 不会每次重新挂监听
const NO_OUTLINE: OutlineEntry[] = [];

export default function LessonPage({
  courseId,
  lessonNum,
  annotationId,
  initial,
}: {
  courseId: string;
  lessonNum: string;
  // ?annotation=<id>：加载后滚到那处划线并打开那条问答（找不到就当没有）
  annotationId?: number;
  // 服务端渲染时已经取好的正文、课程和目录（lib/learn/lesson-start.ts）：直接显示，不再等浏览器取一轮。
  // 换一篇课文时整个组件重新挂载，所以只看第一次渲染时的值；没有就照原来那样自己取
  initial?: LessonStart | null;
}) {
  const seed = initial?.lesson.course_id === Number(courseId) && initial.lesson.number === Number(lessonNum) ? initial : null;
  const t = useTranslations("learn");
  const locale = useLocale();
  const router = useRouter();
  const report = useLearnError();
  const { user } = useAppContext();
  // 资料类课程的文件：在课文页上直接改正文和文件名，右栏列表里改名、删除
  const [editing, setEditing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ number: number; filename: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ number: number; name: string } | null>(null);

  const [styleBusy, setStyleBusy] = useState(false);
  const [lesson, setLesson] = useState<Lesson | null>(seed?.lesson ?? null);
  const [course, setCourse] = useState<Course | null>(seed?.course ?? null);
  const [lessonItems, setAllLessons] = useState<LessonItem[]>(seed?.lessons ?? []);
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const allLessons = lessonItems.filter(x => x.number > 0 && (course?.is_project || !x.is_source));
  const [sessions, setSessions] = useState<Session[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [highlights, setHighlights] = useState<PassageHighlight[]>([]);
  // 「我的标记」读取失败：只在标记列表那里提示，不锁整页（标记是可选的辅助数据）
  const [highlightsError, setHighlightsError] = useState("");
  const [highlightsAttempt, setHighlightsAttempt] = useState(0);
  // 正在标记选中的这段（"new"），或正在取消哪一条标记（它的 id）
  // 当前在看哪一篇；离开页面时清空。异步请求回来时先对一下：已经不在这一篇（或页面已经关了）就不再改界面、不再跳转
  const highlightRoute = `${courseId}/${lessonNum}`;
  const highlightRouteRef = useRef(highlightRoute);
  highlightRouteRef.current = highlightRoute;
  useEffect(() => {
    highlightRouteRef.current = highlightRoute;
    return () => {
      highlightRouteRef.current = "";
    };
  }, [highlightRoute]);
  const highlightPath = `/api/courses/${courseId}/lessons/${lessonNum}/highlights`;
  const markedSessions: Session[] = highlights.map(h => ({ ...h, id: `${MARK_PREFIX}${h.id}`, comment: "", messages: [] }));
  // 鼠标停在哪条标记的哪一行：行尾冒出的删除按钮（位置相对 <article>）。触屏没有 hover，点一下标记也能出现
  const [markBadge, setMarkBadge] = useState<{ id: number; top: number; left: number } | null>(null);
  const [loading, setLoading] = useState(!seed);
  const [detailsReady, setDetailsReady] = useState(false);
  // 问答列表取回来了没有：没取回来时写完的回答先排着（queuedSessionsRef），取回来之后接着换上，不被列表盖掉
  const detailsReadyRef = useRef(false);
  const queuedSessionsRef = useRef<SetStateAction<Session[]>[]>([]);
  const [detailsError, setDetailsError] = useState("");
  const [detailsAttempt, setDetailsAttempt] = useState(0);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false); // 课文 / 课程不存在（404）：整页显示「找不到这篇课文」
  const [nextError, setNextError] = useState(""); // 「生成下一篇」失败：只有它带重试（重试会再调一次模型）
  const [checkingNext, setCheckingNext] = useState(false); // 重试之前先确认后端没有已经存好的新课文
  const [openedError, setOpenedError] = useState(""); // 「打开」学习记录没写上：轻提示
  const [lengthNote, setLengthNote] = useState(""); // 这篇比学生要求的字数长（已照常保存）：轻提示
  const [selectionNote, setSelectionNote] = useState(""); // 选区和标记、删除相关的提示（选得太长、还没加载好、标记失败、已删除）：贴在屏幕底部，几秒后消失
  const [sourceOpen, setSourceOpen] = useState(false); // 「参考原文」面板开着：桌面上右栏被让掉，提问卡片改放左半屏底部

  const [feedbackScope, setFeedbackScope] = useState<FeedbackScope>("auto");
  const [feedbackContent, setFeedbackContent] = useState("");
  const [thoughtAnswers, setThoughtAnswers] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackDirty, setFeedbackDirty] = useState(false);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const feedbackDirtyRef = useRef(feedbackDirty);
  feedbackDirtyRef.current = feedbackDirty;
  const feedbackRef = useRef({ content: feedbackContent, thoughts: thoughtAnswers, scope: feedbackScope });
  feedbackRef.current = { content: feedbackContent, thoughts: thoughtAnswers, scope: feedbackScope };

  // Highlight Q&A sessions
  const [marker, setMarker] = useState<Marker | null>(null); // pre-ask icon
  const selectedMarkerRef = useRef(marker);
  selectedMarkerRef.current = marker;
  const [composer, setComposer] = useState<Composer | null>(null);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const translationRef = useRef(translation);
  translationRef.current = translation;
  // 本篇存下来的译文（只有自己的）：正文里画虚线、页边放空心圆点，点开不再调模型
  const [translations, setTranslations] = useState<PassageTranslation[]>([]);
  // 进这一篇之后写完的译文：读列表的请求要是在它存好之前就发出去了，回来的列表里没有它，合进去不丢
  const finishedTranslationsRef = useRef<PassageTranslation[]>([]);
  const [deletingTranslation, setDeletingTranslation] = useState(false);
  // 正在写的翻译、提问（lib/learn/running.ts）：不跟着这个页面走，换到别的一篇再回来也接着显示
  const runs = useSyncExternalStore(subscribeRuns, readRuns, noRuns);
  const runOwner = useRef({}).current;
  const translateRuns = runs.filter((run) => run.kind === "translate" && run.route === highlightRoute);
  // 换到别的一篇时还在写的提问 / 追问：发起的页面已经卸掉，这个页面照着它显示（同一篇同时只有一条在写）
  const adoptedQa = runs.find((run) => run.route === highlightRoute && run.owner !== runOwner && (run.kind === "ask" || run.kind === "follow"));
  const translateRunKeys = translateRuns.map((run) => run.key).join(",");
  // 还在写的翻译也先在正文里画上虚线、页边放空心圆点（圆点在闪），收起卡片后点它能接着看
  const translatedSessions: Session[] = [
    ...translations.map((tr) => ({
      id: `${TRANSLATION_PREFIX}${tr.id}`, original_text: tr.original_text, position_start: tr.position_start,
      position_end: tr.position_end, anchor_top: tr.anchor_top, pdf_position: tr.pdf_position, comment: "", messages: [],
    })),
    ...translateRuns.map((run) => ({ ...run.place!, id: `${TRANSLATION_PREFIX}${run.key}`, comment: "", messages: [] })),
  ];
  const [openId, setOpenId] = useState<number | string | null>(null); // expanded session id
  const [followDrafts, setFollowDrafts] = useState<FollowDrafts>({}); // 每条问答各自没发出去的追问
  const followDraft = draftOf(followDrafts, openId); // 当前打开的那条的追问草稿
  // 回答正在流式写入的那一条问答（临时 id 或已存的 id）：只有它的卡片显示流式文字和「停止」，回答写着时打开别的问答，看到的是那一条自己的内容
  const [streamingId, setStreamingId] = useState<number | string | null>(null);
  const streaming = streamingId !== null;
  const streamingIdRef = useRef(streamingId);
  streamingIdRef.current = streamingId;
  // 点了停止、还在存已收到的半截回答：「停止」换成「正在停止…」
  const [stopping, setStopping] = useState(false);
  // 提问 / 追问 / 存半截回答失败的原因：写在那条问答的卡片里（读者正看着它），不报到页面底部
  const [cardError, setCardError] = useState<{ id: number | string; message: string } | null>(null);
  // 停止 / 断线之后还在等后端后台写完的问答（lib/learn/background-answer.ts），key 是问答 id：
  // partial——已经存下半截；expired——等满两分钟没等到。等着的时候这条不能删（删了后台写完会再出现）
  // since：开始等的时刻（卡片上写已等多久）
  const [background, setBackground] = useState<Record<string, { partial: boolean; expired?: boolean; since?: number }>>({});
  // 后台写完的完整回答刚换上的那几条（问答 id，逗号隔开）：卡片里说一句「完整回答已更新」，几秒后收起
  const [updatedIds, flashUpdated] = useFlash(6000);
  const [backgroundError, setBackgroundError] = useState("");
  const waitsRef = useRef<BackgroundWait[]>([]);
  const backgroundTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // 流式写入中的回答（每帧刷新一次界面；streamTextRef 随时是完整文字，停止 / 断线时按它存半截回答）
  const { text: ownStreamText, ref: streamTextRef, append: appendStreamText, reset: resetStreamText } = useFrameText();
  // 换篇回来接着显示的那一条，写到哪儿了在 lib/learn/running.ts 里
  const streamText = adoptedQa ? adoptedQa.text : ownStreamText;
  const [tops, setTops] = useState<Record<string, number>>({}); // session id -> px top within article (reflow-resilient)
  const [pdfTops, setPdfTops] = useState<Record<string, number>>({}); // PDF session id -> px top within article, computed from geometric rects

  const [generating, setGeneratingState] = useState(false);
  // 「生成下一篇」要调模型：守卫看 ref，不看渲染时的 state——重试先等一次检查再生成，两次点击、旧闭包都不能发出第二个 POST /next
  const generatingRef = useRef(false);
  const setGenerating = useCallback((value: boolean) => {
    generatingRef.current = value;
    setGeneratingState(value);
  }, []);
  const { text: streamContent, append: appendStreamContent, reset: resetStreamContent } = useFrameText();
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [readSaved, setReadSaved] = useState(Boolean(seed?.lesson.is_read));
  // 这一篇是不是刚才点「标记已读」时按设置自动归档的：是的话下一步那里说一句、给撤销
  const [autoArchived, setAutoArchived] = useState(false);
  // 问答卡片的 key：读者主动打开另一条才换。回答写完、临时 id 换成存下来的 id 时不换，
  // 否则卡片重新挂载，滚动位置回到顶部（读者正读着回答，突然被拽回开头）
  const [panelKey, setPanelKey] = useState(0);
  const [barHidden, revealBar] = useBarHidden();

  const contentRef = useRef<HTMLElement>(null); // <article>
  const markRangesRef = useRef(new Map<number, Range>()); // 每条标记在正文里的 Range（画 ::highlight() 时顺手记下，悬浮删除按它找位置）
  const markBadgeRef = useRef<{ id: number; top: number; left: number } | null>(null); // 当前显示的删除按钮（指针停在按钮上时保持不闪）
  const badgeRef = useRef<HTMLButtonElement>(null);
  const hoverFrameRef = useRef(0); // 鼠标移动按帧取样：每次移动都量一遍所有标记的矩形太费
  const badgeHideRef = useRef(0); // 指针离开标记后稍等再收起删除按钮
  markBadgeRef.current = markBadge;
  const panelAreaRef = useRef<HTMLDivElement>(null); // 桌面右栏里放问答卡片的区域（和右栏一样高）
  const panelRef = useRef<HTMLElement>(null); // 问答卡片本身
  const deepLinked = useRef(""); // 已经处理过的 ?annotation= 深链接
  // 通过深链接（从笔记「回到课文」）打开的不算学习进度，不记「打开」事件
  const viaDeepLink = useRef(annotationId !== undefined);
  viaDeepLink.current = annotationId !== undefined;
  const proseRef = useRef<HTMLDivElement>(null); // markdown content only (excludes overlay)
  // 「问这篇」：整篇课文随问题一起发，对话存在本机。开着时占划线卡片的位置；划线卡片打开时让给它，划线卡片收起后回来
  const [chatOpen, setChatOpen] = useState(false);
  const chatAnchor = useCallback(() => readingAnchor(contentRef.current, topSafe()), []);
  const chat = useLessonChat({ courseId, lessonNum, report, anchor: chatAnchor });
  const streamRef = useRef<HTMLElement>(null); // 生成下一篇时的流式预览
  const railRef = useRef<HTMLDivElement>(null); // 桌面右侧栏（章节列表的滚动容器）
  const abortRef = useRef<AbortController | null>(null); // AbortController for the active stream

  useEffect(() => {
    const start = seedRef.current;
    setLoading(!start);
    setEditing(false);
    setLesson(start?.lesson ?? null);
    setCourse(start?.course ?? null);
    setAllLessons(start?.lessons ?? []);
    setSessions([]);
    setError("");
    setNotFound(false);
    setNextError("");
    setOpenedError("");
    let longer = 0;
    try {
      const note = JSON.parse(sessionStorage.getItem(LONGER_NOTE_KEY) ?? "null");
      if (note?.route === `${courseId}/${lessonNum}`) {
        longer = Number(note.limit) || 0;
        sessionStorage.removeItem(LONGER_NOTE_KEY);
      }
    } catch {
      // 读不了就不提示
    }
    setLengthNote(longer ? t("lesson.lengthExceeded", { limit: longer }) : "");
    setFeedbackSaved(false);
    resetStreamContent();
    setGenerating(false);
    setMarkingRead(false);
    setReadSaved(false);
    setFeedbackContent("");
    setThoughtAnswers("");
    setFeedbackScope("auto");
    let active = true;
    setHighlights([]);
    setFeedbackDirty(false);
    setMarker(null);
    setComposer(null);
    closeTranslation();
    setOpenId(null);
    setChatOpen(false);
    setFollowDrafts({});
    setStreamingId(null);
    setStopping(false);
    setCardError(null);
    setBackground({});
    setBackgroundError("");
    resetStreamText();
    setTops({});
    setPdfTops({});

    const opened = (l: Lesson) => {
      setLesson(l);
      setReadSaved(Boolean(l.is_read));
      setAutoArchived(false);
      // 课文真的取到了才记「打开」：找不到的课文不写学习记录；回看笔记（深链接）也不算学习进度
      if (!viaDeepLink.current) {
        recordLessonOpened(courseId, lessonNum).catch((err) => {
          if (active) setOpenedError(t("lesson.openedFailed", { message: report(err) }));
        });
      }
    };
    // 服务端已经带来了这一篇：不再取一遍
    if (start) {
      opened(start.lesson);
    } else {
      getLesson(courseId, lessonNum)
        .then((l) => { if (active) opened(l); })
        .catch((err) => {
          if (!active) return;
          setNotFound(isNotFound(err));
          setError(report(err));
        })
        .finally(() => { if (active) setLoading(false); });
    }

    window.scrollTo(0, 0);
    return () => { active = false; };
  }, [courseId, lessonNum, report, t, resetStreamContent, resetStreamText, setGenerating]);

  // 换了一篇或离开页面：不再等上一篇的后台回答
  useEffect(() => () => {
    backgroundTimers.current.forEach(clearTimeout);
    backgroundTimers.current = [];
    waitsRef.current = [];
  }, [courseId, lessonNum]);

  useEffect(() => {
    let active = true;
    detailsReadyRef.current = false;
    setDetailsReady(false);
    setDetailsError("");
    Promise.all([
      getCourse(courseId), getAnnotations(courseId, lessonNum), getLessons(courseId), getFeedback(courseId, lessonNum),
    ]).then(([c, annotations, lessons, feedback]) => {
      if (!active) return;
      setCourse(c);
      setSessions(annotations);
      detailsReadyRef.current = true;
      for (const value of queuedSessionsRef.current.splice(0)) setSessions(value);
      setAllLessons(lessons);
      setFeedbackContent(feedback.content || "");
      setThoughtAnswers(feedback.thought_answers || "");
      setFeedbackScope(feedback.scope || "auto");
      setFeedbackSaved(feedback.exists);
      setDetailsReady(true);
    }).catch(err => { if (active) setDetailsError(report(err)); });
    return () => { active = false; };
  }, [courseId, lessonNum, detailsAttempt, report]);

  useEffect(() => {
    let active = true;
    setHighlightsError("");
    api<PassageHighlight[]>(highlightPath).then(
      (marks) => { if (active) setHighlights(marks); },
      (err) => { if (active) setHighlightsError(t("lesson.highlightsFailed", { message: report(err) })); }
    );
    return () => { active = false; };
  }, [highlightPath, highlightsAttempt, report, t]);

  // 本篇存下来的译文：只是辅助，取不到在屏幕底部说一声，不锁页面
  useEffect(() => {
    let active = true;
    setTranslations([]);
    finishedTranslationsRef.current = [];
    getTranslations(courseId, lessonNum).then(
      (items) => {
        if (!active) return;
        const finished = finishedTranslationsRef.current;
        setTranslations([...items.filter((tr) => !finished.some((row) => row.id === tr.id || samePlace(row)(tr))), ...finished]);
      },
      (err) => { if (active) setSelectionNote(t("lesson.translationsFailed", { message: report(err) })); }
    );
    return () => { active = false; };
  }, [courseId, lessonNum, report, t]);

  useEffect(() => {
    if (!selectionNote) return;
    const timer = setTimeout(() => setSelectionNote(""), 5000);
    return () => clearTimeout(timer);
  }, [selectionNote]);

  // Paint yellow highlights for saved sessions + recompute reflow-resilient dot positions.
  useEffect(() => {
    const article = contentRef.current;
    const prose = proseRef.current;
    if (!article || !prose) return;
    const supported = highlightsSupported();

    const compute = () => {
      const articleTop = article.getBoundingClientRect().top;
      const ranges: Range[] = [];
      const translated: Range[] = [];
      const marks = new Map<number, Range>();
      const nextTops: Record<string, number> = {};
      for (const s of [...sessions, ...markedSessions, ...translatedSessions]) {
        const off = locateOffsets(prose, s);
        const range = off ? rangeFromOffsets(prose, off[0], off[1]) : null;
        if (range) {
          (String(s.id).startsWith(TRANSLATION_PREFIX) ? translated : ranges).push(range);
          nextTops[s.id] = Math.max(
            0,
            Math.round(range.getBoundingClientRect().top - articleTop)
          );
          // 只是标记的那几条记下 Range：悬浮时按它找出指针在哪一行（问答有自己的卡片，不需要这个按钮）
          if (typeof s.id === "string" && s.id.startsWith(MARK_PREFIX)) {
            const markId = Number(s.id.slice(MARK_PREFIX.length));
            // 还没存好的标记（负数 id）不给悬浮删除按钮
            if (markId > 0) marks.set(markId, range);
          }
        } else {
          nextTops[s.id] = s.anchor_top || 0;
        }
      }
      markRangesRef.current = marks;
      setTops(nextTops);
      if (supported) {
        if (ranges.length)
          CSS.highlights.set("bloom-ann", new Highlight(...ranges));
        else CSS.highlights.delete("bloom-ann");
        if (translated.length) CSS.highlights.set("bloom-translated", new Highlight(...translated));
        else CSS.highlights.delete("bloom-translated");
      }
    };

    compute();
    window.addEventListener("resize", compute);
    // 窗口没变、正文自己挪了也要重算：图片是懒加载的、没写宽高，加载完（滚到附近才加载）才撑开，
    // 把下面的段落往下推；字体换上也会挪。只听 resize 的话圆点留在原处，段落旁边看着像没了
    const observer = new ResizeObserver(compute);
    observer.observe(article);
    return () => {
      window.removeEventListener("resize", compute);
      observer.disconnect();
      markRangesRef.current.clear();
      if (supported) {
        CSS.highlights.delete("bloom-ann");
        CSS.highlights.delete("bloom-translated");
      }
    };
    // markedSessions、translatedSessions 由 highlights、translations 和还在写的翻译算出来，每次渲染都是新数组；
    // 还在写的翻译只看有哪几条（译文每帧都在变，位置不变）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, highlights, translations, translateRunKeys, lesson?.content]);

  // Paint a distinct highlight for the pending (being-asked) selection.
  useEffect(() => {
    if (!highlightsSupported() || !proseRef.current) return;
    const sel = composer || marker || translation?.marker;
    const range = sel
      ? rangeFromOffsets(proseRef.current, sel.start, sel.end)
      : null;
    if (range) {
      const pending = new Highlight(range);
      pending.priority = 1;
      CSS.highlights.set("bloom-pending", pending);
    } else CSS.highlights.delete("bloom-pending");
    return () => {
      CSS.highlights.delete("bloom-pending");
    };
  }, [marker, composer, translation?.marker, lesson?.content]);

  const bubbleRef = useRef<HTMLDivElement>(null); // Selection action menu
  const navGroupRef = useRef<HTMLDivElement>(null); // 右栏顶上收起 / 展开的课文目录那一组

  // 问答卡片开着的那一句：比平时的淡绿更深，一眼能看出卡片问的是哪一句（PDF 的高亮在 pdfHighlights 里标 active）
  const openSessionData = sessions.find((s) => s.id === openId);
  const activeText = openSessionData && !openSessionData.pdf_position ? openSessionData : null;
  useEffect(() => {
    const prose = proseRef.current;
    if (!highlightsSupported() || !prose || !activeText) return;
    const off = locateOffsets(prose, activeText);
    const range = off ? rangeFromOffsets(prose, off[0], off[1]) : null;
    if (!range) return;
    const active = new Highlight(range);
    active.priority = 2;
    CSS.highlights.set("bloom-active", active);
    return () => {
      CSS.highlights.delete("bloom-active");
    };
    // 只看是哪一条、划的是哪段字：回答流式写入时 sessions 每次都是新对象，不该重画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeText?.id, activeText?.original_text, activeText?.position_start, lesson?.content]);

  // 深链接 ?annotation=<id>（「我的笔记」「最近的笔记」的「回到课文」）：课文和划线加载好之后，滚到那一处并打开那条问答。
  // 找不到这个 id（删了、别的课文的）就当没有这个参数；同一个链接只处理一次，之后读者自己关掉卡片不会再被打开
  useEffect(() => {
    if (loading || !detailsReady || annotationId == null) return;
    const key = `${courseId}/${lessonNum}/${annotationId}`;
    if (deepLinked.current === key) return;
    const session = sessions.find((s) => s.id === annotationId);
    if (!session) {
      deepLinked.current = key;
      return;
    }
    // PDF 的划线位置要等页面画出来才知道
    if (session.pdf_position && pdfTops[session.id] === undefined) return;
    deepLinked.current = key;
    scrollToSession(session);
    setPanelKey((k) => k + 1);
    setOpenId(session.id);

    // 字体换上之后版面可能挪几个像素：读者还没自己动过页面的话，再对一次。
    // 「动过」靠对比位置——页面现在不在我们刚滚到的地方，就是读者动过了（滚轮、触摸、键盘、拖滚动条都算）；
    // 清理时（换课文、数据变了、离开页面）取消，不会在别的页面上滚。
    const landed = window.scrollY;
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled && Math.abs(window.scrollY - landed) <= 2) scrollToSession(session);
    });
    return () => {
      cancelled = true;
    };
    // scrollToSession 每次渲染都是新函数；这里只在数据就绪时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, detailsReady, annotationId, courseId, lessonNum, sessions, pdfTops]);

  // 选区消失（点了别处）：去掉「提问」气泡和还没写字的提问框；已经写了一半的问题留着，别因为误点一下丢掉
  const clearPendingSelection = () => {
    setMarker(null);
    setComposer((c) => (c?.draft.trim() ? c : null));
  };

  const sessionTop = (session?: Session) => {
    if (!session) return 0;
    if (session.pdf_position)
      return pdfTops[session.id] ?? session.anchor_top ?? 0;
    return tops[session.id] ?? session.anchor_top ?? 0;
  };

  const openSession = (id: number | string) => {
    setMarker(null);
    setComposer(null);
    closeTranslation();
    setPanelKey((k) => k + 1);
    setOpenId(id);
  };

  // 滚到某条划线所在的位置（让那一句落在视口上三分之一处，躲开吸顶的顶栏和面包屑条）。瞬间跳过去，不做动画：
  // 来自「我的笔记」的深链接和右栏的问答列表，都是读者要的就是「直接带我到那儿」
  const scrollToSession = (session: Session) => {
    const article = contentRef.current;
    if (!article) return;
    const articleTop = article.getBoundingClientRect().top;
    let top: number | null = null;
    if (!session.pdf_position && proseRef.current) {
      const off = locateOffsets(proseRef.current, session);
      const range = off ? rangeFromOffsets(proseRef.current, off[0], off[1]) : null;
      if (range) top = range.getBoundingClientRect().top - articleTop;
    }
    top ??= session.pdf_position ? (pdfTops[session.id] ?? session.anchor_top) : session.anchor_top;
    const lead = Math.max(140, window.innerHeight * 0.3);
    // behavior 写 "instant"：全站样式给 html 设了 scroll-behavior: smooth，写 "auto" 会被它变成动画，卡片就在页面还没滚到位时算了位置
    window.scrollTo({ top: Math.max(0, articleTop + window.scrollY + (top ?? 0) - lead), behavior: "instant" });
  };

  const revealSession = (id: number | string) => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    scrollToSession(session);
    openSession(id);
  };

  // 右栏「我的标记」点一条：滚到正文里那一段（和问答的跳转同一套定位，PDF 走几何坐标）
  const jumpToMark = (id: number) => {
    const mark = markedSessions.find((s) => s.id === `${MARK_PREFIX}${id}`);
    if (mark) scrollToSession(mark);
  };

  // 选得比后端能收的还长：提示分段，不发一个注定被拒（422）的请求
  const quoteTooLong = (text: string) => {
    if (text.length <= QUOTE_MAX_CHARS) return false;
    setSelectionNote(t("lesson.selectionTooLong", { max: QUOTE_MAX_CHARS }));
    return true;
  };

  const openComposerFromMarker = () => {
    if (!marker || quoteTooLong(marker.selectedText)) return;
    setOpenId(null);
    closeTranslation();
    setComposer({ ...marker, draft: "" });
    setMarker(null);
  };

  // 翻译卡片收起（或被新选区、别的卡片换掉）：还在写的照样写完、存好，正文里那一段画着虚线、页边留着圆点，点它接着看
  function closeTranslation() {
    setTranslation(null);
  }

  // 划线翻译：译成界面语言；卡片放在提问卡片的位置。开始了就写完，几段可以同时在翻
  const startTranslation = (base: Marker) => {
    if (base.selectedText.length > TRANSLATE_MAX_CHARS) {
      setSelectionNote(t("lesson.translateTooLong", { max: TRANSLATE_MAX_CHARS }));
      return;
    }
    setOpenId(null);
    setComposer(null);
    setMarker(null);
    const place: Place = {
      original_text: base.selectedText, position_start: base.start, position_end: base.end,
      anchor_top: Math.max(0, Math.round(base.top)), pdf_position: base.pdfPosition ? JSON.stringify(base.pdfPosition) : null,
    };
    // 同一处选区已经翻过：直接打开存下来的那条，不再调模型；还在翻：打开那一条接着看
    const saved = translations.find(samePlace(place));
    if (saved) {
      setTranslation({ marker: base, savedId: saved.id });
      return;
    }
    const running = translateRuns.find((run) => samePlace(place)(run.place!));
    if (running) {
      setTranslation({ marker: base, runKey: running.key });
      return;
    }
    const route = highlightRoute;
    const key = startRun({ route, kind: "translate", place, owner: runOwner });
    setTranslation({ marker: base, runKey: key });
    let text = "";
    // 结果交给写完时挂在这一篇上的页面：一直在这一篇就是这个页面；中途换到别的一篇再回来的，是新挂上的页面
    const finish = (outcome: TranslateOutcome) => {
      pageAt(route).translationFinished(key, place, outcome);
      finishRun(key);
    };
    createTranslation(
      courseId, lessonNum, { ...place, context: base.context ?? "", title: translationTitle(), target: courseLanguageOf(locale) },
      (chunk) => {
        text += chunk;
        appendRun(key, chunk);
      },
      ({ translation: row }) => finish({ row })
    ).catch((err) => {
      const dropped = err instanceof StreamError;
      finish({ error: dropped ? t("lesson.translateInterrupted") : report(err), reason: dropped ? t("lesson.translateDropped") : undefined, text });
    });
  };

  // 一段翻译写完：存好的换上，虚线和圆点留着，卡片开着就显示存好的这条；
  // 没成功：卡片开着就把原因写在卡片里、可以重试，卡片收起了就在屏幕底部说一声
  const translationFinished = (key: string, place: Place, { row, error = "", reason, text }: TranslateOutcome) => {
    if (row) {
      finishedTranslationsRef.current = [...finishedTranslationsRef.current.filter((item) => !samePlace(row)(item)), row];
      setTranslations((items) => [...items.filter((tr) => tr.id !== row.id && !samePlace(row)(tr)), row]);
      setTranslation((cur) => (cur?.runKey === key ? { marker: cur.marker, savedId: row.id } : cur));
    } else if (translationRef.current?.runKey === key) {
      setTranslation((cur) => (cur?.runKey === key ? { marker: cur.marker, text, error } : cur));
    } else if (error) {
      const quote = place.original_text;
      setSelectionNote(t("lesson.translateFailedAway", { text: quote.length > 20 ? `${quote.slice(0, 20)}…` : quote, message: reason ?? error }));
    }
  };

  // 告诉模型这是哪篇文章：课程名加文件名（或课文标题），领域词才翻得准
  const translationTitle = () =>
    [course?.name, displayFileName(lesson?.source_filename ?? "") || allLessons.find((l) => l.number === Number(lessonNum))?.title]
      .filter(Boolean).join(" · ").slice(0, 300);

  // 打开一条译文（页边圆点、PDF 里的虚线、右栏「我的翻译」）：存下来的（数字 id）直接显示，不调模型；
  // 还在写的（run key）接着显示写到哪儿了。卡片放在那一段旁边
  const openTranslationCard = (id: number | string) => {
    const run = typeof id === "string" ? translateRuns.find((item) => item.key === id) : undefined;
    const tr = typeof id === "number" ? translations.find((item) => item.id === id) : undefined;
    const place = run?.place ?? tr;
    const session = translatedSessions.find((item) => item.id === `${TRANSLATION_PREFIX}${id}`);
    if (!place || !session) return;
    const off = proseRef.current && !place.pdf_position ? locateOffsets(proseRef.current, session) : null;
    let pdfPosition: PdfPosition | undefined;
    try {
      pdfPosition = place.pdf_position ? JSON.parse(place.pdf_position) : undefined;
    } catch {
      pdfPosition = undefined;
    }
    setMarker(null);
    setComposer(null);
    setOpenId(null);
    setTranslation({
      marker: {
        top: sessionTop(session), bubble: { mode: "above", top: 0, left: 0, arrow: 0 }, selectedText: place.original_text,
        start: off ? off[0] : place.position_start, end: off ? off[1] : place.position_end, pdfPosition,
      },
      ...(run ? { runKey: run.key } : { savedId: tr!.id }),
    });
  };

  const revealTranslation = (id: number) => {
    const session = translatedSessions.find((item) => item.id === `${TRANSLATION_PREFIX}${id}`);
    if (!session) return;
    scrollToSession(session);
    openTranslationCard(id);
  };

  // 删掉开着的这条译文：正文里的虚线和页边圆点一起消失；没删成把原因写在卡片里
  const removeTranslation = async () => {
    const id = translation?.savedId;
    if (id == null || deletingTranslation) return;
    const route = highlightRoute;
    setDeletingTranslation(true);
    try {
      await deleteTranslation(courseId, lessonNum, id);
      if (highlightRouteRef.current !== route) return;
      finishedTranslationsRef.current = finishedTranslationsRef.current.filter((tr) => tr.id !== id);
      setTranslations((items) => items.filter((tr) => tr.id !== id));
      setTranslation((cur) => (cur?.savedId === id ? null : cur));
    } catch (err) {
      if (highlightRouteRef.current === route) {
        setTranslation((cur) => (cur?.savedId === id ? { ...cur, error: t("lesson.translationDeleteFailed", { message: report(err) }) } : cur));
      }
    } finally {
      setDeletingTranslation(false);
    }
  };

  // 看完译文接着问这一段：同一处选区打开提问框
  const askAboutTranslation = () => {
    if (!translation || quoteTooLong(translation.marker.selectedText)) return;
    const { marker: base } = translation;
    closeTranslation();
    setComposer({ ...base, draft: "" });
  };

  const closePanel = () => {
    setComposer(null);
    setOpenId(null);
    closeTranslation();
  };

  const openChat = () => {
    setMarker(null);
    closePanel();
    setChatOpen(true);
  };

  // 指针落在哪条标记上：返回删除按钮的位置（相对 <article>），不在标记上返回 null。
  // 每次现量 range 的矩形：页面滚动、排版变化后坐标都会变，不能缓存。
  const markBadgeUnder = (x: number, y: number) => {
    const article = contentRef.current;
    if (!article) return null;
    const box = article.getBoundingClientRect();
    const shown = markBadgeRef.current;
    const badge = badgeRef.current?.getBoundingClientRect();
    // 指针在按钮上或刚到按钮边上（含按钮和行尾之间的缝）：保持不动，否则刚移过去按钮就没了、点不到
    if (shown && badge && nearBadge(badge, x, y)) return shown;
    const marks = [...markRangesRef.current].map(([id, range]) => ({ id, lines: markLines(Array.from(range.getClientRects())) }));
    const hit = markedLineAt(marks, x, y);
    return hit ? { id: hit.id, ...markBadgeAt(hit.line, box) } : null;
  };

  // 指针离开标记不马上收起按钮：往按钮去的路上稍微偏出标记一点，按钮还在，回到按钮上就留住
  const hideMarkBadgeSoon = () => {
    if (!markBadgeRef.current || badgeHideRef.current) return;
    badgeHideRef.current = window.setTimeout(() => {
      badgeHideRef.current = 0;
      setMarkBadge(null);
    }, 300);
  };

  // 悬浮到标记上就显示行尾的删除按钮。按帧取样：鼠标划过正文时一帧最多量一次；
  // 位置没变就沿用原来那个对象，鼠标在标记上移动时不触发多余的渲染
  const showMarkBadgeUnder = (x: number, y: number) => {
    cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = 0;
      const next = markBadgeUnder(x, y);
      if (!next) return hideMarkBadgeSoon();
      clearTimeout(badgeHideRef.current);
      badgeHideRef.current = 0;
      setMarkBadge(prev =>
        prev && prev.id === next.id && prev.top === next.top && prev.left === next.left ? prev : next
      );
    });
  };

  useEffect(() => () => {
    cancelAnimationFrame(hoverFrameRef.current);
    clearTimeout(badgeHideRef.current);
  }, []);

  const handleTextSelect = (e?: React.MouseEvent) => {
    // 「参考原文」面板经 portal 渲染，但 React 事件仍沿组件树冒泡到 <article>：在面板里选字、点按钮不能清掉提问框和气泡
    if (e?.target instanceof Element && e.target.closest("[data-reference-panel]")) return;
    // 问答、课文列表还没取回来：先不出气泡，但在正文里选了字要说一声，不能选了没反应
    if (!detailsReady) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim() && proseRef.current?.contains(sel.anchorNode)) {
        setSelectionNote(t("lesson.askNotReady"));
      }
      return;
    }
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        clearPendingSelection();
        // 点一下标记也能看到删除按钮：触屏没有 hover，桌面上点击也顺手
        if (e) showMarkBadgeUnder(e.clientX, e.clientY);
        else setMarkBadge(null);
        return;
      }
      const text = selection.toString().trim();
      const range = selection.getRangeAt(0);
      // 用选区公共祖先判断是否落在课文区（跨浏览器更稳健）
      const node = range.commonAncestorContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
      if (!text || !proseRef.current?.contains(el)) {
        clearPendingSelection();
        return;
      }
      const rect = range.getBoundingClientRect();
      const articleRect = contentRef.current!.getBoundingClientRect();
      const top = Math.max(0, Math.round(rect.top - articleRect.top));
      // 代码块和行内代码不给「翻译」
      const foreign = isForeignText(text, locale) && !(el instanceof Element && el.closest("pre, code"));
      // 「提问」气泡紧挨着选中的字（lib/learn/bubble.ts）
      const bubble = placeBubble({
        head: edgeLine(range, "first") ?? rect,
        tail: edgeLine(range, "last") ?? rect,
        box: rect,
        article: articleRect,
        topSafe: topSafe(),
        ...(foreign ? { halfWidth: TRANSLATE_HALF_WIDTH } : {}),
      });
      const start = charOffset(
        proseRef.current,
        range.startContainer,
        range.startOffset
      );
      const end = charOffset(
        proseRef.current,
        range.endContainer,
        range.endOffset
      );
      // 鼠标选的字留着，Cmd+C、右键复制照常能用；触屏上系统自己的选字菜单（拷贝、查询……）会盖住气泡，只在触屏上收掉选区
      if (window.matchMedia("(pointer: coarse)").matches) selection.removeAllRanges();
      setOpenId(null);
      setComposer(null);
      closeTranslation();
      setMarkBadge(null);
      setMarker({ top, bubble, selectedText: text, start, end, foreign,
        context: foreign ? selectionContext(range, proseRef.current, text) : undefined });
    } catch (e) {
      console.error("handleTextSelect failed", e);
    }
  };

  // 标记 / 取消标记都先在页面上生效，再在后台存：读了一阵之后数据库可能已经休眠、后端实例可能要冷启动，一次保存要等好几秒，
  // 读者不该陪着等。存失败就撤回刚才的改动，原因用屏幕底部的提示说（页底的错误条离得太远看不见）。
  // 还没存好的标记用负数 id（存好后换成后端的 id），这期间不能取消
  const pendingMarkRef = useRef(0);
  const savePassageHighlight = async () => {
    if (!marker || quoteTooLong(marker.selectedText)) return;
    // 选区留着是为了能复制；标好了就收掉，露出标记的底色
    window.getSelection()?.removeAllRanges();
    const route = highlightRoute;
    const fields = {
      position_start: marker.start ?? 0, position_end: marker.end ?? marker.selectedText.length,
      original_text: marker.selectedText, anchor_top: Math.max(0, Math.round(marker.top)),
      pdf_position: marker.pdfPosition ? JSON.stringify(marker.pdfPosition) : null,
    };
    const pendingId = --pendingMarkRef.current;
    setHighlights(items => [...items, { ...fields, id: pendingId, lesson_id: lesson?.id ?? 0 }]);
    clearPendingSelection();
    try {
      const saved = await api<PassageHighlight>(highlightPath, { method: "POST", json: fields });
      if (highlightRouteRef.current !== route) return;
      // 同一段标了两次：后端返回同一条，只留一份
      setHighlights(items => [...items.filter(item => item.id !== pendingId && item.id !== saved.id), saved]);
    } catch (err) {
      if (highlightRouteRef.current !== route) return;
      setHighlights(items => items.filter(item => item.id !== pendingId));
      setSelectionNote(t("lesson.markFailed", { message: report(err) }));
    }
  };

  const removePassageHighlight = async (id: number) => {
    const removed = highlights.find(item => item.id === id);
    if (!removed || id < 0) return;
    const route = highlightRoute;
    setHighlights(items => items.filter(item => item.id !== id));
    setMarkBadge(badge => (badge?.id === id ? null : badge));
    try {
      await api(`${highlightPath}/${id}`, { method: "DELETE" });
    } catch (err) {
      // 404：别处已经删掉了（另一个标签页），本来就该不在
      if (highlightRouteRef.current !== route || (err instanceof ApiError && err.status === 404)) return;
      setHighlights(items => (items.some(item => item.id === id) ? items : [...items, removed].sort((a, b) => a.id - b.id)));
      setSelectionNote(t("lesson.unmarkFailed", { message: report(err) }));
    }
  };

  // 停止 / 断线之后：重新拉一次本篇的问答（不走缓存），把后台已经写完的换上（换上的那条不再锁着删除）
  const checkBackground = async (route: string) => {
    if (highlightRouteRef.current !== route || !waitsRef.current.length) return;
    let fresh: Annotation[];
    try {
      fresh = await getAnnotations(courseId, lessonNum, true);
    } catch (err) {
      if (highlightRouteRef.current === route) setBackgroundError(t("lesson.backgroundCheckFailed", { message: report(err) }));
      return;
    }
    if (highlightRouteRef.current !== route) return;
    setBackgroundError("");
    const done = new Map<number | string, Annotation>();
    for (const wait of waitsRef.current) {
      // 这条正在追问、流式写着：等它写完拿到存好的整条，这次先不换
      if (wait.id === streamingIdRef.current) continue;
      const hit = settledAnswer(wait, fresh, sessionsRef.current);
      if (hit) done.set(wait.id, hit);
    }
    if (!done.size) return;
    waitsRef.current = waitsRef.current.filter((w) => !done.has(w.id));
    setSessions((prev) => prev.map((s) => done.get(s.id) ?? s));
    setOpenId((cur) => (cur !== null && done.has(cur) ? done.get(cur)!.id : cur));
    setBackground((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ![...done.keys()].some((key) => String(key) === id))));
    flashUpdated([...done.values()].map((a) => a.id).join(","));
    forgetLessonAnnotations(Number(courseId), Number(lessonNum));
  };

  // 后端照样在后台把回答写完、保存：约 20 秒、60 秒、120 秒后各拉一次；120 秒还没等到就不再锁着删除，
  // 没收到字的临时气泡改说「请稍后刷新查看」
  const waitForBackground = (wait: BackgroundWait) => {
    const route = highlightRoute;
    waitsRef.current = [...waitsRef.current.filter((w) => w.id !== wait.id), wait];
    setBackground((prev) => ({ ...prev, [String(wait.id)]: { partial: Boolean(wait.partial), since: Date.now() } }));
    for (const ms of BACKGROUND_CHECK_MS) {
      backgroundTimers.current.push(
        setTimeout(() => {
          void checkBackground(route).then(() => {
            if (ms < BACKGROUND_WAIT_MS || highlightRouteRef.current !== route || !waitsRef.current.includes(wait)) return;
            waitsRef.current = waitsRef.current.filter((w) => w !== wait);
            setBackground((prev) => {
              const next = { ...prev };
              if (wait.partial) delete next[String(wait.id)];
              else next[String(wait.id)] = { partial: false, expired: true };
              return next;
            });
          });
        }, ms)
      );
    }
  };

  const handleCreateSession = async () => {
    if (!detailsReady || !composer?.draft.trim() || streaming || styleBusy) return;
    const asked = composer;
    const route = highlightRoute;
    // 下面换页面上的这条问答，都换到那时挂着这一篇的页面上：回答写着时换到别的一篇再回来，结果照样换上
    const { setSessions, setOpenId, setCardError, setStreamingId, setStopping, setComposer, waitForBackground } = pageAt(route);
    const q = composer.draft.trim();
    const tempId = `tmp-${Date.now()}`;
    const pdfPos = composer.pdfPosition
      ? JSON.stringify(composer.pdfPosition)
      : null;
    const temp: Session = {
      id: tempId,
      original_text: composer.selectedText,
      comment: q,
      anchor_top: composer.top,
      position_start: composer.start ?? 0,
      position_end: composer.end ?? composer.selectedText.length,
      pdf_position: pdfPos,
      messages: [{ role: "user", content: q }],
    };
    setSessions((prev) => [...prev, temp]);
    setOpenId(tempId);
    setComposer(null);
    resetStreamText();
    setStreamingId(tempId);
    setCardError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    // 换到别的一篇再回来时，新挂上的页面照着它显示这条问答、写到哪儿了，也能停止
    const runKey = startRun({ route, kind: "ask", owner: runOwner, session: temp, question: q, stop: () => controller.abort() });
    // 同一次提问的 id：点停止存下的半截回答和后端后台存完的完整回答靠它合成一条
    const requestId = newRequestKey();
    // 等后台写完的那一条要和这处选区、这个问题对上（问答列表的响应里没有 request_id）
    const selection = {
      original_text: temp.original_text,
      position_start: temp.position_start,
      position_end: temp.position_end,
      pdf_position: pdfPos,
    };
    try {
      const result: { ann?: Annotation } = {};
      await createAnnotation(
        courseId,
        lessonNum,
        {
          position_start: temp.position_start,
          position_end: temp.position_end,
          original_text: temp.original_text,
          comment: q,
          answer_immediately: true,
          anchor_top: temp.anchor_top,
          pdf_position: pdfPos,
          request_id: requestId,
        },
        (chunk) => {
          appendStreamText(chunk);
          appendRun(runKey, chunk);
        },
        (data) => {
          result.ann = data.annotation;
        },
        controller.signal
      );
      const saved = result.ann!;
      setSessions((prev) => swapSession(prev, tempId, saved));
      // 回答写着的时候读者打开了别的问答、或者选了新的一段：不把卡片拽回这一条
      setOpenId((cur) => (cur === tempId ? saved.id : cur));
    } catch (err) {
      const stopped = (err as Error).name === "AbortError";
      const message = stopped ? "" : report(err);
      const partial = streamTextRef.current;
      // 读者点了停止，或者连接断在半路（没收到完成事件）：后端照样在后台把回答写完、保存。
      // 已经写出来的部分先存下来，后台写完会把它换成完整回答；一个字都还没收到就留着这个气泡、说明情况，过一会儿去拉后台存好的那条。
      // 后端明确报错的、请求没被受理的不存也不等
      if (stopped || err instanceof StreamError) {
        if (!partial.trim()) {
          waitForBackground({ id: tempId, question: q, nth: 0, partial: "", selection });
          if (message) setCardError({ id: tempId, message });
        } else {
          try {
            const ann = await saveInterruptedAnnotation(courseId, lessonNum, {
              ...selection,
              comment: q,
              anchor_top: temp.anchor_top,
              partial_answer: partial,
              request_id: requestId,
            });
            setSessions((prev) => swapSession(prev, tempId, ann));
            setOpenId((cur) => (cur === tempId ? ann.id : cur));
            if (message) setCardError({ id: ann.id, message });
            // 后台先写完了的话，存下来的已经是完整回答，不用再等
            const savedAnswer = answerAfter(ann.messages, q, 0) ?? "";
            if (savedAnswer.trimEnd() === partial.trimEnd()) {
              waitForBackground({ id: ann.id, question: q, nth: 0, partial: savedAnswer });
            }
          } catch (saveErr) {
            setCardError({ id: tempId, message: t("lesson.partialSaveFailed", { message: report(saveErr) }) });
            setSessions((prev) =>
              prev.map((s) =>
                s.id === tempId
                  ? {
                      ...s,
                      messages: [
                        ...s.messages,
                        { role: "assistant", content: partial },
                      ],
                    }
                  : s
              )
            );
            // 半截没存上，后台写完的完整回答照样会存成一条：等到了就换掉这个临时气泡
            waitForBackground({ id: tempId, question: q, nth: 0, partial: "", selection });
          }
        }
      } else {
        setSessions((prev) => prev.filter((s) => s.id !== tempId));
        setOpenId((cur) => (cur === tempId ? null : cur));
        // 没被受理（500、422、409、断网）：同一处选区的提问框带着读者写的问题回来，原因写在卡片里，打的字不丢。
        // 读者这期间又开了一个提问框的不动它；已经离开这一篇的也不在新的一篇上弹出来（pageAt 只换到这一篇的页面上）
        setComposer((c) => c ?? { ...asked, error: message || undefined });
      }
    } finally {
      finishRun(runKey);
      abortRef.current = null;
      setStreamingId(null);
      setStopping(false);
      resetStreamText();
      // 这篇课文的问答变了：「我的笔记」里展开全文用的缓存作废，回去再展开拿到最新的对话
      forgetLessonAnnotations(Number(courseId), Number(lessonNum));
    }
  };

  const handleFollowUp = async (sessionId: number | string) => {
    if (styleBusy || !detailsReady) return;
    if (!followDraft.trim() || streaming) return;
    // 临时 id（tmp-…）的问答后端没有这一条：不发注定 404 的追问（卡片上已经禁用追问并说明原因）
    if (typeof sessionId !== "number") return;
    const typed = followDraft;
    const q = followDraft.trim();
    // 和首次提问一样：换到那时挂着这一篇的页面上
    const route = highlightRoute;
    const { setSessions, setCardError, setStreamingId, setStopping, setFollowDrafts, waitForBackground } = pageAt(route);
    // 这个问题之前在这条问答里问过几次：等后台回答时认的是这一次
    const nth = countQuestion(sessionsRef.current.find((s) => s.id === sessionId)?.messages ?? [], q);
    setFollowDrafts((prev) => withDraft(prev, sessionId, ""));
    // optimistically show the user's question; reverted if the request fails
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, { role: "user", content: q }] }
          : s
      )
    );
    resetStreamText();
    setStreamingId(sessionId);
    setCardError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const runKey = startRun({ route, kind: "follow", owner: runOwner, sessionId, question: q, stop: () => controller.abort() });
    const requestId = newRequestKey();
    try {
      const result: { ann?: Annotation } = {};
      await addAnnotationMessage(
        courseId,
        lessonNum,
        sessionId,
        q,
        (chunk) => {
          appendStreamText(chunk);
          appendRun(runKey, chunk);
        },
        (data) => {
          result.ann = data.annotation;
        },
        controller.signal,
        requestId
      );
      const saved = result.ann!;
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? saved : s))
      );
    } catch (err) {
      const stopped = (err as Error).name === "AbortError";
      const message = stopped ? "" : report(err);
      if (message) setCardError({ id: sessionId, message });
      const partial = streamTextRef.current;
      // 和首次提问一样：后端照样在后台写完、保存。已经写出来的部分先存下来；还没收到字的，追问留着，等后台那份
      if (stopped || err instanceof StreamError) {
        if (!partial.trim()) {
          waitForBackground({ id: sessionId, question: q, nth, partial: "" });
        } else {
          try {
            const ann = await saveInterruptedAnnotation(courseId, lessonNum, {
              annotation_id: sessionId,
              question: q,
              partial_answer: partial,
              request_id: requestId,
            });
            setSessions((prev) =>
              prev.map((s) => (s.id === sessionId ? ann : s))
            );
            const savedAnswer = answerAfter(ann.messages, q, nth) ?? "";
            if (savedAnswer.trimEnd() === partial.trimEnd()) {
              waitForBackground({ id: sessionId, question: q, nth, partial: savedAnswer });
            }
          } catch (saveErr) {
            setCardError({ id: sessionId, message: t("lesson.partialSaveFailed", { message: report(saveErr) }) });
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      messages: [
                        ...s.messages,
                        { role: "assistant", content: partial },
                      ],
                    }
                  : s
              )
            );
            waitForBackground({ id: sessionId, question: q, nth, partial: "" });
          }
        }
      } else {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId ? { ...s, messages: s.messages.slice(0, -1) } : s
          )
        );
        // 没被受理：追问放回输入框（这期间又打了字的，接在后面），打的字不丢
        setFollowDrafts((prev) => {
          const now = draftOf(prev, sessionId);
          return withDraft(prev, sessionId, now.trim() ? `${typed}\n${now}` : typed);
        });
      }
    } finally {
      finishRun(runKey);
      abortRef.current = null;
      setStreamingId(null);
      setStopping(false);
      resetStreamText();
      // 这篇课文的问答变了：「我的笔记」里展开全文用的缓存作废，回去再展开拿到最新的对话
      forgetLessonAnnotations(Number(courseId), Number(lessonNum));
    }
  };

  // 点下去立刻换成「正在停止…」：之后还要存已经收到的半截回答，这期间「停止」不该还能点
  const handleStopStreaming = () => {
    if (!abortRef.current) {
      // 换篇回来接着显示的那一条：停的是发起时开的那个请求，停下之后照样存半截、等后台写完
      if (adoptedQa) {
        setStopping(true);
        stopRun(adoptedQa.key);
      }
      return;
    }
    setStopping(true);
    abortRef.current.abort();
  };

  // 登记成挂在这一篇上的页面：这一篇上还在写的翻译、回答（这个页面发起的，或换篇之前发起的）写完都交给它换上
  const pageRef = useRef<LessonPage | null>(null);
  pageRef.current = {
    translationFinished,
    setSessions: (value) => (detailsReadyRef.current ? setSessions(value) : queuedSessionsRef.current.push(value)),
    setOpenId, setCardError, setStreamingId, setStopping, setComposer, setFollowDrafts, waitForBackground,
  };
  useEffect(() => registerPage(highlightRoute, "lesson", () => pageRef.current), [highlightRoute]);

  // 换到别的一篇时还在写的提问 / 追问（发起它的页面已经卸掉）：回来后问答列表一到，照样显示问题、接着显示写到哪儿了，能停止
  const shownRunRef = useRef("");
  useEffect(() => {
    if (!detailsReady || !adoptedQa || shownRunRef.current === adoptedQa.key) return;
    shownRunRef.current = adoptedQa.key;
    const { session, sessionId, question = "" } = adoptedQa;
    if (session) {
      setSessions((prev) => (prev.some((s) => s.id === session.id) ? prev : [...prev, session]));
      setStreamingId(session.id);
    } else if (sessionsRef.current.some((s) => s.id === sessionId)) {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: [...s.messages, { role: "user", content: question }] } : s)));
      setStreamingId(sessionId!);
    }
    // 只在问答列表到了、换了一条要接着显示时做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsReady, adoptedQa?.key]);

  // 这条问答现在为什么不能删（能删返回 undefined）：回答正在写，或者停止之后还在等后台写完
  const deleteBlocked = (id: number | string) => {
    if (streamingId === id) return t("lesson.deleteWhileAnswering");
    const wait = background[String(id)];
    return wait && !wait.expired ? t("lesson.deleteWhileBackground") : undefined;
  };

  // 卡片上先确认再调这里；返回失败的原因（写在卡片的确认条里），成功返回空串
  const handleDeleteSession = async (id: number | string) => {
    if (deleteBlocked(id)) return;
    try {
      // 临时 id（tmp-…）的问答没存进后端（存半截回答也失败了）：只在本地去掉，不发注定 422 的 DELETE
      if (typeof id === "number") {
        await deleteAnnotation(courseId, lessonNum, id);
        forgetLessonAnnotations(Number(courseId), Number(lessonNum));
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setOpenId((cur) => (cur === id ? null : cur));
      // 卡片收起、页边圆点消失，读者不一定分得清是删了还是收起了：说一句
      setSelectionNote(t("lesson.sessionDeleted"));
      return "";
    } catch (err) {
      return report(err);
    }
  };

  const handleSubmitFeedback = async () => {
    if (!detailsReady) return false;
    // 按点保存那一刻的内容存；保存期间读者又改了的话，存上的是旧的那份，不能标成「已保存」
    const sent = feedbackRef.current;
    setSubmittingFeedback(true);
    setError("");
    try {
      await submitFeedback(
        courseId,
        lessonNum,
        sent.content,
        sent.thoughts,
        sent.scope
      );
      const now = feedbackRef.current;
      if (now.content === sent.content && now.thoughts === sent.thoughts && now.scope === sent.scope) {
        setFeedbackSaved(true);
        setFeedbackDirty(false);
      }
      return true;
    } catch (err) {
      setError(report(err));
      return false;
    } finally {
      setSubmittingFeedback(false);
    }
  };

  // 不走缓存看一眼最新的课文列表和课程状态：这一篇之后已经有新课文就跳过去，课程已经完结就回课程页，返回 true（已经离开这一篇也返回 true）。
  // 生成断在半路（超时、断网、没收到完成事件）时，后端的收尾线程可能已经把课文存好：失败之后、以及每次重试（会扣费）之前都先看这一眼
  const goToLandedLesson = async () => {
    const route = highlightRoute;
    const [lessons, latest] = await Promise.all([getLessons(courseId, true), getCourse(courseId, true)]);
    if (highlightRouteRef.current !== route) return true;
    setAllLessons(lessons);
    const later = lessons.filter((l) => !l.is_source && l.number > currentNum).map((l) => l.number);
    if (later.length) {
      router.push(`/learn/course/${courseId}/lesson/${Math.min(...later)}`);
      return true;
    }
    if (latest.status === "completed") {
      router.push(`/learn/course/${courseId}`);
      return true;
    }
    return false;
  };

  const handleGenerateNext = async () => {
    if (styleBusy || !detailsReady) return;
    const route = highlightRoute;
    try {
      const result: { done?: NextLessonDone } = {};
      await generateNextLesson(
        courseId,
        appendStreamContent,
        (data) => {
          result.done = data;
        },
        lessonNum
      );
      const { lesson_number: next, length_exceeded: limit } = result.done ?? {};
      if (next && limit) {
        try {
          sessionStorage.setItem(LONGER_NOTE_KEY, JSON.stringify({ route: `${courseId}/${next}`, limit }));
        } catch {
          // 存不了只是少一句提示
        }
      }
      // 读者已经离开这一篇（去了别的页面）：课文照样生成好了，不把人拽回来
      if (highlightRouteRef.current !== route) return;
      // 成功后保持 generating，直到页面跳走：router.push 是异步的，
      // 此时放开会让旧页面上的按钮重新可点，再点一次会重复生成
      if (result.done?.completed) {
        router.push(`/learn/course/${courseId}`);
      } else if (result.done?.lesson_number) {
        router.push(
          `/learn/course/${courseId}/lesson/${result.done.lesson_number}`
        );
      } else {
        setGenerating(false);
      }
    } catch (err) {
      try {
        if (await goToLandedLesson()) return;
      } catch {
        // 查不到最新列表就照常报原来的错；重试之前还会再查一次
      }
      if (highlightRouteRef.current !== route) return;
      setNextError(report(err));
      setGenerating(false);
    }
  };

  const handleReadDone = async () => {
    // 划线回答还在写：按钮已禁用并写明原因（下一篇要参考这篇的问答，写了一半的不算）
    if (styleBusy || !detailsReady || streaming) return;
    // 先占住 generating（看 ref）：保存反馈期间按钮不能再点第二次，否则会生成两次
    if (generatingRef.current) return;
    setGenerating(true);
    resetStreamContent();
    setError("");
    setNextError("");
    const unsaved =
      feedbackDirty || ((feedbackContent.trim() || thoughtAnswers.trim()) && !feedbackSaved);
    // 反馈（或思考题回答）没存上就不生成：停在这里，错误条显示后端原因，generating 放开，用户改好再点
    const generated = await saveFeedbackThenGenerate(
      unsaved ? handleSubmitFeedback : null,
      handleGenerateNext
    );
    if (!generated) setGenerating(false);
  };

  // 检查要等一会儿：检查完调用的是最新一次渲染的 handleReadDone（看到的是读者刚改的反馈），不是点重试那一刻的旧闭包
  const handleReadDoneRef = useRef(handleReadDone);
  handleReadDoneRef.current = handleReadDone;
  const checkingNextRef = useRef(false);

  // 「生成下一篇」失败后的重试：先确认上一次没有在后台存好新课文（存好了就直接过去），确认没有才再生成
  const handleRetryNext = async () => {
    if (checkingNextRef.current || generatingRef.current) return;
    checkingNextRef.current = true;
    setCheckingNext(true);
    try {
      if (await goToLandedLesson()) return;
    } catch (err) {
      setNextError(report(err));
      return;
    } finally {
      checkingNextRef.current = false;
      setCheckingNext(false);
    }
    await handleReadDoneRef.current();
  };

  const currentNum = parseInt(lessonNum, 10);
  // 资料课里归档的文件不在右栏列表里，「下一个」也跳过它们；正在看的这一篇归档了照样列着
  const railLessons = allLessons.filter((l) => !l.is_archived || l.number === currentNum);
  // 后端永远在最后一篇之后生成：只有最后一篇上才给生成按钮，回看更早的课文只给跳转
  const action = nextAction(
    currentNum,
    railLessons,
    course?.status === "completed"
  );

  const handleMarkRead = async () => {
    if (!detailsReady || markingRead || readSaved) return;
    setMarkingRead(true);
    setError("");
    try {
      const result = await markLessonCompleted(courseId, lessonNum);
      setReadSaved(true);
      setAutoArchived(Boolean(result.archived));
      setLesson((prev) => (prev ? { ...prev, is_read: true } : prev));
      setAllLessons((prev) =>
        prev.map((l) => (l.number === currentNum ? { ...l, is_read: true, ...(result.archived && { is_archived: true }) } : l))
      );
      setCourse((prev) =>
        prev
          ? {
              ...prev,
              mastery_progress:
                result.mastery_progress ?? prev.mastery_progress,
              status: result.course_completed ? "completed" : prev.status,
            }
          : prev
      );
    } catch (err) {
      setError(report(err));
    } finally {
      setMarkingRead(false);
    }
  };

  const isSourceLesson = Boolean(lesson?.is_source);
  const isProject = Boolean(course?.is_project);
  const isPdf = Boolean(
    lesson?.source_filename?.toLowerCase().endsWith(".pdf")
  );
  const markdownOptions = lessonMarkdownOptions(isProject, isSourceLesson);
  // 宽屏左栏的目录，至少两条才显示。原文篇要等课程信息回来才分得清是不是项目文件（正文这时先是骨架屏），目录也等它
  const outlineReady = Boolean(lesson) && !isPdf && !(isSourceLesson && !course);
  const outline = useMemo(
    () => (outlineReady ? outlineOf(lesson?.content, lessonMarkdownOptions(isProject, isSourceLesson)) : NO_OUTLINE),
    [outlineReady, lesson?.content, isProject, isSourceLesson]
  );
  const showOutline = outline.length >= 2;
  // 读到哪一节、点了跳过去：宽屏左栏、右栏（1024–1279px）和手机抽屉里的目录共用一份。改文件时正文藏起来了，目录都先收掉
  const sectionEntries = showOutline && !editing ? outline : NO_OUTLINE;
  const sections = useSections(sectionEntries);
  const handlePdfSelect = ({
    text,
    position,
    box,
    head,
    tail,
    context,
  }: {
    text: string;
    position: PdfPosition;
    box: Box;
    head: Box;
    tail: Box;
    context: string;
  }) => {
    if (!detailsReady) {
      setSelectionNote(t("lesson.askNotReady"));
      return;
    }
    const articleRect = contentRef.current?.getBoundingClientRect();
    if (!articleRect) return;
    const top = Math.max(0, Math.round(box.top - articleRect.top));
    const foreign = isForeignText(text, locale);
    setOpenId(null);
    setComposer(null);
    closeTranslation();
    setMarker({
      top,
      bubble: placeBubble({ head, tail, box, article: articleRect, topSafe: topSafe(), ...(foreign ? { halfWidth: TRANSLATE_HALF_WIDTH } : {}) }),
      selectedText: text,
      start: 0,
      end: text.length,
      pdfPosition: position,
      foreign,
      context,
    });
  };
  const handlePdfHighlightTops = useCallback(
    (nextTops: Record<string, number>) => {
      setPdfTops((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(nextTops);
        if (
          prevKeys.length === nextKeys.length &&
          nextKeys.every((key) => prev[key] === nextTops[key])
        )
          return prev;
        return nextTops;
      });
    },
    []
  );
  // 开着的是存下来的（或还在写的）译文：PDF 里那条虚线画成「开着」，不再叠一层「正在选」的底
  const openTranslationId = translation?.savedId ?? translation?.runKey ?? null;
  const pendingPdfPosition = composer?.pdfPosition || marker?.pdfPosition || (openTranslationId == null ? translation?.marker.pdfPosition : undefined);
  // 只在划线、开着的那条、正在提问的选区变了时才重算：回答流式写入时整页每帧都在重渲染，PDF 的高亮层不能跟着拆了重画
  const pdfHighlights = useMemo<PdfHighlight[]>(() => {
    if (!isPdf) return [];
    const marks = highlights.map((h) => ({ id: `highlight-${h.id}`, pdf_position: h.pdf_position }));
    return [
      ...[...sessions, ...marks, ...translatedSessions].flatMap((s): PdfHighlight[] => {
        if (!s.pdf_position) return [];
        const translated = String(s.id).startsWith(TRANSLATION_PREFIX);
        try {
          return [{
            id: s.id, position: JSON.parse(s.pdf_position), translation: translated,
            active: translated ? s.id === `${TRANSLATION_PREFIX}${openTranslationId}` : s.id === openId,
          }];
        } catch {
          return [];
        }
      }),
      ...(pendingPdfPosition ? [{ id: "__pending-pdf", position: pendingPdfPosition, pending: true }] : []),
    ];
    // translatedSessions 由 translations 和还在写的翻译（只看有哪几条）算出来
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPdf, sessions, highlights, translations, translateRunKeys, openId, openTranslationId, pendingPdfPosition]);

  // Esc 收起划线提问卡片（写了一半的提问或追问不理会，输入法选字时的 Esc 也不算）
  const composerDraft = composer?.draft ?? "";
  useEffect(() => {
    if ((!composer && openId == null && !translation) || showMobileNav) return;
    const onKey = (e: KeyboardEvent) => {
      if (!shouldCloseOnEscape(e, { composer: composerDraft, follow: followDraft })) {
        return;
      }
      setComposer(null);
      setOpenId(null);
      closeTranslation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composer, composerDraft, openId, translation, followDraft, showMobileNav]);

  // 「问这篇」开着（上面没有划线卡片）：Esc 收起；写了一半的问题不理会
  const chatVisible = chatOpen && !composer && !openSessionData && !translation;
  const chatDraft = chat.draft;
  useEffect(() => {
    if (!chatVisible || showMobileNav) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldCloseOnEscape(e, { composer: chatDraft, follow: "" })) setChatOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatVisible, chatDraft, showMobileNav]);

  // 触屏上长按选字不会触发 mouseup：选区稳定下来之后同样出现「提问」气泡
  const selectRef = useRef(handleTextSelect);
  useEffect(() => {
    selectRef.current = handleTextSelect;
  });
  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const sel = window.getSelection();
        const prose = proseRef.current;
        if (!sel || sel.isCollapsed || !prose?.contains(sel.anchorNode)) return;
        selectRef.current();
      }, 450);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  // 生成下一篇：平滑滚到流式内容的开头，让读者看见它正在写
  useEffect(() => {
    if (!generating) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    streamRef.current?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  }, [generating]);

  // 桌面右栏里的问答卡片：顶部对齐被问的那一段（见 use-panel-top.ts）
  // 「问这篇」不对着哪一段（anchor 为 null）：卡片紧贴在右栏顶上那一行目录下面，吸顶跟着页面走
  const panelOpen = Boolean(composer || openSessionData || translation || chatOpen);
  const panelTop = usePanelTop({
    open: panelOpen,
    // 参考原文面板开关时卡片换了位置（右栏 ↔ 左半屏底部），也要重新挂监听
    version: `${composer ? "compose" : translation ? "translate" : openSessionData ? `${openSessionData.id}:${panelKey}` : "chat"}:${sourceOpen}`,
    anchor: composer ? composer.top : translation ? translation.marker.top : openSessionData ? sessionTop(openSessionData) : null,
    article: contentRef,
    area: panelAreaRef,
    card: panelRef,
    // 右栏顶上的「课文 · 第 N 篇」一行高 44px，卡片离它再空 12px
    minTop: 56,
  });
  // 目录那一组（一行 + 展开时的列表）有多高，卡片的吸附线就让出多高再加 12px（--panel-offset，annotation-panel.tsx 的 sticky top / max-h 用它）：
  // 展开时卡片被往下推、最大高度跟着缩，收起时回来；卡片不管吸顶吸底都碰不到这一组
  useLayoutEffect(() => {
    const group = navGroupRef.current;
    const area = panelAreaRef.current;
    if (!panelOpen || !group || !area) return;
    const apply = () => area.style.setProperty("--panel-offset", `${Math.round(group.getBoundingClientRect().height) + 12}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(group);

    return () => observer.disconnect();
  }, [panelOpen, sourceOpen]);

  if (loading || (lesson && (lesson.course_id !== Number(courseId) || lesson.number !== Number(lessonNum)))) {
    return (
      <div className="lesson-page min-h-[60dvh]">
        <HideFooter />
        {/* 课文还没取到，抽屉也还没有：「课文」按钮先禁用（不传 onOpenNav） */}
        <LessonBar courseId={courseId} navOpen={false} />
        <div className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 sm:pt-10 lg:px-8">
          <LearnColumns
            rail={
              <div className="hidden space-y-2 lg:block">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            }
          >
            <div role="status" aria-label={t("common.loading")}>
              <Skeleton className="mb-3 h-8 w-4/5" />
              <Skeleton className="mb-8 h-8 w-2/5" />
              <div className="space-y-3">
                {[100, 100, 90, 0, 100, 100, 70, 0, 100, 60].map((w, i) =>
                  w ? (
                    <Skeleton key={i} className="h-4" style={{ width: `${w}%` }} />
                  ) : (
                    <div key={i} className="h-4" />
                  )
                )}
              </div>
            </div>
          </LearnColumns>
        </div>
      </div>
    );
  }

  // 打不开：整页提示（页脚照常显示，只有读课文时才隐藏页脚）
  if (error && !lesson) {
    return <LearnStatus kind="lesson" notFound={notFound} message={error} courseId={courseId} />;
  }

  // 资料类课程：文件能改名、删除；不是原 PDF 的还能改正文
  const canManageFiles = isProject && Boolean(course);
  const canEditText = canManageFiles && Boolean(lesson) && currentNum > 0 && !isPdf;
  const fileRenamed = (renamed: { number: number; source_filename: string | null }) => {
    setAllLessons((list) => list.map((l) => (l.number === renamed.number ? { ...l, source_filename: renamed.source_filename } : l)));
    if (renamed.number === currentNum) setLesson((prev) => (prev ? { ...prev, source_filename: renamed.source_filename } : prev));
  };
  // 归档 / 取消归档（右栏文件菜单）：列表先变，没改成就退回去并说原因；改成了用返回的状态和进度更新课程
  const fileArchived = async (file: LessonItem) => {
    const archive = !file.is_archived;
    const flip = (value: boolean) =>
      setAllLessons((list) => list.map((l) => (l.number === file.number ? { ...l, is_archived: value } : l)));
    flip(archive);
    try {
      const result = await setLessonArchived(courseId, file.number, archive);
      setCourse((prev) => prev && {
        ...prev,
        status: result.status,
        mastery_covered: result.mastery_covered,
        mastery_total: result.mastery_total,
        mastery_progress: result.mastery_progress,
      });
    } catch (err) {
      flip(!archive);
      setError(report(err));
    }
  };
  // 删的是正在看的这一篇：去列表里的下一篇（没有就上一篇），一篇都不剩回到课程页
  const fileDeleted = (file: { number: number }) => {
    setDeleteTarget(null);
    const rest = allLessons.filter((l) => l.number !== file.number && l.number > 0);
    setAllLessons((list) => list.filter((l) => l.number !== file.number));
    if (file.number !== currentNum) return;
    const next = rest.find((l) => l.number > file.number) ?? rest[rest.length - 1];
    router.replace(next ? `/learn/course/${courseId}/lesson/${next.number}` : `/learn/course/${courseId}`);
  };
  // 文字里的篇号不补零（「第 1 篇」），补零的「01」只用在目录那一列等宽小编号上
  const lessonNumberLabel = t("common.lessonNumber", { number: Number(lessonNum) });
  const lessonLabel = isProject
    ? displayFileName(lesson?.source_filename ?? "") || lessonNumberLabel
    : lessonNumberLabel;
  // 课程信息（是不是项目课）还没回来时，原文篇和项目文件分不清：不先挂「原文」徽标，免得一闪就没
  const lessonBadge = lesson?.is_evaluation
    ? t("lesson.evaluation")
    : isSourceLesson && course && !isProject
      ? t("common.source")
      : isProject && allLessons.find((l) => l.number === currentNum)?.is_archived
        ? t("course.archive.badge")
        : undefined;
  // 设置里开了「读完立刻归档」：读之前说标记已读会归档，读完了说已归档并给撤销（撤销 = 取消归档）
  const currentFile = allLessons.find((l) => l.number === currentNum);
  const hintAction = "font-medium text-foreground underline underline-offset-2";
  const markReadHint = !isProject || !currentFile ? undefined
    : autoArchived && currentFile.is_archived ? (
      <>
        {t("lesson.autoArchive.done")}{" "}
        <button type="button" className={hintAction} onClick={() => void fileArchived(currentFile)}>
          {t("course.archive.undo")}
        </button>
      </>
    )
    : !readSaved && user?.archive_on_read && !currentFile.is_archived ? (
      <>
        {t("lesson.autoArchive.will")}{" "}
        <Link href="/me/settings" className={hintAction}>{t("lesson.autoArchive.settings")}</Link>
      </>
    )
    : undefined;
  const tabTitle = lessonTabTitle(t, currentNum, { lesson, course, lessons: allLessons });
  const navProps = {
    courseId,
    currentNum,
    // 这一篇刚保存的反馈：侧栏的列表是进页面时取的，不会自己知道，这里补上，保存后立刻显示、翻看别篇再回来也还在
    allLessons: railLessons.map((l) => (l.number === currentNum && feedbackSaved && !l.has_feedback ? { ...l, has_feedback: true } : l)),
    isProject,
    sessions: sessions.map((s) => ({
      id: s.id,
      comment: s.comment,
      original_text: s.original_text,
    })),
    onOpenSession: revealSession,
    marks: highlights.map((h) => ({ id: h.id, original_text: h.original_text })),
    onJumpMark: jumpToMark,
    onRemoveMark: removePassageHighlight,
    translations: translations.map((tr) => ({ id: tr.id, original_text: tr.original_text, translation: tr.translation })),
    onOpenTranslation: revealTranslation,
    // 本篇目录：桌面宽屏在左栏，窄一点时是右栏里的一组，手机在抽屉里
    outline: sectionEntries,
    activeSection: sections.active,
    onJumpSection: sections.jump,
    ...(canManageFiles && {
      onRenameFile: (l: LessonItem) => setRenameTarget({ number: l.number, filename: l.source_filename || `${l.number}.md` }),
      onDeleteFile: (l: LessonItem) => setDeleteTarget({ number: l.number, name: displayFileName(l.source_filename || "") || lessonNumberLabel }),
      onArchiveFile: (l: LessonItem) => void fileArchived(l),
    }),
  };
  const dot = isPdf ? "right-1.5" : "-right-4 lg:-right-9";
  const dotTops = spreadDots(
    [...sessions, ...translatedSessions].map((s) => ({ id: s.id, top: Math.max(0, sessionTop(s) - 8) }))
  );
  const generateLabel = lesson?.is_evaluation
    ? t("lesson.next.finishedEval")
    : t("lesson.next.finished");

  // 现在不能提问 / 追问的原因：卡片上写在按钮旁边，按钮禁用、回车无效时读者知道为什么
  const askBusy = streaming
    ? t("lesson.askWhileAnswering")
    : chat.streaming
      ? t("lesson.chatBusy")
      : generating
      ? t("lesson.askWhileGenerating")
      : styleBusy
        ? t("lesson.askWhileSwitching")
        : undefined;
  const panelProps = {
    busyReason: askBusy,
    docked: sourceOpen,
    onClose: closePanel,
    // 划线卡里引的原文：原文篇的是学生自己的字，不做排版
    quoteTypography: !isSourceLesson,
  };

  // 打开的这条问答：是不是正在流式写着；停止之后在等后台写完的，卡片上说明情况；临时 id 的不能追问
  const openStreaming = openSessionData !== undefined && streamingId === openSessionData.id;
  // 翻译卡片上的译文：存下来的那条，或还在写的写到哪儿了，或没成功之前收到的
  const cardTranslationRun = translation?.runKey ? translateRuns.find((run) => run.key === translation.runKey) : undefined;
  const cardTranslationText =
    translation?.savedId != null
      ? translations.find((tr) => tr.id === translation.savedId)?.translation ?? ""
      : cardTranslationRun?.text ?? translation?.text ?? "";
  const openWait = openSessionData ? background[String(openSessionData.id)] : undefined;
  const sessionNotice = openWait
    ? t(openWait.expired ? "lesson.backgroundExpired" : openWait.partial ? "lesson.backgroundPartial" : "lesson.backgroundPending")
    : undefined;
  const followUpBlocked =
    openSessionData && typeof openSessionData.id === "string" && !openStreaming
      ? t(openWait && !openWait.expired ? "lesson.followUpWaiting" : "lesson.followUpUnsaved")
      : undefined;
  const openError = openSessionData && cardError?.id === openSessionData.id ? cardError.message : undefined;

  // 划线提问卡片：平时在右栏；「参考原文」面板开着时右栏被让掉，卡片放在正文栏里、作为左半屏底部的抽屉（docked）
  const annotationCards = (
    <>
      {composer && (
        <AnnotationPanel
          ref={panelRef}
          kind="compose"
          quote={composer.selectedText}
          draft={composer.draft}
          onDraftChange={(draft) =>
            setComposer((c) => (c ? { ...c, draft } : c))
          }
          onSubmit={handleCreateSession}
          {...panelProps}
          error={composer.error}
        />
      )}
      {/* 提问框开着时只显示提问框：回答写完不会再把会话卡片顶出来 */}
      {openSessionData && !composer && (
        <AnnotationPanel
          ref={panelRef}
          key={panelKey}
          kind="session"
          session={openSessionData}
          streaming={openStreaming}
          streamText={openStreaming ? streamText : ""}
          notice={sessionNotice}
          noticeSince={openWait && !openWait.expired ? openWait.since : null}
          updated={updatedIds.split(",").includes(String(openSessionData.id))}
          followDraft={followDraft}
          onFollowDraftChange={(value) =>
            setFollowDrafts((prev) => withDraft(prev, openSessionData.id, value))
          }
          followUpBlocked={followUpBlocked}
          onFollowUp={() => handleFollowUp(openSessionData.id)}
          onStop={handleStopStreaming}
          stopping={openStreaming && stopping}
          deleteBlocked={deleteBlocked(openSessionData.id)}
          onDelete={() => handleDeleteSession(openSessionData.id)}
          {...panelProps}
          error={openError}
        />
      )}
      {chatVisible && (
        <AnnotationPanel
          ref={panelRef}
          kind="chat"
          turns={chat.turns}
          streaming={chat.streaming}
          streamText={chat.streamText}
          draft={chat.draft}
          onDraftChange={chat.setDraft}
          onSend={chat.send}
          onClear={chat.clear}
          {...panelProps}
          // 自己的回答在写时按钮转圈，不另写原因
          busyReason={streaming ? t("lesson.askWhileAnswering") : generating ? t("lesson.askWhileGenerating") : styleBusy ? t("lesson.askWhileSwitching") : undefined}
          onClose={() => setChatOpen(false)}
          error={chat.error}
        />
      )}
      {translation && !composer && !openSessionData && (
        <AnnotationPanel
          ref={panelRef}
          kind="translate"
          quote={translation.marker.selectedText}
          translation={cardTranslationText}
          translating={Boolean(cardTranslationRun)}
          typography={courseLanguageOf(locale) === "zh"}
          onRetry={translation.error && translation.savedId == null ? () => startTranslation(translation.marker) : undefined}
          onAsk={askAboutTranslation}
          onDelete={translation.savedId != null ? removeTranslation : undefined}
          deleting={deletingTranslation}
          {...panelProps}
          error={translation.error}
        />
      )}
    </>
  );

  return (
    <div className="lesson-page min-h-[60dvh]" data-bar-hidden={barHidden} data-outline={showOutline ? "" : undefined}>
      {/* 浏览器标签页标题：第 N 篇：课文标题 | Bloom（课文标题取自课文列表，没有就只写第 N 篇） */}
      <DocumentTitle title={`${tabTitle} | Bloom`} />
      {/* 阅读页底部是反馈和「生成下一篇」，站点页脚会打断它（课文打不开的整页提示里有页脚） */}
      <HideFooter />
      <style>{HIGHLIGHT_CSS}</style>
      <LessonBar
        courseId={courseId}
        courseName={course?.name}
        label={lessonLabel}
        badge={lessonBadge}
        hidden={barHidden}
        onReveal={revealBar}
        onOpenNav={() => setShowMobileNav(true)}
        navOpen={showMobileNav}
        onEdit={canEditText && !editing ? () => setEditing(true) : undefined}
        textSize={!isPdf}
      />
      {canManageFiles && (
        <>
          <RenameFileDialog courseId={courseId} file={renameTarget} onClose={() => setRenameTarget(null)} onRenamed={fileRenamed} />
          <DeleteFileDialog courseId={Number(courseId)} file={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={fileDeleted} />
        </>
      )}

      <div data-learn-page className="relative mx-auto w-full max-w-6xl px-4 pb-24 pt-8 sm:px-6 sm:pt-10 lg:px-8">
        {/* 宽屏左边的目录（learn.css 的 [data-outline] 让出位置）；改文件时正文藏起来了，目录也先收掉，位置留着不让页面左右跳 */}
        {sectionEntries.length > 0 && <LessonOutline entries={sectionEntries} active={sections.active} onJump={sections.jump} />}
        <LearnColumns
          rail={
            // 右栏：桌面常驻——平时是课文导航（吸顶），打开划线提问时让位给提问卡片，卡片顶部对齐被问的那一段；
            // 手机 / 平板上这里什么都不占，提问卡片是固定在屏幕底部的抽屉，课文列表在面包屑条的抽屉里。
            <>
              <div
                ref={railRef}
                className={cn("learn-rail hidden lg:block", panelOpen && "lg:hidden")}
              >
                <div className="mb-4"><LessonChatEntry variant="rail" onOpen={openChat} started={chat.turns.length > 0} /></div>
                <div className="mb-6"><TeachingStyleControl prominent disabled={generating || streaming || styleBusy} onBusy={setStyleBusy} /></div>
                {/* 目录有了就先显示（服务端带来的）：我的提问、标记、译文随后补进来 */}
                {detailsReady || lessonItems.length ? <LessonNav {...navProps} scrollRef={railRef} visible={!panelOpen} /> : <Skeleton className="h-36" />}
              </div>

              {panelOpen && !sourceOpen && (
                <div
                  ref={panelAreaRef}
                  // 区域向上伸出容器的上内边距（pt-10）、向下伸出下内边距（pb-24），卡片的吸附范围才够到页面最顶 / 最底
                  className="relative lg:-mb-24 lg:-mt-10 lg:flex lg:flex-1 lg:flex-col"
                  // --panel-offset：顶上那一组目录（收起时是一行 44px，展开时再加上列表；再加下面空的 12px）占的高度，卡片的吸附线要再让出它，
                  // 吸附到顶也压不到它；由下面的 useLayoutEffect 量出来设上（展开 / 收起时跟着变，卡片被推下去、最大高度跟着缩）。
                  // --panel-slack：页面滚到最顶时右栏顶（顶栏 + 面包屑条之下 40px）比吸附线（再下 16px）低 24px，卡片最高能到的位置也低这么多，
                  // 卡片的最大高度再扣掉它，页面在最顶时卡片底边也在视口之内
                  style={{ "--panel-top": `${panelTop}px`, "--panel-slack": "1.5rem" } as CSSProperties}
                >
                  {/* 问答卡片打开时，课文目录不消失：收成右栏顶上的一行「课文 · 第 N 篇」，点开原位展开，把卡片往下推。
                      这一行和卡片一样吸顶（顶栏 + 面包屑条之下），所以课文读到中段、页面滚了很远，它也还在视口里；
                      区域向上伸出了 40px（见上），这一行用 mt-10 放回右栏本来的顶部，下面空 12px */}
                  <div
                    ref={navGroupRef}
                    className="sticky top-[calc(var(--header-height)+var(--rail-offset,0px)+1rem)] z-30 mb-3 hidden lg:mt-10 lg:block"
                  >
                    <CollapsedNav {...navProps} />
                  </div>
                  {/* 卡片和它前面的占位放在目录行下面的内层容器里：sticky 的卡片只在自己的容器里挪，容器从目录行下方开始，
                      所以卡片不管吸顶还是吸底都到不了目录行（目录行自己也吸顶，页面滚得再远两者都在视口里） */}
                  <div className="lg:flex-1">
                    {/* 占位：把卡片顶部推到被问的那一段旁边（--panel-top 是卡片相对区域顶的位置，减掉目录行占的 40 + 56px）。
                        放在卡片前面当兄弟（不是 padding），卡片向上吸附时才能越过原位 */}
                    <div aria-hidden="true" className="hidden lg:block lg:h-[calc(var(--panel-top)-6rem)]" />
                    {annotationCards}
                  </div>
                </div>
              )}
            </>
          }
        >
          <div className="mb-5 lg:hidden"><TeachingStyleControl prominent disabled={generating || streaming || styleBusy} onBusy={setStyleBusy} /></div>
          {sourceOpen && annotationCards}
          {lengthNote && <QuietNotice className="mb-4" message={lengthNote} onClose={() => setLengthNote("")} />}
          {backgroundError && <QuietNotice className="mb-4" message={backgroundError} onClose={() => setBackgroundError("")} />}
          {openedError && <QuietNotice className="mb-4" message={openedError} onClose={() => setOpenedError("")} />}

          {/* 第一次读时提示怎么划线提问（关掉后不再出现） */}
          <AskHint />

          {/* PDF 阅读版（实验）：自动转换的，说明可能有出入，附原 PDF */}
          {lesson?.is_source && isPdfReadingName(lesson.source_filename) && <PdfReadingNotice courseId={courseId} lessonNum={lessonNum} />}

          {/* 资料文件、PDF 的预计阅读时间（AI 课文标题下自己写着，不重复） */}
          {lesson && !editing && <ReadingTime content={lesson.content} />}

          {/* 课文 */}
          <article
            ref={contentRef}
            onMouseUp={handleTextSelect}
            // 悬浮到标记上显示删除按钮；选字气泡开着、或者正在选字时不打扰
            onMouseMove={(e) => {
              if (marker || composer) return;
              const sel = window.getSelection();
              if (sel && !sel.isCollapsed) return;
              showMarkBadgeUnder(e.clientX, e.clientY);
            }}
            onMouseLeave={() => {
              cancelAnimationFrame(hoverFrameRef.current);
              hideMarkBadgeSoon();
            }}
            className={cn(
              "relative",
              // clip 而不是 hidden：hidden 会让 PDF 的缩放按钮只贴在这个框里，跟着窗口滚的时候贴不住屏幕底部
              isPdf && "overflow-clip rounded-xl border bg-card"
            )}
          >
            {course?.mode === "source" && !isProject && <div className="mb-6"><SourceMaterial courseId={courseId} onOpenChange={setSourceOpen} /></div>}
            {isPdf ? (
              <PdfViewer
                courseId={courseId}
                lessonNum={lessonNum}
                highlights={pdfHighlights}
                onSelect={handlePdfSelect}
                onOpenHighlight={(id) => {
                  // 译文：点虚线打开（开着的再点一下收起）
                  if (String(id).startsWith(TRANSLATION_PREFIX)) {
                    // 存下来的是数字 id，还在写的是 run key
                    const rest = String(id).slice(TRANSLATION_PREFIX.length);
                    const tid = rest.startsWith("run-") ? rest : Number(rest);
                    if (openTranslationId === tid) closeTranslation();
                    else openTranslationCard(tid);
                    return;
                  }
                  // 标记：滚到 PDF 里那一段（「我的标记」从页面底部搬到右栏了）
                  if (String(id).startsWith(MARK_PREFIX)) jumpToMark(Number(String(id).slice(MARK_PREFIX.length)));
                  else openSession(id);
                }}
                onHighlightTops={handlePdfHighlightTops}
                onClearSelection={clearPendingSelection}
              />
            ) : (
              <>
              {editing && lesson && (
                <LessonEditor
                  courseId={courseId}
                  number={lesson.number}
                  filename={lesson.source_filename || `${lesson.number}.md`}
                  content={lesson.content}
                  onCancel={() => setEditing(false)}
                  onSaved={(saved) => {
                    setEditing(false);
                    setLesson((prev) => (prev ? { ...prev, ...saved } : prev));
                    fileRenamed({ number: lesson.number, source_filename: saved.source_filename });
                    // 找不到原文的划线后端已经不再按旧位置画：重取划线和标记
                    setDetailsAttempt((n) => n + 1);
                    setHighlightsAttempt((n) => n + 1);
                  }}
                />
              )}
              {/* 编辑时正文先藏起来不卸掉：划线、提问气泡都挂在它上面 */}
              <div
                ref={proseRef}
                hidden={editing}
                className="prose prose-bloom prose-lesson max-w-none"
              >
                {/* 原文篇（上传的资料、项目课的文件）是学生自己的文字，不做中文排版。是原文篇还是项目文件要等课程信息回来才分得清，先不渲染，免得排版闪一下 */}
                {isSourceLesson && !course ? (
                  <Skeleton className="h-40 w-full" />
                ) : (
                  <Markdown {...markdownOptions} sectionIds title={course?.name}>
                    {lesson?.content}
                  </Markdown>
                )}
              </div>
              </>
            )}

            {/* 选中文字后冒出的「提问」气泡：紧挨着选中的字（lib/learn/bubble.ts），默认在选区第一行的正上方（底下小三角），
                被顶栏挡住时在最后一行的正下方（顶上小三角） */}
            {marker && (
              <div
                ref={bubbleRef}
                onMouseUp={(e) => e.stopPropagation()}
                role="group" aria-label={t("lesson.selectionActions")}
                style={{ top: marker.bubble.top, left: marker.bubble.left, "--arrow": `${marker.bubble.arrow}px` } as CSSProperties}
                data-bubble={marker.bubble.mode}
                className={cn(
                  // 小三角对准选中的字（贴边时气泡被挪过，见 bubble.ts 的 arrow），但不跑出气泡两头的圆角
                  "ann-in absolute z-20 inline-flex h-8 -translate-x-1/2 items-center justify-center gap-0 whitespace-nowrap rounded-full bg-primary px-1 text-[13px] font-medium text-primary-foreground shadow-md transition-colors before:absolute before:left-[clamp(18px,calc(50%_+_var(--arrow)),calc(100%_-_18px))] before:size-2 before:-translate-x-1/2 before:rotate-45 before:rounded-[1px] before:bg-primary hover:bg-primary-hover hover:before:bg-primary-hover",
                  marker.bubble.mode === "above" ? "before:-bottom-1" : "before:-top-1"
                )}
              >
                {/* 「标记」点了立刻画上、气泡收起，后台再存（savePassageHighlight） */}
                <button type="button" onClick={openComposerFromMarker} className="h-8 rounded-full px-1.5 hover:bg-primary-hover">{t("common.ask")}</button>
                <button type="button" onClick={savePassageHighlight} className="inline-flex h-8 items-center gap-1 rounded-full px-1.5 hover:bg-primary-hover">{t("lesson.mark")}</button>
                {/* 选中的是外文：多一个「翻译」 */}
                {marker.foreign && (
                  <button type="button" onClick={() => startTranslation(marker)} className="inline-flex h-8 items-center justify-center rounded-full px-1.5 hover:bg-primary-hover">
                    {t("lesson.translate")}
                  </button>
                )}
              </div>
            )}

            {/* 已有划线问答：页边的圆点（可点区域 28px），点它打开那条问答；卡片开着的那条放大。
                再点一次同一颗圆点就收起卡片——开着的时候不该只能跑到卡片右上角去点 × */}
            {/* 编辑文件时正文藏起来了，圆点也不显示 */}
            {!editing && sessions.map((s) => (
              <button
                key={`dot-${s.id}`}
                type="button"
                onClick={() => (openId === s.id ? closePanel() : openSession(s.id))}
                onMouseUp={(e) => e.stopPropagation()}
                title={openId === s.id ? t("lesson.minimize") : t("lesson.viewSession")}
                aria-label={openId === s.id ? t("lesson.minimize") : t("lesson.openSession", { question: s.comment })}
                aria-pressed={openId === s.id}
                className={cn(
                  // 页边的圆点贴着视口右缘（手机上更近）：轮廓收进圆点里（-outline-offset-2），不被 main 的 overflow-x-clip 截掉
                  "group/dot absolute z-10 flex size-6 items-center justify-center rounded-full focus-visible:-outline-offset-2 lg:size-7",
                  dot
                )}
                style={{ top: dotTops.get(s.id) }}
              >
                <span
                  className={cn(
                    "rounded-full bg-ring ring-4 transition-transform group-hover/dot:scale-125",
                    openId === s.id ? "size-3.5 ring-ring/40" : "size-3 ring-ring/20"
                  )}
                />
              </button>
            ))}

            {/* 存下来的译文：空心圆点（问答是实心的），点它打开译文，开着的再点一下收起；还在写的圆点在闪，点开接着看 */}
            {!editing && [
              ...translations.map((tr) => ({ ref: tr.id as number | string, quote: tr.original_text, running: false })),
              ...translateRuns.map((run) => ({ ref: run.key as number | string, quote: run.place!.original_text, running: true })),
            ].map(({ ref, quote, running }) => {
              const id = `${TRANSLATION_PREFIX}${ref}`;
              const open = openTranslationId === ref;
              return (
                <button
                  key={`dot-${id}`}
                  type="button"
                  onClick={() => (open ? closeTranslation() : openTranslationCard(ref))}
                  onMouseUp={(e) => e.stopPropagation()}
                  title={open ? t("lesson.minimize") : running ? t("lesson.translating") : t("lesson.viewTranslation")}
                  aria-label={open ? t("lesson.minimize") : t("lesson.openTranslation", { text: quote.slice(0, 40) })}
                  aria-pressed={open}
                  className={cn(
                    "group/dot absolute z-10 flex size-6 items-center justify-center rounded-full focus-visible:-outline-offset-2 lg:size-7",
                    dot
                  )}
                  style={{ top: dotTops.get(id) }}
                >
                  <span
                    className={cn(
                      "rounded-full border-2 border-ring bg-background ring-4 transition-transform group-hover/dot:scale-125",
                      open ? "size-3.5 ring-ring/40" : "size-3 ring-ring/20",
                      running && "motion-safe:animate-pulse"
                    )}
                  />
                </button>
              );
            })}

            {/* 标记的删除按钮：悬浮（触屏点一下）到标记上时贴在那一行末尾 */}
            {markBadge && (
              <button
                ref={badgeRef}
                type="button"
                // 按下时不抢走选区、不触发课文里的选中处理；松开也拦一下，免得走到 handleTextSelect
                onMouseDown={(e) => e.preventDefault()}
                onMouseUp={(e) => e.stopPropagation()}
                onClick={() => removePassageHighlight(markBadge.id)}
                title={t("lesson.unmark")}
                aria-label={t("lesson.unmark")}
                style={{ top: markBadge.top, left: markBadge.left }}
                className="absolute z-20 flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-colors hover:border-destructive hover:text-destructive"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </article>

          {/* 反馈：卡片；「下一步」另起一块 */}
          {/* 问答、反馈、课文列表还在取：转圈写明在加载；取不到只给「重试」（不能关掉：没有它们下面的反馈和提问都用不了） */}
          {!detailsReady && <div className="mt-8">
            {detailsError ? <LessonNotice message={detailsError}>
              <button type="button" className="text-sm underline" onClick={() => setDetailsAttempt(n => n + 1)}>{t("common.retry")}</button>
            </LessonNotice> : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="text-primary-text" />{t("lesson.detailsLoading")}</p>}
          </div>}
          <fieldset disabled={!detailsReady} className="mt-14 min-w-0 space-y-6 border-0 p-0">
            {highlightsError && <QuietNotice message={highlightsError}>
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setHighlightsAttempt((n) => n + 1)}>{t("common.retry")}</button>
            </QuietNotice>}
            {lesson?.teaching_plan && <p className="border-l-2 border-ring pl-3 text-sm text-muted-foreground">
              {t("teaching.planLine", { action: t(`teaching.action.${lesson.teaching_plan.action}`), focus: lesson.teaching_plan.focus })}
            </p>}
            {course && !isProject && (
              <FeedbackCard
                content={feedbackContent}
                onContentChange={(value) => {
                  setFeedbackContent(value);
                  setFeedbackDirty(true);
                  setFeedbackSaved(false);
                }}
                thoughts={thoughtAnswers}
                onThoughtsChange={(value) => {
                  setThoughtAnswers(value);
                  setFeedbackDirty(true);
                  setFeedbackSaved(false);
                }}
                showThoughts={!isSourceLesson}
                saved={feedbackSaved}
                saving={submittingFeedback}
                disabled={generating}
                onSave={handleSubmitFeedback}
              >
              <TeachingFeedback courseId={courseId} scope={feedbackScope}
                onScopeChange={(value) => { setFeedbackScope(value); setFeedbackSaved(false); setFeedbackDirty(true); }}
                refreshKey={feedbackSaved} disabled={generating || submittingFeedback} />
              </FeedbackCard>
            )}

            {/* 通用错误：可关闭，不带任何会调模型的动作 */}
            {error && <LessonNotice message={error} onClose={() => setError("")} />}

            {/* 生成下一篇失败：重试就是再调一次生成接口 */}
            {nextError && (
              <LessonNotice message={nextError} onClose={() => setNextError("")}>
                {action.kind === "generate" && (
                  // 重试前先确认上一次没有在后台存好新课文（handleRetryNext），确认没有才生成
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRetryNext}
                    loading={checkingNext}
                    disabled={checkingNext || streaming}
                  >
                    {checkingNext ? t("lesson.next.checking") : t("common.retry")}
                  </Button>
                )}
              </LessonNotice>
            )}


            {/* 下一步 / 生成下一篇的流式预览 */}
            {isProject ? (
              <MarkReadStep
                read={readSaved}
                marking={markingRead}
                onMarkRead={handleMarkRead}
                hint={markReadHint}
              />
            ) : generating ? (
              <GeneratingCard ref={streamRef} content={streamContent} />
            ) : action.kind === "go" ? (
              <GoNextStep
                href={`/learn/course/${courseId}/lesson/${action.lessonNumber}`}
              />
            ) : action.kind === "generate" ? (
              <GenerateStep
                label={generateLabel}
                onReadDone={handleReadDone}
                blockedReason={streaming ? t("lesson.next.waitAnswer") : undefined}
              />
            ) : null}
          </fieldset>
        </LearnColumns>
      </div>

      {selectionNote && (
        <p role="alert" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg border bg-card px-4 py-3 text-center text-sm text-card-foreground shadow-md">
          {selectionNote}
        </p>
      )}

      {/* 手机 / 平板（和参考原文面板开着的桌面）右下角的「问这篇」：有卡片或抽屉开着、正在改文件时不出现 */}
      {!panelOpen && !editing && !showMobileNav && (
        <LessonChatEntry variant="fab" onOpen={openChat} raised={isPdf} desktop={sourceOpen} />
      )}

      <ChapterDrawer
        {...navProps}
        open={showMobileNav}
        onOpenChange={setShowMobileNav}
      />
    </div>
  );
}
