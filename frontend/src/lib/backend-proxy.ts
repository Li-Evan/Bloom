import { Agent } from "undici";
import { decodeSegment, pageErrorStatus, pageGist } from "@/lib/api-common";
import { REASON_MARK } from "@/lib/backend-errors";

// Node's fetch gives up after 300 s without response headers. Course creation and material courses answer only when done,
// so headers may take as long as the backend route may run; 900 s still bounds the bridge.
// Once a body flows it never pauses long: SSE sends a heartbeat every 10 s. The browser gives up on a silent stream after
// 120 s with its own clear message (lib/learn/stream.ts); 150 s here only backstops a stuck backend behind it.
const dispatcher = new Agent({ headersTimeout: 900_000, bodyTimeout: 150_000 });

// The bridge's own failures say why, so they are never mistaken for a backend answer.
function bridgeError(status: number, message: string, reason: string, cause?: unknown) {
  console.error(`[backend-proxy] ${message}: ${reason}`, cause ?? "");
  return Response.json({ detail: `${message}${REASON_MARK}${reason}）` }, { status });
}

const invalidPath = () => Response.json({ detail: "Invalid API path." }, { status: 400 });

function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const parts = [cause?.code, cause?.message ?? (error as Error)?.message].filter(Boolean);
  return parts.join(" ") || String(error);
}

// A platform or proxy error page is plain text or HTML; turn it into a readable detail.
async function readableUpstreamError(upstream: Response): Promise<Response> {
  return bridgeError(pageErrorStatus(upstream.status), "后端没有返回可读的错误", pageGist(upstream, await upstream.text()));
}

// A same-origin bridge. Forward the caller's token, never a privileged service token.
export async function forwardBackendRequest(request: Request, path: string[]): Promise<Response> {
  // Next hands over segments decoded once; a double-encoded "%252e%252e" arrives as "%2e%2e", so check them decoded.
  const parts = path.map(decodeSegment);
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || /[/\\]/.test(part))) {
    return invalidPath();
  }
  const base = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!base) return bridgeError(500, "前端没有配置后端地址", "BACKEND_URL is not set");
  const target = new URL(`${base}/api/${parts.map(encodeURIComponent).join("/")}`);
  if (!target.pathname.startsWith(`${new URL(base).pathname.replace(/\/+$/, "")}/api/`)) return invalidPath();
  target.search = new URL(request.url).search;
  const headers = new Headers();
  for (const name of ["authorization", "content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      duplex: "half",
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
      dispatcher,
    } as RequestInit & { duplex: "half"; dispatcher: Agent });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return bridgeError(502, "无法连接后端服务", causeOf(error), error);
  }
  // Do not forward credentials through an upstream redirect or expose its Location.
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return bridgeError(502, "后端返回了意外的跳转", `HTTP ${upstream.status}`);
  }
  const type = upstream.headers.get("content-type") ?? "";
  if (upstream.status >= 400 && (!type.includes("json") || upstream.headers.has("x-vercel-error"))) {
    return readableUpstreamError(upstream);
  }
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["content-type", "content-disposition", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Stream PDF/SSE bodies; buffering them breaks large files and generation progress.
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
