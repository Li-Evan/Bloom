import { normalizeMath } from "@/lib/learn/lesson-text";

export interface NotePreviewPart {
  text: string;
  math: boolean;
}

// 摘要是已经去掉普通 Markdown 标记的文本，公式仍保留。只把完整公式交给数学渲染器。
export function notePreviewParts(text: string, cut: boolean): NotePreviewPart[] {
  const normalized = normalizeMath(text);
  const parts: NotePreviewPart[] = [];
  let from = 0;
  const plain = (value: string, tail = false) => {
    // normalizeMath 把没有收尾的 $ 转义。被后端截断的公式不能露出半截命令；美元金额照常保留。
    if (tail && cut) value = value.replace(/(?:\\\$(?=[A-Za-z\\({])|\\[([])[\s\S]*$/, "").trimEnd();
    if (value) parts.push({ text: value.replace(/\\\$/g, "$"), math: false });
  };
  for (const match of normalized.matchAll(/(?<!\\)(\${1,2})([\s\S]+?)\1/g)) {
    plain(normalized.slice(from, match.index));
    parts.push({ text: `$${match[2].trim().replace(/\n/g, " ")}$`, math: true });
    from = match.index! + match[0].length;
  }
  plain(normalized.slice(from), true);
  return parts;
}
