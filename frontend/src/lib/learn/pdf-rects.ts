import type { PdfPosition } from "@/lib/learn/types";

type Rect = PdfPosition["rects"][number];

// 后端（highlights.py）收的 PDF 划线：最多 4000 个矩形，x / y / w / h 都在 [0, 1] 里，整个 pdf_position 序列化后不超过 400000 字
export const PDF_MAX_RECTS = 4000;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
// 坐标留 6 位小数（页面 1000px 宽时误差不到 0.001px）：4000 个矩形序列化后约 27 万字，稳稳在 40 万以内
const round = (value: number) => Math.round(value * 1e6) / 1e6;

// 浏览器给的选区矩形很碎：pdf.js 文字层每个 span 一个，整段选中的 span 和它的文字节点还会各给一个（重复）。
// 同一页、同一行（竖直方向大半重叠）且左右挨着或重叠的并成一个，先夹进页面范围，再限制数量，不让后端因为越界或太多直接拒收
export function normalizePdfRects(rects: Rect[]): Rect[] {
  const boxes = rects
    .map((r) => ({ page: r.page, x0: clamp(r.x), y0: clamp(r.y), x1: clamp(r.x + r.w), y1: clamp(r.y + r.h) }))
    .filter((b) => Number.isFinite(b.x0 + b.y0 + b.x1 + b.y1) && b.x1 - b.x0 > 0.001 && b.y1 - b.y0 > 0.001)
    .sort((a, b) => a.page - b.page || a.y0 - b.y0 || a.x0 - b.x0);

  // 先分行，行内按左右顺序并；隔栏（中间空得远）的不并
  const rows: (typeof boxes)[] = [];
  for (const box of boxes) {
    const row = rows[rows.length - 1];
    const band = row && { page: row[0].page, y0: Math.min(...row.map((b) => b.y0)), y1: Math.max(...row.map((b) => b.y1)) };
    const overlap = band ? Math.min(band.y1, box.y1) - Math.max(band.y0, box.y0) : 0;
    if (band && band.page === box.page && overlap >= Math.min(band.y1 - band.y0, box.y1 - box.y0) * 0.5) row.push(box);
    else rows.push([box]);
  }
  const lines: typeof boxes = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    let line = { ...row[0] };
    lines.push(line);
    for (const box of row.slice(1)) {
      if (box.x0 <= line.x1 + 0.01) {
        line.x1 = Math.max(line.x1, box.x1);
        line.y0 = Math.min(line.y0, box.y0);
        line.y1 = Math.max(line.y1, box.y1);
      } else {
        line = { ...box };
        lines.push(line);
      }
    }
  }

  return lines
    .slice(0, PDF_MAX_RECTS)
    .map((l) => ({ page: l.page, x: round(l.x0), y: round(l.y0), w: round(l.x1 - l.x0), h: round(l.y1 - l.y0) }));
}

// 一页上的一行字（归一化坐标）：竖直范围 + 这一行真正有字的几段（隔栏的分成两段）
export interface PdfTextLine {
  y0: number;
  y1: number;
  segments: { x0: number; x1: number }[];
}

// pdf.js 的 TextItem（有字）；TextMarkedContent（只有 type、id，标记结构用）跳过
interface TextItemLike {
  str: string;
  width: number;
  height: number;
  transform: number[];
}

interface ViewportLike {
  width: number;
  height: number;
  rotation: number;
  convertToViewportPoint(x: number, y: number): number[];
}

// 字框：基线往上 0.85 个字高、往下 0.22 个字高，盖住大写字母和下伸笔画；论文排得紧的行距也有字高的 1.09 倍，上下两行的框不叠成深色条
const ASCENT = 0.85;
const DESCENT = 0.22;
// 同一行里两段字之间空得比这宽（页宽的比例）就当作隔栏，高亮不跨过中间的空白
export const SEGMENT_GAP = 0.015;

// 一段字的框
export interface TextBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// 把一页的字框归成一行行：竖直方向大半重叠的算同一行；行内左右挨着的连成一段，中间空得比 gap 宽的（隔栏）分开。
// 每一段带着它自己的竖直范围：两栏的行对不齐时会归进同一行，行的范围比其中任何一段都高
export function groupTextBoxes<B extends TextBox>(boxes: B[], gap: number) {
  const groups: { y0: number; y1: number; boxes: B[] }[] = [];
  for (const box of [...boxes].sort((a, b) => a.y0 + a.y1 - b.y0 - b.y1)) {
    const line = groups[groups.length - 1];
    const overlap = line ? Math.min(line.y1, box.y1) - Math.max(line.y0, box.y0) : 0;
    if (line && overlap >= Math.min(line.y1 - line.y0, box.y1 - box.y0) * 0.5) {
      line.boxes.push(box);
      line.y0 = Math.min(line.y0, box.y0);
      line.y1 = Math.max(line.y1, box.y1);
    } else {
      groups.push({ y0: box.y0, y1: box.y1, boxes: [box] });
    }
  }

  return groups.map(({ y0, y1, boxes: row }) => {
    const segments: (TextBox & { boxes: B[] })[] = [];
    for (const box of row.sort((a, b) => a.x0 - b.x0)) {
      const last = segments[segments.length - 1];
      if (last && box.x0 <= last.x1 + gap) {
        last.x1 = Math.max(last.x1, box.x1);
        last.y0 = Math.min(last.y0, box.y0);
        last.y1 = Math.max(last.y1, box.y1);
        last.boxes.push(box);
      } else segments.push({ x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1, boxes: [box] });
    }
    return { y0, y1, segments };
  });
}

// 从空白处起拖选字时，选区该从哪一段字开始：鼠标所在的高度上有字，又和离鼠标最近的字在同一栏（左右有重叠），就是那一行里的；
// 否则就是离鼠标最近的。只看「所在高度」会跳栏：双栏的 PDF，鼠标在左栏两段之间的空白里，右栏正好有一行和它一样高。
// 只看「最近」的话，在段落末行右边的空白里起拖，起点会落到上一行正对着鼠标的地方
export function nearestTextBox<B extends TextBox>(boxes: B[], gap: number, x: number, y: number): B | undefined {
  const dx = (b: TextBox) => Math.max(b.x0 - x, 0, x - b.x1);
  const dy = (b: TextBox) => Math.max(b.y0 - y, 0, y - b.y1);
  const least = <T>(items: T[], cost: (item: T) => number) => items.reduce<T | undefined>((best, item) => (best !== undefined && cost(best) <= cost(item) ? best : item), undefined);
  const segments = groupTextBoxes(boxes, gap).flatMap((line) => line.segments);
  const nearest = least(segments, (s) => Math.hypot(dx(s), dy(s)));
  if (!nearest) return;
  const level = least(segments.filter((s) => !dy(s)), dx);
  return least((level && level.x0 < nearest.x1 && nearest.x0 < level.x1 ? level : nearest).boxes, dx);
}

// 按 pdf.js 的文字几何（getTextContent 的 items）算出每一行有字的范围。斜排、竖排的字和旋转过的页不算，那些地方的高亮照原样画
export function pdfTextLines(items: (TextItemLike | { type: string })[], viewport: ViewportLike): PdfTextLine[] {
  if (viewport.rotation % 180 !== 0) return [];
  const boxes = items
    .filter((it): it is TextItemLike => "str" in it && !!it.str.trim() && it.transform[1] === 0 && it.transform[2] === 0 && it.width > 0 && it.height > 0)
    .map((it) => {
      const [, , , , e, f] = it.transform;
      const h = it.height;
      const [ax, ay] = viewport.convertToViewportPoint(e, f - DESCENT * h);
      const [bx, by] = viewport.convertToViewportPoint(e + it.width, f + ASCENT * h);
      return {
        x0: Math.min(ax, bx) / viewport.width,
        x1: Math.max(ax, bx) / viewport.width,
        y0: Math.min(ay, by) / viewport.height,
        y1: Math.max(ay, by) / viewport.height,
      };
    });
  return groupTextBoxes(boxes, SEGMENT_GAP).map(({ y0, y1, segments }) => ({ y0, y1, segments: segments.map(({ x0, x1 }) => ({ x0, x1 })) }));
}

// 高亮框收到真正有字的地方：每个框（一行选区）对到和它竖直重叠最多、且左右有字相交的那一行，
// 高度换成这一行的字框，左右只留有字的部分。行尾、栏间的空白不画；早先文字层错位时存下的偏宽、偏高的框也就收回到字上。
// 这一页的行还没算出来（页面还没画过）、或者框附近没有字，就照原样
export function snapPdfRects(rects: Rect[], linesOf: (page: number) => PdfTextLine[] | undefined): Rect[] {
  const snapped = rects.flatMap((r) => {
    let best: PdfTextLine | undefined;
    let bestOverlap = 0;
    for (const line of linesOf(r.page) ?? []) {
      const overlap = Math.min(line.y1, r.y + r.h) - Math.max(line.y0, r.y);
      if (overlap > bestOverlap && line.segments.some((s) => s.x0 < r.x + r.w && s.x1 > r.x)) {
        best = line;
        bestOverlap = overlap;
      }
    }
    if (!best) return [r];
    const { y0, y1 } = best;
    return best.segments
      .map((s) => ({ x0: Math.max(s.x0, r.x), x1: Math.min(s.x1, r.x + r.w) }))
      .filter((s) => s.x1 > s.x0)
      .map((s) => ({ page: r.page, x: s.x0, y: y0, w: s.x1 - s.x0, h: y1 - y0 }));
  });
  return normalizePdfRects(snapped);
}
