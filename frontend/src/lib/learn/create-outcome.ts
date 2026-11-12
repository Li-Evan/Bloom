import { ApiError } from "@/lib/api-common";
import { KNOWN_ERROR_KEYS, splitReason } from "@/lib/backend-errors";

// 建课是一次要等几十秒的请求，后端可能在课程已经提交之后才出错（序列化、网关超时……）。所以只有后端自己处理过、
// 回了固定报错的失败（它已经回滚，课程没建成），以及校验失败等 4xx，才是确定的失败；没有收到后端应答（断网、网关超时/错误），
// 以及 5xx 但响应体是通用兜底（服务器内部错误）或没有可识别的 detail，都不能说明「没建成」：
// 课程可能仍在生成，界面要提示并去列表里确认，而不是报「失败」。
export function isUnconfirmedCreate(err: unknown): boolean {
  if (!(err instanceof ApiError)) {
    return false;
  }

  if (err.status === 0) {
    return true;
  }

  const base = typeof err.detail === "string" ? splitReason(err.detail)[0] : "";
  const handled = Object.hasOwn(KNOWN_ERROR_KEYS, base) && KNOWN_ERROR_KEYS[base] !== "serverError";

  return err.status >= 500 && !handled;
}
