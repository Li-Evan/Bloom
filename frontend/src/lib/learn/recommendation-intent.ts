import type { LearningIntent } from "@/lib/learn/api";
import type { Recommendation } from "@/lib/learn/types";

// 用推荐开课时，推荐理由和它接在哪些已学内容上作为「学习意图」交给建课（和新建课程对话框里确认过的目标走同一条路）。
// 不能当 reference 传：非空的 reference 会被当成用户上传的参考资料，大纲每条都要标资料出处、联网检索也会关掉。
export function recommendationIntent(item: Pick<Recommendation, "title" | "rationale" | "bridge">): LearningIntent {
  const bridge = item.bridge?.trim();

  return {
    goal: item.title,
    summary: item.rationale?.trim() || item.title,
    assumptions: bridge ? [bridge] : [],
    answers: [],
  };
}
