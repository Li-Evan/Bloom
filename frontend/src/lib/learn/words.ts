// 中文标题的断行：浏览器在汉字之间随处可以折行，「为什么」会被拆成「为 / 什么」。
// 按词切开（Intl.Segmenter），每个两个字以上的中文词包进不换行的片段，折行就只发生在词与词之间。
// 纯函数，课文标题的 rehype 插件和 React 组件共用；浏览器不支持 Segmenter 时原样返回。

const CJK = /[⺀-鿿＀-￯]/;

export interface WordRun {
  text: string;
  // true：这一段是一个中文词，不能在里面折行
  keep: boolean;
}

export function wordRuns(text: string, locale = "zh"): WordRun[] {
  if (!text || !CJK.test(text) || typeof Intl === "undefined" || !("Segmenter" in Intl)) {
    return [{ text, keep: false }];
  }

  const runs: WordRun[] = [];
  const push = (piece: string, keep: boolean) => {
    const last = runs[runs.length - 1];
    if (!keep && last && !last.keep) last.text += piece;
    else runs.push({ text: piece, keep });
  };

  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  for (const part of segmenter.segment(text)) {
    const word = part.segment;
    push(word, Boolean(part.isWordLike) && CJK.test(word) && [...word].length >= 2);
  }

  return runs;
}
