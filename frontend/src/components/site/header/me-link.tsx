"use client";

import { useTranslations } from "next-intl";
import InitialAvatar from "@/components/brand/initial-avatar";
import { Link } from "@/i18n/navigation";
import { useAppContext } from "@/contexts/app";

// 顶栏右侧的「我的」入口：本地用户的头像（没有头像就是昵称首字）
export default function MeLink() {
  const t = useTranslations("header");
  const { user } = useAppContext();

  return (
    <Link href="/me" aria-label={t("menu_items.center")} title={t("menu_items.center")} className="rounded-full">
      <InitialAvatar name={user?.nickname || "Bloom"} src={user?.avatar_url} size={32} />
    </Link>
  );
}
