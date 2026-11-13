"use client";

import ErrorView from "@/components/brand/error-view";

// (default) 下的页面出错：顶栏页脚还在，正文换成出错页
export default function DefaultError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorView {...props} />;
}
