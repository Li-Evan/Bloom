// 参考原文可能有上百万字，一次渲染完手机会卡死：按行切成约 size 字一段，先显示第一段，滚到接近底部再接下一段。
// Markdown 只在空行处切（不把一个段落、列表项切成两半），也不在 ``` / ~~~ 围起来的代码块中间切；纯文本在任意换行处切
export const PROGRESSIVE_CHARS = 50_000;

export function splitForDisplay(text: string, markdown: boolean, size = PROGRESSIVE_CHARS): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let length = 0;
  let fence = false;
  for (const line of text.split("\n")) {
    if (length >= size && !fence && (!markdown || !line.trim())) {
      parts.push(current.join("\n"));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
    if (markdown && /^ {0,3}(```|~~~)/.test(line)) fence = !fence;
  }
  parts.push(current.join("\n"));

  return parts;
}
