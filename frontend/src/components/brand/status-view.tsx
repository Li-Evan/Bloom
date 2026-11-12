import BellCurve from "@/components/brand/bell-curve";
import Eyebrow from "@/components/brand/eyebrow";

// 404、出错页共用的版面：小号钟形曲线、等宽小标签、标题、说明、两个按钮。
// 放在页面正文里（顶栏页脚由外层提供），所以是 auto 配色，跟着亮暗主题走。
export default function StatusView({
  eyebrow,
  title,
  description,
  detail,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex min-h-[60dvh] w-full max-w-xl flex-col items-center justify-center px-4 py-16 text-center sm:px-6">
      <BellCurve tone="auto" className="mb-8 w-64 sm:w-80" />
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="mt-4 text-3xl sm:text-4xl">{title}</h1>
      <p className="mt-4 max-w-md text-balance leading-relaxed text-muted-foreground">{description}</p>
      {children && <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{children}</div>}
      {detail && (
        <p className="mt-8 font-mono text-xs text-subtle-foreground">{detail}</p>
      )}
    </section>
  );
}
