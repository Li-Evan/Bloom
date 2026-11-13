"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { OutlineEntry } from "@/lib/learn/outline";

// 课文目录（lib/learn/outline.ts）读到哪一节、点一条跳过去。宽屏左栏、右栏里的一组、手机抽屉里的一组共用一份：
// - 读到哪一节：标题的顶边过了页面的滚动留白（跳过去时标题停在那儿），就算进了这一节；已经滚到页底时，露在屏幕上的最后一个标题算当前这一节。
// - 点过的那一条一直亮着，直到用户自己滚动：文末的小节太短时，页面滚到底标题也到不了顶上，按位置算会亮成前一条。
// - 跳过去不改地址栏：课文页打开一篇时总是回到顶上，地址里带着 #section-3 刷新也不会停在那一节，反而误导。
//   焦点跟着移到那个标题上，接着按 Tab、读屏都从这一节往下走。
export function useSections(entries: OutlineEntry[]) {
  const [active, setActive] = useState<string | null>(null);
  const pinned = useRef<string | null>(null);

  useEffect(() => {
    pinned.current = null;
    if (!entries.length) {
      setActive(null);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      if (pinned.current) {
        setActive(pinned.current);
        return;
      }
      const line = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 8;
      const atBottom = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      let current: string | null = null;
      for (const entry of entries) {
        const heading = document.getElementById(entry.id);
        if (!heading) continue;
        const top = heading.getBoundingClientRect().top;
        if (top > line && !(atBottom && top < window.innerHeight)) break;
        current = entry.id;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // 滚轮、触摸、按键、按下鼠标：用户自己在动，不再固定在点过的那一条
    const release = () => {
      if (!pinned.current) return;
      pinned.current = null;
      schedule();
    };
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    for (const type of inputs) window.addEventListener(type, release, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const type of inputs) window.removeEventListener(type, release, { capture: true });
    };
  }, [entries]);

  const jump = useCallback((id: string) => {
    const heading = document.getElementById(id);
    if (!heading) return;
    pinned.current = id;
    setActive(id);
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start" });
  }, []);

  return { active, jump };
}
