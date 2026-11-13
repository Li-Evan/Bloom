import Footer from "@/components/site/footer";
import Header from "@/components/site/header";
import DocumentTitle from "@/components/brand/document-title";
import StatusView from "@/components/brand/status-view";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

// 404 页的 <title>：「找不到页面 | Bloom」，不再沿用首页的标题（RP17）
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("not_found");

  return { title: { absolute: t("meta_title") }, robots: { index: false, follow: false } };
}

// [locale] 下任何 notFound() 和没有匹配到的地址（见 [...rest]）都落在这里，状态码是 404
export default async function NotFound() {
  const t = await getTranslations("not_found");

  return (
    <div className="flex min-h-dvh flex-col">
      <DocumentTitle title={t("meta_title")} />
      <Header />
      <main className="flex-1">
        <StatusView
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("description")}
        >
          <Button asChild size="lg">
            <Link href="/">{t("home")}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/learn">{t("courses")}</Link>
          </Button>
        </StatusView>
      </main>
      <Footer />
    </div>
  );
}
