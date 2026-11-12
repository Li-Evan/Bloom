import type { CourseLanguage } from "@/lib/learn/types";

export const COURSE_LANGUAGES: CourseLanguage[] = ["zh", "en"];

// 语言的自称（每种语言写它自己的名字，任何界面语言下都一样），所以不放进翻译文件
export const LANGUAGE_NAMES: Record<CourseLanguage, string> = {
  zh: "中文",
  en: "English",
};

// 界面语言 → 课程语言的默认值
export const courseLanguageOf = (locale: string): CourseLanguage =>
  locale === "zh" ? "zh" : "en";

// 语言选项的排列顺序：跟着当前界面语言，当前语言排第一（中文界面「中文 | English」，英文界面「English | 中文」）。
// 新建课程的「课程语言」和设置里的「界面语言」共用，两处顺序不再各是各的
export const languagesFor = (locale: string): CourseLanguage[] => {
  const first = courseLanguageOf(locale);

  return [first, ...COURSE_LANGUAGES.filter((l) => l !== first)];
};

// 英文里几乎每句都有、其他拉丁字母语言（法、德、西、意、葡……）里几乎不出现的词：一个都没有的拉丁字母文字多半不是英文
const ENGLISH_WORDS = new Set(
  "the of and to is it that for with this these those are were be been from have has had which who you your they their there would could should can what when about into than its our we she his her them not but at by or if".split(" ")
);

// 划线的这段主要不是界面语言写的：气泡里多给一个「翻译」。数汉字和其他文字的词，谁多算谁（夹几个英文术语的中文还是中文）；
// 英文界面再看拉丁字母的文字里有没有英文常用词（带重音字母或至少六个词才算，免得几个术语也被当成外文）。假名占得多的是日文，两种界面都算外文
export function isForeignText(text: string, locale: string): boolean {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kana = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}+/gu) ?? [];
  const others = text.match(/[^\P{L}\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)?.length ?? 0;
  if (kana && kana * 4 >= han) return true;
  if (courseLanguageOf(locale) === "zh") return latin.length + others > han;
  if (han + others > latin.length) return true;

  return latin.length > 0 && !latin.some((w) => ENGLISH_WORDS.has(w.toLowerCase())) && (latin.length >= 6 || latin.some((w) => /[^a-z]/i.test(w)));
}

// 课程语言和界面语言不同才需要在课程卡片上标出来
export const foreignLanguage = (
  language: CourseLanguage | undefined,
  locale: string
): CourseLanguage | null =>
  language && language !== courseLanguageOf(locale) ? language : null;
