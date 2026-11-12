"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useAppContext } from "@/contexts/app";
import { cn } from "@/lib/utils";

// 用户资料（GET /api/me）自动重试用完还是没取到：说一句，给「重试」，别让昵称一直停在骨架屏
export default function ProfileRetry({ className }: { className?: string }) {
  const t = useTranslations("me.common");
  const { reloadUser } = useAppContext();

  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-sm", className)}>
      <p className="text-muted-foreground">{t("profile_failed")}</p>
      <Button variant="outline" size="sm" onClick={() => reloadUser()}>
        {t("retry")}
      </Button>
    </div>
  );
}
