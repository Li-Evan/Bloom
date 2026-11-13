import { getTranslations } from "next-intl/server";

import { PageHead } from "@/components/me/page-head";
import { DataPanel, LearningPanel, PreferencesPanel, ProfilePanel } from "@/components/me/settings-panels";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("me.nav.settings");
}

export default async function SettingsPage() {
  const t = await getTranslations("me.settings");

  return (
    <>
      <PageHead eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />
      <div className="space-y-6">
        <ProfilePanel />
        <PreferencesPanel />
        <LearningPanel />
        <DataPanel />
      </div>
    </>
  );
}
