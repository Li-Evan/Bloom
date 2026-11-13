export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class BackendUnreachableError extends ApiError {
  constructor(message: string, cause: unknown) {
    super(0, message);
    this.name = "BackendUnreachableError";
    this.cause = cause;
  }
}

const UNREACHABLE_MESSAGES = {
  zh: "无法连接后端服务",
  en: "Cannot connect to the backend service",
};
const TIMEOUT_MESSAGES = {
  zh: "请求超时，后端没有在限定时间内响应",
  en: "The request timed out before the backend responded",
};

function describeDetail(detail: unknown): string | undefined {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((e) => (e?.loc ? `${e.loc.join(".")}: ${e.msg}` : String(e)))
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    const { message } = detail as { message?: unknown };
    return typeof message === "string" ? message : JSON.stringify(detail);
  }
}

// A platform or proxy error page (HTML or text) still says why; keep its gist, not its CSS or scripts.
export function pageGist(res: Response, text: string): string {
  const page = text
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return [`HTTP ${res.status}`, res.headers.get("x-vercel-error"), page].filter(Boolean).join(" ");
}

// A platform error page is not the backend's answer, so its status must not read as one: a 404 page would show
// "course not found". Only timeouts, oversized requests and rate limits keep theirs.
const PAGE_STATUSES_KEPT = new Set([413, 429, 504]);
export const pageErrorStatus = (status: number) => (PAGE_STATUSES_KEPT.has(status) ? status : 502);

export async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  const body = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const detail = body?.detail;

  if (body === null) {
    return new ApiError(pageErrorStatus(res.status), pageGist(res, text || res.statusText));
  }

  return new ApiError(
    res.status,
    describeDetail(detail) ?? pageGist(res, text || res.statusText),
    detail
  );
}

// 路由参数拼进后端路径前先规整：Next 交来的动态参数有时已解码、有时仍是百分号编码（中文 slug），
// 先解码再编码，两种情况都得到同一个正确的路径片段。
// 孤立的 % 或被截断的序列（100%、%E4%BD）解不了码，说明它本来就是原文，按原文处理，不抛 URIError。
export function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const pathSegment = (value: string) =>
  encodeURIComponent(decodeSegment(value));

export type ApiInit = RequestInit & { json?: unknown };
export type LocaleGetter = () => string | Promise<string>;

export async function request(
  url: string,
  token: string | null,
  { json, ...init }: ApiInit,
  getLocale: LocaleGetter
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
      body: json === undefined ? init.body : JSON.stringify(json),
    });
  } catch (e) {
    return fetchFailed(e, getLocale);
  }

  return checked(res);
}

// fetch 本身抛错（连不上、超时、被取消）时调用方看到的错误；合并请求里单条超时或被取消也走这里
export async function fetchFailed(e: unknown, getLocale: LocaleGetter): Promise<never> {
  if ((e as Error)?.name === "AbortError") {
    throw e;
  }

  const zh = (await getLocale()).startsWith("zh");
  // AbortSignal.timeout() rejects with TimeoutError: that is a slow backend, not an unreachable one.
  if ((e as Error)?.name === "TimeoutError") {
    throw new BackendUnreachableError(zh ? TIMEOUT_MESSAGES.zh : TIMEOUT_MESSAGES.en, e);
  }
  const base = zh ? UNREACHABLE_MESSAGES.zh : UNREACHABLE_MESSAGES.en;
  const cause = ((e as Error)?.cause as Error | undefined)?.message ?? (e as Error)?.message;
  throw new BackendUnreachableError(
    cause ? `${base}${zh ? "（原因：" : " (Reason: "}${cause}${zh ? "）" : ")"}` : base,
    e
  );
}

export async function checked(res: Response): Promise<Response> {
  if (!res.ok) {
    throw await toApiError(res);
  }

  return res;
}

export async function readJson<T>(res: Response): Promise<T> {
  return res.status === 204 ? (undefined as T) : res.json();
}
