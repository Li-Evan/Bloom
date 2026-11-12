// 推荐卡片上「因为你学过《课程名》」：推荐的 source_topics 是模型写的「相关的已学主题」，
// 有时是课程名，有时是大纲里某个掌握项的原文（又长又拗口）。只把能对上用户某门课程名的拿出来，对不上的不显示——
// 推荐理由已经把话说清楚了，一句看不懂的"来自 Compute a posterior probability…"比没有更糟。

const SKIP = /[\s《》“”"'「」『』·:：,，.。、\-—–]/g;
const norm = (text: string) => text.toLowerCase().replace(SKIP, "");

export function studiedCourses(
  topics: string[] | undefined,
  courseNames: string[],
  max = 2
): string[] {
  const names = courseNames
    .map((name) => ({ name, key: norm(name) }))
    .filter(({ key }) => key.length >= 2);
  const out: string[] = [];

  for (const topic of topics ?? []) {
    const key = norm(topic);
    if (!key) continue;
    const hit = names.find(
      (course) =>
        key === course.key ||
        (course.key.length >= 3 && key.includes(course.key)) ||
        (key.length >= 4 && course.key.includes(key))
    );
    if (hit && !out.includes(hit.name)) out.push(hit.name);
    if (out.length >= max) break;
  }

  return out;
}

// 课程名加引号（中文《》，英文弯引号）后按语言连起来：《A》《B》 / “A” and “B”
export function listCourses(names: string[], locale: string): string {
  if (locale === "zh") return names.map((name) => `《${name}》`).join("");

  const quoted = names.map((name) => `“${name}”`);
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(quoted);
}
