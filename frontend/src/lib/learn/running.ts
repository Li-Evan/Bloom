import type { Session } from "@/lib/learn/types";

// 课文页上开始的翻译、划线提问 / 追问、「问这篇」：开始了就写完。点别的、收起卡片都不打断，后端也照样写完、存好。
// 换到别的一篇时课文页整个卸掉重挂（Next 按路由段换 key），请求照常收着，不跟着页面走：
// - 还在写的记在这里（runs），回到那一篇时新挂上的页面接着显示写到哪儿了；
// - 写完的结果交给那时挂在那一篇上的页面（livePage）：一直没离开就是发起的页面，换篇回来的就是新挂上的页面，都不在就不用换

export type RunKind = "translate" | "ask" | "follow" | "chat";

export interface Run {
  key: string;
  // 哪一篇：`${courseId}/${lessonNum}`
  route: string;
  kind: RunKind;
  // 已经收到的字
  text: string;
  // 发起它的页面：那个页面自己显示着它；别的页面（换篇回来新挂上的）照着这里显示
  owner: object;
  // 翻译：划的那一段和它在正文里的位置
  place?: Pick<Session, "original_text" | "position_start" | "position_end" | "anchor_top" | "pdf_position">;
  // 首次提问：页面上那条临时问答
  session?: Session;
  // 追问：哪一条问答
  sessionId?: number;
  // 提问、追问、「问这篇」的问题
  question?: string;
}

const EMPTY: readonly Run[] = [];
let runs: readonly Run[] = EMPTY;
let count = 0;
let frame: ReturnType<typeof setTimeout> | number = 0;
const listeners = new Set<() => void>();
const stops = new Map<string, () => void>();
const pages = new Map<string, () => unknown>();

const raf = typeof requestAnimationFrame === "function";

function notify() {
  if (frame) {
    if (raf) cancelAnimationFrame(frame as number);
    else clearTimeout(frame);
    frame = 0;
  }
  for (const listener of listeners) listener();
}

// 下一帧再通知：收字时每帧最多刷新一次界面；写完时，页面换上结果（setState）那一次渲染已经读到登记撤掉了，
// 不会先单独渲染一次「登记没了、结果还没换上」（回答闪成空白）
function notifySoon() {
  if (frame) return;
  const flush = () => {
    frame = 0;
    for (const listener of listeners) listener();
  };
  frame = raf ? requestAnimationFrame(flush) : setTimeout(flush, 16);
}

// useSyncExternalStore 用
export const subscribeRuns = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const readRuns = () => runs;
export const noRuns = () => EMPTY;

export function startRun(fields: Omit<Run, "key" | "text"> & { stop?: () => void }) {
  const { stop, ...rest } = fields;
  const key = `run-${++count}`;
  runs = [...runs, { ...rest, key, text: "" }];
  if (stop) stops.set(key, stop);
  notify();
  return key;
}

export function appendRun(key: string, chunk: string) {
  if (!runs.some((run) => run.key === key)) return;
  runs = runs.map((run) => (run.key === key ? { ...run, text: run.text + chunk } : run));
  notifySoon();
}

export function finishRun(key: string) {
  if (!runs.some((run) => run.key === key)) return;
  runs = runs.filter((run) => run.key !== key);
  stops.delete(key);
  notifySoon();
}

// 换篇回来的页面上点「停止」：停的是发起的页面开的那个请求
export const stopRun = (key: string) => stops.get(key)?.();

// 课文页挂上时登记自己（part 区分课文页和「问这篇」），卸掉时撤掉；get 每次取最新的那份
export function registerPage(route: string, part: string, get: () => unknown) {
  const id = `${route}#${part}`;
  pages.set(id, get);
  return () => {
    if (pages.get(id) === get) pages.delete(id);
  };
}

export const livePage = <T>(route: string, part: string) => pages.get(`${route}#${part}`)?.() as T | undefined;
