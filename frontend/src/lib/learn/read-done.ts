// 「我读完了」：有没存的反馈（或思考题回答）就先存。存失败就停在这里，不去调生成接口：
// 下一篇课文要根据已保存的反馈个性化，没存上就生成只会得到一篇更差的课文。
// 返回是否执行了生成。
export async function saveFeedbackThenGenerate(
  save: (() => Promise<boolean>) | null,
  generate: () => Promise<void>
): Promise<boolean> {
  if (save && !(await save())) {
    return false;
  }

  await generate();
  return true;
}
