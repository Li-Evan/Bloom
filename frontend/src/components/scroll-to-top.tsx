"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "@/i18n/navigation";

// 站内换页后回到页面顶部。Next 的做法是「新页面最上面那个元素已经在屏幕里就不滚」，所以从一个只滚了几十像素的页面
// （比如笔记页）点页脚的链接，新页面会带着原来的滚动位置打开，顶上的标题被顶栏盖住一截。
// 只管换了页（路径变了；改语言、改查询参数、带 # 锚点的跳转都不算），浏览器的后退 / 前进交给浏览器恢复位置。
export default function ScrollToTop() {
  const pathname = usePathname();
  const first = useRef(true);
  const history = useRef(false);

  useEffect(() => {
    const mark = () => {
      history.current = true;
    };
    window.addEventListener("popstate", mark);

    return () => window.removeEventListener("popstate", mark);
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (history.current) {
      history.current = false;
      return;
    }
    if (window.location.hash || window.scrollY === 0) return;
    // 页面设了 scroll-behavior: smooth，这里要瞬间回去，不然一路滑上去
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);

  return null;
}
