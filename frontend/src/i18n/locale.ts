// 界面语言只有英文和中文：英文不带前缀，中文在 /zh 下（localePrefix: "as-needed"）
export const locales = ["en", "zh"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

export const localePrefix = "as-needed";

// 按浏览器语言（Accept-Language）自动选语言，默认开启：中文浏览器第一次打开根地址进 /zh，英文浏览器留在 /。
// 用户在顶栏手动切换过语言后以 NEXT_LOCALE cookie 为准（next-intl 会写它）。只有明确设成 false 才关闭
export const localeDetection = process.env.NEXT_PUBLIC_LOCALE_DETECTION !== "false";

// 把请求里的语言归一成支持的语言（zh-CN 算 zh）；不支持的返回 undefined，由调用方决定怎么处理
export function toLocale(value: string | undefined): Locale | undefined {
  const tag = value?.toLowerCase();
  const wanted = tag === "zh-cn" ? "zh" : tag;
  return locales.find((locale) => locale === wanted);
}
