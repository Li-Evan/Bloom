// ::highlight() 伪元素不能写进 CSS 文件（next dev --turbopack 的 CSS 解析器会报错），课文页运行时注入这段样式。
// 颜色取主题的主色（翠绿）按透明度调淡：亮、暗主题下文字都清楚，不再用固定的黄色。
export const HIGHLIGHT_CSS = `
/* 已有划线问答的文字：淡绿底 + 下划线 */
::highlight(bloom-ann) {
  background-color: color-mix(in oklab, var(--primary) 24%, transparent);
  text-decoration: underline;
  text-decoration-color: var(--ring);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}
/* 正在提问的选区 */
::highlight(bloom-pending) {
  background-color: color-mix(in oklab, var(--primary) 40%, transparent);
}
/* 问答卡片开着的那条：比平时的淡绿更深，一眼能看出卡片问的是哪一句 */
::highlight(bloom-active) {
  background-color: color-mix(in oklab, var(--primary) 52%, transparent);
  text-decoration: underline;
  text-decoration-color: var(--ring);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}
/* 翻译过的文字：虚线下划线、没有底色，和问答、标记的淡绿底分得开 */
::highlight(bloom-translated) {
  text-decoration: underline dashed;
  text-decoration-color: var(--ring);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 4px;
}
/* 暗色：一整行饱和的亮绿底在一片近黑的页面里太扎眼，比页面上任何别的绿都亮。改成低饱和的底（透明度降到 16–22%）+ 2px 下划线，
   正文字色不动，对比度仍远高于 4.5:1（近白字落在近黑偏一点绿的底上）。 */
.dark ::highlight(bloom-ann) {
  background-color: color-mix(in oklab, var(--primary) 14%, transparent);
}
.dark ::highlight(bloom-pending) {
  background-color: color-mix(in oklab, var(--primary) 20%, transparent);
  text-decoration: underline;
  text-decoration-color: var(--ring);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}
.dark ::highlight(bloom-active) {
  background-color: color-mix(in oklab, var(--primary) 24%, transparent);
}
/* pdf.js 文本层：文字本身透明（真实字渲染在 canvas 上），下划线/描边会糊在字上，
   所以只用干净的半透明底，让下面 canvas 的黑字清晰透出。 */
.textLayer span::highlight(bloom-ann) {
  background-color: color-mix(in oklab, var(--primary) 32%, transparent);
  text-decoration: none;
}
.textLayer span::highlight(bloom-translated) {
  text-decoration: none;
}
.textLayer span::highlight(bloom-pending) {
  background-color: color-mix(in oklab, var(--primary) 48%, transparent);
  text-decoration: none;
}
`;

export const highlightsSupported = () =>
  typeof CSS !== "undefined" &&
  "highlights" in CSS &&
  typeof Highlight !== "undefined";

// Character offset of (container, offset) within `root`'s plain text.
export const charOffset = (root: Node, container: Node, offset: number) => {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(container, offset);
  return r.toString().length;
};

interface OffsetSession {
  original_text: string;
  position_start: number;
  position_end: number;
}

// 在 plain 里找 text 出现的位置，多处时取离 target 最近的一处（前后两个方向都看）；没有返回 -1
const nearest = (plain: string, text: string, target: number) => {
  let best = -1;
  for (let i = plain.indexOf(text); i !== -1; i = plain.indexOf(text, i + 1)) {
    if (best === -1 || Math.abs(i - target) < Math.abs(best - target)) {
      best = i;
    } else if (i > target) {
      break; // 已经越过存档位置、而且越来越远
    }
  }
  return best;
};

// 课文渲染时把直引号、弯引号都换成「」『』、汉字后的半角冒号换成全角（lib/learn/lesson-text.ts 的 zhTypography），
// 旧划线存下的原文是换之前的写法（直引号、弯引号），精确匹配不上。把两边都折回直引号 / 半角冒号再找：
// 引号（双引号、嵌套的单引号 ‘ ’ 与 『』 对应）、冒号都是一对一的字符，折叠不改变位置；冒号后面被去掉的空格，在划线原文里也去掉。
// 中文加粗修好以前（markdown-config 的 remarkCjkFriendly）关不上的 ** 原样显示，旧划线原文里可能带着，也去掉。
const fold = (s: string) => s.replace(/[“”‘’「」『』]/g, '"').replace(/：/g, ":");
const foldSaved = (s: string) => fold(s).replace(/([\u3400-\u9fff]):[ \t]+/g, "$1:").replace(/\*\*/g, "");

// Resolve a session's [start, end] offsets — prefer matching its original text
// (robust to legacy rows that stored placeholder offsets), fall back to stored offsets.
// 原文在全文里出现好几处时，取离存档位置最近的一处（前后两个方向都看）：
// 课文的渲染改过之后（评估篇开头的注释不再当文字渲染、标题下的元信息排成一行、美元金额不再被当成公式……），
// 旧划线的存档位置会偏几个到上千个字符，但仍然比其它出现的地方更靠近原来那一处。
export const locateOffsets = (
  root: HTMLElement,
  session: OffsetSession
): [number, number] | null => {
  const text = session.original_text || "";
  if (text) {
    const plain = root.textContent || "";
    const target = session.position_start || 0;
    const exact = nearest(plain, text, target);
    if (exact !== -1) return [exact, exact + text.length];
    const needle = foldSaved(text);
    const folded = nearest(fold(plain), needle, target);
    if (folded !== -1) return [folded, folded + needle.length];
  }
  if (session.position_end > session.position_start) {
    return [session.position_start, session.position_end];
  }
  return null;
};

// Rebuild a DOM Range from plain-text [start, end] offsets within `root`.
export const rangeFromOffsets = (
  root: HTMLElement,
  start?: number | null,
  end?: number | null
) => {
  if (start == null || end == null || end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const len = n.textContent!.length;
    if (startNode === null && count + len > start) {
      startNode = n;
      startOffset = start - count;
    }
    if (count + len >= end) {
      endNode = n;
      endOffset = end - count;
      break;
    }
    count += len;
  }
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
};

// ---- 标记的悬浮删除按钮（页面上的 ::highlight() 不能接事件，只能按坐标找是哪一条） ----

export type MarkLine = { left: number; top: number; right: number; bottom: number };

// 指针落在哪一条标记的哪一行上：坐标是视口坐标，命中哪一行就把删除按钮贴到哪一行。
// 一条标记可能跨好几行（range.getClientRects() 每行一个矩形），逐行判断。
export const markedLineAt = (
  marks: { id: number; lines: MarkLine[] }[],
  x: number,
  y: number
): { id: number; line: MarkLine } | null => {
  for (const mark of marks) {
    for (const line of mark.lines) {
      if (x >= line.left && x <= line.right && y >= line.top && y <= line.bottom) {
        return { id: mark.id, line };
      }
    }
  }
  return null;
};

// range.getClientRects() 不是一行一个：加粗、链接、行内代码在同一行各给一段，整个落在标记里的元素还多给一个外框
// （段落、列表项、带内边距的行内代码）。去掉包住别的矩形又比它高的外框，再把同一行的几段并成一段：
// 按钮贴在这一行标记的末尾，不会出现在半行中间、指针一动就跳走
export const markLines = (rects: MarkLine[]): MarkLine[] => {
  const boxes = rects.filter((r) => r.right > r.left && r.bottom > r.top);
  const inner = boxes.filter((r) => !boxes.some((o) => o !== r && o.bottom - o.top < r.bottom - r.top - 1 &&
    o.left >= r.left - 0.5 && o.right <= r.right + 0.5 && o.top >= r.top - 0.5 && o.bottom <= r.bottom + 0.5));
  const lines: MarkLine[] = [];
  for (const r of inner.sort((a, b) => a.top - b.top)) {
    const mid = (r.top + r.bottom) / 2;
    const line = lines.find((l) => mid >= l.top && mid <= l.bottom);
    if (!line) lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    else Object.assign(line, {
      left: Math.min(line.left, r.left), right: Math.max(line.right, r.right),
      top: Math.min(line.top, r.top), bottom: Math.max(line.bottom, r.bottom),
    });
  }
  return lines;
};

// 指针在按钮上或按钮四周 reach 像素内都算在按钮上：按钮和行尾之间有道缝，鼠标路过缝的那一帧不能把按钮收掉
export const nearBadge = (badge: MarkLine, x: number, y: number, reach = 8) =>
  x >= badge.left - reach && x <= badge.right + reach && y >= badge.top - reach && y <= badge.bottom + reach;

// 删除按钮相对 <article> 的位置：贴在那一行末尾的外侧，纵向压在行中间；
// 正文排到很右边（窄屏、行很长）时收进正文里，不压右边栏。size 是按钮边长。
export const markBadgeAt = (
  line: MarkLine,
  article: { left: number; top: number; width: number },
  size = 24,
  gap = 2
): { top: number; left: number } => {
  const lineRight = line.right - article.left;
  const lineHeight = line.bottom - line.top;
  return {
    left: Math.max(0, Math.min(lineRight + gap, article.width - size)),
    top: Math.max(0, line.top - article.top + (lineHeight - size) / 2),
  };
};
