import {
  defaultLocale,
  localeDetection,
  localePrefix,
  locales,
} from "./locale";

import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix,
  localeDetection,
  // hreflang 由页面 metadata 生成；next-intl 默认还会按请求主机名在 Link 响应头里再给一份，反向代理后可能与 HTML 不一致
  alternateLinks: false,
});
