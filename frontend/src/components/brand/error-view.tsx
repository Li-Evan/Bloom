"use client";

import { useEffect, useTransition } from "react";
import StatusView from "@/components/brand/status-view";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

// 段级 error.tsx 的内容：重试 + 回首页。
// 只调 reset() 只会重画客户端那一层，服务端出的错原样再来一遍；先 refresh 重新向服务端取，整个过程按钮转圈
export default function ErrorView({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("error");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusView
      eyebrow={t("eyebrow")}
      title={t("title")}
      description={t("description")}
      detail={error.digest ? `${t("ref")}: ${error.digest}` : undefined}
    >
      <Button
        size="lg"
        loading={pending}
        onClick={() =>
          startTransition(() => {
            router.refresh();
            reset();
          })
        }
      >
        {pending ? t("retrying") : t("retry")}
      </Button>
      <Button asChild size="lg" variant="outline">
        <Link href="/">{t("home")}</Link>
      </Button>
    </StatusView>
  );
}
