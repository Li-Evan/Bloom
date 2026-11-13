"use client";

import {
  CalendarDays,
  LayoutDashboard,
  NotebookPen,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import Eyebrow from "@/components/brand/eyebrow";
import InitialAvatar from "@/components/brand/initial-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/contexts/app";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

type Item = { key: string; href: string; icon: LucideIcon };

// 学习（看自己学得怎么样）在上，偏好设置在下
const GROUPS: { key: "learn" | "account"; items: Item[] }[] = [
  {
    key: "learn",
    items: [
      { key: "overview", href: "/me", icon: LayoutDashboard },
      { key: "activity", href: "/me/activity", icon: CalendarDays },
      { key: "notes", href: "/me/notes", icon: NotebookPen },
      { key: "teaching", href: "/me/teaching", icon: SlidersHorizontal },
    ],
  },
  {
    key: "account",
    items: [
      { key: "settings", href: "/me/settings", icon: Settings },
    ],
  },
];

export const ME_NAV_ITEMS = GROUPS.flatMap((group) => group.items);

const isCurrent = (pathname: string, href: string) =>
  href === "/me" ? pathname === "/me" : pathname === href || pathname.startsWith(`${href}/`);

function Identity() {
  const { user: who } = useAppContext();

  if (!who) {
    return (
      <div className="flex items-center gap-3" aria-hidden="true">
        <Skeleton className="size-10 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <InitialAvatar name={who.nickname} src={who.avatar_url} size={40} />
      {who.nickname && <p className="min-w-0 truncate text-sm font-semibold">{who.nickname}</p>}
    </div>
  );
}

// 桌面：左侧 sticky 的分组导航；手机：顶栏下面一条可横向滑动的标签（当前项自动滚到中间）
export default function MeNav() {
  const t = useTranslations("me.nav");
  const pathname = usePathname();
  const strip = useRef<HTMLDivElement>(null);
  // 标签条两端还有没露出来的标签时，那一端渐隐，提示可以横向滑
  const [fade, setFade] = useState({ start: false, end: false });

  useEffect(() => {
    const box = strip.current;
    const current = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (box && current) {
      box.scrollLeft = current.offsetLeft - (box.clientWidth - current.clientWidth) / 2;
    }
  }, [pathname]);

  useEffect(() => {
    const box = strip.current;
    if (!box) return;
    const update = () =>
      setFade({
        start: box.scrollLeft > 4,
        end: box.scrollLeft + box.clientWidth < box.scrollWidth - 4,
      });
    update();
    box.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(box);

    return () => {
      box.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [pathname]);

  return (
    <>
      <aside className="hidden lg:block">
        <nav aria-label={t("label")} className="sticky top-[calc(var(--header-height)+2rem)] space-y-7">
          <Identity />
          {GROUPS.map((group) => (
            <div key={group.key}>
              <Eyebrow className="mb-2 px-3 text-xs [&:lang(zh)]:text-xs text-subtle-foreground">{t(`group_${group.key}`)}</Eyebrow>
              <ul className="space-y-0.5">
                {group.items.map(({ key, href, icon: Icon }) => {
                  const current = isCurrent(pathname, href);

                  return (
                    <li key={key}>
                      <Link
                        href={href}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                          "flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors",
                          current
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {t(key)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <nav
        aria-label={t("label")}
        className="sticky top-[var(--header-height)] z-30 -mx-4 border-b bg-background/90 backdrop-blur sm:-mx-6 lg:hidden"
      >
        <div
          ref={strip}
          data-fade-start={fade.start}
          data-fade-end={fade.end}
          // 渐隐 48px 宽：24px 只够把最后一个标签的字尾淡掉，看不出「后面还有」；到头那一端的渐隐自动消失
          className="scroll-fade-x flex gap-1 overflow-x-auto px-4 [--fade-size:3rem] sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {ME_NAV_ITEMS.map(({ key, href, icon: Icon }) => {
            const current = isCurrent(pathname, href);

            return (
              <Link
                key={key}
                href={href}
                aria-current={current ? "page" : undefined}
                // Tab 到只露出一部分的标签时，浏览器不会把它完整滚进来：聚焦时自己滚到完整可见
                // 只在键盘聚焦时补这一次滚动：鼠标 / 触摸点一个只露出一截的标签，不能把它从手指下滚走（点击会落空）
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible")) {
                    e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
                  }
                }}
                className={cn(
                  // 横向滚动的标签条：容器会截掉上下溢出的内容，轮廓收进框里（-outline-offset-2）
                  "relative flex h-12 shrink-0 items-center gap-2 px-3 text-sm whitespace-nowrap transition-colors focus-visible:text-foreground focus-visible:-outline-offset-2",
                  current
                    ? "font-medium text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {t(key)}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
