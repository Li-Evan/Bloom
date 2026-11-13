import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { AppContextProvider } from "@/contexts/app";
import { Metadata } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { ThemeProvider } from "@/providers/theme";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const t = await getTranslations();
  // 自托管的学习工具：整站不进搜索引擎
  return { title: t("metadata.title"), description: t("metadata.description"), robots: { index: false, follow: false } };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={messages}>
      <AppContextProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </AppContextProvider>
    </NextIntlClientProvider>
  );
}
