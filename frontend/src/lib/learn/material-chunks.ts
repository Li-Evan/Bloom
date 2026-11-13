// 资料文件在浏览器里的读取校验，和后端的 Unicode 行为一致；不用于估算费用。
// 后端常量（backend/app/courses.py）
export const MATERIAL_MAX_FILES = 50;

// Python str.isspace() 为真的字符（strip 按它）。手写扫描，不用 `[空白]+$` 这类正则：
// 一长串空白后面跟着一个非空白字符时，这种正则会在每个起点各扫一遍，平方级回溯
const isPySpace = (ch: string) => {
  const code = ch.charCodeAt(0);

  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
};

function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPySpace(text[start])) start++;
  while (end > start && isPySpace(text[end - 1])) end--;

  return text.slice(start, end);
}

// 去掉空白后什么都没有（后端对这样的文件直接拒绝：没有提取到可阅读文本）
export const isBlankText = (text: string) => pyStrip(text) === "";

// 文件字节 → 文本：先按 UTF-8（严格，保留 BOM——后端的 utf-8 解码不去 BOM，BOM 算一个字符），不行再按 GB18030，和后端 _decode_text_bytes 一样的顺序
export function decodeMaterialBytes(bytes: ArrayBuffer): string | null {
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      /* 换下一种编码 */
    }
  }

  return null;
}
