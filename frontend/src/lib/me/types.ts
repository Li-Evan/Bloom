import type { Paged } from "@/types/api";
import type { GlobalStats, LastLesson } from "@/lib/learn/types";

// 用户中心用到的后端数据形状。接口说明见 task-2-report（/api/me/annotations、/api/stats 的 last_lesson、流水的 description）。

export type { LastLesson };

export type MeStats = GlobalStats & { last_lesson: LastLesson | null };

export interface NoteItem {
  id: number;
  course_id: number;
  course_name: string;
  // 0 是课程总结篇
  lesson_number: number;
  lesson_title: string;
  original_text: string;
  question: string;
  answer_preview: string;
  // 提问和回答各算一条：一问一答是 2，追问一次是 4
  message_count: number;
  created_at: string;
  updated_at: string;
}

export type NotesPage = Paged<NoteItem>;

export interface CourseBrief {
  id: number;
  name: string;
  status: string;
  lesson_count: number;
  mastery_progress: number;
  mastery_covered?: number;
  mastery_total?: number;
  is_project?: boolean;
}
