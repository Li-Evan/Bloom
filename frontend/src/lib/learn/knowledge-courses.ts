import type { KnowledgeMap, KnowledgeNode } from "@/lib/learn/knowledge";

export interface CourseKnowledgeNode {
  id: string;
  courseId: number;
  label: string;
  readLessons?: number;
  topics: KnowledgeNode[];
}

// 知识地图右栏「已学内容」：每门课一个，里面是从它已读课文里抽出的主题（同一主题出现在两门课里各算一个）
export function courseKnowledgeMap(data: Pick<KnowledgeMap, "courses" | "nodes">) {
  const courses = new Map<number, CourseKnowledgeNode>(data.courses.map((course) => [course.id, {
    id: `course-${course.id}`, courseId: course.id, label: course.name, readLessons: course.read_lessons, topics: [],
  }]));
  for (const topic of data.nodes) {
    const owners = [...new Set(topic.sources.map((source) => source.course_id))]
      .filter((id) => courses.has(id)).sort((a, b) => a - b);
    for (const id of owners) {
      const course = courses.get(id)!;
      if (!course.topics.some((existing) => existing.id === topic.id)) {
        const sources = new Map(topic.sources.filter((source) => source.course_id === id).map((source) => [source.lesson_number, source]));
        course.topics.push({ ...topic, sources: [...sources.values()] });
      }
    }
  }
  return { nodes: [...courses.values()] };
}

// 各门课「已学内容」里的主题数之和：同一主题出现在两门课里算两个
export const courseTopicCount = (data: Pick<KnowledgeMap, "courses" | "nodes">) =>
  courseKnowledgeMap(data).nodes.reduce((sum, course) => sum + course.topics.length, 0);
