"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

// 某一块数据没取到：说明原因，给「重试」（重新取一遍这一页）。放在卡片里时传 className 收小内边距。
// 重取要等后端，按钮转圈到新页面渲染完；再失败时框原样回来，但用户看到过「正在重试…」，知道点上了
export default function LoadError({ message, className }: { message: string; className?: string }) {
  const t = useTranslations("me.common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div role="alert" className={cn("rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center", className)}>
      <p className="font-medium">{t("load_failed")}</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-4" loading={pending} onClick={() => startTransition(() => router.refresh())}>
        {pending ? t("retrying") : t("retry")}
      </Button>
    </div>
  );
}
