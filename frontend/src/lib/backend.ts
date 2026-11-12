import { cache } from "react";
import { ApiError, type ApiInit, checked, fetchFailed, readJson, request } from "@/lib/api-common";
import { createBatcher } from "@/lib/batch";
import { getLocale } from "next-intl/server";
import { LOCAL_USER } from "@/lib/local-user";
import { signToken } from "@/lib/token";

export { ApiError } from "@/lib/api-common";

type BackendInit = ApiInit;

function backendUrl() {
  const baseUrl = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("BACKEND_URL is not set");
  }
  return baseUrl;
}

// 同一次页面渲染里只签一次令牌：这些读请求带的是同一个令牌，才能合成一批（见下面的 batchedGet）
const userToken = cache(async () => (await signToken({ scope: "user", sub: LOCAL_USER.uuid, email: LOCAL_USER.email })).token);

// 同一时刻的多个读请求合成一次发给后端（lib/batch.ts）
const tokenOf = (key: string) => key.split(" ")[1] ?? null;
const batchedGet = createBatcher({
  send: (paths, key, signal) =>
    request(`${backendUrl()}/api/batch`, tokenOf(key), { method: "POST", json: { paths }, signal }, getLocale),
  single: (path, key, signal) => request(`${backendUrl()}${path}`, tokenOf(key), { signal }, getLocale),
});

// 只合并普通的读请求：带缓存策略（next.revalidate）、请求头之类选项的照原样单独发
const plainRead = (init: ApiInit) =>
  Object.keys(init).every((name) => name === "signal" || (name === "method" && init.method === "GET"));

export async function backendFetch<T>(path: string, init: BackendInit = {}): Promise<T> {
  const baseUrl = backendUrl();
  const token = await userToken();

  if (plainRead(init)) {
    let res: Response;
    try {
      res = await batchedGet(path, `user ${token}`, init.signal ?? undefined);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return fetchFailed(e, getLocale);
    }
    return readJson<T>(await checked(res));
  }

  return readJson<T>(
    await request(`${baseUrl}${path}`, token, init, getLocale)
  );
}
