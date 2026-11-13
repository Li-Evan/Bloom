const SRC = new URL("../src/", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const path = specifier.slice(2);
    return nextResolve(new URL(path.endsWith(".json") ? path : `${path}.ts`, SRC).href, context);
  }
  // next-intl 的 ESM 产物和源码里写的是 `next/server`、`next/headers`，node 原生 ESM 解析需要带扩展名（Next 自带的打包器不需要）
  if (specifier === "next/server" || specifier === "next/headers") {
    return nextResolve(`${specifier}.js`, context);
  }
  return nextResolve(specifier, context);
}

// 源码里的 JSON 是打包器直接 import 的，没有 node 要求的 `with { type: "json" }`；测试里补上
export function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    return nextLoad(url, { ...context, importAttributes: { type: "json" } });
  }
  return nextLoad(url, context);
}
