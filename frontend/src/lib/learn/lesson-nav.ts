// 课文页桌面右栏的「文件 / 课文」列表展开没有：默认收起，点列表上面那一行切换（下面的提问、标记、翻译几组不跟着收）。
// 展开了记在本机 localStorage，换一篇、刷新都还是那样；<html data-lesson-nav="expanded"> 由根布局里的 LESSON_NAV_SCRIPT 在首次绘制前设好，
// 服务端照展开渲染列表，learn.css 在没有这个标记时把它藏起来，所以刷新时收着的不会先闪出整列、展开的也不会先收着再弹开；
// 别的标签页改了也跟着变（storage 事件）。根布局（服务端组件）要引 LESSON_NAV_SCRIPT，这里不能引 React 的客户端 hook：组件里自己调 useSyncExternalStore
const KEY = "bloom:lesson-nav-expanded";
const CHANGE = "bloom:lesson-nav-change";

export const LESSON_NAV_SCRIPT = `(function(){var d=document.documentElement;function a(v){if(v==="1")d.dataset.lessonNav="expanded";else delete d.dataset.lessonNav}try{a(localStorage.getItem("${KEY}"))}catch(e){}addEventListener("storage",function(e){if(e.key==="${KEY}")a(e.newValue)})})()`;

export function readLessonNavExpanded(): boolean {
  return document.documentElement.dataset.lessonNav === "expanded";
}

export function saveLessonNavExpanded(expanded: boolean) {
  const root = document.documentElement;
  if (expanded) root.dataset.lessonNav = "expanded";
  else delete root.dataset.lessonNav;
  try {
    if (expanded) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch { /* 存不下（隐私模式）就只管这一页 */ }
  window.dispatchEvent(new Event(CHANGE));
}

export function subscribeLessonNav(onChange: () => void) {
  const stored = (event: StorageEvent) => { if (event.key === KEY) onChange(); };
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", stored);
  };
}
