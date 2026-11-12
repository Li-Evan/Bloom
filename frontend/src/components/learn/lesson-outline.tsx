"use client";

import { useEffect, useId, useRef } from "react";
import { useTranslations } from "next-intl";

import { EYEBROW_CLASS } from "@/components/brand/eyebrow";
import Mono from "@/components/brand/mono";
import type { OutlineEntry } from "@/lib/learn/outline";
import { cn } from "@/lib/utils";

const INDENT = ["pl-2.5", "pl-6", "pl-[2.375rem]"];

interface OutlineProps {
  entries: OutlineEntry[];
  // 读到哪一节、点一条跳过去：页面上的 useSections（components/learn/use-sections.ts）
  active: string | null;
  onJump: (id: string) => void;
}

// 目录的一条条（<li>）：宽屏左栏、右栏里的「目录」一组、手机抽屉里的同一组都用它。
// 是真的链接（#section-N），服务端渲染出来就能被抓到；点击由 onJump 接管（不改地址栏），新标签页打开之类照浏览器默认
export function OutlineItems({ entries, active, onJump }: OutlineProps) {
  return entries.map((entry) => {
    const current = entry.id === active;
    return (
      <li key={entry.id}>
        <a
          href={`#${entry.id}`}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onJump(entry.id);
          }}
          aria-current={current ? "location" : undefined}
          title={entry.text}
          className={cn(
            "block rounded-md py-1.5 pr-2 text-sm leading-snug transition-colors hover:bg-muted",
            INDENT[entry.level],
            current ? "font-medium text-primary-text" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <span className="line-clamp-2 break-words">{entry.text}</span>
        </a>
      </li>
    );
  });
}

// 课文页左栏的目录（和飞书文档左边的一样）：按课文的标题列出来，点一条滚到那个标题，读到哪一节哪一条亮起来。
// 只在宽屏（xl 起）显示，挂在整页容器左边的留白里（learn.css 的 [data-outline] 给它让出位置）；
// 吸顶、太长时自己滚，和右栏同一套（.learn-rail）。条目和标题锚点见 lib/learn/outline.ts
export default function LessonOutline({ entries, active, onJump }: OutlineProps) {
  const t = useTranslations("learn.lesson");
  const labelId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  // 目录比屏幕长时，亮着的那一条要露在框里
  useEffect(() => {
    const box = boxRef.current;
    const item = box?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!box || !item) return;
    const a = item.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (a.top < b.top) box.scrollTop -= b.top - a.top + 8;
    else if (a.bottom > b.bottom) box.scrollTop += a.bottom - b.bottom + 8;
  }, [active]);

  return (
    // 左右留白：文字离屏幕左边 16px（悬停底色离边 6px），和正文隔开约 60px，目录看着是靠左的一栏，不贴着正文
    <nav
      data-lesson-outline
      aria-labelledby={labelId}
      className="absolute bottom-24 right-full top-10 hidden w-56 pl-1.5 pr-5.5 xl:block"
    >
      <div ref={boxRef} className="learn-rail">
        <p id={labelId} className={cn(EYEBROW_CLASS, "mb-2 px-2.5 py-1 text-primary-text")}>
          <Mono text={t("outline")} />
        </p>
        <ul className="space-y-0.5">
          <OutlineItems entries={entries} active={active} onJump={onJump} />
        </ul>
      </div>
    </nav>
  );
}
