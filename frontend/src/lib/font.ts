// 界面字体（设置 → 界面 → 字体）：只换英文字母和数字，汉字仍走 theme.css 里的中文回退栈。
// 选择存在本机 localStorage；<html data-font> 由根布局里的 FONT_SCRIPT 在首次绘制前设好，不会先闪一下默认字体，
// 别的标签页改了也跟着换（storage 事件）。theme.css 按 data-font 换掉 --font-ui。
export const FONTS = ["outfit", "public-sans", "system"] as const;
export type Font = (typeof FONTS)[number];

const KEY = "bloom:font";
const CHANGE = "bloom:font-change";

export const FONT_SCRIPT = `(function(){var d=document.documentElement;function a(f){if(f)d.dataset.font=f;else delete d.dataset.font}try{a(localStorage.getItem("${KEY}"))}catch(e){}addEventListener("storage",function(e){if(e.key==="${KEY}")a(e.newValue)})})()`;

export function parseFont(value: string | null | undefined): Font {
  return FONTS.find((font) => font === value) ?? "outfit";
}

export function readFont(): Font {
  return parseFont(document.documentElement.dataset.font);
}

export function saveFont(font: Font) {
  const root = document.documentElement;
  if (font === "outfit") delete root.dataset.font;
  else root.dataset.font = font;
  try {
    if (font === "outfit") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, font);
  } catch { /* 存不下（隐私模式）就只管这一页 */ }
  window.dispatchEvent(new Event(CHANGE));
}

export function subscribeFont(onChange: () => void) {
  const stored = (event: StorageEvent) => { if (event.key === KEY) onChange(); };
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", stored);
  };
}
