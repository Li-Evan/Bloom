// 课文渲染前的纯文本处理，与 React 无关（单测直接 import）。
// 顺序：去掉模型有时包在外面的 ```markdown 围栏 → 剥 HTML 注释 → （课文）隐藏末尾的「你的反馈」占位小节 → 公式（美元金额的 $ 转义、\( \[ 转 $ 写法）
// → （中文内容）中文排版：成对的直引号换成弯引号、汉字后的半角冒号换成全角。
// 代码区域（围栏代码块、缩进代码块、行内代码）里的内容一律不动。

export function stripFences(text?: string): string {
  if (!text) return "";
  let t = text.trim();
  if (/^```(?:markdown|md)?\s*\n?/i.test(t)) {
    t = t.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  }
  return t.trim();
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_OPEN_ANY_INDENT = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})\s*$/;
const INDENTED = /^(?: {4}|\t)/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

// 每一行是不是代码：围栏代码块（围栏没关就一直到文末，和 CommonMark 一致）、缩进代码块。
// 缩进代码块只在「空行之后、不在列表里」时才算——列表项里缩进的续段是正文。
// 围栏跟踪只在这里写一遍，剥注释、转义 $、找「你的反馈」都用它。
function codeLineMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let fence: { char: string; len: number } | null = null;
  let indented = false;
  let inList = false;
  let prevBlank = true;

  const nextNonBlank = (from: number) => {
    for (let j = from; j < lines.length; j++) {
      if (lines[j].trim() !== "") return j;
    }
    return -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blank = line.trim() === "";

    if (fence) {
      mask[i] = true;
      const close = line.match(FENCE_CLOSE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        fence = null;
      }
      prevBlank = false;
      continue;
    }

    if (indented) {
      if (!blank && INDENTED.test(line)) {
        mask[i] = true;
        continue;
      }
      if (blank) {
        const next = nextNonBlank(i + 1);
        if (next !== -1 && INDENTED.test(lines[next])) {
          mask[i] = true;
          continue;
        }
        indented = false;
        prevBlank = true;
        continue;
      }
      indented = false;
    }

    if (blank) {
      prevBlank = true;
      continue;
    }

    const open = line.match(inList ? FENCE_OPEN_ANY_INDENT : FENCE_OPEN);
    // 反引号围栏的说明文字里不能有反引号，否则那是行内代码
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], len: open[1].length };
      mask[i] = true;
      prevBlank = false;
      continue;
    }

    if (INDENTED.test(line) && prevBlank && !inList) {
      indented = true;
      mask[i] = true;
      prevBlank = false;
      continue;
    }

    if (LIST_ITEM.test(line)) inList = true;
    else if (/^ {0,3}#{1,6}(?:\s|$)/.test(line) || (prevBlank && !/^\s/.test(line))) {
      inList = false;
    }
    prevBlank = false;
  }
  return mask;
}

// 把文本切成「代码」和「其余」两种片段（片段之间原本由换行连着）
function splitCode(text: string): { code: boolean; text: string }[] {
  const lines = text.split("\n");
  const mask = codeLineMask(lines);
  const out: { code: boolean; text: string }[] = [];
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    if (i === lines.length || mask[i] !== mask[start]) {
      out.push({ code: mask[start], text: lines.slice(start, i).join("\n") });
      start = i;
    }
  }
  return out;
}

// 行内代码：同样长度的反引号成对，可以跨行但不能跨空行。返回结束位置（不含），没有配对返回 -1
function inlineCodeEnd(text: string, start: number): number {
  let n = 1;
  while (text[start + n] === "`") n++;
  for (let j = start + n; j < text.length; j++) {
    const ch = text[j];
    if (ch === "`") {
      let m = 1;
      while (text[j + m] === "`") m++;
      if (m === n) return j + m;
      j += m - 1;
    } else if (ch === "\n") {
      let k = j + 1;
      while (text[k] === " " || text[k] === "\t") k++;
      if (text[k] === "\n") return -1;
    }
  }
  return -1;
}

// 从 start 起一段行内代码（没配对的反引号就是普通字符）占到哪里
function inlineCodeStop(text: string, start: number): number {
  const end = inlineCodeEnd(text, start);
  if (end >= 0) return end;
  let stop = start;
  while (text[stop] === "`") stop++;
  return stop;
}

// 剥掉这一段里闭合的 `<!-- … -->`（行内代码里的原样放过）；
// openAt：最后一个没闭合的 `<!--` 在输出文本里的位置，没有则 -1（流式输出时用来隐藏写了一半的注释）
function stripCommentsIn(text: string): { text: string; openAt: number } {
  let out = "";
  let openAt = -1;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end >= 0) {
        i = end + 3;
      } else {
        openAt = out.length;
        out += "<!--";
        i += 4;
      }
    } else if (text[i] === "`") {
      const stop = inlineCodeStop(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else {
      out += text[i];
      i++;
    }
  }
  return { text: out, openAt };
}

// 剥掉全部闭合的 HTML 注释（课文末尾的 `<!-- mastery: … -->` 是给后端勾选掌握项用的，不是给读者看的）。
// 代码里的 `<!-- … -->` 是内容，保留；没闭合的 `<!--` 是正文里的字符，也保留——
// 只有流式预览（streaming）才把「最后一个没闭合的 `<!--` 到文末」先藏起来，免得 mastery 注释写到一半时闪出来。
export function stripHtmlComments(
  text: string,
  options: { streaming?: boolean } = {}
): string {
  if (!text.includes("<!")) return text;
  const parts = splitCode(text);
  return parts
    .map((part, index) => {
      if (part.code) return part.text;
      const { text: stripped, openAt } = stripCommentsIn(part.text);
      // 末尾是代码块的内容，「文末」不在文字里，不动
      if (!options.streaming || index !== parts.length - 1) return stripped;
      const cut = openAt >= 0 ? stripped.slice(0, openAt) : stripped;
      return cut.replace(/<!-{0,2}$/, "");
    })
    .join("\n");
}

const H2 = /^ {0,3}##(?!#)[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FEEDBACK_TITLE = /^(?:你的反馈|your feedback)$/i;

// 课文末尾的「你的反馈 / Your feedback」是模型写的占位小节（页面下方有真正的反馈表单）：
// 最后一个二级标题是它时，连同它之后的内容一起去掉；不是最后一个二级标题就不动。
export function hideFeedbackSection(text: string): string {
  const lines = text.split("\n");
  const mask = codeLineMask(lines);
  let lastH2 = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i] && H2.test(lines[i])) lastH2 = i;
  }
  if (lastH2 < 0) return text;

  const title = lines[lastH2]
    .match(H2)![1]
    .replace(/[*_`]/g, "")
    .replace(/[\s:：.。]+$/, "")
    .trim();
  if (!FEEDBACK_TITLE.test(title)) return text;
  return lines.slice(0, lastH2).join("\n").trimEnd();
}

const BODY_TITLE = /^(?:正文内容|main content)$/i;

// 模型在「正文内容 / Main content」这个二级标题下面写正文小节（三级标题）：这一层本身没有信息，渲染时隐藏标题那一行。
// 只认标题文字整个就是它的二级标题；课文里别的标题（「Main content strategy」）、代码里的 `## 正文内容` 不动。
export function hideBodyHeading(text: string): string {
  const lines = text.split("\n");
  const mask = codeLineMask(lines);
  const kept = lines.filter((line, i) => {
    if (mask[i]) return true;
    const match = line.match(H2);
    if (!match) return true;
    const title = match[1]
      .replace(/[*_`]/g, "")
      .replace(/[\s:：.。]+$/, "")
      .trim();

    return !BODY_TITLE.test(title);
  });

  return kept.length === lines.length ? text : kept.join("\n");
}

// ── 公式：美元金额的 $ 不当公式；\( … \) 与 \[ … \] 转成 remark-math 认的 $ 写法 ──
//
// 美元金额里的 $ 不是公式：remark-math 会把「$1,000 … $100」之间当成一段 LaTeX（英文课里到处是金额）。
// 照 pandoc 的规则判断一对 $ 是不是公式——开头的 $ 后面不能是空白；结尾的 $ 前面不能是空白、后面不能紧跟数字；
// 不成对的 $ 一律加反斜杠，当普通字符显示。代码、$$ 显示公式、已有的 \$ 都原样放过。
// （本地开发库里 41 篇课文 + 14 条问答：没有一处「$ 后面跟空格」的写法，所以不另给「$ x^2 $」留规则。）
//
// 模型自己写公式时用的是 \( … \)（行内）与 \[ … \]（块级）——remark-math 不认，会当成转义的括号显示成「(P)」。
// 在同一趟扫描里转成 $…$ 与 $$ 围栏（去掉定界符内侧的首尾空白，所以 pandoc 的首尾空格规则不会误伤）：
// - 转出来的公式原样输出，不再参与上面的 $ 配对；
// - 没有闭合的（流式输出中只来了开头）、闭合前有空行的、里面带 $ 的、看起来是普通文字的（\[可选\]）都不转；
// - \\( 是转义的反斜杠加括号，不动；代码区域整段跳过（由调用方切开）。
function closingDollar(text: string, open: number): number {
  const next = text[open + 1];
  if (next === undefined || /\s/.test(next)) return -1;
  for (let j = open + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\n" && text[j + 1] === "\n") return -1;
    if (ch === "\\") {
      j++;
    } else if (ch === "$") {
      const after = text[j + 1];
      if (after === "$") return -1;
      if (/\s/.test(text[j - 1])) {
        // 前面是空白：它不能收尾；后面紧跟字符的话它自己是下一个开头，当前这个就没有配对了
        if (after !== undefined && !/\s/.test(after)) return -1;
        continue;
      }
      if (after !== undefined && /\d/.test(after)) continue;
      return j;
    }
  }
  return -1;
}

// 从 from 起找 `\)` / `\]`：跳过转义的字符（含 \\），不跨空行；找不到返回 -1
function latexClose(text: string, from: number, closer: ")" | "]"): number {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") {
      if (text[j + 1] === closer) return j;
      j++;
    } else if (ch === "\n") {
      let k = j + 1;
      while (text[k] === " " || text[k] === "\t") k++;
      if (text[k] === "\n") return -1;
    }
  }
  return -1;
}

const CJK = /[\u2e80-\u9fff\uff00-\uffef]/;
// LaTeX 命令（\times、\frac、\text……）和数学运算符。斜杠只在挨着数字或单个字母时才算运算（1/2、a/b），
// 汉字之间的斜杠（可选/必填）和 and/or 这类词之间的不算
const COMMAND = /\\[A-Za-z]/;
const OPERATOR = /[=^_<>+*×÷−±≤≥≠≈|]|(?:\d|\b[A-Za-z])\s*\/|\/\s*(?:\d|[A-Za-z]\b)/;
// 只由数字、逗号、连字符 / 破折号（范围）、空格构成：编号、年份、页码范围（1、2024、1, 2、1-3），不是公式
const NUMBER_LIST = /^\d+(?:(?:\s*[,\-–—]\s*|\s+)\d+)*$/;

// 定界符里的内容像公式吗。按顺序：
// 1. 带 $ 的不是（金额）；
// 2. 有 LaTeX 命令或数学运算符的就是公式——KaTeX 在数学模式里能渲染汉字，\[ 利息 = 本金 \times 利率 \] 要转；
// 3. 既没有命令也没有运算符时：含汉字 / 日文 / 全角字符的是文字（\[可选\]、\(第 1 步\)），
//    纯数字 / 逗号 / 范围的是编号（\[1\]、\[2024\]、\[1-3\]），三个以上连着的字母（see below）是文字；
// 4. 其余（单个变量 x、x y、a-b、3x）是公式。
function looksLikeMath(inner: string): boolean {
  if (!inner || inner.includes("$")) return false;
  if (COMMAND.test(inner) || OPERATOR.test(inner)) return true;
  if (CJK.test(inner) || NUMBER_LIST.test(inner)) return false;
  return !/[A-Za-z]{3,}/.test(inner);
}

// 表格行、标题行（可以在引用块里）：这些行里不能断行
const SINGLE_LINE_BLOCK = /^(?:[ \t]*>)*[ \t]*(?:\||#{1,6}(?:[ \t]|$))/;

const LINE_PREFIX = /^((?:[ \t]*>)*[ \t]*)(?:([-*+]|\d{1,9}[.)])([ \t]+))?/;

// 把一段块级公式写成 $$ 围栏。围栏能直接打断段落，所以不需要额外的空行：
// 定界符本来就单独占行时（模型常见的 `> \[` / `> I = …` / `> \]`）行结构原样保留，只是把 \[ 和 \] 换成 $$；
// 前后夹着文字的，在定界符处断行，新行沿用当前行的缩进 / 引用前缀 / 列表项缩进（cont）。
function displayBlock(out: string, inner: string): { out: string; cont: string } {
  const lineStart = out.lastIndexOf("\n") + 1;
  const cur = out.slice(lineStart);
  const m = cur.match(LINE_PREFIX)!;
  const cont = m[1] + (m[2] ? " ".repeat(m[2].length + m[3].length) : "");
  const atLineStart = cur.slice(m[0].length).trim() === "";
  let res = atLineStart ? out : out.replace(/[ \t]+$/, "") + "\n" + cont;

  const pieces = inner.split("\n");
  res += "$$";
  if (pieces.length === 1) {
    res += "\n" + cont + pieces[0].trim() + "\n" + cont + "$$";
    return { out: res, cont };
  }
  const first = pieces[0].trim();
  if (first) res += "\n" + cont + first;
  for (const mid of pieces.slice(1, -1)) res += "\n" + mid.trimEnd();
  const last = pieces[pieces.length - 1];
  // 收尾的 \] 单独占一行（行首只有缩进 / 引用前缀）时，围栏就写在原来的位置上
  res += /^[ \t>]*$/.test(last)
    ? "\n" + last + "$$"
    : "\n" + last.trimEnd() + "\n" + cont + "$$";
  return { out: res, cont };
}

function normalizeMathIn(text: string): string {
  if (!text.includes("$") && !text.includes("\\")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const kind = text[i + 1];
      if (kind === "(" || kind === "[") {
        const close = latexClose(text, i + 2, kind === "(" ? ")" : "]");
        const inner = close < 0 ? "" : text.slice(i + 2, close).trim();
        if (close >= 0 && looksLikeMath(inner)) {
          let next = close + 2;
          // 单行的 \[ … \] 出现在表格行（以 | 开头）或标题行（# 开头）里时当行内公式：块级公式要断行，会拆坏表格和标题
          const inlineOnly =
            kind === "[" &&
            !inner.includes("\n") &&
            SINGLE_LINE_BLOCK.test(out.slice(out.lastIndexOf("\n") + 1));
          if (kind === "(" || inlineOnly) {
            // 行内：多行的折成一行（顺带去掉引用前缀），$…$ 紧贴内容
            out += "$" + inner.replace(/\n[ \t]*(?:>[ \t]*)*/g, " ") + "$";
          } else {
            const block = displayBlock(out, text.slice(i + 2, close));
            out = block.out;
            while (text[next] === " " || text[next] === "\t") next++;
            // 定界符后面同一行还有文字：另起一行接着写
            if (next < text.length && text[next] !== "\n") out += "\n" + block.cont;
          }
          i = next;
          continue;
        }
      }
      out += text.slice(i, i + 2);
      i += 2;
    } else if (ch === "`") {
      const stop = inlineCodeStop(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else if (ch === "$" && text[i + 1] === "$") {
      const end = text.indexOf("$$", i + 2);
      const stop = end < 0 ? i + 2 : end + 2;
      out += text.slice(i, stop);
      i = stop;
    } else if (ch === "$") {
      const close = closingDollar(text, i);
      if (close < 0) {
        out += "\\$";
        i++;
      } else {
        out += text.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function normalizeMath(text: string): string {
  if (!text.includes("$") && !text.includes("\\")) return text;
  return splitCode(text)
    .map((p) => (p.code ? p.text : normalizeMathIn(p.text)))
    .join("\n");
}

// ── 中文排版 ──
//
// 模型写中文课文时常用 ASCII 直引号（"凭感觉"）、弯引号（“凭感觉”）和半角冒号（难度: 入门），和界面里的全角标点（「」）不一样；
// 同一门课里两种引号还会交替出现。渲染时统一：
// - 双引号统一成「」，嵌套的一层用『』：成对的 ASCII 直引号和模型自己写的弯引号 “ ” 都转（弯引号自带方向，不要求成对）；
//   引号里再套的单弯引号 ‘ ’（成对才转）转成『』；模型已经写的「」『』也算进嵌套层数里。全是一个字符换一个字符，划线的位置不受影响；
// - 紧跟在汉字后面的半角冒号 → 全角「：」，冒号后面的空格去掉（可隔着一层加粗的 ** / __：「**难度**: 入门」）。
// 判断的粒度是「一行 / 一个列表项 / 一个表格单元格」：这一格里有汉字才处理，没有汉字的（英文例句、英文列表项、
// 夹在中文表格里的英文单元格）原样不动，同一段里中英文行互不连累。
// 不动：围栏 / 缩进代码块、行内代码、公式（$…$、$$…$$）、链接的地址和标题、链接引用定义行（`[a]: url "title"`）、
// HTML 标签、裸网址、被反斜杠转义的字符。
// 引号按这一格配对：引号个数是奇数（有一个没配上）就这一格的引号都不动，宁可不改也不改错；
// 前面紧跟标识符加「(」或「=」的引号（print("x")、name="x"）当代码，这一对不动。
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const URL_BODY = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i;
const TAG = /^(?:<\/?[A-Za-z][^<>\n]*>|<https?:\/\/[^<>\s]+>)/;
const CODE_LIKE_PREFIX = /[A-Za-z_][A-Za-z0-9_]*\s*[(=]\s*$/;
// 链接引用定义（`[a]: https://x.com "标题"`）：整行原样放过
const REF_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S/;
// 表格行：行首（可以在引用块里）是竖线，这一行里没转义的 | 把单元格隔开，每格单独判断
const TABLE_ROW = /^(?:[ \t]*>)*[ \t]*\|/;

// `$…$`（行内公式）收尾的位置：同一段里下一个没被转义的 $；找不到返回 -1
function inlineMathEnd(text: string, open: number): number {
  for (let j = open + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "$") return j;
    else if (ch === "\n") {
      let k = j + 1;
      while (text[k] === " " || text[k] === "\t") k++;
      if (text[k] === "\n") return -1;
    }
  }
  return -1;
}

// `](` 之后到配对的 `)`：链接 / 图片的地址和标题（里面常有直引号），原样放过。括号可以嵌套；找不到返回 -1
function linkTargetEnd(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return j + 1;
    else if (ch === "\n" && text[j + 1] === "\n") return -1;
  }
  return -1;
}

const QUOTE_MARKS = new Set(["“", "”", "‘", "’", "「", "」", "『", "』"]);

// 双引号配得上吗：直引号一开一合，弯引号 “ 开 ” 合，一对里不能混着用（"好” 不行），不能先合后开（”好” 不行），
// 不能连着开了两层都没合（“好“ 不行）。结尾最多留一个还没合上的 “（流式写到一半、模型漏写了收尾，方向是对的，照转）。
// 模型自己写的「」『』不参与判断（它们不会被改）
function doubleQuotesWellFormed(events: { ch: string }[]): boolean {
  const stack: ("s" | "c")[] = [];
  for (const { ch } of events) {
    if (ch === '"') {
      if (stack[stack.length - 1] === "c") return false;
      if (stack[stack.length - 1] === "s") stack.pop();
      else stack.push("s");
    } else if (ch === "“") {
      stack.push("c");
    } else if (ch === "”") {
      if (stack[stack.length - 1] !== "c") return false;
      stack.pop();
    }
  }

  return stack.length === 0 || (stack.length === 1 && stack[0] === "c");
}

// 一格里的引号改成「」『』：按出现的先后走一遍，数着嵌套的层数——一层「」、再里面一层『』。
// 直引号（straight，已经确认成对）一开一合交替；弯引号 “ ” 自带方向；模型自己写的「」『』只用来数层数，不改。
// 单弯引号 ‘ ’ 只在双引号里面、成对出现时才转（英文的所有格撇号 don’t 不会被当成引号）。
function quoteMarks(out: string[], straight: number[], skipped: Set<number>, marks: { at: number; ch: string }[]) {
  const events = [
    ...straight.flatMap((at, n) => (skipped.has(n) ? [] : [{ at, ch: '"', open: n % 2 === 0 }])),
    ...marks.map(({ at, ch }) => ({ at, ch, open: ch === "“" || ch === "「" || ch === "『" || ch === "‘" })),
  ].sort((a, b) => a.at - b.at);
  // 这一格的双引号写得不对（弯引号方向反了、直引号和弯引号混着配对、直引号个数是奇数）：整格的双引号都不转，宁可不改也不改错
  if (!doubleQuotesWellFormed(events)) return;
  let depth = 0;
  let single: number | null = null; // 还没配上的 ‘ 的位置

  for (const { at, ch, open } of events) {
    if (ch === "‘" || ch === "’") {
      if (open && depth >= 1 && single === null) single = at;
      else if (!open && single !== null) {
        out[single] = "『";
        out[at] = "』";
        single = null;
      }
    } else if (open) {
      depth++;
      if (ch === '"' || ch === "“") out[at] = depth === 1 ? "「" : "『";
    } else {
      if (ch === '"' || ch === "”") out[at] = depth <= 1 ? "」" : "』";
      depth = Math.max(0, depth - 1);
    }
  }
}

function zhTypographyIn(text: string): string {
  const out: string[] = [];
  let quotes: number[] = []; // 本段里直引号在 out 里的位置
  let marks: { at: number; ch: string }[] = []; // 本段里模型写的弯引号、「」『』（位置，字符）
  let skipped = new Set<number>(); // 本段里按代码处理的直引号（序号）
  let han = false;
  let lastBase = ""; // 上一个不是加粗符号的普通字符（看冒号前面是不是汉字）

  const plain = (chunk: string) => {
    out.push(chunk);
    if (HAN.test(chunk)) han = true;
    if (chunk !== "*" && chunk !== "_") lastBase = chunk;
  };
  const keep = (chunk: string) => {
    out.push(chunk);
    lastBase = "";
  };
  // 一格（一行或一个表格单元格）到这里结束：这一格里有汉字、引号配得成对，才改
  const endParagraph = () => {
    if (han) quoteMarks(out, quotes, skipped, marks);
    quotes = [];
    marks = [];
    skipped = new Set();
    han = false;
  };

  let i = 0;
  let lineStart = true;
  let tableRow = false;
  while (i < text.length) {
    const ch = text[i];

    if (lineStart) {
      lineStart = false;
      const rest = text.slice(i, text.indexOf("\n", i) < 0 ? undefined : text.indexOf("\n", i));
      if (REF_DEFINITION.test(rest)) {
        keep(rest);
        i += rest.length;
        continue;
      }
      tableRow = TABLE_ROW.test(rest);
    }

    if (ch === "\n") {
      // 换行：这一行结束（空行也一样）
      endParagraph();
      keep(ch);
      i++;
      lineStart = true;
      continue;
    }

    if (ch === "|" && tableRow) {
      endParagraph();
      plain(ch);
      i++;
    } else if (ch === "\\" && i + 1 < text.length) {
      keep(text.slice(i, i + 2));
      i += 2;
    } else if (ch === "`") {
      const stop = inlineCodeStop(text, i);
      keep(text.slice(i, stop));
      i = stop;
    } else if (ch === "$") {
      const display = text[i + 1] === "$";
      const close = display ? text.indexOf("$$", i + 2) : inlineMathEnd(text, i);
      const stop = close < 0 ? i + (display ? 2 : 1) : close + (display ? 2 : 1);
      if (close < 0 && !display) plain(ch);
      else keep(text.slice(i, stop));
      i = stop;
    } else if (ch === "]" && text[i + 1] === "(") {
      const stop = linkTargetEnd(text, i + 1);
      if (stop < 0) {
        plain(ch);
        i++;
      } else {
        keep(text.slice(i, stop));
        i = stop;
      }
    } else if (ch === "<" && TAG.test(text.slice(i, i + 400))) {
      const stop = i + text.slice(i, i + 400).match(TAG)![0].length;
      keep(text.slice(i, stop));
      i = stop;
    } else if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(text.slice(i, i + 8)) && !/[A-Za-z0-9]/.test(lastBase)) {
      const url = text.slice(i).match(URL_BODY)![0];
      keep(url);
      i += url.length;
    } else if (QUOTE_MARKS.has(ch)) {
      marks.push({ at: out.length, ch });
      plain(ch);
      i++;
    } else if (ch === '"') {
      const n = quotes.length;
      // 这一对是不是代码：开头的引号前面紧跟「标识符 + ( 或 =」
      if (n % 2 === 0 && CODE_LIKE_PREFIX.test(text.slice(Math.max(0, i - 40), i))) {
        skipped.add(n);
        skipped.add(n + 1);
      }
      quotes.push(out.length);
      plain(ch);
      i++;
    } else if (ch === ":" && HAN.test(lastBase) && text[i + 1] !== ":" && text[i + 1] !== "/") {
      plain("：");
      i++;
      while (text[i] === " " || text[i] === "\t") i++;
    } else {
      plain(ch);
      i++;
    }
  }
  endParagraph();
  return out.join("");
}

// 中文排版（见上面的说明）：Markdown 文本 / 纯文本都可以。没有汉字的文本原样返回
export function zhTypography(text: string): string {
  if (!HAN.test(text)) return text;
  return splitCode(text)
    .map((p) => (p.code ? p.text : zhTypographyIn(p.text)))
    .join("\n");
}

// ── 导入原文里的加粗 ──
//
// txt、Word、网页导入时按纯文本处理，原文里写着的 **加粗** 被转义成 \*\*（后端 document_import.escape_text、markdownify、trafilatura），
// 页面上露出两对星号。这类原文多半是从 AI 对话、Markdown 稿里粘过来的，作者本意是加粗：成对的 \*\*…\*\* 还原成 **…**。
// 只认一行之内、里面首尾不是空白的一对；开头前面紧跟字母数字的不认（x\*\*2 + y\*\*2、2\*\*10 是乘方）。代码区域不动。
const ESCAPED_BOLD = /(^|[^A-Za-z0-9\\])\\\*\\\*(?=\S)((?:(?!\\\*\\\*)[^\n])*?\S)\\\*\\\*/g;

function restoreBoldIn(text: string): string {
  let out = "";
  let prose = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") {
      prose += text.slice(i, i + 2);
      i += 2;
    } else if (text[i] === "`") {
      const stop = inlineCodeStop(text, i);
      out += prose.replace(ESCAPED_BOLD, "$1**$2**") + text.slice(i, stop);
      prose = "";
      i = stop;
    } else {
      prose += text[i];
      i++;
    }
  }
  return out + prose.replace(ESCAPED_BOLD, "$1**$2**");
}

export function restoreEscapedBold(text: string): string {
  if (!text.includes("\\*\\*")) return text;
  return splitCode(text)
    .map((p) => (p.code ? p.text : restoreBoldIn(p.text)))
    .join("\n");
}

export function prepareMarkdown(
  text: string | undefined,
  options: {
    hideFeedback?: boolean;
    hideBody?: boolean;
    streaming?: boolean;
    typography?: boolean;
    restoreBold?: boolean;
  } = {}
): string {
  let out = stripHtmlComments(stripFences(text), {
    streaming: options.streaming,
  });
  if (options.hideFeedback) out = hideFeedbackSection(out);
  if (options.hideBody) out = hideBodyHeading(out);
  if (options.restoreBold) out = restoreEscapedBold(out);
  out = normalizeMath(out);
  if (options.typography) out = zhTypography(out);
  return out.trim();
}

// <Markdown> 实际渲染的文字：lesson 时隐藏「你的反馈」小节和「正文内容」标题。课文页的目录（lib/learn/outline.ts）
// 也从这份文字取标题，两边必须一致——标题的锚点按第几个标题编号
export function markdownText(
  text: string | undefined,
  { lesson = false, ...options }: { lesson?: boolean; streaming?: boolean; typography?: boolean; restoreBold?: boolean } = {}
): string {
  return prepareMarkdown(text, { hideFeedback: lesson, hideBody: lesson, ...options });
}
