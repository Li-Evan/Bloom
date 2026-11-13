import Mono from "@/components/brand/mono";
import { cn } from "@/lib/utils";

// 等宽小标签：笔记本页眉的批注（原官网最有辨识度的元素）。
// 英文：JetBrains Mono、14px、大写、字距 0.2em、字重 regular，和官网一致。
// 中文：汉字没有等宽字形、也没有大写：外层用正文字体（汉字、空格都是正文字体，间距均匀），字重 500、13px、字距 0.08em
//   （原来 0.16em 太散，像报幕；0.2em 是给拉丁大写字母配的）；其中的数字和拉丁字母由 <Mono> 包一层 font-mono，仍是 JetBrains Mono（第 3 轮 P6 / P7）。
// 有自然序号的区块（首页各节）前缀等宽序号：「01 / 为什么有效」，序号和斜杠是 JetBrains Mono，把中文页的气质拉回来（RP2）。
// 大小两档全站统一：EYEBROW_CLASS 是区块标题上方的小标签；LABEL_CLASS 是区块内部的小标题（价目表上方、页脚栏目名等，13px）。
export const EYEBROW_CLASS =
  "font-mono text-sm font-normal uppercase tracking-[0.2em] [&:lang(zh)]:font-sans [&:lang(zh)]:text-[13px] [&:lang(zh)]:font-medium [&:lang(zh)]:tracking-[0.08em]";
export const LABEL_CLASS =
  "font-mono text-[13px] font-normal uppercase tracking-[0.2em] [&:lang(zh)]:font-sans [&:lang(zh)]:font-medium [&:lang(zh)]:tracking-[0.08em]";

// auto：浅色底（用文字绿 --primary-text，亮色 5.1:1）；dark：深色底
export default function Eyebrow({
  tone = "auto",
  index,
  className,
  children,
  ...props
}: React.ComponentProps<"p"> & { tone?: "auto" | "dark"; index?: number }) {
  return (
    <p
      className={cn(
        EYEBROW_CLASS,
        tone === "dark" ? "text-emerald-400" : "text-primary-text",
        className
      )}
      {...props}
    >
      {index !== undefined && (
        <>
          <span className="font-mono tabular">{String(index).padStart(2, "0")}</span>{" "}
          <span aria-hidden="true" className="font-mono">/</span>{" "}
        </>
      )}
      {typeof children === "string" ? <Mono text={children} /> : children}
    </p>
  );
}
