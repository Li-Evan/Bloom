import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const { localePath } = await import("../src/lib/locale-path.ts");
const robots = (await import("../src/app/robots.ts")).default;

test("默认语言不带前缀，其它语言带前缀，首页是 /zh 而不是 /zh/", () => {
  assert.equal(localePath("en", "/"), "/");
  assert.equal(localePath("en", "/learn"), "/learn");
  assert.equal(localePath("zh", "/"), "/zh");
  assert.equal(localePath("zh", "/learn"), "/zh/learn");
});

test("robots.txt：自托管的个人学习工具，整站禁止抓取，不给 sitemap", () => {
  const { rules, sitemap } = robots();
  assert.equal(rules.userAgent, "*");
  assert.equal(rules.disallow, "/");
  assert.equal(rules.allow, undefined);
  assert.equal(sitemap, undefined);
});

test("整站和学习区、用户中心都声明 noindex", async () => {
  for (const file of [
    "src/app/[locale]/layout.tsx",
    "src/app/[locale]/(default)/learn/layout.tsx",
    "src/app/[locale]/(default)/me/layout.tsx",
  ]) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(text, /robots:\s*{\s*index:\s*false/, file);
  }
});

test("robots.txt 不依赖后端：同步生成，源码里没有引用后端客户端", async () => {
  assert.equal(robots() instanceof Promise, false);
  const text = await readFile(
    new URL("../src/app/robots.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(text, /@\/lib\/backend|backendFetch/);
});

test("next-intl 不再自己在 HTTP Link 头里输出 hreflang，HTML 里的标签是唯一来源", async () => {
  const text = await readFile(
    new URL("../src/i18n/routing.ts", import.meta.url),
    "utf8"
  );
  assert.match(text, /alternateLinks:\s*false/);
});
