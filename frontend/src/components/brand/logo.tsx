import { cn } from "@/lib/utils";

// 原官网的花形标志：四瓣主花 + 两瓣淡的斜瓣 + 花心
const PETALS: [string, number][] = [
  ["M50 6C54 20 64 25 50 42C36 25 46 20 50 6Z", 1],
  ["M88 42C74 46 69 56 50 42C69 28 74 38 88 42Z", 0.8],
  ["M50 78C46 64 36 59 50 42C64 59 54 64 50 78Z", 0.6],
  ["M12 42C26 38 31 28 50 42C31 56 26 46 12 42Z", 0.7],
  ["M76 16C68 24 66 34 50 42C58 28 63 21 76 16Z", 0.5],
  ["M24 68C32 60 34 50 50 42C42 56 37 63 24 68Z", 0.4],
];

// dark：深色底（顶栏、页脚）；light：浅色底；auto：跟着亮暗主题
type Tone = "dark" | "light" | "auto";

const MARK_COLOR: Record<Tone, string> = {
  dark: "text-emerald-400",
  light: "text-emerald-600",
  auto: "text-emerald-600 dark:text-emerald-400",
};
const WORD_COLOR: Record<Tone, string> = {
  dark: "text-stone-50",
  light: "text-stone-900",
  auto: "text-foreground",
};

export function LogoMark({
  size = 26,
  tone = "auto",
  className,
}: {
  size?: number;
  tone?: Tone;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={(size * 84) / 100}
      viewBox="0 0 100 84"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", MARK_COLOR[tone], className)}
    >
      {PETALS.map(([d, opacity]) => (
        <path key={d} d={d} fill="currentColor" opacity={opacity} />
      ))}
      <circle cx="50" cy="42" r="5" fill="currentColor" />
    </svg>
  );
}

export default function Logo({
  size = 26,
  tone = "auto",
  showWordmark = true,
  className,
}: {
  size?: number;
  tone?: Tone;
  showWordmark?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex select-none items-center gap-2.5", className)}>
      <LogoMark size={size} tone={tone} />
      {showWordmark && (
        <span
          className={cn(
            // 字标始终用 Outfit，不跟设置里的界面字体走
            "font-[family-name:var(--font-outfit)] text-[1.15rem] leading-none font-semibold tracking-tight",
            WORD_COLOR[tone]
          )}
        >
          Bloom
        </span>
      )}
    </span>
  );
}
