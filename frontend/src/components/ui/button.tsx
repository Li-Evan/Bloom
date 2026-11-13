import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

// 变体：default 主按钮（亮绿底 + 近黑字，亮暗主题一致，和原官网同款）、outline 描边、ghost 幽灵、destructive 危险（红字红边，不铺红底）；
// on-dark 系列用于深色底（顶栏、hero）；cta 是翠绿行动区上的深色按钮。
// 字重统一 600；禁用的实心按钮用 muted 底 + muted-foreground 字（不拿主色淡化，淡化后白字对比只有 1.9:1），描边 / 幽灵类仍用半透明。
// loading：点下去后在等请求的那个按钮。保持原来的颜色、前面加转圈，和旁边一起禁用的灰按钮区分开，一眼看出「点的是它、正在处理」。
// 它不用原生 disabled（那样键盘焦点会被浏览器移走），而是 aria-disabled + 吞掉点击：表单里按回车触发的提交也是一次点击，同样被拦下。
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-muted disabled:text-muted-foreground",
        // 危险操作只用红字 + 细红边，不铺整块红底：确认框里已经写清后果，按钮不必再吓人（红字对白底 4.8:1）
        destructive:
          "border border-destructive/40 bg-transparent text-destructive hover:border-destructive/60 hover:bg-destructive/5 disabled:opacity-50",
        outline:
          "border border-foreground/20 bg-transparent text-foreground hover:border-foreground/30 hover:bg-muted disabled:opacity-50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70 disabled:opacity-50",
        ghost: "text-foreground hover:bg-muted disabled:opacity-50",
        link: "text-primary-text underline-offset-4 hover:underline active:scale-100 disabled:opacity-50",
        // 深色底上的两种按钮：主按钮和 default 同色（令牌里亮暗一致），只有禁用态要适配深色底
        "on-dark":
          "bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-white/10 disabled:text-stone-400",
        "outline-on-dark":
          "border border-white/20 bg-transparent text-stone-100 hover:border-white/40 hover:bg-white/5 disabled:opacity-50",
        // 翠绿行动区（首页底部）上的深色按钮：焦点轮廓也用深色（--ink-inverse 对翠绿底 7.8:1；默认的 --ring 对翠绿底只有 1.3–1.5:1，看不见）
        cta: "bg-stone-950 text-stone-50 hover:bg-stone-800 focus-visible:outline-ink-inverse disabled:opacity-50",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3.5",
        md: "h-10 px-4 py-2 has-[>svg]:px-3.5",
        sm: "h-8 gap-1.5 rounded-sm px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-12 px-6 text-base has-[>svg]:px-5",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      disabled={loading ? undefined : disabled}
      className={cn(buttonVariants({ variant, size, className }), loading && "pointer-events-none")}
      {...props}
      onClick={loading ? (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault() : props.onClick}
    >
      {/* asChild 时 Slot 只接受一个子元素，不能往里加转圈 */}
      {asChild ? children : <>{loading && <Spinner />}{children}</>}
    </Comp>
  )
}

export { Button, buttonVariants }
