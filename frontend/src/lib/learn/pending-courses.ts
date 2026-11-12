// 「正在生成」的课程。建课是一次要等几十秒的请求，课程要到生成完才出现在列表里。
// 提交时在本地记一条，「我的课程」顶部就能显示一张「正在生成」卡片，
// 刷新、离开再回来、关掉标签再打开都还在，课程出现后自动消失。
// 服务端没有「生成中」这个状态，所以课程是否出现只能靠列表判断（settlePending）。

// source 是已下线的「我的资料」建课；保留它，本地还存着的旧记录照样能读、能显示
export type PendingKind = "topic" | "materials" | "source" | "project" | "pdf";

export interface PendingCourse {
  id: string;
  // 用户填的课名；资料课、项目课可以留空（后端用文件名生成），此时为空
  name: string;
  kind: PendingKind;
  startedAt: number;
  // 提交时已经存在的课程 id：这些不可能是这次生成出来的
  known: number[];
  // 请求没收到应答：提示刷新任务状态。
  unconfirmed?: boolean;
  // 结果未确认的具体原因（后端 detail 或网络错误），卡片上原样显示
  reason?: string;
  // known 是在课程列表加载完之后记的吗？没加载完就提交（?new=1 直接开对话框、从推荐开课时列表还没回来），known 是空的，
  // 没填课名的记录会把别的课认领走；所以这种记录先不结算，等列表加载完再按「提交之前就有的课程」补出 known
  knownReady?: boolean;
}

// 超过这个时间还没出现，就不再说「正在生成」，改成「结果未确认」。按建课方式分：资料 / 原文 / 项目课后端最长要跑十几分钟
// （资料解析总时限 MATERIAL_TOTAL_TIMEOUT_SECONDS 默认 720 秒），主题课也可能要好几分钟
export const PENDING_STALE_MS: Record<PendingKind, number> = {
  topic: 10 * 60_000,
  materials: 15 * 60_000,
  source: 15 * 60_000,
  project: 15 * 60_000,
  // PDF 阅读版逐页转换，后端总时限 PDF_READING_TIMEOUT_SECONDS 默认 600 秒
  pdf: 15 * 60_000,
};
// 超过一天的记录直接丢掉
export const PENDING_FORGET_MS = 24 * 60 * 60_000;
// 本机时钟可能比服务器快一点：课程的 created_at 允许比提交时间早这么多
const CLOCK_SLACK_MS = 2 * 60_000;
const MAX_PENDING = 5;

export const pendingStorageKey = (userId: string) => `bloom:pending-courses:${userId}`;

export const normalizeCourseName = (name: string) => name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

// 隔多久看一次课程列表：在生成时每 5 秒；「等得有点久」之后每 60 秒、最多再查 30 分钟，之后不再查（卡片和重试入口还留着）；没有记录就不查
export const POLL_RUNNING_MS = 5_000;
export const POLL_STALLED_MS = 60_000;
export const POLL_STALLED_WINDOW_MS = 30 * 60_000;

export function pollIntervalMs(list: PendingCourse[], now = Date.now()): number | null {
  if (list.some((item) => pendingState(item, now) === "running")) return POLL_RUNNING_MS;
  if (list.some((item) => now - item.startedAt < staleAfter(item) + POLL_STALLED_WINDOW_MS)) return POLL_STALLED_MS;

  return null;
}

const staleAfter = (item: Pick<PendingCourse, "kind">) => PENDING_STALE_MS[item.kind];

// 没收到应答（unconfirmed）不等于没在生成：请求可能已经到了后端、正在跑。和正常提交一样，等满这种建课方式的最长时间
// 之前都算 running（每 5 秒查一次列表、不给「重新创建」），免得用户在第一次还在生成时又建一门、扣两次费
export function pendingState(item: Pick<PendingCourse, "kind" | "startedAt">, now = Date.now()): "running" | "stalled" {
  return now - item.startedAt >= staleAfter(item) ? "stalled" : "running";
}

const KINDS = Object.keys(PENDING_STALE_MS) as PendingKind[];

// 读出来的东西不可信（别的版本写的、被手改过）：字段不对的整条丢掉
export function parsePending(raw: string | null, now = Date.now()): PendingCourse[] {
  if (!raw) return [];

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out: PendingCourse[] = [];
  for (const entry of data) {
    const item = entry as Partial<PendingCourse> | null;
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      !KINDS.includes(item.kind as PendingKind) ||
      typeof item.startedAt !== "number" ||
      !Number.isFinite(item.startedAt) ||
      !Array.isArray(item.known) ||
      !item.known.every((id) => typeof id === "number")
    ) {
      continue;
    }
    if (now - item.startedAt > PENDING_FORGET_MS) continue;
    out.push({
      id: item.id,
      name: item.name,
      kind: item.kind as PendingKind,
      startedAt: item.startedAt,
      known: item.known,
      ...(item.unconfirmed === true && { unconfirmed: true }),
      ...(typeof item.reason === "string" && item.reason && { reason: item.reason }),
      ...(item.knownReady === false && { knownReady: false }),
    });
  }

  return out.slice(-MAX_PENDING);
}

export const serializePending = (list: PendingCourse[]) => JSON.stringify(list.slice(-MAX_PENDING));

export function addPending(list: PendingCourse[], item: PendingCourse): PendingCourse[] {
  return [...list.filter((existing) => existing.id !== item.id), item].slice(-MAX_PENDING);
}

export const removePending = (list: PendingCourse[], id: string) => list.filter((item) => item.id !== id);

// 课程列表里出现了提交之后才有的新课程，就认为是这一次生成的。
// 有课名的记录只认同名的新课程（主题课、资料课的课名后端原样存）；没填课名的（上传原文、项目文件，后端用文件名生成）
// 认不出名字，按先后顺序配给剩下的新课程。认领过的课程记进剩下记录的 known，以后谁也不会再认领它。
export function settlePending(
  list: PendingCourse[],
  courses: { id: number; name: string; created_at: string }[],
  now = Date.now()
): { remaining: PendingCourse[]; settled: { pending: PendingCourse; courseId: number }[] } {
  // 列表没加载完就提交的记录：现在列表有了，把一分钟之前就有的课程记成 known（留一分钟余量给本机和服务器的时钟差）
  list = list.map((item) =>
    item.knownReady === false
      ? {
          ...item,
          known: courses.filter((course) => Date.parse(course.created_at) < item.startedAt - 60_000).map((course) => course.id),
          knownReady: true,
        }
      : item
  );
  const claimed = new Set<number>();
  const settledBy = new Map<string, number>();
  const ordered = [...list].sort((a, b) => a.startedAt - b.startedAt);
  const fresh = (item: PendingCourse) =>
    courses
      .filter((course) => {
        if (claimed.has(course.id) || item.known.includes(course.id)) return false;
        const created = Date.parse(course.created_at);

        return Number.isFinite(created) && created >= item.startedAt - CLOCK_SLACK_MS;
      })
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  for (const item of ordered) {
    const name = normalizeCourseName(item.name);
    if (!name) continue;
    const hit = fresh(item).find((course) => normalizeCourseName(course.name) === name);
    if (hit) {
      claimed.add(hit.id);
      settledBy.set(item.id, hit.id);
    }
  }
  for (const item of ordered) {
    if (settledBy.has(item.id) || normalizeCourseName(item.name)) continue;
    const hit = fresh(item)[0];
    if (hit) {
      claimed.add(hit.id);
      settledBy.set(item.id, hit.id);
    }
  }

  const claimedIds = [...claimed];

  return {
    remaining: list
      .filter((item) => !settledBy.has(item.id) && now - item.startedAt <= PENDING_FORGET_MS)
      .map((item) => (claimedIds.length > 0 ? { ...item, known: [...item.known, ...claimedIds] } : item)),
    settled: ordered.filter((item) => settledBy.has(item.id)).map((item) => ({ pending: item, courseId: settledBy.get(item.id)! })),
  };
}

// 别的路径（对话框里建课成功）建出了这门课：让所有还在等的记录都知道它不是自己的
export const withKnownCourse = (list: PendingCourse[], courseId: number): PendingCourse[] =>
  list.map((item) => (item.known.includes(courseId) ? item : { ...item, known: [...item.known, courseId] }));

// 新建对话框里：这个课名是不是正有一门在生成。课名留空的（后端用文件名生成）认不出来
export function runningWithName(list: PendingCourse[], name: string, now = Date.now()): PendingCourse | undefined {
  const wanted = normalizeCourseName(name);
  if (!wanted) return undefined;

  return list.find((item) => pendingState(item, now) === "running" && normalizeCourseName(item.name) === wanted);
}

// 已等了多久：{ minutes, seconds }，不足一分钟 minutes 为 0
export function elapsedParts(startedAt: number, now = Date.now()) {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));

  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

// 记录变了（同一个标签页里别的组件、已经离开的页面改的）：监听这个事件重读。别的标签页改的走浏览器自带的 storage 事件
export const PENDING_CHANGED_EVENT = "bloom:pending-courses-changed";

// 存储读不了（被禁用）时返回 null：和「读到了、是空的」区分开
export function readPendingStrict(userId: string, now = Date.now()): PendingCourse[] | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;

    return parsePending(storage.getItem(pendingStorageKey(userId)), now);
  } catch {
    return null;
  }
}

export const readPending = (userId: string, now = Date.now()): PendingCourse[] => readPendingStrict(userId, now) ?? [];

export function writePending(userId: string, list: PendingCourse[]): void {
  try {
    if (list.length === 0) globalThis.localStorage?.removeItem(pendingStorageKey(userId));
    else globalThis.localStorage?.setItem(pendingStorageKey(userId), serializePending(list));
  } catch {
    // 浏览器禁用了存储：只在这个页面里有效，刷新后就没了，不影响建课本身
    return;
  }
  globalThis.dispatchEvent?.(new Event(PENDING_CHANGED_EVENT));
}
