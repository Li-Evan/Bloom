import { ApiError, api } from "@/lib/api-client";

const CHUNK_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 20 * CHUNK_BYTES;
const MAX_TOTAL_BYTES = 50 * CHUNK_BYTES;
const CHUNK_RETRY_DELAYS_MS = [400, 1200];

// These failures happen BEFORE course submission: never leave a generating card.
export class UploadError extends Error {}

// 后端上传接口的固定英文报错：中文页面换成中文，不在中文句子后面接一句英文
const ZH_REASONS: Record<string, string> = {
  "Upload expired or unavailable; please upload again.": "上传已过期。",
  "Upload already consumed; please upload again.": "这次上传已被使用过。",
  "Files must total at most 50 MB.": "文件总计不能超过 50 MB。",
  "Invalid or duplicate filenames.": "文件名无效或有重复。",
  "Too many unfinished uploads; please retry later.": "未完成的上传太多，请稍后再试。",
  "Upload chunk exceeds 1 MB.": "上传分片超过 1 MB。",
  "Invalid chunk index or length.": "上传分片不完整。",
  "Chunk already uploaded with different content.": "文件在上传过程中被改动过。",
  "Unsupported upload chunk size": "上传分片大小不受支持。",
};

// 分片 PUT 对同一内容是幂等的（后端存过同样的字节就直接返回 ok）：断网、超时、5xx、429 时退避后重发，别因为一片抖动整次上传作废
const retryable = (error: unknown) =>
  !(error instanceof ApiError) || error.status === 0 || error.status === 429 || error.status >= 500;

async function putChunk(path: string, body: Blob) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(path, { method: "PUT", body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (attempt >= CHUNK_RETRY_DELAYS_MS.length || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, CHUNK_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// onProgress(已传字节, 总字节)：建课等待弹窗用它显示真实的上传进度
export async function uploadCourseFiles(files: File[], onProgress?: (sent: number, total: number) => void): Promise<string> {
  const zh = typeof document === "undefined" || document.documentElement.lang.startsWith("zh");
  let id: string | undefined;
  try {
    if (!files.length || files.length > 50 || files.some(f => f.size > MAX_FILE_BYTES) ||
        files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) {
      throw new Error(zh ? "最多上传 50 个文件，单个不超过 20 MB，总计不超过 50 MB。" :
        "Upload at most 50 files, 20 MB per file and 50 MB in total.");
    }
    // crypto.subtle 只在安全上下文（HTTPS、localhost）里有：局域网 http 地址上打开时直接说清楚，别抛一个 TypeError
    if (!globalThis.crypto?.subtle) {
      throw new Error(zh ? "当前地址不是安全连接（HTTPS 或 localhost），浏览器不允许计算文件校验值。请改用 HTTPS 地址打开后再上传。" :
        "This page is not on a secure connection (HTTPS or localhost), so the browser cannot checksum files. Open it over HTTPS and upload again.");
    }
    const total = files.reduce((sum, f) => sum + f.size, 0);
    let sent = 0;
    onProgress?.(0, total);
    const manifest = [];
    for (const file of files) {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      manifest.push({ name: file.webkitRelativePath || file.name, size: file.size,
        sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("") });
    }
    const session = await api<{ id: string; chunk_bytes: number }>("/api/uploads", {
      method: "POST", json: { files: manifest }, signal: AbortSignal.timeout(60_000),
    });
    id = session.id;
    if (session.chunk_bytes !== CHUNK_BYTES) throw new Error("Unsupported upload chunk size");
    for (const [i, file] of files.entries()) {
      const count = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
      for (let j = 0; j < count; j++) {
        const chunk = file.slice(j * CHUNK_BYTES, (j + 1) * CHUNK_BYTES);
        await putChunk(`/api/uploads/${id}/files/${i}/parts/${j}`, chunk);
        sent += chunk.size;
        onProgress?.(sent, total);
      }
    }
    return id;
  } catch (error) {
    if (id) void discardUpload(id);
    const message = error instanceof Error ? error.message : "";
    const reason = zh ? ZH_REASONS[message] ?? message : message;
    throw new UploadError(zh ? `文件上传失败，课程尚未开始生成。请重新上传。${reason}` :
      `File upload failed. Course generation has not started. Please upload again. ${reason}`);
  }
}

export async function discardUpload(id: string): Promise<void> {
  // Expiry cleanup is the fallback if the network is unavailable.
  await api(`/api/uploads/${id}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => {});
}
