import { getRequestConfig } from "next-intl/server";
import { toLocale } from "./locale";
import { loadMessages } from "./messages";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  // 没有语言或语言不支持时（比如 404 页）用默认语言；支持的语言加载失败直接抛出
  const locale = toLocale(await requestLocale) ?? routing.defaultLocale;

  return { locale, messages: await loadMessages(locale) };
});
