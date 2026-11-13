"use client";

import { useEffect } from "react";

// 404 页的浏览器标题：服务端 HTML 里的 <title> 是对的（generateMetadata，搜索引擎看这个），
// 但 Next 的 App Router 在水合之后会把 not-found 页的标题换回根布局的首页标题，标签页上就又变成了「Bloom: a private AI tutor…」（实测，开发和生产构建都这样，RP17）。
// 所以页面里再用一次 effect 把标题定住；离开这个页面后由 Next 的元数据照常接管。
export default function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}
