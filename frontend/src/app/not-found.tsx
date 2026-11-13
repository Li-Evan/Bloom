import BellCurve from "@/components/brand/bell-curve";
import DocumentTitle from "@/components/brand/document-title";
import Eyebrow from "@/components/brand/eyebrow";
import GridGlow from "@/components/brand/grid-glow";
import Logo from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { toLocale } from "@/i18n/locale";
import { localePath } from "@/lib/locale-path";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

// 根级 404 的 <title>（拿不到语言按英文）
export async function generateMetadata(): Promise<Metadata> {
  const locale = toLocale(await getLocale().catch(() => undefined)) ?? "en";
  const t = await getTranslations({ locale, namespace: "not_found" });

  return { title: { absolute: t("meta_title") }, robots: { index: false, follow: false } };
}

// 根级 404：没有落进任何语言路径时用（多半是被扫描器打到的地址）。不在 NextIntlClientProvider 里，
// 所以用服务端文案和普通 <a>；拿不到语言就按英文。深色整页，不依赖主题。
export default async function RootNotFound() {
  const locale = toLocale(await getLocale().catch(() => undefined)) ?? "en";
  const t = await getTranslations({ locale, namespace: "not_found" });

  return (
    <main className="relative isolate flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-ink-inverse px-4 py-16 text-center text-stone-50">
      <DocumentTitle title={t("meta_title")} />
      <GridGlow />
      <div className="relative flex w-full max-w-xl flex-col items-center">
        <a href={localePath(locale, "/")} aria-label="Bloom" className="mb-10">
          <Logo tone="dark" />
        </a>
        <BellCurve tone="dark" className="mb-8 w-56 sm:w-64" />
        <Eyebrow tone="dark">{t("eyebrow")}</Eyebrow>
        <h1 className="mt-4 text-3xl sm:text-4xl">{t("title")}</h1>
        <p className="mt-4 max-w-md text-balance leading-relaxed text-stone-300/90">{t("description")}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href={localePath(locale, "/")} className={buttonVariants({ variant: "on-dark", size: "lg" })}>
            {t("home")}
          </a>
          <a href={localePath(locale, "/learn")} className={buttonVariants({ variant: "outline-on-dark", size: "lg" })}>
            {t("courses")}
          </a>
        </div>
      </div>
    </main>
  );
}
