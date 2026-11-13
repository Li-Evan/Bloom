// 「问这篇」的对话存在后端（backend/app/lesson_chat.py，每人每篇一份）：提问只交这次的问题，之前的几轮后端从库里接上。

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  // 这篇太长，回答时只带上了读者正在读的位置前后一部分
  partial?: boolean;
};

// 读者正在读的那段最多带这么多字（后端上限 400）
export const ANCHOR_CHARS = 300;

const count = (turns: ChatTurn[], question: string) => turns.filter((t) => t.role === "user" && t.content === question).length;

// 连接断了以后读回来的对话：最后是这次的问题和它的回答（后端答完存好的），就用这份；还没存好返回 undefined。
// 同一个问题以前问过：比提问前多出一次才算这次的，免得拿旧的那次回答当成这次的
export function savedAnswer(saved: ChatTurn[], question: string, before: ChatTurn[]): ChatTurn[] | undefined {
  const [asked, answer] = saved.slice(-2);
  if (asked?.role !== "user" || asked.content !== question || answer?.role !== "assistant") return undefined;

  return count(saved, question) > count(before, question) ? saved : undefined;
}

const BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dt,dd,figcaption";

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function textAt(x: number, y: number): Node | null {
  const doc = document as CaretDocument;
  const node = doc.caretPositionFromPoint?.(x, y)?.offsetNode ?? doc.caretRangeFromPoint?.(x, y)?.startContainer ?? null;
  return node?.nodeType === Node.TEXT_NODE ? node : null;
}

// 读者正在读的那一段：正文里、顶栏下面第一块看得见的文字（PDF 是文字层里的那一行）。课文太长、整篇带不上时，后端以它为中心截一段；
// 找不到就是空串，后端从开头截
export function readingAnchor(article: HTMLElement | null, top: number): string {
  if (!article) return "";
  const box = article.getBoundingClientRect();
  const bottom = Math.min(window.innerHeight, box.bottom);
  for (let y = Math.max(top, box.top) + 12; y < bottom; y += 28) {
    for (const x of [box.left + 48, box.left + box.width / 2]) {
      const node = textAt(x, y);
      if (!node || !article.contains(node)) continue;
      const block = node.parentElement?.closest(BLOCKS) ?? node.parentElement;
      const text = (block?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length >= 8) return text.slice(0, ANCHOR_CHARS);
    }
  }
  return "";
}
