import { LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"

// 全站统一的转圈：按钮里、进行中提示里、区块加载里都用它，不再各写一套边框转圈。减少动态效果时停转，图标仍在。
export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
    />
  )
}
