"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import StatusView from "@/components/brand/status-view";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api-client";

// 课程 / 课文打不开时的整页提示，复用 404 页的品牌版面（曲线插图、小标签、标题、说明、主按钮 + 次按钮）：
// - 404（课程不存在、课文不存在、不是你的课程）：「找不到这门课程 / 这篇课文」，主按钮回「我的课程」，次按钮回课程（课文）或首页；
// - 其它失败（后端连不上、5xx）：「没能加载……」，带后端给的原因，主按钮是「重试」。
// 不再是一行纯红字加一个小按钮。
// 这是客户端判定的「软 404」：页面不进搜索引擎（learn 布局 noindex），先返回 200 再由客户端取数发现没有，
// 所以页面上不写「404」，小标签是「找不到 / Not found」，并把 document.title 改成「找不到这门课程 | Bloom」，浏览器标签页和历史记录里也能看出来。
// 不改成服务端真 404：这些页面本来就 noindex，没有 SEO 影响。
export const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

export default function LearnStatus({
  kind,
  notFound,
  message,
  courseId,
}: {
  kind: "course" | "lesson";
  notFound: boolean;
  message?: string;
  // 课文页的次按钮回这门课
  courseId?: string;
}) {
  const t = useTranslations("learn.status");
  const title = t(notFound ? `${kind}NotFoundTitle` : `${kind}ErrorTitle`);

  useEffect(() => {
    document.title = `${title} | Bloom`;
  }, [title]);

  if (notFound) {
    return (
      <StatusView eyebrow={t("eyebrow")} title={title} description={t(`${kind}NotFoundText`)}>
        <Button asChild size="lg">
          <Link href="/learn">{t("toCourses")}</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          {kind === "lesson" && courseId ? (
            <Link href={`/learn/course/${courseId}`}>{t("toCourse")}</Link>
          ) : (
            <Link href="/">{t("toHome")}</Link>
          )}
        </Button>
      </StatusView>
    );
  }

  return (
    <StatusView eyebrow={t("errorEyebrow")} title={title} description={message || t("errorText")}>
      <Button size="lg" onClick={() => window.location.reload()}>
        {t("retry")}
      </Button>
      <Button asChild size="lg" variant="outline">
        <Link href="/learn">{t("toCourses")}</Link>
      </Button>
    </StatusView>
  );
}
