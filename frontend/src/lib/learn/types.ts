export type LearningDepth = "simple" | "standard" | "deep";

// 课程语言：建课时定下，之后不变（后端 courses.language）
export type CourseLanguage = "zh" | "en";

export interface Course {
  id: number;
  name: string;
  mode: string;
  status: string;
  learning_depth: string;
  language?: CourseLanguage;
  is_project: boolean;
  created_at: string;
  lesson_count: number;
  mastery_progress: number;
  // 已讲到几个要点 / 一共几个要点（项目课：已读几个文件 / 一共几个文件）。进度百分比 = 已讲到 / 总数
  mastery_covered?: number;
  mastery_total?: number;
  source_filename: string | null;
  syllabus_content?: string | null;
  // 项目导入时读不了、被跳过的文件（只在 from-project 的响应里有）
  skipped_files?: string[];
  // 浏览器插件剪下来的网页都进这门课
  is_clippings?: boolean;
}

// 往项目课里添加资料的结果：新课文的编号，和建课时一样列出读不了、被跳过的文件
export interface AddedLessons {
  added: number[];
  skipped_files: string[];
}

export interface LessonItem {
  id: number;
  number: number;
  is_evaluation: boolean;
  is_source: boolean;
  source_filename: string | null;
  title: string;
  has_feedback: boolean;
  is_read: boolean;
  // 资料课里归档了：课程页收进「已归档」，不算已读进度和「继续学习」
  is_archived?: boolean;
  created_at: string;
}

export interface Lesson {
  teaching_plan?: { action: "repair" | "consolidate" | "advance"; focus: string } | null;
  id: number;
  course_id: number;
  number: number;
  content: string;
  is_evaluation: boolean;
  is_source: boolean;
  source_filename: string | null;
  is_read: boolean;
  created_at: string;
}

// 课文页首屏：服务端渲染时取好的正文、课程和课文目录（lib/learn/lesson-start.ts）
export interface LessonStart {
  lesson: Lesson;
  course: Course | null;
  lessons: LessonItem[] | null;
}

export interface Message {
  role: string;
  content: string;
}

export interface Session {
  id: number | string;
  original_text: string;
  comment: string;
  anchor_top: number;
  position_start: number;
  position_end: number;
  pdf_position: string | null;
  messages: Message[];
}

export interface Annotation extends Session {
  id: number;
  lesson_id: number;
  answer: string;
  created_at: string;
}

export interface FeedbackState {
  scope?: "auto" | "next" | "course";
  exists: boolean;
  content: string;
  thought_answers: string;
}

export interface LastLesson {
  course_id: number;
  course_name: string;
  lesson_number: number;
  lesson_title: string;
  opened_at: string;
  // 这门课已经完结：「继续学习」去课程页（总结在那里），而不是某一篇课文
  course_completed?: boolean;
}

export interface GlobalStats {
  total_courses: number;
  active_courses: number;
  completed_courses: number;
  total_lessons_read: number;
  total_annotations: number;
  total_feedback: number;
  current_streak: number;
  longest_streak: number;
  last_lesson?: LastLesson | null;
}

export interface CalendarCourse {
  course_id: number;
  course_name: string;
  mode: string;
  lessons: number[];
  annotations: number;
  event_count: number;
}

export interface CalendarDay {
  date: string;
  event_count: number;
  lessons_read: number;
  annotations: number;
  courses: CalendarCourse[];
}

export interface Calendar {
  days: CalendarDay[];
  total_active_days: number;
  first_active_date: string | null;
  last_active_date: string | null;
}

export interface Recommendation {
  id: number;
  title: string;
  rationale: string;
  bridge: string;
  source_topics: string[];
  status: string;
  generation: number;
  language?: CourseLanguage;
  course_id: number | null;
}

export interface RecommendationDashboard {
  recommendations: Recommendation[];
  saved: Recommendation[];
}

export interface CompletedResult {
  ok: boolean;
  is_read: boolean;
  // 按设置「读完立刻归档」顺手归档了这个文件
  archived?: boolean;
  course_completed: boolean;
  mastery_progress: number;
}

export interface PdfPosition {
  page: number;
  rects: { page: number; x: number; y: number; w: number; h: number }[];
}

export type NextLessonDone = {
  done: true;
  lesson_number?: number;
  is_evaluation?: boolean;
  completed?: boolean;
  // 新课文比学生要求的字数上限长（值是那个上限）：照常保存了，只在新课文页提示一句
  length_exceeded?: number;
};

export interface PassageHighlight {
  id: number; lesson_id: number; original_text: string; position_start: number; position_end: number; anchor_top: number; pdf_position: string | null;
}

// 本篇保存下来的一条划线翻译
export interface PassageTranslation {
  id: number; lesson_id: number; original_text: string; position_start: number; position_end: number; anchor_top: number;
  pdf_position: string | null; target: CourseLanguage; translation: string; created_at: string;
}
