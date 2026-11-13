// 浏览器插件（仓库根目录 extension/）和 /learn/clip 页面之间的约定。CLIP_PROTOCOL 和 MAX_CLIP_BYTES 由 extension/build.mjs
// 构建时从这里读进插件，写法要保持「export const 名字 = 数字;」；消息格式改了要同步改 extension/src 并把 CLIP_PROTOCOL 加一。
//
// 1. 用户在某个网页上点插件：插件取下渲染好的整页，暂存在浏览器内存里（chrome.storage.session），打开 /learn/clip?clip=<id>。
//    取不了的页面（浏览器自己的页面、PDF、太大、Bloom 自己的页面）打开 /learn/clip?error=<原因>。
// 2. 页面发 clip-request；插件在 Bloom 站点上的内容脚本回 clip（找不到时 clip 为 null）。内容脚本比页面脚本先就位，
//    但页面也可能先发请求，所以插件就位时还会发一次 ready，页面收到再问一遍。
// 3. 页面存完（或确定存不了）发 clip-done，插件删掉暂存。同一网页后端去重，重复存一次也只得到原来那篇。
export const CLIP_PROTOCOL = 1;
// 和后端 web_import.MAX_BYTES 一致；插件取页时也按这个拦
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;
export const CLIP_ERRORS = ["restricted", "pdf", "too-big", "failed", "bloom"] as const;
export type ClipError = (typeof CLIP_ERRORS)[number];

export type CapturedPage = { url: string; title: string; html: string };

export type ExtensionMessage =
  | { source: "bloom-extension"; type: "ready"; version: number }
  | { source: "bloom-extension"; type: "clip"; version: number; id: string; clip: CapturedPage | null };

export type PageMessage =
  | { source: "bloom-page"; type: "clip-request"; id: string }
  | { source: "bloom-page"; type: "clip-done"; id: string };

export const isClipId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);

export const clipError = (value: unknown): ClipError | null =>
  CLIP_ERRORS.includes(value as ClipError) ? (value as ClipError) : null;

export function fromExtension(event: MessageEvent): ExtensionMessage | null {
  if (event.source !== window || event.origin !== window.location.origin) return null;
  const data = event.data as Partial<ExtensionMessage> | null;
  return data && data.source === "bloom-extension" && (data.type === "ready" || data.type === "clip")
    ? (data as ExtensionMessage)
    : null;
}

export function toExtension(message: Omit<PageMessage, "source">) {
  window.postMessage({ source: "bloom-page", ...message }, window.location.origin);
}
