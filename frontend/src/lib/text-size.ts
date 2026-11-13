// 正文字号（设置 → 偏好 → 正文字号；课文页、大纲页顶上的「字号」按钮是同一个）：只放大缩小 .prose-bloom 里的阅读正文
// （课文、问答回答、资料原文、大纲），按钮、导航这些界面文字不变，版面不会被撑坏。
// 选择存在本机 localStorage；<html data-text-size> 由根布局里的 TEXT_SIZE_SCRIPT 在首次绘制前设好，不会先闪一下默认字号，
// 别的标签页改了也跟着变（storage 事件）。theme.css 按 data-text-size 设 --text-scale，globals.css、learn.css 里正文的字号都乘它。
export const TEXT_SIZES = ["sm", "md", "lg", "xl", "xxl"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

const KEY = "bloom:text-size";
const CHANGE = "bloom:text-size-change";

export const TEXT_SIZE_SCRIPT = `(function(){var d=document.documentElement;function a(s){if(s)d.dataset.textSize=s;else delete d.dataset.textSize}try{a(localStorage.getItem("${KEY}"))}catch(e){}addEventListener("storage",function(e){if(e.key==="${KEY}")a(e.newValue)})})()`;

export function parseTextSize(value: string | null | undefined): TextSize {
  return TEXT_SIZES.find((size) => size === value) ?? "md";
}

export function readTextSize(): TextSize {
  return parseTextSize(document.documentElement.dataset.textSize);
}

export function saveTextSize(size: TextSize) {
  const root = document.documentElement;
  if (size === "md") delete root.dataset.textSize;
  else root.dataset.textSize = size;
  try {
    if (size === "md") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, size);
  } catch { /* 存不下（隐私模式）就只管这一页 */ }
  window.dispatchEvent(new Event(CHANGE));
}

// 根布局（服务端组件）要引 TEXT_SIZE_SCRIPT，这里不能引 React 的客户端 hook：
// 组件里用 useSyncExternalStore(subscribeTextSize, readTextSize, () => null)，服务端渲染时还不知道本机选了哪档，先什么都不选中
export function subscribeTextSize(onChange: () => void) {
  const stored = (event: StorageEvent) => { if (event.key === KEY) onChange(); };
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", stored);
  };
}
