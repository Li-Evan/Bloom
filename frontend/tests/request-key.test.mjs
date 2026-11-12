import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const { newRequestKey } = await import("../src/lib/learn/request-key.ts");

// 后端接受的 request_id（划线提问、追问、问这篇用它对上停止时存的半截回答）：至多 64 个字符，只有字母、数字和 . _ ~ -
const BACKEND_KEY = /^[A-Za-z0-9._~-]{1,64}$/;

test("这里的格式就是后端 schemas 里 request_id 的格式", async () => {
  const schemas = await readFile(new URL("../../backend/app/schemas.py", import.meta.url), "utf8");
  const patterns = [...schemas.matchAll(/request_id: str \| None = Field\(None, pattern=r"([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(patterns.length > 0, "后端 schemas 里找不到 request_id");
  for (const pattern of patterns) assert.equal(pattern, BACKEND_KEY.source);
});

test("有 crypto.randomUUID（安全上下文）时用它", () => {
  const key = newRequestKey({ randomUUID: () => "11111111-2222-4333-8444-555555555555" });
  assert.equal(key, "11111111-2222-4333-8444-555555555555");
  assert.match(key, BACKEND_KEY);
});

test("没有 randomUUID（例如 http://局域网 IP 这种非安全来源）时，用 getRandomValues 拼一个随机的 URL 安全字符串", () => {
  let filled = 0;
  const fake = {
    getRandomValues: (bytes) => {
      filled += bytes.length;
      return bytes.map((_, i) => (i * 37 + 11) % 256);
    },
  };
  const key = newRequestKey(fake);
  assert.ok(filled >= 16, "至少取 128 位随机数");
  assert.match(key, BACKEND_KEY);
  assert.ok(key.length >= 32);
});

test("两条路径各生成的 key 彼此不同；真实的 crypto 两条路径都可用", () => {
  const { randomUUID, getRandomValues } = globalThis.crypto;
  const noUuid = { getRandomValues: getRandomValues.bind(globalThis.crypto) };
  assert.notEqual(newRequestKey(noUuid), newRequestKey(noUuid));
  assert.notEqual(newRequestKey(), newRequestKey());
  assert.match(newRequestKey(noUuid), BACKEND_KEY);
  assert.match(newRequestKey({ randomUUID: randomUUID.bind(globalThis.crypto) }), BACKEND_KEY);
});
