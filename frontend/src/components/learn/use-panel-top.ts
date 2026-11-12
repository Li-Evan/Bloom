"use client";

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

// 桌面右栏里的问答卡片：顶部对齐被问的那一段。返回卡片前面那块占位的高度（px）：卡片相对「右栏本身」顶部的下移距离，
// 加上区域向上多出来的那一截（见下）。
// 只看「被问那一段相对右栏的文档位置」（两个元素视口坐标之差，和当前滚动到哪无关），夹在右栏高度以内（右栏和正文一样高，
// 卡片再往下就把页面撑长了）。所以只在卡片打开、被问段落的位置变了、卡片尺寸变了时才会重算，滚动不会改它——
// 滚回被问的那一段，卡片还在它旁边。
// 卡片要始终完整落在视口里，不归这里管：卡片自己是 position: sticky，上下两边都有吸附线（顶栏下面、视口底边上面）、
// 高度不超过两条线之间，内容在卡片里滚；占位和卡片是兄弟，所以向上吸附时卡片可以越过它原本的位置。
// sticky 只在自己的容器（这块区域）里挪，所以区域用负外边距向上、向下各多伸出一截（页面容器的上下内边距那么多），
// 让页面滚到最顶 / 最底时吸附线还在区域里；这两截不属于「右栏本身」，算位置时要扣掉。
export function usePanelTop({
  open,
  version,
  anchor,
  article,
  area,
  card,
  minTop = 0,
}: {
  open: boolean;
  // 换了一张卡片（另一条问答）就变，让监听改挂到新的元素上
  version: unknown;
  // 被问那一段相对课文顶部的位置；null 表示不对着哪一段（「问这篇」），卡片直接放在 minTop
  anchor: number | null;
  article: RefObject<HTMLElement | null>;
  area: RefObject<HTMLElement | null>;
  card: RefObject<HTMLElement | null>;
  // 卡片顶部离右栏顶部至少多远（右栏顶上放着收成一行的课文导航，卡片不能压到它）
  minTop?: number;
}): number {
  const [top, setTop] = useState(0);

  const place = useCallback(() => {
    const box = area.current;
    const el = card.current;
    const paper = article.current;
    // 手机 / 平板上卡片是固定在屏幕底部的抽屉，没有位置可算
    if (!box || !el || !paper || !window.matchMedia("(min-width: 1024px)").matches) {
      setTop(0);
      return;
    }

    const style = getComputedStyle(box);
    const above = Math.max(0, -parseFloat(style.marginTop) || 0);
    const below = Math.max(0, -parseFloat(style.marginBottom) || 0);
    const wanted = anchor === null ? minTop : paper.getBoundingClientRect().top + anchor - (box.getBoundingClientRect().top + above);
    const room = Math.max(0, box.clientHeight - above - below - el.offsetHeight);

    setTop(Math.round(Math.min(Math.max(wanted, minTop), room)) + above);
  }, [anchor, article, area, card, minTop]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const observer = new ResizeObserver(place);
    if (area.current) observer.observe(area.current);
    if (card.current) observer.observe(card.current);
    window.addEventListener("resize", place);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, version, place, area, card]);

  return top;
}
