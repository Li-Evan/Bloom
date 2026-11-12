"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// 统计格标题旁的小「i」：长说明收在这里，悬停、键盘聚焦或点一下才显示，格子里不放长句。
// 按钮本身只有 14px 的图标，可点区域用负外边距撑到 40px 见方（不改变版面）。
export default function StatHint({ hint }: { hint: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={hint}
          // 触屏没有悬停：点一下打开；关闭交给 Radix（点别处、Esc、失焦）
          onClick={() => setOpen(true)}
          className="-my-3 ml-0.5 inline-flex size-10 shrink-0 translate-y-[3px] items-center justify-center rounded-full align-middle text-subtle-foreground transition-colors hover:text-foreground"
        >
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-pretty">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
