import { getAnnotations } from "@/lib/learn/api";
import type { Annotation, Message } from "@/lib/learn/types";
import type { NoteItem } from "@/lib/me/types";

// 笔记接口（/api/me/annotations）只给回答的前 200 字。要看全文，就取那条笔记所在课文的全部划线问答（GET），
// 按 id 找到那一条的完整对话。同一篇课文的结果短时间内共用（连着展开几条笔记不重复取），但不会一直用旧的：
// - 过了 TTL 就重取；
// - 笔记接口说这条有 N 条消息、缓存里的对话比它少（回课文追问过），或者缓存里找不到这条（刚建的）：清掉这一篇重取一次；
// - 取失败不缓存，下次再试。
// 导出不走这里（export.ts 里一律直接取最新）。
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; list: Promise<Annotation[]> }>();

const keyOf = (courseId: number, lessonNumber: number) => `${courseId}/${lessonNumber}`;

export function forgetLessonAnnotations(courseId: number, lessonNumber: number) {
  cache.delete(keyOf(courseId, lessonNumber));
}

export function lessonAnnotations(courseId: number, lessonNumber: number): Promise<Annotation[]> {
  const key = keyOf(courseId, lessonNumber);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;

  const list = getAnnotations(courseId, lessonNumber);
  cache.set(key, { at: Date.now(), list });
  list.catch(() => {
    if (cache.get(key)?.list === list) cache.delete(key);
  });

  return list;
}

// 这条笔记的完整对话（提问、回答、追问）；这条笔记已经被删了就是 null
export async function fullConversation(note: NoteItem): Promise<Message[] | null> {
  const find = (list: Annotation[]) => list.find((annotation) => annotation.id === note.id)?.messages ?? null;

  let messages = find(await lessonAnnotations(note.course_id, note.lesson_number));
  if (!messages || messages.length < note.message_count) {
    forgetLessonAnnotations(note.course_id, note.lesson_number);
    messages = find(await lessonAnnotations(note.course_id, note.lesson_number));
  }

  return messages;
}

// 后端把回答截成前 200 字（去掉 Markdown 标记之后），没有省略号。长度到了上限就是被截过的：补「…」，
// 英文在最后一个空格处收尾（不停在半个词中间），中文没有空格，按字截。
const PREVIEW_LIMIT = 200;

export function previewText(text: string): { text: string; cut: boolean } {
  if (text.length < PREVIEW_LIMIT - 1) return { text, cut: false };

  const space = text.lastIndexOf(" ");
  const base = /[A-Za-z0-9]$/.test(text) && space > text.length * 0.6 ? text.slice(0, space) : text;

  return { text: base.replace(/[\s,，、;；:：]+$/, ""), cut: true };
}
