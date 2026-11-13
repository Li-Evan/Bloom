"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { nextBar, type BarState } from "@/lib/learn/bar";

// 课文页面包屑条是否收起：往下滚收起、往上滚出现。reveal() 用于键盘焦点落到条里时强行显示。
export function useBarHidden(): [boolean, () => void] {
  const [hidden, setHidden] = useState(false);
  const state = useRef<BarState>({ hidden: false, ref: 0 });

  useEffect(() => {
    state.current = { hidden: false, ref: window.scrollY };
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        state.current = nextBar(state.current, window.scrollY);
        setHidden(state.current.hidden);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const reveal = useCallback(() => {
    state.current = { hidden: false, ref: window.scrollY };
    setHidden(false);
  }, []);

  return [hidden, reveal];
}
