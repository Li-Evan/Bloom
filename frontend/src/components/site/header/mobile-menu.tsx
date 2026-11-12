"use client";

import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Logo from "@/components/brand/logo";
import InitialAvatar from "@/components/brand/initial-avatar";
import LocaleToggle from "@/components/locale/toggle";
import ThemeToggle from "@/components/theme/toggle";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Link, usePathname } from "@/i18n/navigation";
import { useAppContext } from "@/contexts/app";
import { ACCOUNT_MENU, NavLinkDef, isActive } from "@/lib/nav";
import { cn } from "@/lib/utils";
import GitHubLink from "./github-link";

const TRIGGER_CLASS =
  "inline-flex size-10 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted";

// 手机上的全屏主题抽屉：导航、「我的」入口、语言、主题、GitHub 都在这里
export default function MobileMenu({ nav }: { nav: NavLinkDef[] }) {
  const t = useTranslations();
  const pathname = usePathname();
  const { user } = useAppContext();
  const [open, setOpen] = useState(false);

  // 点链接跳转后收起抽屉
  useEffect(() => setOpen(false), [pathname]);

  // Radix 的触发按钮用 useId 写 aria-controls，偶尔（约二十分之一的整页加载）服务端与客户端的 id 对不上，报水合不一致。
  // 所以首屏先放一个同样外观的普通按钮，挂载后再换成真正的抽屉（此后的 id 由客户端生成，不必和服务端一致）。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const close = () => setOpen(false);
  const nickname = user?.nickname || "";

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label={t("header.open_menu")}
        aria-haspopup="dialog"
        aria-expanded="false"
        className={TRIGGER_CLASS}
      >
        <Menu className="size-5" />
      </button>
    );
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={t("header.open_menu")}
          className={TRIGGER_CLASS}
        >
          <Menu className="size-5" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="top"
        showClose={false}
        aria-describedby={undefined}
        className="h-dvh gap-0 border-0 bg-background p-0 text-foreground"
      >
        <SheetTitle className="sr-only">{t("header.menu")}</SheetTitle>
        <SheetDescription className="sr-only">{t("header.nav_label")}</SheetDescription>

        <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
          <Link href="/learn" aria-label={t("header.home")} onClick={close} className="rounded-md">
            <Logo tone="auto" />
          </Link>
          <SheetClose
            aria-label={t("header.close_menu")}
            className="inline-flex size-10 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
          >
            <X className="size-5" />
          </SheetClose>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <nav aria-label={t("header.nav_label")} className="flex flex-col">
            {nav.map((item) => {
              const active = isActive(pathname, item.href);

              return (
                <Link
                  key={item.key}
                  href={item.href as any}
                  onClick={close}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-14 items-center justify-between border-b border-border text-xl font-semibold transition-colors focus-visible:text-foreground",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t(`header.nav.${item.key}`)}
                  {active && <span aria-hidden="true" className="size-2 rounded-full bg-primary" />}
                </Link>
              );
            })}
          </nav>

          <div className="mt-6">
            {nickname && (
              <div className="mb-3 flex items-center gap-3">
                <InitialAvatar name={nickname} src={user?.avatar_url} size={40} />
                <p className="min-w-0 truncate text-sm font-semibold text-foreground">{nickname}</p>
              </div>
            )}
            <div className="flex flex-col">
              {ACCOUNT_MENU.map((item) => (
                <Link
                  key={item.key}
                  href={item.href as any}
                  onClick={close}
                  className="flex h-11 items-center text-[15px] text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground"
                >
                  {t(`header.menu_items.${item.key}`)}
                </Link>
              ))}
            </div>
          </div>
        </div>

        <div className="shrink-0 space-y-3 border-t border-border px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {/* 语言、主题按钮在抽屉里放大到 44px 触控区（原来约 36px 的小图标，手指不好点，RP13） */}
          <div className="flex items-center justify-between">
            <LocaleToggle tone="auto" className="h-11 min-w-11 px-3.5 text-sm" />
            <div className="flex items-center gap-1">
              <GitHubLink className="h-11 min-w-11 px-3" />
              <ThemeToggle tone="auto" className="size-11" />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
