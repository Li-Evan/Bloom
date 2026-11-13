import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 构建验证时用 NEXT_DIST_DIR=.next-build，避免写坏正在运行的 dev server 的 .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // 不许任何站点把 Bloom 嵌进 iframe
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      // pdf.js 的字体和解码文件（scripts/copy-pdfjs-assets.mjs）：地址里带 pdfjs-dist 的版本号，内容不会变，浏览器可以一直缓存
      {
        source: "/pdfjs/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
