import { Fragment } from "react";
import { monoRuns } from "@/lib/mono-runs";

// 中文页里的等宽字体只给数字和拉丁字母。
// 整段文字都套 font-mono 时，汉字会落到系统黑体，但空格、数字用的是等宽字形：一个空格 0.6em 宽，「一门  10  篇」看上去被拉开了。
// 所以外层用正文字体，只把数字 / 字母 / 货币符号这些连续的片段包一层 font-mono；汉字和它们之间的空格仍是正文字体，间距均匀。
// 英文页整段本来就是等宽，这一层是空操作。切法在 lib/mono-runs.ts，钟形曲线的 SVG 标注共用它。
export default function Mono({ text }: { text: string }) {
  return (
    <>
      {monoRuns(text).map((run, i) =>
        run.mono ? (
          <span key={i} className="font-mono">
            {run.text}
          </span>
        ) : (
          <Fragment key={i}>{run.text}</Fragment>
        )
      )}
    </>
  );
}
