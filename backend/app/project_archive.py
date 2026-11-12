"""Bounded in-memory ZIP imports and relative Markdown image references."""

import io
import posixpath
import re
import stat
import unicodedata
import zipfile
from urllib.parse import unquote, urlsplit

from fastapi import HTTPException


def normalized_path(path: str) -> str:
    path = unicodedata.normalize("NFC", path.replace("\\", "/"))
    if (
        not path
        or len(path) > 512
        or any(ord(c) < 32 for c in path)
        or path.startswith("/")
        or re.match(r"^[A-Za-z]:", path)
        or ".." in path.split("/")
    ):
        raise HTTPException(400, "文件路径无效，请重新打包 ZIP")
    return posixpath.normpath(path)


def ignored(path: str) -> bool:
    return any(p == "__MACOSX" or p == ".DS_Store" or p.startswith("._") for p in path.split("/"))


def zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if not info.flag_bits & 0x800:
        # Finder sometimes stores UTF-8 names without the ZIP UTF-8 flag.
        original = name.encode("cp437")
        for encoding in ("utf-8", "gb18030"):
            try:
                name = original.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
    return normalized_path(name)


def expand_uploads(
    uploads: list[tuple[str, bytes]], *, max_files: int, max_file_bytes: int, max_total_bytes: int
) -> list[tuple[str, bytes]]:
    files: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    total = 0

    def add(path: str, raw: bytes):
        nonlocal total
        path = normalized_path(path)
        if ignored(path):
            return
        if path in seen:
            raise HTTPException(400, f"文件路径重复：{path}")
        if len(files) >= max_files:
            raise HTTPException(400, f"解压后一次最多导入 {max_files} 个文件")
        if len(raw) > max_file_bytes:
            raise HTTPException(400, "解压后的文件超过单文件 20 MB 限制")
        total += len(raw)
        if total > max_total_bytes:
            raise HTTPException(400, "解压后的文件总大小不能超过 50 MB")
        seen.add(path)
        files.append((path, raw))

    for path, raw in uploads:
        path = normalized_path(path)
        if ignored(path):
            continue
        if not path.lower().endswith(".zip"):
            if path.lower().endswith((".rar", ".7z", ".tar", ".tgz", ".tar.gz")):
                raise HTTPException(400, "请将压缩包转为 ZIP 后上传")
            add(path, raw)
            continue
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries = archive.infolist()
                if len(entries) > 2000:
                    raise HTTPException(400, "ZIP 目录条目过多，请拆分后上传")
                members = []
                for entry in entries:
                    name = zip_name(entry)
                    if ignored(name) or entry.is_dir():
                        continue
                    if stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG):
                        raise HTTPException(400, "ZIP 包含链接或特殊文件，请只打包普通文件")
                    if entry.flag_bits & 1:
                        raise HTTPException(400, "请解密 ZIP 后再上传")
                    if name.lower().endswith((".zip", ".rar", ".7z", ".tar", ".tgz", ".tar.gz")):
                        raise HTTPException(400, "ZIP 中还有压缩包，请解压后重新打包")
                    members.append((entry, name))
                if len(files) + len(members) > max_files:
                    raise HTTPException(400, f"解压后一次最多导入 {max_files} 个文件")
                if any(entry.file_size > max_file_bytes for entry, _ in members):
                    raise HTTPException(400, "解压后的文件超过单文件 20 MB 限制")
                if total + sum(entry.file_size for entry, _ in members) > max_total_bytes:
                    raise HTTPException(400, "解压后的文件总大小不能超过 50 MB")
                # Preserve an existing common folder; otherwise namespace loose entries by ZIP name.
                roots = {name.split("/", 1)[0] for _, name in members}
                common_root = len(roots) == 1 and all("/" in name for _, name in members)
                prefix = "" if common_root else posixpath.splitext(path)[0] + "/"
                for entry, name in members:
                    with archive.open(entry) as stream:
                        content = stream.read(min(max_file_bytes, max_total_bytes - total) + 1)
                    add(prefix + name, content)
        except HTTPException:
            raise
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, UnicodeError, ValueError, OSError) as exc:
            raise HTTPException(400, "没能解压 ZIP，请检查压缩包是否完整、未加密") from exc
    return files


# Fences and backtick runs are scanned linearly; input size may reach one million characters.
_FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})(.*)$")
_DEST = r"(?P<dest><[^>\n]+>|(?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\))+?)"
_INLINE = re.compile(
    r"(?P<before>!?\[(?:\\.|[^\[\]\\])*\]\(\s*)" + _DEST + r"(?P<after>(?:\s+[\"'][^\n]*?[\"'])?\s*\))"
)
_REFERENCE = re.compile(
    r"(?P<before>^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*)" + _DEST + r"(?P<after>[ \t]*(?:[\"'(].*)?$)", re.M
)


def rewrite_images(markdown: str, document_path: str, urls: dict[str, str]) -> tuple[str, set[str]]:
    if not urls:
        return markdown, set()
    used: set[str] = set()

    def replace(match: re.Match) -> str:
        destination = match["dest"]
        target = destination[1:-1] if destination.startswith("<") else destination
        target = re.sub(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])", r"\1", target)
        try:
            parsed = urlsplit(target)
        except ValueError:
            return match[0]
        if parsed.scheme or parsed.netloc or not parsed.path or parsed.path.startswith("/"):
            return match[0]
        path = unicodedata.normalize(
            "NFC",
            posixpath.normpath(
                posixpath.join(posixpath.dirname(document_path), unquote(parsed.path).replace("\\", "/"))
            ),
        )
        if path not in urls:
            return match[0]
        used.add(path)
        return match["before"] + urls[path] + match["after"]

    def prose(text: str) -> str:
        return _REFERENCE.sub(replace, _INLINE.sub(replace, text))

    def inline(text: str) -> str:
        runs = list(re.finditer(r"`+", text))
        next_same, last = {}, {}
        for index in range(len(runs) - 1, -1, -1):
            length = len(runs[index][0])
            if length in last:
                next_same[index] = last[length]
            last[length] = index
        output, start, index = [], 0, 0
        while index < len(runs):
            if index not in next_same:
                index += 1
                continue
            closing = next_same[index]
            output.extend((prose(text[start : runs[index].start()]), text[runs[index].start() : runs[closing].end()]))
            start, index = runs[closing].end(), closing + 1
        output.append(prose(text[start:]))
        return "".join(output)

    result, pending = [], []
    fence = None
    for line in markdown.splitlines(keepends=True):
        match = _FENCE.match(line.rstrip("\r\n"))
        if fence:
            result.append(line)
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = None
        elif match:
            result.append(inline("".join(pending)))
            pending = []
            result.append(line)
            fence = match[1]
        else:
            pending.append(line)
    result.append(inline("".join(pending)))
    return "".join(result), used
