import { lessonTitle } from "@/lib/learn/lessons";
import type { NoteItem } from "@/lib/me/types";

// 划线摘录来自课文原文，带着 Markdown 标记和换行；显示时压成一段干净的文字
export function plainExcerpt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (text: string) => text.toLocaleLowerCase();

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 句末标点（句号、问号、叹号、分号）；英文的句号后面要跟空白，免得把 3.14、e.g. 当成句末
const SENTENCE_END = /[。！？；!?;]|\.(?=\s|$)/g;
// 显示宽度：汉字算两个单位，其余一个
const widthOf = (text: string) => [...text].reduce((sum, ch) => sum + (HAN.test(ch) ? 2 : 1), 0);

// 摘录太长时按句子边界截断并加「…」，不再在半句话里被 CSS 的省略号切断：
// 在 limit 个显示单位以内，取最后一个句末；整段只有一句或第一句就超出，退到最后一个逗号、顿号或空格；还不行就硬切。
// 搜索词命中在被截掉的后半段时，从命中所在的那一句开始截（前面加「…」），保证命中的词看得见。
export function clipExcerpt(text: string, limit = 220, query = ""): string {
  if (widthOf(text) <= limit) return text;

  const ends = [...text.matchAll(SENTENCE_END)].map((m) => m.index! + m[0].length);
  const sentenceStarts = [0, ...ends];
  let start = 0;
  const needle = norm(query.trim());
  const hit = needle ? norm(text).indexOf(needle) : -1;
  if (hit >= 0 && widthOf(text.slice(0, hit + needle.length)) > limit) {
    start = [...sentenceStarts].reverse().find((at) => at <= hit) ?? 0;
  }

  const body = text.slice(start).trimStart();
  const prefix = start > 0 ? "…" : "";
  if (widthOf(body) <= limit) return prefix + body;

  const cut = (pattern: RegExp) => {
    let used = 0;
    let last = -1;
    for (const m of body.matchAll(pattern)) {
      const end = m.index! + m[0].length;
      if (widthOf(body.slice(0, end)) > limit) break;
      used = end;
      last = used;
    }

    return last;
  };
  // 至少留下四分之一的长度，免得只剩一个很短的第一句
  const enough = (at: number) => at > 0 && widthOf(body.slice(0, at)) >= limit / 4;
  let at = cut(SENTENCE_END);
  if (!enough(at)) at = cut(/[，、,：:\s]+/g);
  if (!enough(at)) {
    let used = 0;
    at = 0;
    for (const ch of body) {
      used += HAN.test(ch) ? 2 : 1;
      if (used > limit) break;
      at += ch.length;
    }
  }

  return `${prefix}${body.slice(0, at).trimEnd().replace(/[，、,：:;；]+$/, "")}…`;
}

export function noteMatches(note: NoteItem, query: string): boolean {
  const needle = norm(query.trim());
  if (!needle) {
    return true;
  }

  return [note.original_text, note.question, note.answer_preview, note.course_name, lessonTitle(note.lesson_title)].some(
    (field) => norm(field).includes(needle)
  );
}

export function filterNotes(notes: NoteItem[], query: string, courseId: number | null): NoteItem[] {
  return notes.filter((note) => (courseId === null || note.course_id === courseId) && noteMatches(note, query));
}

export interface NoteGroup {
  courseId: number;
  courseName: string;
  notes: NoteItem[];
}

// 按课程分组：课程顺序跟着各自最近的一条笔记走（笔记本身已经按时间倒序）
export function groupByCourse(notes: NoteItem[]): NoteGroup[] {
  const groups = new Map<number, NoteGroup>();
  for (const note of notes) {
    const group = groups.get(note.course_id) ?? {
      courseId: note.course_id,
      courseName: note.course_name,
      notes: [],
    };
    group.notes.push(note);
    groups.set(note.course_id, group);
  }

  return [...groups.values()];
}

export function noteCourses(notes: NoteItem[]): { id: number; name: string; count: number }[] {
  const courses = new Map<number, { id: number; name: string; count: number }>();
  for (const note of notes) {
    const course = courses.get(note.course_id) ?? { id: note.course_id, name: note.course_name, count: 0 };
    course.count++;
    courses.set(note.course_id, course);
  }

  return [...courses.values()];
}

// 把文本按关键词切成「命中 / 没命中」的片段，用来高亮。空关键词整段原样返回。
export function splitMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const needle = query.trim();
  if (!needle) {
    return [{ text, hit: false }];
  }

  const lower = norm(text);
  const target = norm(needle);
  const parts: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(target); at !== -1; at = lower.indexOf(target, from)) {
    if (at > from) {
      parts.push({ text: text.slice(from, at), hit: false });
    }
    parts.push({ text: text.slice(at, at + target.length), hit: true });
    from = at + target.length;
  }
  if (from < text.length) {
    parts.push({ text: text.slice(from), hit: false });
  }

  return parts;
}

// 追问了几次：消息里提问和回答各一条，第一问一答是 2 条
export function followUps(messageCount: number): number {
  return Math.max(0, Math.floor((messageCount - 2) / 2));
}
