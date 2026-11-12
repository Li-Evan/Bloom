// 昵称的规则，和后端（backend/app/schemas.py 的 clean_nickname 与 UpdateMeRequest）同一套，tests/round2-front-a.test.mjs 读后端源码对照：
// 1. 规整：看起来是空白的填充字符（韩文填充符等）、控制类（Cc）、行 / 段分隔（Zl、Zp）换成空格；格式类（Cf：零宽字符、方向控制符）、
//    代理（Cs）、私用（Co）、未分配（Cn）去掉；ZWJ / ZWNJ 夹在两个非空白字符之间时保留（emoji 序列、一些文字要用），贴着空白或在首尾时去掉；
//    再把连续的空白合成一个空格、去首尾空白；
// 2. 规整之后至少有一个字母或数字（Unicode 类别 L*、N*）：只剩符号、emoji、空白、零宽字符（包括空的）都不行；
// 3. 规整之后最多 50 个字符（按码点数）。
// 提交前先在这里查一遍；后端的 422（detail 是 pydantic 的校验数组）也转成本地化的人话，不露出后端原文。
export const MAX_NICKNAME = 50;

export const NICKNAME_RULES = {
  blankFillers: ["\u115f", "\u1160", "\u3164", "\uffa0", "\u17b4", "\u17b5"],
  toSpace: ["Cc", "Zl", "Zp"],
  dropped: ["Cf", "Cs", "Co", "Cn"],
  joiners: ["\u200c", "\u200d"],
} as const;

const category = (names: readonly string[]) => new RegExp(`^[${names.map((name) => `\\p{${name}}`).join("")}]$`, "u");
const TO_SPACE = category(NICKNAME_RULES.toSpace);
const DROPPED = category(NICKNAME_RULES.dropped);
const JOINERS = NICKNAME_RULES.joiners.join("");
const EDGE_JOINERS = new RegExp(`(?:^|(?<=\\s))[${JOINERS}]+|[${JOINERS}]+(?=\\s|$)`, "g");

export function cleanNickname(value: string): string {
  let text = "";
  for (const ch of value) {
    if ((NICKNAME_RULES.blankFillers as readonly string[]).includes(ch) || TO_SPACE.test(ch)) text += " ";
    else if (JOINERS.includes(ch)) text += ch;
    else if (!DROPPED.test(ch)) text += ch;
  }

  return text.replace(EDGE_JOINERS, "").replace(/\s+/g, " ").trim();
}

export type NicknameProblem = "length" | "needsLetter";

export function nicknameProblem(value: string, max = MAX_NICKNAME): NicknameProblem | null {
  const cleaned = cleanNickname(value);
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return "needsLetter";

  return Array.from(cleaned).length > max ? "length" : null;
}

// 后端返回 422 时的 detail：pydantic 的校验错误数组，昵称的两条是自定义错误（type 是 nickname_needs_letter / nickname_too_long）。
// 认不出来的 422（字段缺失、类型不对）按「长度不对」说，总不会露出英文原文
export function nicknameProblemFromDetail(detail: unknown): NicknameProblem {
  const items = Array.isArray(detail) ? (detail as { type?: unknown; msg?: unknown }[]) : [];
  const needsLetter = items.some(
    (item) => item?.type === "nickname_needs_letter" || (typeof item?.msg === "string" && item.msg.includes("字母或数字"))
  );

  return needsLetter ? "needsLetter" : "length";
}
