// 顶栏、手机抽屉、页脚的链接都在这里：路径不带语言前缀，文案键在 messages 的 header / footer 命名空间。

export type NavLinkDef = { key: string; href: string };

export const GITHUB_URL = "https://github.com/Li-Evan/Bloom";

export const MAIN_NAV: NavLinkDef[] = [
  { key: "courses", href: "/learn" },
  { key: "map", href: "/learn/map" },
  { key: "next", href: "/learn/next" },
];

// 「我的」里的几页
export const ACCOUNT_MENU: NavLinkDef[] = [
  { key: "center", href: "/me" },
  { key: "settings", href: "/me/settings" },
];

// /learn 是「我的课程」：课程页、课文页都算它，/learn/next、/learn/map 是单独的项。
export function isActive(pathname: string, href: string): boolean {
  if (href === "/learn") {
    return (
      pathname === "/learn" ||
      (pathname.startsWith("/learn/") && !pathname.startsWith("/learn/next") && !pathname.startsWith("/learn/map"))
    );
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}
