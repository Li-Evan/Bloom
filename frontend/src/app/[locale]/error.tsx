"use client";

import ErrorView from "@/components/brand/error-view";
import Logo from "@/components/brand/logo";
import { Link } from "@/i18n/navigation";

// [locale] 下没有自己 error.tsx 的区域的出错页；(default) 下的页面用它自己的，保留顶栏页脚
export default function LocaleError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label="Bloom">
          <Logo tone="auto" />
        </Link>
      </div>
      <ErrorView {...props} />
    </div>
  );
}
