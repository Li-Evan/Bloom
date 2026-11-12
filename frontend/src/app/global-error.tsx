"use client";

import "@/app/globals.css";

import BellCurve from "@/components/brand/bell-curve";
import Eyebrow from "@/components/brand/eyebrow";
import Logo from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

// 根布局本身出错时的最后一道兜底：它替换整个根布局，所以自己带 <html>，也拿不到语言和翻译，中英并列。
// 不再调用 next/font（Turbopack 不认在 global-error 里的字体调用），直接用系统字体栈。
const SYSTEM_FONT =
  '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="antialiased" style={{ fontFamily: SYSTEM_FONT }}>
        <main className="flex min-h-dvh flex-col items-center justify-center bg-ink-inverse px-4 py-16 text-center text-stone-50">
          <Logo tone="dark" className="mb-10" />
          <BellCurve tone="dark" className="mb-8 w-56 sm:w-64" />
          <Eyebrow tone="dark">Error · 出错了</Eyebrow>
          <h1 className="mt-4 text-3xl sm:text-4xl">Something went wrong</h1>
          <p className="mt-2 text-xl font-semibold" lang="zh">页面出了点问题</p>
          <p className="mt-4 max-w-md leading-relaxed text-stone-300/90">
            We couldn&apos;t load this page. Try again, or head back home.
            <br />
            <span lang="zh">我们没能加载这个页面。再试一次，或者先回到首页。</span>
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button variant="on-dark" size="lg" onClick={reset}>
              Try again · 重试
            </Button>
            <Button
              variant="outline-on-dark"
              size="lg"
              onClick={() =>
                window.location.assign(
                  window.location.pathname.startsWith("/zh") ? "/zh" : "/"
                )
              }
            >
              Back to home · 回到首页
            </Button>
          </div>
          {error.digest && (
            <p className="mt-8 font-mono text-xs text-stone-300">Ref: {error.digest}</p>
          )}
        </main>
      </body>
    </html>
  );
}
