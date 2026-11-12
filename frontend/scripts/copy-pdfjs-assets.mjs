// pdf.js 画 PDF 时按需去取的四类文件，npm 包里带着，但要我们自己发布成静态文件、再把地址告诉它（pdf-viewer.tsx 的 getDocument）：
//   cmaps/           中日韩 PDF 用预定义编码（GBK-EUC-H、UniGB-UCS2-H、90ms-RKSJ-H 等）时的字符映射表，没有它整页文字解不出来
//   standard_fonts/  PDF 没内嵌字体、系统里也找不到时的替代字体，以及 Symbol、ZapfDingbats
//   wasm/            JPEG 2000、JBIG2、CCITT 传真图片的解码器（扫描件常见），没有它图片画不出来
//   iccs/            CMYK 的颜色配置
// dev 和 build 之前各跑一次，拷到 public/pdfjs/<版本号>/。目录带版本号：升级 pdfjs-dist 后地址跟着变，
// 所以可以让浏览器长期缓存（next.config.mjs 里给 /pdfjs/ 加了 immutable）。public/pdfjs 不进 git。
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const { version } = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
const dest = path.join(root, "public", "pdfjs");

rmSync(dest, { recursive: true, force: true });
mkdirSync(path.join(dest, version), { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(path.join(pkg, dir), path.join(dest, version, dir), { recursive: true, dereference: true });
}
console.log(`pdf.js ${version} 的字体和解码文件已拷到 public/pdfjs/${version}/`);
