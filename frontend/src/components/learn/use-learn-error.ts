"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api-client";
import { knownErrorKey, translateBackendMessage } from "@/lib/backend-errors";
import { StreamError } from "@/lib/learn/stream";

// 把请求错误变成可展示的文字
export function useLearnError() {
  const t = useTranslations("learn.errors");
  const backend = useTranslations("errors");

  return useCallback(
    (err: unknown): string => {
      if (err instanceof StreamError) {
        return t(err.code);
      }

      const message = err instanceof Error ? err.message : String(err);
      if (knownErrorKey(message)) {
        return translateBackendMessage(message, backend);
      }
      if (
        err instanceof ApiError &&
        err.status > 0 &&
        err.detail === undefined
      ) {
        // No JSON detail (a platform error page): keep whatever the response said after the status.
        const status = t("requestFailed", { status: err.status });
        const reason = message.replace(/^HTTP \d+\s*/, "");
        return reason ? `${status}${backend("reasonOpen")}${reason}${backend("reasonClose")}` : status;
      }

      return message;
    },
    [t, backend]
  );
}
