import type { Metadata } from "next";
import type { ReactNode } from "react";

import MeNav from "@/components/me/nav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// 用户中心：桌面左侧导航 + 右侧内容，手机顶部一条横向标签。
export default function MeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-14 lg:px-8">
      <MeNav />
      <div className="min-w-0 pt-8 pb-16 lg:py-12">{children}</div>
    </div>
  );
}
