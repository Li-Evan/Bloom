import { getAnnotations } from "@/lib/learn/api";
import { previewText } from "@/lib/me/annotations";
import { getNotesPage } from "@/lib/me/api";
import { lessonTitle } from "@/lib/learn/lessons";
import { plainExcerpt } from "@/lib/me/notes";
import type { Message } from "@/lib/learn/types";
import type { NoteItem } from "@/lib/me/types";

// 把「我的笔记」导出成一份 Markdown（按课程分组）。全在浏览器里做：分页取全 /api/me/annotations，
// 再按课文取完整对话（笔记接口只有回答的前 200 字），生成文件下载。只发 GET。

const PAGE = 100;
// 最多取这么多页（2 万条），防止异常数据让导出永远停不下来
const MAX_PAGES = 200;
const PARALLEL = 6;

export interface ExportLabels {
  title: string;
  exported: string; // 「导出于 2026-10-15 · 共 12 条笔记」（取完笔记之后才知道条数，由调用方填好）
  lesson: (number: number) => string; // 第 2 篇
  summary: string; // 课程总结
  question: string;
  answer: string;
  open: string; // 回到课文
  truncated: string; // 回答只取到了开头
}

export interface ExportNote {
  note: NoteItem;
  // 完整对话；取不到时是 null，导出里用回答摘要顶上
  messages: Message[] | null;
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

// 提问的日期按浏览器本地时区写（和界面上显示的一致），不是 UTC 的日期
const day = (iso: string) => {
  const date = new Date(iso);

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

// 标题里放的是用户写的字（课程名、课文标题）：Markdown 的特殊字符转义，不然「* [ ]」「`」之类会被当成语法。换行压成空格
const escapeInline = (text: string) => text.replace(/\s+/g, " ").trim().replace(/([\\`*_\[\]<>|~#!&])/g, "\\$1");

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

// 回答里的 # 标题降成粗体行：文件自己的层级是 课程(##) / 课文(###)，回答里再出现 # 会把结构搅乱。围栏代码块里的 # 是代码，不动
function demoteHeadings(markdown: string): string {
  let fenced = false;

  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) fenced = !fenced;

      return !fenced && /^\s{0,3}#{1,6}\s+\S/.test(line) ? line.replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, "**$1**") : line;
    })
    .join("\n");
}

// 回答被中途停止时可能停在代码块里（围栏没闭合）：补上收尾的围栏，不然它会一直吞到文件结束
function closeFences(markdown: string): string {
  let open: { char: string; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    const match = line.match(FENCE);
    if (!match) continue;
    const [char, length] = [match[1][0], match[1].length];
    if (!open) open = { char, length };
    else if (char === open.char && length >= open.length && line.trim() === match[1].trim()) open = null;
  }

  return open ? `${markdown.trimEnd()}\n${open.char.repeat(open.length)}` : markdown;
}

// 用户写的、模型写的整段内容（提问、回答）一律放进引用块：里面的 `---`、`# 标题`、未闭合的代码围栏都出不了这个块，
// 不会变成文件自己的分隔线 / 标题，也吞不掉后面的笔记。空行写成单独的 `>`，引用块不断开
function quoted(markdown: string): string {
  return closeFences(markdown.trim())
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

export function buildNotesMarkdown(
  items: ExportNote[],
  { labels, origin, localePath }: { labels: ExportLabels; origin: string; localePath: (path: string) => string }
): string {
  const out: string[] = [`# ${labels.title}`, "", labels.exported, ""];

  // 课程按各自最早出现的顺序；课程里按课文编号，同一篇里按提问时间从早到晚
  const courses = new Map<number, { name: string; notes: ExportNote[] }>();
  for (const item of items) {
    const course = courses.get(item.note.course_id) ?? { name: item.note.course_name, notes: [] };
    course.notes.push(item);
    courses.set(item.note.course_id, course);
  }

  for (const course of courses.values()) {
    out.push(`## ${escapeInline(course.name)}`, "");
    const sorted = [...course.notes].sort(
      (a, b) =>
        a.note.lesson_number - b.note.lesson_number ||
        a.note.created_at.localeCompare(b.note.created_at) ||
        a.note.id - b.note.id
    );

    let lastLesson = -1;
    for (const { note, messages } of sorted) {
      if (note.lesson_number !== lastLesson) {
        lastLesson = note.lesson_number;
        const title = lessonTitle(note.lesson_title);
        const head = note.lesson_number > 0 ? labels.lesson(note.lesson_number) : labels.summary;
        out.push(`### ${title ? `${head} · ${escapeInline(title)}` : head}`, "");
      }

      out.push(quote(plainExcerpt(note.original_text)), "");
      if (messages && messages.length > 0) {
        for (const message of messages) {
          const body = message.role === "user" ? message.content : demoteHeadings(message.content);
          out.push(`**${message.role === "user" ? labels.question : labels.answer}**`, "", quoted(body), "");
        }
      } else {
        out.push(`**${labels.question}**`, "", quoted(note.question), "");
        if (note.answer_preview) {
          // 摘要被后端截成 200 字时才加「…」和说明；没截过的就是完整的回答
          const preview = previewText(note.answer_preview);
          out.push(`**${labels.answer}**`, "", quoted(preview.cut ? `${preview.text}…` : preview.text), "");
          if (preview.cut) out.push(`*${labels.truncated}*`, "");
        }
      }
      const link = `${origin}${localePath(`/learn/course/${note.course_id}/lesson/${note.lesson_number}?annotation=${note.id}`)}`;
      out.push(`*${day(note.created_at)}* · [${labels.open}](${link})`, "", "---", "");
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd().concat("\n");
}

// 分页取全部笔记（最近的在前）。onProgress 每取完一页报一次已取到的条数，导出按钮上显示进度
export async function fetchAllNotes(onProgress?: (count: number) => void): Promise<NoteItem[]> {
  const first = await getNotesPage(1, PAGE);
  const notes = [...first.items];
  onProgress?.(notes.length);
  for (let page = 2; notes.length < first.total && page <= MAX_PAGES; page++) {
    const next = await getNotesPage(page, PAGE);
    if (next.items.length === 0) break;
    notes.push(...next.items);
    onProgress?.(notes.length);
  }

  return notes;
}

// 按课文取完整对话，同时最多 PARALLEL 个请求。一律直接取最新（不走笔记展开用的缓存）：用户刚在课文里追问过的话，
// 缓存里的是旧对话，导出就会漏掉追问。某篇取失败，那篇的笔记退回摘要（messages 为 null），不拖垮整个导出。
// onProgress 每处理完一篇课文报一次（已完成篇数, 总篇数）
export async function attachConversations(
  notes: NoteItem[],
  onProgress?: (done: number, total: number) => void
): Promise<ExportNote[]> {
  const lessons = [...new Set(notes.map((n) => `${n.course_id}/${n.lesson_number}`))];
  const byLesson = new Map<string, Map<number, Message[]>>();

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < lessons.length) {
      const key = lessons[next++];
      const [courseId, lessonNumber] = key.split("/").map(Number);
      try {
        const list = await getAnnotations(courseId, lessonNumber);
        byLesson.set(key, new Map(list.map((a) => [a.id, a.messages])));
      } catch {
        // 退回摘要
      }
      onProgress?.(++done, lessons.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, lessons.length) }, worker));

  return notes.map((note) => ({
    note,
    messages: byLesson.get(`${note.course_id}/${note.lesson_number}`)?.get(note.id) ?? null,
  }));
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
