// Click the toolbar button (or Alt+Shift+S) on any page: take the page as the browser rendered it, keep it in memory,
// and open Bloom's /learn/clip, which asks for it through bridge.js and saves it to 网页剪藏.
// Contract: frontend/src/lib/learn/clip-protocol.ts. build.mjs fills in the placeholder values.
const BLOOM_ORIGIN = "__BLOOM_ORIGIN__";
const MAX_CLIP_BYTES = __MAX_CLIP_BYTES__;
// Two pages of at most 4 MB each fit in storage.session (10 MB); an older pending clip makes room for a new one.
const KEEP = 2;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
// A page whose scripts keep it busy can hold the copy up; past this the click gets an answer instead of waiting on.
// Above capturePage's 45 s for scrolling through a long Feishu document.
const CAPTURE_MS = 60000;

const key = (id) => `clip:${id}`;

chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });

chrome.action.onClicked.addListener((tab) => {
  void answer(tab);
});

// Every click gets an answer: "…" on the button at once, then Bloom's page with the clip or with what went wrong
async function answer(tab) {
  const badge = (text) => chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
  await badge("…");
  try {
    await clip(tab);
  } catch {
    await open(tab, { error: "failed" }).catch(() => {});
  } finally {
    await badge("");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only bridge.js on Bloom itself may take or drop a clip
  if (sender.id !== chrome.runtime.id || !sender.url || new URL(sender.url).origin !== BLOOM_ORIGIN) return;
  if (!ID.test(message?.id ?? "")) return;
  if (message.type === "take") {
    chrome.storage.session.get(key(message.id)).then((items) => sendResponse({ clip: items[key(message.id)] ?? null }));
    return true;
  }
  if (message.type === "done") void forget(message.id);
});

async function clip(tab) {
  // On Bloom itself the page is already in Bloom: clipping a lesson would save Bloom's own page into Bloom
  if (tab.url && new URL(tab.url).origin === BLOOM_ORIGIN) return open(tab, { error: "bloom" });
  let page;
  try {
    const injected = chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: capturePage });
    const timeout = new Promise((resolve) => setTimeout(() => resolve([{ result: { timedOut: true } }]), CAPTURE_MS));
    const [injection] = await Promise.race([injected, timeout]);
    page = injection?.result;
  } catch {
    // The browser's own pages, extension stores and the built-in PDF viewer refuse scripts
    return open(tab, { error: /\.pdf(?:$|[?#])/i.test(tab.url ?? "") ? "pdf" : "restricted" });
  }
  if (page?.pdf) return open(tab, { error: "pdf" });
  if (typeof page?.html !== "string") return open(tab, { error: "failed" });
  if (new TextEncoder().encode(page.html).length > MAX_CLIP_BYTES) return open(tab, { error: "too-big" });
  const id = crypto.randomUUID().replaceAll("-", "");
  await remember(id, { url: page.url, title: page.title, html: page.html });
  return open(tab, { clip: id });
}

async function open(tab, params) {
  const url = `${BLOOM_ORIGIN}/learn/clip?${new URLSearchParams(params)}`;
  try {
    return await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
  } catch {
    // No room right next to the clicked tab (an app window, a tab being dragged): any place beats no answer
    return chrome.tabs.create({ url });
  }
}

async function remember(id, page) {
  const { order = [] } = await chrome.storage.session.get("order");
  const next = [...order, id];
  const dropped = next.splice(0, Math.max(0, next.length - KEEP));
  if (dropped.length) await chrome.storage.session.remove(dropped.map(key));
  try {
    await chrome.storage.session.set({ [key(id)]: page, order: next });
  } catch {
    // Over the quota: this page matters more than the one still pending
    await chrome.storage.session.remove(next.slice(0, -1).map(key));
    await chrome.storage.session.set({ [key(id)]: page, order: [id] });
  }
}

async function forget(id) {
  const { order = [] } = await chrome.storage.session.get("order");
  await chrome.storage.session.remove(key(id));
  await chrome.storage.session.set({ order: order.filter((item) => item !== id) });
}

// Runs inside the page (main world, so it can read MathJax 3's formulas). Must not use anything from this file.
async function capturePage() {
  if (document.contentType === "application/pdf") return { pdf: true };
  // A Feishu / Lark document keeps only the blocks near the screen in the page: scroll through it once, keep every
  // top-level block (by its record id), then put the reader back where they were. Neither block ids nor the order in
  // which blocks show up are reliably document order; a block's neighbours on the screen are.
  const feishu = document.querySelector('[data-block-type="page"][data-record-id]');
  const feishuChildren = feishu?.querySelector(".page-block-children");
  let feishuBlocks = null;
  if (feishuChildren) {
    let scroller = document.scrollingElement;
    for (let node = feishuChildren.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
        scroller = node;
        break;
      }
    }
    const html = new Map();
    const order = [];
    const take = () => {
      const screen = [];
      for (const block of feishuChildren.querySelectorAll("[data-record-id]")) {
        if (block.parentElement.closest("[data-record-id]") !== feishu) continue;
        screen.push(block.dataset.recordId);
        html.set(block.dataset.recordId, block.outerHTML);
      }
      // A block seen for the first time goes right after the block above it on this screen, or before the one below
      screen.forEach((id, index) => {
        if (order.includes(id)) return;
        const above = screen.slice(0, index).reverse().find((other) => order.includes(other));
        const below = screen.slice(index + 1).find((other) => order.includes(other));
        const at = above !== undefined ? order.indexOf(above) + 1 : below !== undefined ? order.indexOf(below) : order.length;
        order.splice(at, 0, id);
      });
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
    const start = scroller.scrollTop;
    const deadline = Date.now() + 45000;
    scroller.scrollTop = 0;
    await pause();
    take();
    while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1 && Date.now() < deadline) {
      scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.7);
      await pause();
      take();
    }
    scroller.scrollTop = start;
    feishuBlocks = order.map((id) => html.get(id));
  }
  // MathJax 3 renders formulas into <mjx-container> and keeps the TeX only in JavaScript: write it down for the extractor
  const marked = [];
  try {
    for (const item of window.MathJax?.startup?.document?.math ?? []) {
      const root = item.typesetRoot;
      if (root instanceof Element && typeof item.math === "string") {
        root.setAttribute("data-bloom-tex", item.math);
        root.setAttribute("data-bloom-display", item.display ? "block" : "inline");
        marked.push(root);
      }
    }
  } catch {
    // A page's own MathJax object is not ours to trust; without it formulas fall back to their rendered text
  }
  const copy = document.documentElement.cloneNode(true);
  const children = feishuBlocks && copy.querySelector('[data-block-type="page"][data-record-id] .page-block-children');
  if (children) children.innerHTML = feishuBlocks.join("");
  for (const element of marked) {
    element.removeAttribute("data-bloom-tex");
    element.removeAttribute("data-bloom-display");
  }
  // Styles and script bodies are most of a modern page's weight and never article text. Kept: formula sources, the
  // math renderer's settings (they say whether $...$ is math) and script addresses (they say which renderer runs).
  for (const element of copy.querySelectorAll("style, link[rel~='stylesheet'], link[rel~='preload'], link[rel~='modulepreload']")) {
    element.remove();
  }
  for (const script of copy.querySelectorAll("script")) {
    const code = script.textContent ?? "";
    if (/^math\/tex/i.test(script.type) || (code.length < 20000 && /MathJax|katex|renderMathInElement|cb_enable_mathjax/.test(code))) continue;
    script.textContent = "";
  }
  return { url: location.href, title: document.title, html: `<!DOCTYPE html>\n${copy.outerHTML}` };
}
