import { defaultLocale } from "@/i18n/locale";

// 默认语言不带前缀（localePrefix: as-needed）
export function localePath(locale: string, path = "/") {
  if (locale === defaultLocale) {
    return path;
  }

  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}
