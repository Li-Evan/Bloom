import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import {
  ApiError,
  BackendUnreachableError,
  decodeSegment,
  pathSegment,
  request,
} from "../src/lib/api-common.ts";

async function closedPortUrl() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/api/me`;
}

test("连不上后端：中文界面给中文说明，其它语言给英文，保留原始错误", async () => {
  const url = await closedPortUrl();

  const zh = await request(url, null, {}, () => "zh").catch((e) => e);
  assert.ok(zh instanceof BackendUnreachableError);
  assert.ok(zh instanceof ApiError);
  assert.match(zh.message, /^无法连接后端服务（原因：.+）$/);
  assert.equal(zh.status, 0);
  assert.ok(zh.cause);

  for (const locale of ["en", "", "fr"]) {
    const en = await request(url, null, {}, async () => locale).catch((e) => e);
    assert.ok(en instanceof BackendUnreachableError);
    assert.match(en.message, /^Cannot connect to the backend service \(Reason: .+\)$/);
  }
});

test("主动中断（AbortError）原样抛出，不当成连不上", async () => {
  const controller = new AbortController();
  controller.abort();
  const error = await request(
    await closedPortUrl(),
    null,
    { signal: controller.signal },
    () => "zh"
  ).catch((e) => e);
  assert.equal(error.name, "AbortError");
  assert.ok(!(error instanceof ApiError));
});

test("有响应时仍按 detail 解析：对象取 message 并保留原 detail，字符串保留 detail 文本", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), "Bearer tk");
    return new Response(
      JSON.stringify({ detail: { code: "rate_limited", message: "请求太频繁" } }),
      { status: 429 }
    );
  });
  const e429 = await request("http://x/api", "tk", {}, () => "en").catch(
    (e) => e
  );
  assert.ok(e429 instanceof ApiError && !(e429 instanceof BackendUnreachableError));
  assert.deepEqual(
    [e429.status, e429.message, e429.detail],
    [429, "请求太频繁", { code: "rate_limited", message: "请求太频繁" }]
  );

  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ detail: "找不到这门课程" }), { status: 404 })
  );
  const e404 = await request("http://x/api", null, {}, () => "en").catch(
    (e) => e
  );
  assert.ok(e404 instanceof ApiError && !(e404 instanceof BackendUnreachableError));
  assert.deepEqual([e404.status, e404.message], [404, "找不到这门课程"]);
});

test("路径片段：已解码和已编码的路由参数得到同一个结果，中文 slug 不会被二次编码", () => {
  assert.equal(pathSegment("你好-世界"), "%E4%BD%A0%E5%A5%BD-%E4%B8%96%E7%95%8C");
  assert.equal(
    pathSegment("%E4%BD%A0%E5%A5%BD-%E4%B8%96%E7%95%8C"),
    "%E4%BD%A0%E5%A5%BD-%E4%B8%96%E7%95%8C"
  );
  assert.equal(pathSegment("hello-bloom"), "hello-bloom");
  assert.equal(pathSegment("a b"), "a%20b");
  assert.equal(pathSegment("a%20b"), "a%20b");
  assert.equal(pathSegment("a%2Fb"), "a%2Fb", "斜杠不能变成路径分隔");
  assert.equal(pathSegment("../x"), "..%2Fx");
});

test("路径片段：畸形的百分号（孤立的 %、被截断的序列）当作已解码的原文，不抛 URIError", () => {
  assert.equal(pathSegment("100%"), "100%25");
  assert.equal(pathSegment("100%25"), "100%25", "已编码的 100% 和原文 100% 是同一个");
  assert.equal(pathSegment("%E4%BD"), "%25E4%25BD");
  assert.equal(pathSegment("a%b%20c"), "a%25b%2520c");
  assert.equal(decodeSegment("100%"), "100%");
  assert.equal(decodeSegment("%E4%BD"), "%E4%BD");
  assert.equal(decodeSegment("%E4%BD%A0"), "你");
  assert.equal(decodeSegment("你好码"), "你好码");
});

test("超时不是连不上：AbortSignal.timeout 的 TimeoutError 如实报超时", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const zh = await request("http://x/api", null, {}, () => "zh").catch((e) => e);
  assert.ok(zh instanceof BackendUnreachableError);
  assert.equal(zh.message, "请求超时，后端没有在限定时间内响应");
  const en = await request("http://x/api", null, {}, () => "en").catch((e) => e);
  assert.equal(en.message, "The request timed out before the backend responded");
});

test("平台返回的非 JSON 错误页：保留错误码和页面要点，不只剩状态码", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("<html><body>An error occurred with your deployment</body></html>", {
      status: 504,
      headers: { "x-vercel-error": "FUNCTION_INVOCATION_TIMEOUT", "content-type": "text/html" },
    })
  );
  const error = await request("http://x/api", null, {}, () => "zh").catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 504);
  assert.equal(error.detail, undefined);
  assert.equal(error.message, "HTTP 504 FUNCTION_INVOCATION_TIMEOUT An error occurred with your deployment");
});

test("平台错误页不是后端的回答：404/401 页面不能读成「不存在」「未登录」，一律 502（只有 504/413/429 保留）；原因里不带 CSS 和脚本", async (t) => {
  const cases = [
    [404, "<html><head><style>body{margin:0}</style><script>window.x=1</script></head><body><h1>404: NOT_FOUND</h1></body></html>", 502, "HTTP 404 404: NOT_FOUND"],
    [401, "<html><body>Authentication Required</body></html>", 502, "HTTP 401 Authentication Required"],
    [413, "Request Entity Too Large", 413, "HTTP 413 Request Entity Too Large"],
    [429, "", 429, "HTTP 429"],
  ];
  for (const [status, body, expected, message] of cases) {
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status, headers: { "content-type": "text/html" } }));
    const error = await request("http://x/api", null, {}, () => "zh").catch((e) => e);
    assert.ok(error instanceof ApiError);
    assert.deepEqual([error.status, error.message, error.detail], [expected, message, undefined], `${status}`);
  }
});
