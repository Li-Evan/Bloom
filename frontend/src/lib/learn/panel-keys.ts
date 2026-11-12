// 划线提问卡片的键盘与草稿规则（纯函数，单测直接 import）。

export interface EscapeEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

// Esc 收起卡片：输入法选字时的 Esc 不算（isComposing，Safari 里是 keyCode 229）；
// 新建提问或追问里写了一半的内容不理会，免得误按一下就丢。
export function shouldCloseOnEscape(
  e: EscapeEvent,
  drafts: { composer: string; follow: string }
): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return !drafts.composer.trim() && !drafts.follow.trim();
}

// 每条问答各自的追问草稿：收起再打开同一条，没发出去的追问还在
export type FollowDrafts = Record<string, string>;

export const draftOf = (drafts: FollowDrafts, id: number | string | null) =>
  id == null ? "" : (drafts[String(id)] ?? "");

export const withDraft = (
  drafts: FollowDrafts,
  id: number | string,
  value: string
): FollowDrafts => ({ ...drafts, [String(id)]: value });
