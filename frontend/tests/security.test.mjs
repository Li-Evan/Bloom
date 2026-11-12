import assert from "node:assert/strict";
import { test } from "node:test";

test("所有页面都不许被任何站点嵌入；不猜类型、跨站只带来源；不加会拦掉第三方脚本的完整 CSP", async () => {
  const config = (await import("../next.config.mjs")).default;
  const rules = await config.headers();
  const all = rules.find((rule) => rule.source === "/:path*");
  assert.ok(all, "缺少覆盖全部路径的规则");
  assert.deepEqual(Object.fromEntries(all.headers.map(({ key, value }) => [key, value])), {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  const { createRequire } = await import("node:module");
  const { buildCustomRoute } = createRequire(import.meta.url)("next/dist/server/lib/router-utils/filesystem");
  const route = buildCustomRoute("header", all, "", false);
  for (const path of ["/", "/zh", "/zh/learn/course/3", "/api/backend/courses/1"]) assert.ok(route.match(path), path);
});
