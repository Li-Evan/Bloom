import Logo from "@/components/brand/logo";
import { Link } from "@/i18n/navigation";
import { ACCOUNT_MENU, GITHUB_URL, MAIN_NAV } from "@/lib/nav";
import { getTranslations } from "next-intl/server";
import { SiGithub } from "react-icons/si";

// 全站页脚：跟随亮暗主题。课文页等需要关掉它的页面渲染 <HideFooter />。
export default async function Footer() {
  const t = await getTranslations();

  return (
    <footer data-site-footer className="border-t border-border bg-background text-muted-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex items-center gap-4">
          <Logo />
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center gap-2 text-sm transition-colors hover:text-foreground focus-visible:text-foreground sm:min-h-0"
          >
            <SiGithub aria-hidden="true" className="size-4" />
            {t("footer.github")}
          </a>
        </div>
        <nav aria-label={t("header.nav_label")}>
          <ul className="flex flex-wrap items-center gap-x-5 text-sm">
            {[...MAIN_NAV, ...ACCOUNT_MENU].map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href as any}
                  className="inline-flex min-h-10 items-center transition-colors hover:text-foreground focus-visible:text-foreground sm:min-h-0"
                >
                  {link.href.startsWith("/me") ? t(`header.menu_items.${link.key}`) : t(`header.nav.${link.key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
