import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-subtle-foreground selection:bg-primary selection:text-primary-foreground border-input bg-muted flex h-10 w-full min-w-0 rounded-md border px-3 py-1 text-base transition-[color,box-shadow,background-color,border-color] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        // 聚焦只画一圈：2px 轮廓压在 1px 描边上（偏移 -1px），而不是描边变色、外面再隔 2px 画一圈（看上去是双层线）
        "focus-visible:border-ring focus-visible:bg-card focus-visible:outline-offset-[-1px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
