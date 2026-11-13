import { api } from "@/lib/api-client";
import type { NotesPage } from "@/lib/me/types";
import type { Me } from "@/types/user";

// 用户中心在浏览器里发的请求（服务端取数走 backendFetch）

export const getNotesPage = (page: number, limit = 100) =>
  api<NotesPage>(`/api/me/annotations?page=${page}&limit=${limit}`);

export const saveNickname = (nickname: string) => api<Me>("/api/me", { method: "PATCH", json: { nickname } });

export const saveArchiveOnRead = (enabled: boolean) =>
  api<{ enabled: boolean }>("/api/me/archive-on-read", { method: "PUT", json: { enabled } });
