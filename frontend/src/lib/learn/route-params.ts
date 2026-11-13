// 路由里的 courseId、lessonNum 会被拼进后端路径，只接受不带前导零的非负整数。
export const isRouteId = (value: string) => /^(0|[1-9]\d{0,14})$/.test(value);

// ?annotation=<id>（课文页的深链接）：只认一个正整数；重复参数取第一个，别的都当没有
export function annotationParam(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw !== undefined && /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : undefined;
}
