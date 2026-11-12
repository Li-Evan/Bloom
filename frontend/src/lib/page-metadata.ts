import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

// 页面标题：本地化的页名 + 站点名
export async function privatePageMetadata(titleKey: string): Promise<Metadata> {
  const t = await getTranslations();

  return { title: `${t(titleKey)} | ${t("metadata.site_name")}` };
}
