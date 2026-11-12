// 一次请求的 request_id（建课、提问等；后端只收字母、数字和 . _ ~ -，至多 64 个字符）。
// crypto.randomUUID 只在安全上下文（https 或 localhost）里有，http://局域网 IP 上没有；getRandomValues 不受这个限制。
export function newRequestKey(
  source: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">> = globalThis.crypto
): string {
  if (typeof source.randomUUID === "function") {
    return source.randomUUID();
  }

  const bytes = source.getRandomValues(new Uint8Array(16));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
