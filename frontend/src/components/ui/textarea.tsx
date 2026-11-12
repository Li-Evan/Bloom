import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "border-input bg-muted placeholder:text-subtle-foreground flex min-h-[80px] w-full rounded-md border px-3 py-2 text-base transition-[color,box-shadow,background-color,border-color] focus-visible:border-ring focus-visible:bg-card focus-visible:outline-offset-[-1px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
