import { ApiError, api } from "@/lib/api-client";

// 单门课的知识坐标卡片（后端 backend/app/coordinate.py）。节点只认 node_id；名字是 Bloom 自写的分节名和 Wikidata 标签
export interface CoordinateNode {
  node_id: string;
  label: string;
}

export type CoordinateStep = "anchor" | "directions";

export interface CoordinateCard {
  // empty：课里还没有内容；pending：还没算落点；failed：上次没算出来，retry_after 秒后再试；none：没有合适的位置，不显示；placed：有落点
  state: "empty" | "pending" | "failed" | "none" | "placed";
  // 还没做的步骤，按顺序；前端一步一步调 POST /step
  needs: CoordinateStep[];
  retry_after: number | null;
  here: (CoordinateNode & {
    level: "article" | "section" | "concept";
    crumbs: CoordinateNode[];
    also: CoordinateNode[];
    state: "encountered" | "explained" | "applied" | null;
  }) | null;
  // 骨架的顶层，固定顺序；courses 是落在这里、读过课文的课数；here 是这门课所在的顶层
  band: (CoordinateNode & { courses: number; here: boolean })[];
  connect: (CoordinateNode & { course_id: number; course_name: string }) | null;
  next_item: { text: string; lesson_number: number | null } | null;
  covered: { text: string; state: "encountered" | "explained"; lesson_number: number }[];
  directions: (CoordinateNode & { id: number; question: string; reason: string; status: string })[];
  // 相邻方向能不能收进待学清单
  can_save: boolean;
}

export const getCoordinate = (courseId: string | number, locale: string) =>
  api<CoordinateCard>(`/api/courses/${courseId}/coordinate?locale=${locale}`);

// 跑这门课坐标作业里下一个没做的步骤（课程页打开时、知识地图点「更新地图」时）
export const stepCoordinate = (courseId: string | number, locale: string) =>
  api<CoordinateCard>(`/api/courses/${courseId}/coordinate/step?locale=${locale}`, { method: "POST" });

export const BUSY_ROUNDS = 6;
export const BUSY_DELAY_MS = 5000;

// 按 needs 一步一步跑完坐标作业：每步的结果都交给 onCard（落点算好就先显示出来，相邻方向接着算）。
// 别的窗口正在算同一步（409）：等 5 秒重读一次卡片再接着走，最多 6 轮；上次失败还在退避（retry_after）就停下等用户点重试。
// 其他错误原样抛出，已经显示的部分不动。
export async function advanceCoordinate(
  card: CoordinateCard,
  io: {
    step: () => Promise<CoordinateCard>;
    load: () => Promise<CoordinateCard>;
    onCard: (card: CoordinateCard) => void;
    stopped: () => boolean;
  },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<CoordinateCard> {
  let busy = 0;
  while (!io.stopped() && card.needs.length > 0 && card.retry_after == null) {
    const before = card.needs.join();
    try {
      card = await io.step();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409 || ++busy > BUSY_ROUNDS) throw err;
      await wait(BUSY_DELAY_MS);
      if (io.stopped()) break;
      card = await io.load();
      io.onCard(card);
      continue;
    }
    if (io.stopped()) break;
    io.onCard(card);
    if (card.needs.join() === before) break; // 没有进展（比如课里刚好没内容了）：不空转
  }
  return card;
}

// 卡片上要不要等：落点还没算出来、或者落点有了但相邻方向还在算
export const placing = (card: CoordinateCard | null) => card?.state === "pending" && !card.retry_after;
export const findingDirections = (card: CoordinateCard | null) =>
  card?.state === "placed" && card.needs.includes("directions") && !card.retry_after;
