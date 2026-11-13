// 从拖拽的 DataTransfer 递归读出所有文件：文件夹展开成其内全部文件并保留相对路径，
// 单个文件直接收下——代码自动判断文件/文件夹，无需用户区分。
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = [...(dt.items || [])];
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files || []);
  const out: File[] = [];
  const readAll = (reader: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((resolve) => {
      const acc: FileSystemEntry[] = [];
      const step = () =>
        reader.readEntries(
          (batch) => {
            if (!batch.length) return resolve(acc);
            acc.push(...batch);
            step();
          },
          () => resolve(acc)
        );
      step();
    });
  const walk = async (entry: FileSystemEntry, prefix: string) => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej)
      );
      try {
        Object.defineProperty(file, "webkitRelativePath", {
          value: prefix + entry.name,
          configurable: true,
        });
      } catch {
        /* read-only in some browsers */
      }
      out.push(file);
    } else if (entry.isDirectory) {
      const children = await readAll(
        (entry as FileSystemDirectoryEntry).createReader()
      );
      for (const c of children) await walk(c, prefix + entry.name + "/");
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

export function isReferenceFile(file: File) {
  return /\.(pdf|txt|md|markdown)$/i.test(file.name || "");
}

// PDF 阅读版（实验）：一次最多转几个 PDF、共几页（后端 PDF_READING_MAX_FILES / PDF_READING_MAX_PAGES）；超过页数的只转前面这些页
export const PDF_READING_MAX_FILES = 5;
export const PDF_READING_MAX_PAGES = 100;

export function isPdfFile(file: File) {
  return /\.pdf$/i.test(file.name || "");
}

// PDF 阅读版的课文文件名是原文件名加 .md（paper.pdf.md）：靠这个后缀认出来，显示时去掉 .md
export function isPdfReadingName(name?: string | null) {
  return Boolean(name?.toLowerCase().endsWith(".pdf.md"));
}

// 文件名拆成文件夹、名字、扩展名（docs/notes.md → docs/、notes、.md；paper.pdf.md 的扩展名是 .pdf.md），和后端 _split_lesson_name 一致。
// 改名只改中间那段
export function splitFileName(name: string) {
  const slash = name.lastIndexOf("/") + 1;
  const base = name.slice(slash);
  const dot = isPdfReadingName(base) ? base.length - 7 : base.lastIndexOf(".");
  const suffix = dot > 0 ? base.slice(dot) : "";
  return { folder: name.slice(0, slash), stem: base.slice(0, base.length - suffix.length), suffix };
}

// 显示时不带 .md（像 Obsidian）：Markdown 是 Bloom 自己的页面格式，网页原文、上传的 notes.md 只显示名字，
// PDF 阅读版 paper.pdf.md 显示成 paper.pdf；别的扩展名照常显示。和后端 _display_filename 一致
export function displayFileName(name: string) {
  return name.replace(/\.md$/i, "");
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
