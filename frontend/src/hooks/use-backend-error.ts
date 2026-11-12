"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { translateBackendMessage } from "@/lib/backend-errors";

// 把请求错误里后端的固定中文报错换成当前语言；不认识的原样显示。
export function useBackendError() {
  const t = useTranslations("errors");

  return useCallback(
    (err: unknown) =>
      translateBackendMessage(
        err instanceof Error ? err.message : String(err),
        t
      ),
    [t]
  );
}
