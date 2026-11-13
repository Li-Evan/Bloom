import { ArrowRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EmptyAction } from "@/components/learn/empty-state";
import ActivityStats from "@/components/me/activity-stats";
import ActivityView from "@/components/me/activity-view";
import LoadError from "@/components/me/load-error";
import { PageHead } from "@/components/me/page-head";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { backendErrorText } from "@/lib/backend-error-server";
import type { Calendar } from "@/lib/learn/types";
import { meFetch } from "@/lib/me/server";
import type { MeStats } from "@/lib/me/types";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("me.nav.activity");
}

export default async function ActivityPage() {
  const t = await getTranslations("me.activity");

  const data = await Promise.all([
    meFetch<MeStats>("/api/stats"),
    meFetch<Calendar>("/api/calendar"),
  ]).catch((e: Error) => e);

  return (
    <>
      <PageHead eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />
      {data instanceof Error ? (
        <LoadError message={await backendErrorText(data)} />
      ) : data[1].days.length > 0 ? (
        <ActivityView stats={data[0]} calendar={data[1]} />
      ) : (
        <div className="space-y-6">
          <ActivityStats stats={data[0]} />
          <EmptyAction title={t("empty_title")} text={t("empty_text")}>
            <Button asChild>
              <Link href="/learn">
                {t("empty_cta")}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </EmptyAction>
        </div>
      )}
    </>
  );
}
