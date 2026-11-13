"use client";

import {
  ApiError,
  type ApiInit,
  checked,
  fetchFailed,
  readJson,
  request,
  toApiError,
} from "@/lib/api-common";
import { createBatcher } from "@/lib/batch";
import { createReadCache, readTtl } from "@/lib/read-cache";

export { ApiError } from "@/lib/api-common";

type ClientInit = ApiInit & { auth?: boolean };

const REFRESH_MARGIN_SECONDS = 30;

const pageLocale = () => document.documentElement.lang;

// 令牌何时该换只用本机经过的时间算：收到时的本机时间 + 服务端给的有效期长度（expires_in）。不拿服务端的绝对过期时刻
// 和本机时钟比：本机时钟快了会每次都换令牌，慢了会一直用过期令牌。只有没给 expires_in 的旧接口才退回按 expires_at 算
let cached: { token: string; refreshAt: number } | null = null;
let pending: Promise<string | null> | null = null;
// 每次重置令牌就换一代：旧一代迟到的令牌不能写进缓存
let generation = 0;
const reads = createReadCache();
// 不改动任何缓存读数据的写请求：上传会话和分片、建课前的目标澄清、知识地图同步、知识坐标作业。它们不清缓存，也不通知别的标签页
const KEEPS_READS = /^\/api\/(uploads(?:\/|$)|courses\/clarify$|knowledge-map\/sync$|courses\/\d+\/coordinate\/step(?:\?|$))/;

export function invalidateApiReads(path?: string) {
  if (path?.endsWith("/opened")) {
    reads.clear(key => /\/api\/(stats|calendar)(?:$|\?)/.test(key));
  } else {
    reads.clear();
  }
}

export function notifyApiWrite(path: string) {
  invalidateApiReads(path);
  if (typeof window !== "undefined") {
    try { localStorage.setItem("bloom:api-write", JSON.stringify({ path, at: Date.now(), nonce: Math.random() })); } catch { /* In-memory invalidation still works. */ }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key === "bloom:api-write" && event.newValue) {
      try { invalidateApiReads(JSON.parse(event.newValue).path); } catch { invalidateApiReads(); }
    }
  });
}

export function resetToken() {
  generation++;
  cached = null;
  pending = null;
  invalidateApiReads();
}

async function fetchToken(gen: number): Promise<string | null> {
  const res = await fetch("/api/token", { cache: "no-store" });
  if (res.status === 401) {
    if (gen === generation) {
      cached = null;
    }
    return null;
  }
  if (!res.ok) {
    throw await toApiError(res);
  }

  const receivedAt = Date.now();
  const { token, expires_in, expires_at } = await res.json();
  const lifetime: number = expires_in ?? expires_at - receivedAt / 1000;
  if (gen === generation) {
    cached = { token, refreshAt: receivedAt + (lifetime - REFRESH_MARGIN_SECONDS) * 1000 };
  }

  return token;
}

async function getToken(): Promise<string | null> {
  if (cached && cached.refreshAt > Date.now()) {
    return cached.token;
  }

  if (!pending) {
    const request: Promise<string | null> = fetchToken(generation).finally(() => {
      if (pending === request) {
        pending = null;
      }
    });
    pending = request;
  }

  return pending;
}

// 返回未读取 body 的 Response，流式接口与 FormData 上传都走这里。
// 只有收到 HTTP 401 才会重发，此时 body 还没有任何数据，所以流式请求不会在收到数据后被重试。
export async function apiFetch(
  path: string,
  { auth = true, ...init }: ClientInit = {}
): Promise<Response> {
  if (!path.startsWith("/api/")) throw new Error("Invalid API path");
  const url = `/api/backend/${path.slice(5)}`;
  const token = auth ? await getToken() : null;
  const writing = !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
  if (writing && !KEEPS_READS.test(path)) invalidateApiReads(path);

  try {
    return await request(url, token, init, pageLocale);
  } catch (e) {
    if (!token || !(e instanceof ApiError) || e.status !== 401) {
      throw e;
    }

    // 并发时别的请求可能已经换好新令牌，只丢弃这次失败用的那个
    if (cached?.token === token) {
      cached = null;
    }

    return request(url, await getToken(), init, pageLocale);
  }
}

// 同一时刻的多个读请求合成一次发给后端（lib/batch.ts）。按令牌分组：重置令牌前后的请求不会合进同一批
const tokenOf = (key: string) => key.split(" ")[1] ?? null;
const batchedGet = createBatcher({
  send: (paths, key, signal) => request("/api/backend/batch", tokenOf(key), { method: "POST", json: { paths }, signal }, pageLocale),
  single: (path, key, signal) => request(`/api/backend/${path.slice(5)}`, tokenOf(key), { signal }, pageLocale),
});

// 只合并普通的读请求：带了别的请求选项（请求头之类）的照原样单独发
const PLAIN_READ = new Set(["auth", "signal", "cache", "method"]);

async function readFetch(path: string, init: ClientInit = {}): Promise<Response> {
  if (Object.keys(init).some((name) => !PLAIN_READ.has(name))) return apiFetch(path, init);
  if (!path.startsWith("/api/")) throw new Error("Invalid API path");
  const { auth = true, ...rest } = init;
  const token = auth ? await getToken() : null;
  try {
    return await checked(await batchedGet(path, token ? `user ${token}` : "public", rest.signal ?? undefined));
  } catch (e) {
    if (!(e instanceof ApiError)) return fetchFailed(e, pageLocale);
    if (e.status !== 401 || !token) throw e;
    // 和 apiFetch 一样：令牌失效就换一个，这一条单独再发一次
    if (cached?.token === token) cached = null;
    return request(`/api/backend/${path.slice(5)}`, await getToken(), rest, pageLocale);
  }
}

export async function api<T>(path: string, init?: ClientInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    try { return await readJson<T>(await apiFetch(path, init)); }
    finally { if (!KEEPS_READS.test(path)) notifyApiWrite(path); }
  }
  const fetchJson = async () => readJson<T>(await readFetch(path, init));
  if (init?.signal) return fetchJson();
  const key = `${generation}|${pageLocale()}|${init?.auth === false ? "public" : "user"}|${path}`;
  // 不走缓存（no-store）读到的是最新结果：丢掉旧的那份再读，新结果写回缓存，之后的普通读取不会拿到更旧的数据
  if (init?.cache === "no-store") reads.clear((cachedKey) => cachedKey === key);
  return reads.read(key, readTtl(path), fetchJson);
}
