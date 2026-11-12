import { notFound } from "next/navigation";

// 没有任何页面匹配的地址：交给 [locale]/not-found.tsx（本地化、带顶栏页脚）。
// 没有这个兜底，Next 会直接用根级 404，拿不到语言。
export default function CatchAll() {
  notFound();
}
