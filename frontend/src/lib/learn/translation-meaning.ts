import { useSyncExternalStore } from "react";

// 划线翻译要不要显示译文后面那句「在这里的意思」（单词和短语下面还有一行词根拆解）：设置页和翻译卡片标题旁的开关是同一个。
// 存在本机 localStorage，默认显示；别的标签页改了也跟着变（storage 事件）。只管显示：译文照样带着那句存下来，关了再开还看得到
const KEY = "bloom:translation-meaning";
const CHANGE = "bloom:translation-meaning-change";
// localStorage 用不了（隐私模式）时只在这一页记着
let fallback = true;

export function readShowMeaning(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return fallback;
  }
}

export function saveShowMeaning(show: boolean) {
  fallback = show;
  try {
    if (show) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch { /* 存不下就只管这一页 */ }
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(onChange: () => void) {
  const stored = (event: StorageEvent) => { if (event.key === KEY) onChange(); };
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", stored);
  };
}

export const useShowMeaning = () => useSyncExternalStore(subscribe, readShowMeaning, () => true);

// 那句话和词根拆解的开头（后端 translate.py 的 MEANING_LABELS、ROOTS_LABELS）
const LABELS = ["在这里的意思：", "In this context:", "词根拆解：", "Word roots:"];

// 把模型的一段回复拆成译文和后面那句「在这里的意思」：空一行、以那个开头起头的就是，后面再空一行的词根拆解一起算进去。流式写到一半、开头还没写全时也先拆出去，
// 关着开关时不会先闪一下；更早存下的译文没有这句，整段都是译文
export function splitMeaning(text: string): { translation: string; meaning: string } {
  const gap = /\n\s*\n/g;
  for (let match = gap.exec(text); match; match = gap.exec(text)) {
    const rest = text.slice(match.index + match[0].length);
    if (LABELS.some((label) => rest.startsWith(label) || label.startsWith(rest))) {
      return { translation: text.slice(0, match.index).trim(), meaning: rest.trim() };
    }
  }

  return { translation: text.trim(), meaning: "" };
}
