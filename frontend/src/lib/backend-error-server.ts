import { getTranslations } from "next-intl/server";
import { translateBackendMessage } from "@/lib/backend-errors";

// 服务端组件里同样把后端的固定中文报错换成当前语言
export async function backendErrorText(err: Error) {
  return translateBackendMessage(err.message, await getTranslations("errors"));
}
