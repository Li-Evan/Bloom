import { useTranslations } from "next-intl";

import StatStrip from "@/components/learn/stat-strip";
import type { MeStats } from "@/lib/me/types";

export default function ActivityStats({ stats }: { stats: MeStats }) {
  const t = useTranslations("me.activity");
  const tStats = useTranslations("learn.dashboard.stats");

  return (
    <StatStrip
      columns={5}
      items={[
        { key: "lessons", value: stats.total_lessons_read, label: t("stat_lessons"), info: tStats("lessonsReadHint") },
        { key: "streak", value: stats.current_streak, label: t("stat_streak") },
        { key: "longest", value: stats.longest_streak, label: t("stat_longest") },
        { key: "asks", value: stats.total_annotations, label: t("stat_asks") },
        { key: "completed", value: stats.completed_courses, label: t("stat_completed") },
      ]}
    />
  );
}
