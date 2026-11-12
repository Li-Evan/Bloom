import type { Annotation, Session } from "@/lib/learn/types";

// 划线提问 / 追问点了停止或断了线：后端照样在后台把回答写完、保存（courses.py 的 create_annotation / add_annotation_message）。
// 页面记下在等哪一份回答，过一会儿重新拉本篇的问答列表，拉到了就换上；在那之前这条问答不能删（删了，后台写完会再建一条，「复活」）。
// 问答列表的响应里没有 request_id，只能按内容认：
// - 首次提问还没收到一个字（selection 有值）：等后台新建的那一条——本地还没有、同一处选区、同一个问题、已经有回答；
// - 首次提问停在半截、追问（不管收没收到字）：等这一条里第 nth 次出现的这个问题后面，跟着一段和已存下的半截（partial）不一样的回答
export const BACKGROUND_CHECK_MS = [20_000, 60_000, 120_000] as const;
// 最多等这么久：之后删除按钮放开，没等到的临时气泡改说「请稍后刷新查看」
export const BACKGROUND_WAIT_MS = 120_000;

export interface BackgroundWait {
  // 本地的问答 id（临时 id 或已存的 id）
  id: number | string;
  question: string;
  // 这个问题在这条问答里是第几次出现（从 0 数）：同一个问题之前问过、答过，不能拿旧的那次当成这次
  nth: number;
  // 已存下的半截回答（还没收到字就是 ""）：后台写完会把它换成完整的
  partial: string;
  selection?: Pick<Session, "original_text" | "position_start" | "position_end" | "pdf_position">;
}

// 第 nth 次出现的这个问题后面那段回答；没有（还没写完、问题还没出现）返回 undefined
export function answerAfter(messages: Session["messages"], question: string, nth: number): string | undefined {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user" || messages[i].content !== question) continue;
    if (seen++ < nth) continue;
    const next = messages[i + 1];

    return next?.role === "assistant" ? next.content : undefined;
  }

  return undefined;
}

export const countQuestion = (messages: Session["messages"], question: string) =>
  messages.filter((m) => m.role === "user" && m.content === question).length;

const answered = (wait: BackgroundWait, annotation: Annotation) => {
  const answer = answerAfter(annotation.messages, wait.question, wait.nth);

  return answer !== undefined && answer !== wait.partial;
};

// fresh：刚拉到的本篇问答；local：页面上现有的（首次提问时，本地已经有的那些不算后台新建的）
export function settledAnswer(wait: BackgroundWait, fresh: Annotation[], local: Session[]): Annotation | undefined {
  const { selection } = wait;
  if (!selection) return fresh.find((a) => a.id === wait.id && answered(wait, a));

  return fresh.find(
    (a) =>
      !local.some((s) => s.id === a.id) &&
      a.comment === wait.question &&
      a.original_text === selection.original_text &&
      a.position_start === selection.position_start &&
      a.position_end === selection.position_end &&
      (a.pdf_position ?? null) === (selection.pdf_position ?? null) &&
      answered(wait, a)
  );
}
