"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// 两个图标都渲染，用 .dark 类切换显示：不依赖挂载状态，服务端渲染和首次渲染一致
export default function ThemeToggle({
  tone = "auto",
  className,
}: {
  // dark：放在深色顶栏上；auto：放在跟随主题的表面上
  tone?: "auto" | "dark";
  className?: string;
}) {
  const t = useTranslations("header");
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      type="button"
      aria-label={t("theme")}
      title={t("theme")}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-md transition-colors",
        tone === "dark"
          ? "text-stone-300 hover:bg-white/10 hover:text-white"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        className
      )}
    >
      <Sun className="hidden size-[18px] dark:block" />
      <Moon className="size-[18px] dark:hidden" />
    </button>
  );
}
