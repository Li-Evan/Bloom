import type { MetadataRoute } from "next";

// 自托管的学习工具，内容都是个人的：不让任何爬虫收录
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
