import { getTranslations } from "next-intl/server";

import { PageHead } from "@/components/me/page-head";
import TeachingStylePanel from "@/components/me/teaching-style-panel";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("me.nav.teaching");
}

export default async function TeachingPage() {
  const t = await getTranslations("me.teaching");
  return (
    <>
      <PageHead eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />
      <TeachingStylePanel />
    </>
  );
}
