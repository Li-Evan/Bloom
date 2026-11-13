import localFont from "next/font/local";

// 标题与正文默认用 Outfit（没有汉字，中文走 theme.css 里的回退栈）；小标签、编号、数字用 JetBrains Mono。
// Public Sans 是设置里可选的界面字体（lib/font.ts），和 X 文章用的 Chirp 最接近；只有选了它的人才下载，所以不预加载。
// 都是 Latin 子集的可变字体，文件放在本目录自托管（许可见 OFL-*.txt），不在构建和开发时联网下载：
// next/font/google 在 Turbopack 开发服务器上会随机撞上 Google 返回的 l/font?kit= 地址而整站 500。
export const outfit = localFont({
  src: "./outfit-latin.woff2",
  weight: "400 800",
  variable: "--font-outfit",
  display: "swap",
});

export const publicSans = localFont({
  src: "./public-sans-latin.woff2",
  weight: "100 900",
  variable: "--font-public-sans",
  display: "swap",
  preload: false,
});

export const jetbrainsMono = localFont({
  src: "./jetbrains-mono-latin.woff2",
  weight: "400 500",
  variable: "--font-jetbrains",
  display: "swap",
});

export const fontVariables = `${outfit.variable} ${publicSans.variable} ${jetbrainsMono.variable}`;
