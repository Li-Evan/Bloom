// Content script on Bloom's own site: hands the page waiting in background.js to /learn/clip.
// Contract: frontend/src/lib/learn/clip-protocol.ts. build.mjs fills in the placeholder values.
const CLIP_PROTOCOL = __CLIP_PROTOCOL__;

const reply = (message) =>
  window.postMessage({ source: "bloom-extension", version: CLIP_PROTOCOL, ...message }, window.location.origin);

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (data?.source !== "bloom-page" || typeof data.id !== "string") return;
  if (data.type === "clip-request") {
    chrome.runtime.sendMessage({ type: "take", id: data.id }).then(
      (answer) => reply({ type: "clip", id: data.id, clip: answer?.clip ?? null }),
      () => reply({ type: "clip", id: data.id, clip: null })
    );
  } else if (data.type === "clip-done") {
    void chrome.runtime.sendMessage({ type: "done", id: data.id }).catch(() => {});
  }
});

// The page may have asked before this script was listening
reply({ type: "ready" });
