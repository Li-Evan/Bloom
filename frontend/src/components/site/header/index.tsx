"use client";

import Logo from "@/components/brand/logo";
import LocaleToggle from "@/components/locale/toggle";
import ThemeToggle from "@/components/theme/toggle";
import { Link, usePathname } from "@/i18n/navigation";
import { MAIN_NAV, isActive } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import GitHubLink from "./github-link";
import MeLink from "./me-link";
import MobileMenu from "./mobile-menu";

// 全站共享顶栏跟随主题；95% 不透明背景保证滚动时文字与焦点轮廓清晰。
// 宽度：<768 手机（汉堡 + 抽屉）；≥768 导航在 logo 和右侧按钮之间居中；右栏不许被压窄（shrink-0）。
export default function Header() {
  const t = useTranslations("header");
  const pathname = usePathname();
  const nav = MAIN_NAV;

  return (
    <header className="sticky top-0 z-50 h-16 border-b border-border bg-background/95 text-muted-foreground backdrop-blur-sm [--ring:var(--primary-text)]">
      <div className="mx-auto flex h-full w-full max-w-6xl items-center gap-2 px-4 sm:px-6 lg:gap-8 lg:px-8">
        <Link href="/learn" aria-label={t("home")} className="shrink-0 rounded-md">
          <Logo tone="auto" />
        </Link>

        <nav aria-label={t("nav_label")} className="hidden h-full min-w-0 flex-1 items-center justify-center md:flex lg:gap-1">
          {nav.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <Link
                key={item.key}
                href={item.href as any}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // 链接和顶栏一样高：焦点轮廓收进框里（-outline-offset-2），不然顶边落到视口外、底边伸进正文；左右各留 8px 让轮廓不压到字
                  "relative flex h-full items-center whitespace-nowrap px-1.5 text-sm font-medium transition-colors lg:px-2 hover:text-foreground focus-visible:text-foreground focus-visible:-outline-offset-2",
                  active
                    ? "text-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:bg-primary lg:after:inset-x-2"
                    : "text-muted-foreground"
                )}
              >
                {t(`nav.${item.key}`)}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto hidden shrink-0 items-center justify-end gap-1.5 md:flex lg:gap-2">
          <GitHubLink className="hidden lg:inline-flex" />
          <LocaleToggle tone="auto" />
          <ThemeToggle tone="auto" />
          <MeLink />
        </div>

        <div className="ml-auto flex items-center gap-2.5 md:hidden">
          <MobileMenu nav={nav} />
        </div>
      </div>
    </header>
  );
}
