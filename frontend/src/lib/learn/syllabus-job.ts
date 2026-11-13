// 大纲页的两个长操作（按想法重新生成、生成第一篇）都是一次阻塞请求，读者中途离开或刷新，后端照样跑完、保存。
// 记在 sessionStorage 里：回到大纲页时接着显示「还在进行」并等结果出现，不把按钮恢复成可点，免得再点一次重复生成、收到 409。
export type SyllabusJob = {
  action: "regenerate" | "start";
  startedAt: number;
  // 发起时的大纲全文：重新生成完成的标志是大纲变了
  syllabus: string;
  // 请求在读者离开后才结束：回到页面时说一句结果（重写好了 / 失败原因）
  done?: boolean;
  error?: string;
};

// 比后端上限（生成第一篇 700 秒、重写大纲 600 秒）再多留一点，过了就不再当作进行中
export const SYLLABUS_JOB_MAX_MS = 13 * 60_000;

const keyOf = (courseId: string) => `bloom:syllabus-job:${courseId}`;

export function readSyllabusJob(courseId: string, now = Date.now()): SyllabusJob | null {
  try {
    const raw = sessionStorage.getItem(keyOf(courseId));
    if (!raw) return null;
    const job = JSON.parse(raw) as SyllabusJob;
    if (now - job.startedAt < SYLLABUS_JOB_MAX_MS) return job;
    sessionStorage.removeItem(keyOf(courseId));
  } catch { /* 浏览器存储不可用：只是回来时看不到进行中，不影响操作本身 */ }
  return null;
}

export function writeSyllabusJob(courseId: string, job: SyllabusJob | null) {
  try {
    if (job) sessionStorage.setItem(keyOf(courseId), JSON.stringify(job));
    else sessionStorage.removeItem(keyOf(courseId));
  } catch { /* 同上 */ }
}
