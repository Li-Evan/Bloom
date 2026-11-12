import { api, apiFetch, notifyApiWrite } from "@/lib/api-client";
import { uploadCourseFiles, discardUpload } from "@/lib/learn/upload";
import { readAnnotationStream, streamNextLesson } from "@/lib/learn/stream";
import type { ChatTurn } from "@/lib/learn/lesson-chat";
import type {
  AddedLessons,
  Annotation,
  Calendar,
  CompletedResult,
  Course,
  CourseLanguage,
  FeedbackState,
  GlobalStats,
  Lesson,
  LessonItem,
  NextLessonDone,
  PassageTranslation,
  Recommendation,
  RecommendationDashboard,
} from "@/lib/learn/types";

const post = <T>(path: string, json?: unknown) =>
  api<T>(path, { method: "POST", json });

export type GoalAnswer = { question: string; answer: string };
export type LearningIntent = { goal: string; summary: string; assumptions: string[]; answers: GoalAnswer[] };
export type GoalAnalysis = { title: string; summary: string; assumptions: string[]; questions: { question: string; options: string[] }[] };

export const clarifyCourseGoal = (input: {
  goal: string; learning_depth: string; language: string; reference_excerpt: string;
  material_names: string[]; answers: GoalAnswer[]; skip_questions: boolean;
}, signal?: AbortSignal) => api<GoalAnalysis>("/api/courses/clarify", { method: "POST", json: input, signal });

const createInit = (init: RequestInit & { json?: unknown }) => ({ method: "POST", ...init });

// --- Courses ---

export const getCourses = (fresh = false) => api<Course[]>("/api/courses", fresh ? { cache: "no-store" } : undefined);

export const getCourse = (courseId: string | number, fresh = false) =>
  api<Course>(`/api/courses/${courseId}`, fresh ? { cache: "no-store" } : undefined);

// language 是课程语言（课文、大纲、提问的回答都用它），建课时定下、之后不变；不传就由后端用默认值（zh）
export const createCourse = (
  name: string,
  reference = "",
  learningDepth = "standard",
  language?: CourseLanguage,
  learningIntent?: LearningIntent,
) => api<Course>(
  "/api/courses",
  createInit({
    json: {
      name,
      reference,
      learning_depth: learningDepth,
      ...(learningIntent && { learning_intent: learningIntent }),
      ...(language && { language }),
    },
  }),
);

export async function createCourseFromMaterials(
  name: string,
  reference: string,
  files: File[],
  learningDepth = "standard",
  language?: CourseLanguage,
  learningIntent?: LearningIntent,
  onProgress?: (sent: number, total: number) => void,
) {
  const formData = new FormData();
  formData.append("name", name);
  formData.append("learning_depth", learningDepth);
  if (language) formData.append("language", language);
  formData.append("reference", reference || "");
  if (learningIntent) formData.append("learning_intent", JSON.stringify(learningIntent));
  const uploadId = await uploadCourseFiles(files, onProgress);
  formData.append("upload_id", uploadId);

  try {
    return await api<Course>("/api/courses/from-materials", createInit({ body: formData }));
  } finally { void discardUpload(uploadId); }
}

// 上传一个或多个文件 / 整个文件夹作为「项目」：每个文件直接渲染、可随时划线提问。
export async function createProjectCourse(
  name: string,
  files: File[],
  language?: CourseLanguage,
  onProgress?: (sent: number, total: number) => void,
) {
  const formData = new FormData();
  formData.append("name", name);
  if (language) formData.append("language", language);
  const uploadId = await uploadCourseFiles(files, onProgress);
  formData.append("upload_id", uploadId);

  try {
    return await api<Course>("/api/courses/from-project", createInit({ body: formData }));
  } finally { void discardUpload(uploadId); }
}

// PDF 阅读版（实验）：每个 PDF 逐页转成能重排的 Markdown，建成一门项目课，每个 PDF 一篇。
export async function createPdfReadingCourse(
  name: string,
  files: File[],
  language?: CourseLanguage,
  onProgress?: (sent: number, total: number) => void,
) {
  const formData = new FormData();
  formData.append("name", name);
  if (language) formData.append("language", language);
  const uploadId = await uploadCourseFiles(files, onProgress);
  formData.append("upload_id", uploadId);

  try {
    return await api<Course>("/api/courses/from-pdf-reading", createInit({ body: formData }));
  } finally { void discardUpload(uploadId); }
}

export const deleteCourse = (courseId: number) =>
  api<{ ok: boolean }>(`/api/courses/${courseId}`, { method: "DELETE" });

export const renameCourse = (courseId: string | number, name: string) =>
  api<{ id: number; name: string }>(`/api/courses/${courseId}`, { method: "PATCH", json: { name } });

// 资料类课程（项目文件、网页原文、PDF 阅读版建的课）像文件夹：一个文件可以移到另一门，或新建一门放进去
export const moveLesson = (
  courseId: string | number,
  lessonNum: number,
  target: { target_course_id: number } | { new_course_name: string },
) => post<{ course_id: number; course_name: string; number: number }>(`/api/courses/${courseId}/lessons/${lessonNum}/move`, target);

// 资料类课程的一个文件：改名（name 只是文件名，扩展名和所在文件夹不变）和 / 或改正文（Markdown）
export const editLesson = (courseId: string | number, lessonNum: number, changes: { name?: string; content?: string }) =>
  api<{ number: number; source_filename: string | null }>(`/api/courses/${courseId}/lessons/${lessonNum}`, {
    method: "PATCH", json: changes,
  });

// 归档 / 取消归档资料类课程里的一个文件：归档的收进课程页的「已归档」，不算已读进度；返回这门课新的状态和进度。
// 一个接一个发：连着点「归档」「撤销」时后端按点的顺序改，不会后发先至
let archiving: Promise<unknown> = Promise.resolve();
export function setLessonArchived(courseId: string | number, lessonNum: number, archived: boolean) {
  const request = archiving.then(() =>
    api<{ number: number; is_archived: boolean; status: string; mastery_covered: number; mastery_total: number; mastery_progress: number }>(
      `/api/courses/${courseId}/lessons/${lessonNum}/archived`, { method: "PUT", json: { archived } }));
  archiving = request.catch(() => undefined);
  return request;
}

// 删掉资料类课程里的一个文件：划线、提问、已读记录一起删掉
export const deleteLesson = (courseId: string | number, lessonNum: number) =>
  api<{ ok: boolean }>(`/api/courses/${courseId}/lessons/${lessonNum}`, { method: "DELETE" });

// 浏览器插件交来的网页存进「网页剪藏」（第一次剪时建这门课，language 只在那时用上）；同一网页剪过就返回原来那篇
export const clipPage = (url: string, html: string, language: CourseLanguage) =>
  post<{ course_id: number; lesson_number: number; existed: boolean }>("/api/clippings", { url, html, language });

// 往项目文件、网页原文、PDF 阅读版建的课里再加资料：files 和建课时一样每个文件一篇（网页正文存成一个 Markdown 文件），
// pdf 是 PDF 阅读版
export async function addCourseMaterials(
  courseId: string | number,
  kind: "files" | "web" | "pdf",
  files: File[],
  onProgress?: (sent: number, total: number) => void,
) {
  const formData = new FormData();
  const uploadId = await uploadCourseFiles(files, onProgress);
  formData.append("upload_id", uploadId);
  try {
    return await api<AddedLessons>(
      `/api/courses/${courseId}/${kind === "pdf" ? "pdf-reading" : "files"}`,
      createInit({ body: formData }),
    );
  } finally { void discardUpload(uploadId); }
}

// --- Lessons ---

export const getLessons = (courseId: string | number, fresh = false) =>
  api<LessonItem[]>(`/api/courses/${courseId}/lessons`, fresh ? { cache: "no-store" } : undefined);

export const getLesson = (
  courseId: string | number,
  lessonNum: string | number
) => api<Lesson>(`/api/courses/${courseId}/lessons/${lessonNum}`);

// signal：换了课文、关掉了页面就中止下载（PDF 可能有几十 MB）
export async function getLessonFile(
  courseId: string | number,
  lessonNum: string | number,
  signal?: AbortSignal
) {
  const res = await apiFetch(
    `/api/courses/${courseId}/lessons/${lessonNum}/file`,
    { signal }
  );
  return res.arrayBuffer();
}

// --- Annotations ---

const annotationsPath = (
  courseId: string | number,
  lessonNum: string | number
) => `/api/courses/${courseId}/lessons/${lessonNum}/annotations`;

// fresh：不走缓存（停止提问之后去拉后端后台写完的回答，缓存里是旧的）
export const getAnnotations = (
  courseId: string | number,
  lessonNum: string | number,
  fresh = false
) => api<Annotation[]>(annotationsPath(courseId, lessonNum), fresh ? { cache: "no-store" } : undefined);

export type AnnotationDone = { annotation: Annotation };

// 划线提问：回答经 onChunk 流式到达，最终的批注经 onDone 交付。
export async function createAnnotation(
  courseId: string | number,
  lessonNum: string | number,
  data: unknown,
  onChunk: (text: string) => void,
  onDone: (data: AnnotationDone) => void,
  signal: AbortSignal
) {
  const res = await apiFetch(annotationsPath(courseId, lessonNum), {
    method: "POST",
    json: data,
    signal,
  });
  try { await readAnnotationStream<AnnotationDone>(res, onChunk, onDone); }
  finally { notifyApiWrite(annotationsPath(courseId, lessonNum)); }
}

const translationsPath = (courseId: string | number, lessonNum: string | number) =>
  `/api/courses/${courseId}/lessons/${lessonNum}/translations`;

export const getTranslations = (courseId: string | number, lessonNum: string | number) =>
  api<PassageTranslation[]>(translationsPath(courseId, lessonNum));

// 划线翻译：译文经 onChunk 流式到达，存好的那条经 onDone 交付。同一处选区再翻会换掉旧的。
// 开始了就写完：不跟着卡片、页面断开（lib/learn/running.ts）
export async function createTranslation(
  courseId: string | number,
  lessonNum: string | number,
  data: {
    original_text: string; position_start: number; position_end: number; anchor_top: number; pdf_position: string | null;
    context: string; title: string; target: CourseLanguage;
  },
  onChunk: (text: string) => void,
  onDone: (data: { translation: PassageTranslation }) => void
) {
  const res = await apiFetch(translationsPath(courseId, lessonNum), { method: "POST", json: data });
  try { await readAnnotationStream<{ translation: PassageTranslation }>(res, onChunk, onDone); }
  finally { notifyApiWrite(translationsPath(courseId, lessonNum)); }
}

export const deleteTranslation = (courseId: string | number, lessonNum: string | number, translationId: number) =>
  api(`${translationsPath(courseId, lessonNum)}/${translationId}`, { method: "DELETE" });

// 问这篇：对话存在后端，每篇一份。读、清空，以及把本机旧版存的对话搬进去（库里已有就不动，返回库里那份）
const chatPath = (courseId: string | number, lessonNum: string | number) =>
  `/api/courses/${courseId}/lessons/${lessonNum}/chat`;

export const getLessonChat = (courseId: string | number, lessonNum: string | number) =>
  api<{ messages: ChatTurn[] }>(chatPath(courseId, lessonNum));

export const clearLessonChat = (courseId: string | number, lessonNum: string | number) =>
  api(chatPath(courseId, lessonNum), { method: "DELETE" });

// 只交这次的问题（之前的几轮后端从库里接上），回答经 onChunk 流式到达、答完后端存好；返回完整回答，partial 为真时这次只带上了正在读的那一部分
export async function askAboutLesson(
  courseId: string | number,
  lessonNum: string | number,
  data: { question: string; anchor: string },
  onChunk: (text: string) => void
) {
  const path = chatPath(courseId, lessonNum);
  const res = await apiFetch(path, { method: "POST", json: data });
  const result = { answer: "", partial: false };
  try {
    await readAnnotationStream<{ answer: string; partial: boolean }>(res, onChunk, (done) => {
      result.answer = done.answer;
      result.partial = Boolean(done.partial);
    });
  } finally {
    notifyApiWrite(path);
  }
  return result;
}

// 会话内追问：回答经 onChunk 流式到达，更新后的批注经 onDone 交付。
export async function addAnnotationMessage(
  courseId: string | number,
  lessonNum: string | number,
  annotationId: number,
  content: string,
  onChunk: (text: string) => void,
  onDone: (data: AnnotationDone) => void,
  signal: AbortSignal,
  requestId: string
) {
  const res = await apiFetch(
    `${annotationsPath(courseId, lessonNum)}/${annotationId}/messages`,
    { method: "POST", json: { content, request_id: requestId }, signal }
  );
  try { await readAnnotationStream<AnnotationDone>(res, onChunk, onDone); }
  finally { notifyApiWrite(annotationsPath(courseId, lessonNum)); }
}

// 保存用户中途停止的一轮问答，保留已生成的部分回答，返回存下的批注。
export const saveInterruptedAnnotation = (
  courseId: string | number,
  lessonNum: string | number,
  payload: unknown
) => post<Annotation>(`${annotationsPath(courseId, lessonNum)}/save`, payload);

export const deleteAnnotation = (
  courseId: string | number,
  lessonNum: string | number,
  annotationId: number
) =>
  api<{ ok: boolean }>(
    `${annotationsPath(courseId, lessonNum)}/${annotationId}`,
    {
      method: "DELETE",
    }
  );

// --- Feedback ---

// 空的思考题回答发 ""，不发 null
export const submitFeedback = (
  courseId: string | number,
  lessonNum: string | number,
  content: string,
  thoughtAnswers: string,
  scope: "auto" | "next" | "course" = "auto"
) =>
  post(`/api/courses/${courseId}/lessons/${lessonNum}/feedback`, {
    content,
    thought_answers: thoughtAnswers.trim(),
    scope,
  });

export const getFeedback = (
  courseId: string | number,
  lessonNum: string | number
) =>
  api<FeedbackState>(`/api/courses/${courseId}/lessons/${lessonNum}/feedback`);

// --- Generate next lesson (SSE) ---

export const generateNextLesson = (
  courseId: string | number,
  onChunk: (text: string) => void,
  onDone: (data: NextLessonDone) => void,
  fromLesson?: string | number
) =>
  streamNextLesson<NextLessonDone>(
    (signal) =>
      apiFetch(`/api/courses/${courseId}/next${fromLesson === undefined ? "" : `?from_lesson=${fromLesson}`}`, { method: "POST", signal }),
    onChunk,
    onDone
  ).finally(() => notifyApiWrite(`/api/courses/${courseId}/next`));

// --- Lesson events ---

export const recordLessonOpened = (
  courseId: string | number,
  lessonNum: string | number
) => post(`/api/courses/${courseId}/lessons/${lessonNum}/opened`);

export const markLessonCompleted = (
  courseId: string | number,
  lessonNum: string | number
) =>
  post<CompletedResult>(
    `/api/courses/${courseId}/lessons/${lessonNum}/completed`
  );

// --- Stats / calendar / summary ---

export const getGlobalStats = () => api<GlobalStats>("/api/stats");

export const getCalendar = () => api<Calendar>("/api/calendar");

export const getSummary = (courseId: string | number) =>
  api<{ content: string }>(`/api/courses/${courseId}/summary`);

// --- Recommendations ---

export const getRecommendations = () =>
  api<RecommendationDashboard>("/api/recommendations");

// locale：推荐的标题和理由用哪种语言（界面语言）
export const refreshRecommendations = (locale: CourseLanguage) =>
  post<RecommendationDashboard>("/api/recommendations/refresh", { locale });

export const saveRecommendation = (recommendationId: number) =>
  post<Recommendation>(`/api/recommendations/${recommendationId}/save`);

export const removeSavedRecommendation = (recommendationId: number) =>
  api<{ ok: boolean }>(`/api/recommendations/${recommendationId}/save`, {
    method: "DELETE",
  });

// 不感兴趣：这条推荐不再显示，之后刷新推荐、别的课找相邻方向时都避开它；撤销放回原位
export const dismissRecommendation = (recommendationId: number) =>
  post<{ ok: boolean }>(`/api/recommendations/${recommendationId}/dismiss`);

export const restoreRecommendation = (recommendationId: number) =>
  api<Recommendation>(`/api/recommendations/${recommendationId}/dismiss`, {
    method: "DELETE",
  });

export const startRecommendation = (
  recommendationId: number,
  courseId: number
) =>
  post<Recommendation>(`/api/recommendations/${recommendationId}/start`, {
    course_id: courseId,
  });

// 「下一步学习」首次加载只读不写：没有推荐时也不会自动刷新（刷新要调模型，由用户点击触发）。
export async function loadNextData() {
  const dashboard = await getRecommendations();

  return {
    recommendations: dashboard.recommendations || [],
    saved: dashboard.saved || [],
  };
}

export const updateSyllabus = (courseId: string, content: string) =>
  api<{ content: string }>(`/api/courses/${courseId}/syllabus`, { method: "PUT", json: { content } });
export const regenerateSyllabus = (courseId: string, content: string) =>
  post<{ content: string }>(`/api/courses/${courseId}/syllabus/regenerate`, { content });
export const generateFirstLesson = (courseId: string) =>
  post<Lesson>(`/api/courses/${courseId}/first`);
