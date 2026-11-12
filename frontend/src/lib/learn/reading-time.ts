// 预计阅读时间：汉字按每分钟 400 字、其它文字按每分钟 240 词，两部分相加向上取整，至少 1 分钟。
// 速度取自 Brysbaert 2019 的阅读速度元分析（Journal of Memory and Language 109）：英文成人默读非虚构类 238 词/分钟，
// 汉语默读 260 词/分钟、按 1.5 个字一个词约 390 字/分钟，各取整。后端 courses.py 的 _reading_stats 用同一组数。
export const CHARS_PER_MINUTE = 400;
export const WORDS_PER_MINUTE = 240;

const HAN = /[一-鿿]/g;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

// 不算字数的部分：隐藏注释、图片、链接地址（链接文字照算）、裸网址
const strip = (markdown: string) =>
  markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "");

// 没有文字（扫描版 PDF 提取不出字）返回 0
export function readingMinutes(markdown: string): number {
  const text = strip(markdown);
  const chars = text.match(HAN)?.length ?? 0;
  const words = text.replace(HAN, " ").match(WORD)?.length ?? 0;
  if (!chars && !words) return 0;

  return Math.max(1, Math.ceil((chars * WORDS_PER_MINUTE + words * CHARS_PER_MINUTE) / (CHARS_PER_MINUTE * WORDS_PER_MINUTE)));
}

// 第一个二级标题之前已经写着带数字的阅读时间（AI 课文标题下的元信息、原文篇头部）：页面上不再另加一行。
// 旧原文篇里「按原文长度而定」这类占位不算（渲染时被去掉了）
const STATED = /(?:阅读(?:时间|时长)|read(?:ing)? time)[ \t*]*[:：][^\n]*[0-9一二三四五六七八九十]/i;

export function statesReadingTime(markdown: string): boolean {
  return STATED.test(markdown.split(/^##[ \t]/m)[0]);
}
