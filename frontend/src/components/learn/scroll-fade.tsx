"use client";

import { useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";

import ZoomableImage from "@/components/learn/zoomable-image";
import { cn } from "@/lib/utils";

// 横向可滚的块（代码块、块级公式、表格容器）：还有内容没露出来的那一端渐隐 24px，滚到头那一端的渐隐就消失（样式 .scroll-fade-x，见 learn.css）。
// 手机上这些块常常比屏幕宽，只有一点阴影看不出能滑；渐隐是最直接的「后面还有」的提示。
function FadeScroll({
  as: Tag,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { as: "pre" | "div" }) {
  const ref = useRef<HTMLElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  // 只在挂载时订阅一次（卸载时取消）：之前依赖 children，流式写入时每个字都会重新订阅一遍。
  // 量的时机：容器尺寸变了（窗口、字体、手机转屏）、里面的内容变了（流式写入、公式渲染完；<pre> 里的 <code> 是行内元素，
  // ResizeObserver 看不到它变宽，所以内容变化用 MutationObserver 盯着）、滚动。算出来的值没变就不更新状态
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const start = el.scrollLeft > 4;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setFade((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    const mutation = new MutationObserver(schedule);
    mutation.observe(el, { childList: true, subtree: true, characterData: true });
    document.fonts?.ready.then(schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  return (
    <Tag
      ref={ref as React.Ref<never>}
      data-fade-start={fade.start}
      data-fade-end={fade.end}
      className={cn("scroll-fade-x", className)}
      {...props}
    >
      {children}
    </Tag>
  );
}

// 需要渐隐的 div：表格容器（rehypeWrapTables 包的 .lesson-table）和块级公式的容器（rehypeScrollMath 包的 .math-scroll）
const FADE_DIV = /(?:^|\s)(?:lesson-table|math-scroll)(?:\s|$)/;

export const scrollFadeComponents: Components = {
  // Document images load as they approach the viewport, including authenticated project images.
  img: ({ node: _node, ...props }) => <ZoomableImage {...props} />,
  pre: ({ node: _node, ...props }) => <FadeScroll as="pre" {...props} />,
  div: ({ node: _node, className, ...props }) =>
    className && FADE_DIV.test(className) ? (
      <FadeScroll as="div" className={className} {...props} />
    ) : (
      <div className={className} {...props} />
    ),
};
