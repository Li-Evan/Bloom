import type { Locale } from "@/i18n/locale";

// 界面文案：同样是写死的静态 import，新增语言而没有补这里是类型错误
export const messageLoaders: Record<
  Locale,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  en: () => import("@/i18n/messages/en.json"),
  zh: () => import("@/i18n/messages/zh.json"),
};

export async function loadMessages(locale: Locale) {
  return (await messageLoaders[locale]()).default;
}
