// 划线翻译带给模型的上下文：选区前后各取这么多字（选区本身最多 4000 字，加起来不超过后端 translate.py 的 CONTEXT_CHARS）
export const CONTEXT_SIDE_CHARS = 1200;

// 从选区所在的一大段文字里截出以选区为中心的一段；找不到选区（空白和选区对不上）就从头截
export function contextAround(full: string, selected: string): string {
  const flat = full.replace(/\s+/g, " ").trim();
  const passage = selected.replace(/\s+/g, " ").trim();
  const at = Math.max(0, flat.indexOf(passage));

  return flat.slice(Math.max(0, at - CONTEXT_SIDE_CHARS), at + passage.length + CONTEXT_SIDE_CHARS);
}
