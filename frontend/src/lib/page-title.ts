// 学习区和用户中心所有页面的 h1：36px / 700（手机 30px）。每个页面都用它，不再各写各的字号。
// 放在不带 "use client" 的模块里：服务端组件（用户中心各页）也要读到它的值。
export const PAGE_TITLE = "text-3xl font-bold sm:text-4xl";
