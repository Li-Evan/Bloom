import { ApiError, api } from "@/lib/api-client";
import type { CoordinateCard, CoordinateNode } from "@/lib/learn/coordinate";

// 知识地图页：自己单独学的每门课落在共享知识树的哪里（后端 GET /api/knowledge-map/coordinate）
export interface MapCourse {
  course_id: number;
  name: string;
  // placed：有落点；pending：还没定位；failed：上次没算出来，retry_after 秒后再试；none：找不到合适的位置
  state: "placed" | "pending" | "failed" | "none";
  read: boolean;
  learned: "encountered" | "explained" | null;
  // 所在的顶层（band 里的 node_id）；path 是顶层之下、显示节点之上有 Bloom 名字的各级
  area: string | null;
  path: CoordinateNode[];
  // place 是界面上显示的节点（主落点是还没有名字的深层分节时，是离它最近的有名字的上级）
  here: (CoordinateNode & { place: string; level: string }) | null;
  also: CoordinateNode[];
  directions: CoordinateCard["directions"];
  // 相邻方向还没算（进课程页才算）；算过了却没有（没找到，或都点了「不感兴趣」）时不显示这一栏
  directions_pending: boolean;
  retry_after: number | null;
}

export interface CoordinateOverview {
  // 骨架的 11 个顶层，固定顺序：placed 是落在这里的课数，courses 是其中读过课文的
  band: (CoordinateNode & { placed: number; courses: number })[];
  courses: MapCourse[];
  // 还没定位、也不在退避里的课：地图页逐门跑一次落点
  needs: number[];
}

export const getCoordinateOverview = (locale: string, signal?: AbortSignal) =>
  api<CoordinateOverview>(`/api/knowledge-map/coordinate?locale=${locale}`, { signal });

// 逐门定位：每门只跑一步（落点），每定位完一门重读一次总览，树一点点长出来。相邻方向和掌握项链接留到进课程页时再算。
// 别的窗口正在算这门（409）就跳过；这门在退避（429）就停下；模型出错（后端已记下并退避）接着下一门。
export async function placeCourses(
  overview: CoordinateOverview,
  io: {
    step: (courseId: number) => Promise<unknown>;
    load: () => Promise<CoordinateOverview>;
    onOverview: (overview: CoordinateOverview) => void;
    onPlacing: (courseId: number | null) => void;
    stopped: () => boolean;
  },
): Promise<CoordinateOverview> {
  let failed = false;
  for (const courseId of overview.needs) {
    if (io.stopped()) break;
    io.onPlacing(courseId);
    try {
      await io.step(courseId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) break;
      if (!(err instanceof ApiError && err.status === 409)) failed = true;
      continue;
    }
    if (io.stopped()) break;
    overview = await io.load();
    io.onOverview(overview);
    failed = false;
  }
  io.onPlacing(null);
  if (failed && !io.stopped()) {
    overview = await io.load();
    io.onOverview(overview);
  }
  return overview;
}

export interface TreeNode {
  id: string;
  label: string;
  // 被并进来的上级（只有一条路往下、自己没有课的那几级）：「法律 › 法律基础」显示在「谈判」前面
  trail: string[];
  courses: MapCourse[];
  children: TreeNode[];
  // 这一支下面一共几门课
  count: number;
}

export interface MapArea {
  area: CoordinateOverview["band"][number];
  nodes: TreeNode[];
  count: number;
}

function compress(node: TreeNode): TreeNode {
  const children = node.children.map(compress);
  const count = node.courses.length + children.reduce((sum, child) => sum + child.count, 0);
  if (!node.courses.length && children.length === 1) {
    const [child] = children;
    return { ...child, trail: [...node.trail, node.label, ...child.trail] };
  }
  return { ...node, children, count };
}

// 按顶层分区，把课挂到它在树上的位置：同一个上级下的课排在一起，几门课共同的上级就是它们相连的地方。
// 只有一条路往下的中间各级并成一行，所以树只在课程分开的地方分叉。顶层按固定顺序，只列有课的。
export function coordinateTree(overview: Pick<CoordinateOverview, "band" | "courses">): MapArea[] {
  const areas: MapArea[] = [];
  for (const area of overview.band) {
    const placed = overview.courses.filter((c) => c.state === "placed" && c.here && c.area === area.node_id);
    if (!placed.length) continue;
    const root: TreeNode = { id: area.node_id, label: area.label, trail: [], courses: [], children: [], count: 0 };
    for (const course of placed) {
      let node = root;
      for (const step of [...course.path, { node_id: course.here!.place, label: course.here!.label }]) {
        let child = node.children.find((c) => c.id === step.node_id);
        if (!child) {
          child = { id: step.node_id, label: step.label, trail: [], courses: [], children: [], count: 0 };
          node.children.push(child);
        }
        node = child;
      }
      node.courses.push(course);
    }
    areas.push({ area, nodes: root.children.map(compress), count: placed.length });
  }
  return areas;
}

// 搜索：课名、落点、上级名字、这门课已学内容里的主题都算
export function matchesCourse(course: MapCourse, query: string, topics: string[] = []) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  const text = [course.name, course.here?.label, ...course.path.map((p) => p.label), ...course.also.map((a) => a.label), ...topics];
  return text.some((part) => part?.toLocaleLowerCase().includes(q));
}
