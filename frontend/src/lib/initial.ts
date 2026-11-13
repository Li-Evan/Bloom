// 头像里显示的「首字」：中文取第一个字，英文取首字母并大写。昵称为空时显示 ?
export function initialOf(name?: string | null): string {
  const chars = Array.from((name ?? "").trim());
  const first = chars.find((c) => /[\p{L}\p{N}]/u.test(c)) ?? chars[0] ?? "?";

  return first.toUpperCase();
}
