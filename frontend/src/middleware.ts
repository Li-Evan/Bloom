import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// 语言路由：中文页在 /zh 下，英文不带前缀；没带前缀的地址按 NEXT_LOCALE cookie 或浏览器语言决定留下还是去 /zh
export default createMiddleware(routing);

// 只处理页面：后端代理和令牌（/api/…）、Next 自己的资源（/_next/…）、带扩展名的静态文件都不经过语言路由
export const config = {
  matcher: ["/((?!api/|_next/|.*\\..*).*)"],
};
