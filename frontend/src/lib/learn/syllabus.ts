// 大纲 Markdown 的整理：去掉 HTML 注释；去掉开头的一级标题（页面标题已经是课程名）；
// 「学习进度」一节：模型在大纲里写的占位行（「待生成」「—」「无」「TBD」…，词表和后端一致）和空表一样不算数据，去掉；
// 去完没有数据行了，表换成一句空状态（emptyProgress，没传就整节拿掉）；有真实的行就只留真实的行；数出勾选了几项掌握项。

const PROGRESS_HEADING = /^##\s+(?:学习进度|Learning progress)\s*$/i;
const HEADING = /^#{1,6}\s/;
const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// 占位单元格：和后端 backend/app/courses.py 的 _PLACEHOLDER_CELLS 一模一样（后端追加进度行时用它去掉占位行；
// tests/round2-front-a.test.mjs 读后端源码对照），比较时不分大小写
export const PLACEHOLDER_CELLS: ReadonlySet<string> = new Set([
  "", "-", "—", "–", "…", "...", "待生成", "待定", "待补充", "未生成", "无", "tbd", "pending", "to be generated", "to be written", "n/a",
]);

// 和后端 _table_cells 一样：去掉首尾所有的 |，按 | 切开，每格去首尾空白
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|+|\|+$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

// 和后端 _is_placeholder_row 一样：除了第一格（篇号）以外，其余格子全是占位词。只有一格的行不算
function isPlaceholderRow(line: string): boolean {
  const cells = cellsOf(line);

  return cells.length > 1 && cells.slice(1).every((cell) => PLACEHOLDER_CELLS.has(cell.toLowerCase()));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// 一行里的日期格子（旧课程的进度表写的是 2026-10-15）换成全站统一的写法（10月15日 / 跨年带年份），其余格子原样
function withDates(line: string, formatDate: (year: number, month: number, day: number) => string): string {
  const cells = cellsOf(line);
  if (!cells.some((cell) => ISO_DATE.test(cell))) return line;

  return `| ${cells.map((cell) => {
    const match = ISO_DATE.exec(cell);

    return match ? formatDate(Number(match[1]), Number(match[2]), Number(match[3])) : cell;
  }).join(" | ")} |`;
}

// 一节的整理结果：保留的行（表头、分隔线、真实的数据行、表之外的文字），以及有没有真实内容
function tidyProgress(
  body: string[],
  formatDate?: (year: number, month: number, day: number) => string
): { kept: string[]; hasData: boolean } {
  const lines = body.map((l) => l.trim()).filter(Boolean);
  const tableLines = lines.filter((l) => l.startsWith("|"));
  const other = lines.filter((l) => !l.startsWith("|"));
  const header = tableLines.find((l) => !TABLE_SEPARATOR.test(l));
  const separator = tableLines.find((l) => TABLE_SEPARATOR.test(l));
  const rows = tableLines
    .filter((l) => l !== header && l !== separator)
    .filter((l) => !isPlaceholderRow(l))
    .map((l) => l.replace(/<br\s*\/?>/gi, "\ue000"))
    .map((l) => (formatDate ? withDates(l, formatDate) : l));
  const hasData = other.length > 0 || rows.length > 0;
  // 旧课程的进度表表头第一格写的是「文档」，全站都叫「课文」（后端新写的已经是「课文」）
  const table = header && separator && rows.length > 0 ? [header.replace(/^(\|?\s*)文档(\s*\|)/, "$1课文$2"), separator, ...rows] : [];

  return { kept: [...other, ...(other.length && table.length ? [""] : []), ...table], hasData };
}

export function prepareSyllabus(
  source: string | null | undefined,
  { emptyProgress, formatDate }: { emptyProgress?: string; formatDate?: (year: number, month: number, day: number) => string } = {}
): {
  content: string;
  mastered: number;
  total: number;
} {
  // 开头说明里的「文档数量因人而异」同理（后端新写的是「课文数量因人而异」）
  const text = (source ?? "").replace(/<!--[\s\S]*?-->/g, "").replace("> 文档数量因人而异", "> 课文数量因人而异");
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^#\s/.test(lines[first])) lines.splice(first, 1);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!PROGRESS_HEADING.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !HEADING.test(lines[end])) end++;
    const { kept: body, hasData } = tidyProgress(lines.slice(i + 1, end), formatDate);
    if (hasData) kept.push(lines[i], "", ...body, "");
    else if (emptyProgress) kept.push(lines[i], "", emptyProgress, "");
    i = end - 1;
  }

  // 开头那段引用（几行说明）里的换行在 Markdown 里会被合成一行，换成硬换行
  for (let i = 0; i < kept.length - 1; i++) {
    if (kept[i].startsWith(">") && kept[i + 1].startsWith(">") && !kept[i].endsWith("  ")) {
      kept[i] += "  ";
    }
  }

  let mastered = 0;
  let total = 0;
  let fenced = false;
  for (const line of kept) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = !fenced && TASK_ITEM.exec(line);
    if (match) {
      total++;
      if (match[1] !== " ") mastered++;
    }
  }

  return { content: kept.join("\n").trim(), mastered, total };
}
