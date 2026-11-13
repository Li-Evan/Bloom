import { useId } from "react";
import { monoRuns } from "@/lib/mono-runs";
import { cn } from "@/lib/utils";

// 「两个标准差」的钟形曲线：灰色是普通课堂，翠绿是一对一辅导，两条曲线相距 +2σ。
// 移植自原官网 hero（site/src/pages/index.astro），曲线在模块加载时算好。
const W = 560;
const BASE_Y = 250;
const X0 = 40;
const X1 = 520;
const SIGMA = 48;
const AMP = 168;
const MEAN_A = 196;
const MEAN_B = MEAN_A + 2 * SIGMA;
const PEAK = BASE_Y - AMP;

function curve(cx: number) {
  let d = "";
  for (let x = X0; x <= X1; x += 3) {
    const y = BASE_Y - AMP * Math.exp(-((x - cx) ** 2) / (2 * SIGMA * SIGMA));
    d += `${d ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
  }
  return d.trim();
}

const area = (cx: number) => `${curve(cx)} L${X1},${BASE_Y} L${X0},${BASE_Y} Z`;
const GREY_CURVE = curve(MEAN_A);
const GREY_AREA = area(MEAN_A);
const EM_CURVE = curve(MEAN_B);
const EM_AREA = area(MEAN_B);

export type BellCurveLabels = {
  avg: string;
  tutored: string;
  top: string;
};

// 标注字号：SVG 等比缩放，手机上整张图只有 320px 宽（约 0.57 倍），原来的 12.5 / 16 缩成 7 / 9px 看不清。
// 所以手机（< 640px）单独放大一档：缩放后标签约 10px、+2σ 约 11px；≥ 640px 用 14 / 18；桌面首屏图（≥ 1280 时只有约 430px 宽，缩放 0.77）标签用 16，实际约 12.3px（JetBrains Mono 12px，和官网一致，RP15）。
const SIZES = "[--bc-label:18px] [--bc-sigma:20px] sm:[--bc-label:14px] sm:[--bc-sigma:18px] lg:[--bc-label:17px] xl:[--bc-label:18px]";

// dark：深色底（等待弹窗、404 页）；auto：浅色底，暗色主题下自动换成深色底的配色
const TONE: Record<"dark" | "auto", string> = {
  dark: "[--bc-em:#00d492] [--bc-em-text:#00d492] [--bc-em-soft:#5ee9b5] [--bc-grey:#78716c] [--bc-grey-text:#a8a29e] [--bc-axis:#44403c]",
  auto: "[--bc-em:#009966] [--bc-em-text:#007a55] [--bc-em-soft:#007a55] [--bc-grey:#a8a29e] [--bc-grey-text:#78716c] [--bc-axis:#d6d3d1] dark:[--bc-em:#00d492] dark:[--bc-em-text:#00d492] dark:[--bc-em-soft:#5ee9b5] dark:[--bc-grey:#78716c] dark:[--bc-grey-text:#a8a29e] dark:[--bc-axis:#44403c]",
};

// SVG 标注：数字、拉丁字母用等宽，汉字用正文字体（和 Mono 组件同一个切法，「前 2%」里的汉字原来也是等宽栈）
// 英文（没有汉字）整句本来就是等宽，原样输出，不然单词之间的空格会变成正文字体的窄空格
function LabelText({ text }: { text: string }) {
  if (!/[一-鿿]/.test(text)) return <>{text}</>;

  return (
    <>
      {monoRuns(text).map((run, i) => (
        <tspan key={i} className={run.mono ? "font-mono" : "font-sans"}>
          {run.text}
        </tspan>
      ))}
    </>
  );
}

export default function BellCurve({
  className,
  style,
  tone = "dark",
  animated = true,
  loop = false,
  annotated = true,
  labels,
  ariaLabel,
}: {
  className?: string;
  style?: React.CSSProperties;
  tone?: "dark" | "auto";
  // 描线动画（减弱动效偏好下自动关闭）
  animated?: boolean;
  // 描线动画一遍遍重复，用作等待动画（建课弹窗）
  loop?: boolean;
  // 显示「+2σ」括标；labels 给了才显示底部的曲线名称
  annotated?: boolean;
  labels?: BellCurveLabels;
  ariaLabel?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const emGradient = `bc-em-${id}`;
  const greyGradient = `bc-grey-${id}`;
  const fadeLate = animated ? "fade-late" : undefined;
  const fadeLater = animated ? "fade-later" : undefined;

  return (
    <svg
      viewBox={labels ? `0 0 ${W} 324` : `0 30 ${W} 242`}
      className={cn("h-auto w-full", SIZES, TONE[tone], className)}
      style={style}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <defs>
        <linearGradient id={emGradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--bc-em)", stopOpacity: 0.45 }} />
          <stop offset="100%" style={{ stopColor: "var(--bc-em)", stopOpacity: 0.02 }} />
        </linearGradient>
        <linearGradient id={greyGradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--bc-grey)", stopOpacity: 0.22 }} />
          <stop offset="100%" style={{ stopColor: "var(--bc-grey)", stopOpacity: 0.01 }} />
        </linearGradient>
      </defs>
      <line x1={X0} y1={BASE_Y} x2={X1} y2={BASE_Y} strokeWidth="1" style={{ stroke: "var(--bc-axis)" }} />
      <path d={GREY_AREA} fill={`url(#${greyGradient})`} />
      <path d={GREY_CURVE} fill="none" strokeWidth="1.75" style={{ stroke: "var(--bc-grey)" }} />
      <line
        x1={MEAN_A}
        y1={BASE_Y}
        x2={MEAN_A}
        y2={PEAK + 6}
        strokeWidth="1"
        strokeDasharray="3 4"
        style={{ stroke: "var(--bc-grey)" }}
      />
      <path className={fadeLate} d={EM_AREA} fill={`url(#${emGradient})`} />
      <path
        className={animated ? (loop ? "curve-draw-loop" : "curve-draw") : undefined}
        d={EM_CURVE}
        fill="none"
        strokeWidth="2.75"
        strokeLinecap="round"
        pathLength="1"
        style={{ stroke: "var(--bc-em)" }}
      />
      <line
        x1={MEAN_B}
        y1={BASE_Y}
        x2={MEAN_B}
        y2={PEAK + 6}
        strokeWidth="1.25"
        strokeDasharray="3 4"
        style={{ stroke: "var(--bc-em)" }}
      />
      {annotated && (
        <g className={fadeLater} style={{ stroke: "var(--bc-em)" }} strokeWidth="1.25">
          <line x1={MEAN_A} y1={PEAK - 14} x2={MEAN_B} y2={PEAK - 14} />
          <line x1={MEAN_A} y1={PEAK - 20} x2={MEAN_A} y2={PEAK - 8} />
          <line x1={MEAN_B} y1={PEAK - 20} x2={MEAN_B} y2={PEAK - 8} />
          <text
            x={(MEAN_A + MEAN_B) / 2}
            y={PEAK - 22}
            textAnchor="middle"
            className="font-mono"
            fontWeight="500"
            stroke="none"
            style={{ fill: "var(--bc-em-text)", fontSize: "var(--bc-sigma)" }}
          >
            +2σ
          </text>
        </g>
      )}
      {labels && (
        <>
          <text
            x={MEAN_A + 32}
            y={BASE_Y + 24}
            textAnchor="end"
            className="font-mono"
            style={{ fill: "var(--bc-grey-text)", fontSize: "var(--bc-label)" }}
          >
            <LabelText text={labels.avg} />
          </text>
          <text
            x={MEAN_B + 8}
            y={BASE_Y + 24}
            textAnchor="start"
            className="font-mono"
            style={{ fill: "var(--bc-em-soft)", fontSize: "var(--bc-label)" }}
          >
            <LabelText text={labels.tutored} />
          </text>
          <text
            x={MEAN_B + 30}
            y={PEAK - 30}
            textAnchor="middle"
            className={cn("font-mono", fadeLater)}
            fontWeight="500"
            style={{ fill: "var(--bc-em-text)", fontSize: "var(--bc-label)" }}
          >
            <LabelText text={labels.top} />
          </text>
        </>
      )}
    </svg>
  );
}
