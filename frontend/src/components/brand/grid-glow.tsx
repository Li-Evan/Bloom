import { cn } from "@/lib/utils";

// 深色区块的背景：细点阵 + 两团极淡的翠绿光晕（原官网 hero 的做法）。
// 父元素需要 relative，内容放在它后面并带 relative。
export default function GridGlow({
  className,
  glow = true,
}: {
  className?: string;
  glow?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0)",
          backgroundSize: "26px 26px",
        }}
      />
      {glow && (
        <>
          <div className="absolute -top-40 -right-32 size-[36rem] rounded-full bg-emerald-500/20 blur-[120px]" />
          <div className="absolute -bottom-48 -left-24 size-[30rem] rounded-full bg-emerald-700/10 blur-[120px]" />
        </>
      )}
    </div>
  );
}
