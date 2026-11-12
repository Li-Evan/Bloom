import { backendFetch } from "@/lib/backend";

// 用户中心服务端取数的超时：后端卡住时，整页不能陪着一起等下去。
// 超时按「连不上后端」处理（api-common 的 request 把非 AbortError 的失败都转成 BackendUnreachableError），
// 走各页已有的降级：核心数据取不到显示带「重试」的错误块，概览里的辅助数据取不到就在那一块显示加载失败。
export const ME_FETCH_TIMEOUT_MS = 8000;

// 用户中心各页取数一律用它，不直接用 backendFetch（tests/me.test.mjs 守着）。
// 同一页里要连着取好几次的传同一个 signal，总共只等一个超时
export function meFetch<T>(path: string, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
  return backendFetch<T>(path, { signal: signal ?? AbortSignal.timeout(ME_FETCH_TIMEOUT_MS) });
}
