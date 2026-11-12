import { Metadata } from "next";
import { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "learn" });

  // 课程页、大纲页、课文页的标题要等取到课程才知道，由页面里的 DocumentTitle 换成具体的；这里是取到之前的默认值
  return { title: `${t("title")} | Bloom`, robots: { index: false, follow: false } };
}

export default function LearnLayout({ children }: { children: ReactNode }) {
  return children;
}
