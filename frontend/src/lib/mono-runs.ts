// 数字、拉丁字母、货币符号这一串（「100」「¥35.00」「Bloom」「2.8」「2%」）
const MONO_RUN = /([0-9A-Za-z¥$€£%][0-9A-Za-z¥$€£%.,:/+×~-]*)/;

// 把文字切成「等宽片段 / 正文片段」交替的几段：中文页里的等宽字体只给数字和拉丁字母，
// 汉字和它们之间的空格留在正文字体。Mono 组件（HTML）和钟形曲线的标注（SVG <tspan>）共用这一个切法。
export function monoRuns(text: string): { text: string; mono: boolean }[] {
  return text
    .split(MONO_RUN)
    .map((part, i) => ({ text: part, mono: i % 2 === 1 }))
    .filter((run) => run.text !== "");
}
