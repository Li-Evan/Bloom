import { ApiError, api } from "@/lib/api-client";

export interface KnowledgeSource {
  course_id: number;
  course_name: string;
  lesson_number: number;
  lesson_title: string;
  quote: string;
}

export interface KnowledgeNode {
  id: string;
  label: string;
  summary: string;
  domain: string;
  sources: KnowledgeSource[];
}

export interface KnowledgeChunk { lesson_id: number; part_index: number; fingerprint: string }
export interface KnowledgeMap {
  nodes: KnowledgeNode[];
  // 按最近学习排序；read_lessons 是这门课整理范围内的已读篇数（旧后端没有这个字段）
  courses: { id: number; name: string; read_lessons?: number }[];
  read_lessons: number;
  pending_count: number;
  // 暂时整理失败、等着后端重试的分块数
  failed_count: number;
  next_chunk: KnowledgeChunk | null;
  // 接下来要整理的分块（后端最多给 200 块）；别处正在整理的、失败后等着重试的不在里面
  queue: KnowledgeChunk[];
}
// 整理完一块，后端直接给回这块新增的主题（和地图里的主题同一形状）
export interface KnowledgeSync { updated: boolean; nodes: KnowledgeNode[] }

export const getKnowledgeMap = (signal?: AbortSignal) => api<KnowledgeMap>("/api/knowledge-map", { signal });
// 只在用户点了「更新地图」时调：每一块是一次模型调用
export const syncKnowledgeChunk = (chunk: KnowledgeChunk, signal?: AbortSignal) =>
  api<KnowledgeSync>("/api/knowledge-map/sync", { method: "POST", json: chunk, signal });

// 切回窗口时重新读地图：上次读过不到一分钟就不读
export const FOCUS_REFRESH_MS = 60_000;
export const focusRefreshDue = (last: number, now = Date.now()) => now - last >= FOCUS_REFRESH_MS;

export const CONFLICT_ROUNDS = 5;
export const conflictDelay = (round: number) => 3000 * 2 ** (round - 1);
const chunkKey = (c: KnowledgeChunk) => `${c.lesson_id}:${c.part_index}:${c.fingerprint}`;

function settle(map: KnowledgeMap, chunk: KnowledgeChunk, change: Partial<KnowledgeMap>): KnowledgeMap {
  const queue = map.queue.filter((c) => chunkKey(c) !== chunkKey(chunk));
  return { ...map, ...change, queue, next_chunk: queue[0] ?? null };
}

// 把一块新增的主题并进地图：同一主题只多记一处来源（同一课程同一篇只记一次），和后端整张地图的拼法一致
export function mergeSynced(map: KnowledgeMap, chunk: KnowledgeChunk, result: KnowledgeSync): KnowledgeMap {
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  for (const node of result.nodes) {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      continue;
    }
    const fresh = node.sources.filter((s) =>
      !existing.sources.some((e) => e.course_id === s.course_id && e.lesson_number === s.lesson_number));
    if (fresh.length) nodes.set(node.id, { ...existing, sources: [...existing.sources, ...fresh] });
  }
  return settle(map, chunk, { nodes: [...nodes.values()], pending_count: Math.max(0, map.pending_count - 1) });
}

// 按后端给的队列一块一块整理，每块只把新增主题并进地图；一轮整理完才重新读一次地图，看还有没有新的待整理分块。
// 某块整理失败（模型出错 502 / 超时 504 / 这块稍后重试 429）：后端记下失败并退避，这里计入失败数、接着整理下一块；
// 重新读到的队列里还有这块（后端没记下）才把错误抛出去。每小时 / 每天的整理量用完（429）：停下，重读一次地图后抛出提示。
// 冲突（409，别的窗口正在整理同一块，或课文、学习记录刚变）：这一轮整理完后等 3、6、12、24、48 秒重读地图再试，连续 5 轮冲突才报错。
export async function syncKnowledgeMap(
  map: KnowledgeMap,
  step: {
    load: () => Promise<KnowledgeMap>;
    sync: (chunk: KnowledgeChunk) => Promise<KnowledgeSync>;
    onMap: (map: KnowledgeMap) => void;
    stopped: () => boolean;
  },
  wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
) {
  const tried = new Set<string>();
  let failure: ApiError | null = null;
  let conflicts = 0;
  while (!step.stopped()) {
    let conflict: ApiError | null = null;
    for (const chunk of map.queue.filter((c) => !tried.has(chunkKey(c)))) {
      if (step.stopped()) return;
      try {
        const result = await step.sync(chunk);
        tried.add(chunkKey(chunk));
        map = mergeSynced(map, chunk, result);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 409) {
          conflict = err;
          continue;
        }
        if (![502, 504, 429].includes(err.status)) throw err;
        tried.add(chunkKey(chunk));
        failure = err;
        map = settle(map, chunk, { failed_count: map.failed_count + 1 });
      }
      if (!step.stopped()) step.onMap(map);
    }
    if (conflict) {
      if (++conflicts > CONFLICT_ROUNDS) throw conflict;
      await wait(conflictDelay(conflicts));
      if (step.stopped()) return;
    } else {
      conflicts = 0;
    }
    map = await step.load();
    if (step.stopped()) return;
    step.onMap(map);
    if (!map.queue.some((c) => !tried.has(chunkKey(c)))) break;
  }
  if (failure && map.queue.some((c) => tried.has(chunkKey(c)))) throw failure;
}
