import { api } from "@/lib/api-client";

export const TEACHING_STYLES = ["balanced", "socratic", "analogy", "practical", "concise", "rigorous", "custom"] as const;
export type TeachingStyleId = (typeof TEACHING_STYLES)[number];
export type TeachingStyle = { preset: TeachingStyleId; custom_instructions: string };
export const MAX_STYLE_LENGTH = 2000;

export const getTeachingStyle = () => api<TeachingStyle>("/api/me/teaching-style");
export const saveTeachingStyle = (style: TeachingStyle) =>
  api<TeachingStyle>("/api/me/teaching-style", { method: "PUT", json: style });
