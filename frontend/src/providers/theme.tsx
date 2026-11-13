"use client";

import { useEffect, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ThemeProvider as NextThemes } from "next-themes";
import { Toaster } from "sonner";

// 没在设置里选过主题时用哪一套：light / dark / system（构建时写死，见 .env.example）
const DEFAULT_THEME = process.env.NEXT_PUBLIC_DEFAULT_THEME || "system";

// 亮暗主题（next-themes 在 <html> 上切 .dark）和全站的通知
export function ThemeProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const t = useTranslations("common");

  // 站内切换语言时根布局不重新渲染，<html lang> 由这里跟上
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <NextThemes attribute="class" defaultTheme={DEFAULT_THEME} enableSystem disableTransitionOnChange>
      {children}
      {/* 通知放在吸顶顶栏的下方（顶栏高 --header-height），不遮住导航：桌面用 offset；
          手机（≤ 600px）Sonner 的 top 写死 20px、不认 offset，由 globals.css 里的一条媒体查询规则改 */}
      <Toaster
        position="top-center"
        richColors
        offset="calc(var(--header-height) + 0.75rem)"
        containerAriaLabel={t("notifications")}
      />
    </NextThemes>
  );
}
