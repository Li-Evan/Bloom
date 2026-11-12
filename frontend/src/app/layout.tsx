import "@/app/globals.css";

import type { Viewport } from "next";
import { getLocale, setRequestLocale } from "next-intl/server";
import { fontVariables } from "@/fonts";
import { FONT_SCRIPT } from "@/lib/font";
import { LESSON_NAV_SCRIPT } from "@/lib/learn/lesson-nav";
import { TEXT_SIZE_SCRIPT } from "@/lib/text-size";

// 顶栏在亮、暗两套主题下都是深色，浏览器地址栏跟着它
export const viewport: Viewport = { themeColor: "#0c0a09" };

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  setRequestLocale(locale);

  return (
    <html lang={locale} className={fontVariables} suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {/* 首次绘制前套上设置里选的字体和正文字号（lib/font.ts、lib/text-size.ts），以及课文页右栏列表收没收（lib/learn/lesson-nav.ts） */}
        <script dangerouslySetInnerHTML={{ __html: FONT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: TEXT_SIZE_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: LESSON_NAV_SCRIPT }} />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
