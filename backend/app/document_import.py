"""Uploaded documents to Markdown pages for project courses.

Word, PowerPoint, Excel, CSV, EPUB, Jupyter notebooks, saved web pages and plain text. Embedded images
come back as assets: a page refers to asset N as ![alt](bloom-asset/N.<ext>) until attach_assets()
swaps in the stored address.
"""

import base64
import csv
import email
import functools
import hashlib
import io
import itertools
import json
import logging
import posixpath
import re
import secrets
import warnings
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, time
from email import policy
from typing import Callable
from urllib.parse import unquote, urlsplit

from fastapi import HTTPException

from app import omml
from app.project_images import MAX_IMAGE_BYTES, MAX_PIXELS, validate_image

logger = logging.getLogger(__name__)
ASSET_LINK = re.compile(r"!\[([^\]\n]*)\]\(bloom-asset/(\d+)\.\w+\)")
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 5000
MAX_TABLE_ROWS = 2000
MAX_TABLE_COLUMNS = 50
MAX_OUTPUT_CHARS = 20_000
WEB_IMAGE_FORMATS = {"JPEG": "jpg", "PNG": "png", "GIF": "gif", "WEBP": "webp"}
# Raster formats browsers cannot show but Pillow can turn into PNG.
CONVERTIBLE_IMAGE_FORMATS = {"BMP", "TIFF", "ICO", "MPO", "DIB", "PCX", "TGA"}

TEXTS = {
    "zh": {
        "slide": "第 {n} 页", "notes": "备注", "section": "第 {n} 节", "rows_cut": "（只显示前 {n} 行）",
        "columns_cut": "（只显示前 {n} 列）", "output_cut": "……（输出过长，已截断）", "cover": "封面",
    },
    "en": {
        "slide": "Slide {n}", "notes": "Notes", "section": "Section {n}", "rows_cut": "(First {n} rows only)",
        "columns_cut": "(First {n} columns only)", "output_cut": "… (output truncated)", "cover": "Cover",
    },
}
REASONS = {
    "zh": {
        "legacy_word": "Word 97-2003 格式，请另存为 .docx 后上传",
        "legacy_powerpoint": "PowerPoint 97-2003 格式，请另存为 .pptx 后上传",
        "legacy_excel": "旧版表格格式，请另存为 .xlsx 后上传",
        "apple": "Apple 格式，请导出为 PDF 或 Office 格式后上传",
        "opendocument": "OpenDocument 格式，请另存为 .docx、.pptx 或 .xlsx 后上传",
        "rtf": "RTF 格式，请另存为 .docx 后上传",
        "image": "这种图片格式无法显示，请转换为 PNG 或 JPG",
        "media": "暂不支持音频和视频",
        "unsupported": "暂不支持这种文件格式",
        "broken": "文件已损坏或已加密，无法读取",
        "encoding": "文字编码无法识别，请转为 UTF-8 后上传",
        "too_large": "文件解压后过大",
        "too_long": "文字超过 100 万字",
        "empty": "没有可读取的文字",
    },
    "en": {
        "legacy_word": "Word 97-2003 format. Save it as .docx and upload again",
        "legacy_powerpoint": "PowerPoint 97-2003 format. Save it as .pptx and upload again",
        "legacy_excel": "Legacy spreadsheet format. Save it as .xlsx and upload again",
        "apple": "Apple format. Export it to PDF or an Office format",
        "opendocument": "OpenDocument format. Save it as .docx, .pptx or .xlsx",
        "rtf": "RTF format. Save it as .docx and upload again",
        "image": "This image format cannot be shown. Convert it to PNG or JPG",
        "media": "Audio and video are not supported",
        "unsupported": "This file type is not supported",
        "broken": "The file is damaged or encrypted",
        "encoding": "Unknown text encoding. Convert it to UTF-8",
        "too_large": "The file is too large once unpacked",
        "too_long": "More than one million characters of text",
        "empty": "No readable text",
    },
}
UNSUPPORTED = {
    **dict.fromkeys(("doc", "dot", "wps"), "legacy_word"),
    **dict.fromkeys(("ppt", "pps", "pot", "dps"), "legacy_powerpoint"),
    **dict.fromkeys(("et",), "legacy_excel"),
    **dict.fromkeys(("pages", "key", "numbers"), "apple"),
    **dict.fromkeys(("odt", "odp", "ods", "odg"), "opendocument"),
    "rtf": "rtf",
    **dict.fromkeys(("svg", "heic", "heif", "bmp", "tif", "tiff", "avif", "ico", "psd"), "image"),
    **dict.fromkeys(("mp3", "mp4", "m4a", "mov", "wav", "avi", "mkv", "flac", "aac", "webm", "ogg"), "media"),
}
DOCX_STYLES = "\n".join(
    ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh",
     "p[style-name='标题'] => h1:fresh", "p[style-name='副标题'] => h2:fresh",
     "r[style-name='Verbatim Char'] => code", "r[style-name='HTML Code'] => code"]
    + [f"p[style-name='{name}'] => pre:separator('\\n')" for name in ("Source Code", "HTML Preformatted", "Code", "代码")]
    + [f"p.{style_id} => pre:separator('\\n')" for style_id in ("SourceCode", "HTMLPreformatted", "Code")]
    + [f"p[style-name='标题 {n}'] => h{n}:fresh" for n in range(1, 7)]
)
INLINE_SPECIALS = re.compile(r"([\\`*_\[\]<>~$|])")
BLOCK_START = re.compile(r"^([ \t]*)(?:([#>+=-])|(\d+)([.)]))", re.M)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class Unsupported(Exception):
    def __init__(self, key: str):
        super().__init__(key)
        self.key = key

    def reason(self, language: str) -> str:
        return REASONS.get(language, REASONS["en"])[self.key]


@dataclass
class Document:
    pages: list[tuple[str, str]]
    assets: list[bytes] = field(default_factory=list)


def escape_text(text: str) -> str:
    """Plain text as Markdown that renders exactly as written."""
    text = INLINE_SPECIALS.sub(r"\\\1", text)
    return BLOCK_START.sub(lambda m: m[1] + (f"\\{m[2]}" if m[2] else f"{m[3]}\\{m[4]}"), text)


def _web_image(raw: bytes) -> tuple[bytes, str] | None:
    from PIL import Image

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.width * image.height > MAX_PIXELS:
                    return None
                if image.format in WEB_IMAGE_FORMATS:
                    return (raw, WEB_IMAGE_FORMATS[image.format]) if len(raw) <= MAX_IMAGE_BYTES else None
                if image.format not in CONVERTIBLE_IMAGE_FORMATS:
                    return None  # EMF/WMF drawings and other vector or exotic formats
                out = io.BytesIO()
                image.convert("RGBA" if "A" in image.getbands() else "RGB").save(out, "PNG")
                return (out.getvalue(), "png") if out.tell() <= MAX_IMAGE_BYTES else None
    except Exception:
        return None


class _Assets:
    def __init__(self):
        self.items: list[bytes] = []
        self.index: dict[str, int] = {}

    def add(self, raw: bytes | None) -> str | None:
        """Markdown target for an embedded image, or None when a browser could not show it."""
        image = _web_image(raw) if raw else None
        if image is None:
            return None
        raw, extension = image
        try:
            validate_image("image", raw)  # the same check the upload runs; one bad picture must not fail the import
        except HTTPException:
            return None
        key = hashlib.sha256(raw).hexdigest()
        if key not in self.index:  # decks repeat the same logo on every slide
            self.index[key] = len(self.items)
            self.items.append(raw)
        return f"bloom-asset/{self.index[key]}.{extension}"


def attach_assets(markdown: str, urls: list[str | None]) -> str:
    def replace(match: re.Match) -> str:
        index = int(match[2])
        url = urls[index] if index < len(urls) else None
        return f"![{match[1]}]({url})" if url else ""

    return ASSET_LINK.sub(replace, markdown)


class _Formulas:
    """Formulas ride through the HTML-to-Markdown step as plain tokens, so no escaping touches the LaTeX."""

    def __init__(self):
        self.nonce = secrets.token_hex(4)
        self.items: list[tuple[str, bool]] = []
        self.pattern = re.compile(f"BLOOMMATH{self.nonce}N(\\d+)E")

    def token(self, tex: str, display: bool) -> str:
        self.items.append((" ".join(tex.split()), display))
        return f"BLOOMMATH{self.nonce}N{len(self.items) - 1}E"

    def restore(self, markdown: str) -> str:
        if not self.items:
            return markdown
        lines = []
        for line in markdown.split("\n"):
            alone = self.pattern.fullmatch(line.strip())
            if alone and self.items[int(alone[1])][1]:
                lines.append(f"$$\n{self.items[int(alone[1])][0]}\n$$")
                continue
            table = line.lstrip().startswith("|")

            def inline(match: re.Match) -> str:
                tex = self.items[int(match[1])][0]
                return "$" + (tex.replace("|", r"\vert ") if table else tex) + "$"

            lines.append(self.pattern.sub(inline, line))
        return "\n".join(lines)


@functools.cache
def _converter():
    """markdownify pulls in BeautifulSoup and lxml (~0.2 s): load them on the first conversion, not at API startup."""
    from markdownify import MarkdownConverter

    class Converter(MarkdownConverter):
        def escape(self, text, parent_tags):
            return super().escape(text, parent_tags).replace("$", r"\$")

        def convert_a(self, el, text, parent_tags):
            # Links inside a document (table of contents, footnotes, other chapters) go nowhere once it is a page.
            if not re.match(r"(?i)(https?:|mailto:)", el.get("href") or ""):
                return text
            return super().convert_a(el, text, parent_tags)

        def convert_br(self, el, text, parent_tags):
            return "\n" if "pre" in parent_tags else super().convert_br(el, text, parent_tags)

        def convert_img(self, el, text, parent_tags):
            return _image(el.get("src") or "", el.get("alt") or "")

    return Converter


def _image(src: str, alt: str) -> str:
    alt = " ".join(re.sub(r"[\[\]]", " ", alt).split())
    if not src:
        return ""
    return f"![{alt}](<{src}>)" if re.search(r"[\s()<>]", src) else f"![{alt}]({src})"


SUPERSCRIPT = str.maketrans("0123456789+-=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ")
SUBSCRIPT = str.maketrans("0123456789+-=()", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
# Lines that open an HTML block (CommonMark ends one at the next blank line).
HTML_BLOCK = re.compile(r"^ {0,3}</?(?:address|article|aside|blockquote|center|details|div|dl|dt|dd|figure|figcaption|"
                        r"h[1-6]|hr|li|ol|p|picture|section|summary|table|tbody|thead|tr|td|th|ul)(?:[\s/>]|$)", re.I)
CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`).+?(?<!`)\1(?!`)")
ATTRIBUTE = re.compile(r"""([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")


def _attributes(tag: str) -> dict[str, str]:
    return {m[1].lower(): next(v for v in m.groups()[1:] if v is not None) for m in ATTRIBUTE.finditer(tag)}


def _script(match: re.Match, table: dict) -> str:
    inner = match[2]
    mapped = inner.translate(table)
    # Only when every character has a Unicode form (x², H₂O); citation markers like [12] just lose the tag.
    return mapped if inner and all(c != m for c, m in zip(inner, mapped)) else inner


def _inline_html(text: str, in_table: bool) -> str:
    text = re.sub(r"<img\b[^>]*>", lambda m: _image(_attributes(m[0]).get("src", ""), _attributes(m[0]).get("alt", "")),
                  text, flags=re.I)
    if not in_table:
        text = re.sub(r"<br\s*/?>\s*$", "\\\\", text, flags=re.I)  # the line break itself follows
    text = re.sub(r"<br\s*/?>", " " if in_table else "\\\n", text, flags=re.I)
    text = re.sub(r"<(sup)>(.*?)</sup>", lambda m: _script(m, SUPERSCRIPT), text, flags=re.I | re.S)
    text = re.sub(r"<(sub)>(.*?)</sub>", lambda m: _script(m, SUBSCRIPT), text, flags=re.I | re.S)
    text = re.sub(r"<(b|strong)>(.*?)</\1>", r"**\2**", text, flags=re.I | re.S)
    text = re.sub(r"<(i|em)>(.*?)</\1>", r"*\2*", text, flags=re.I | re.S)
    text = re.sub(r"<(del|s|strike)>(.*?)</\1>", r"~~\2~~", text, flags=re.I | re.S)
    text = re.sub(r"<(kbd|code)>([^<`]*)</\1>", r"`\2`", text, flags=re.I)
    text = re.sub(r"""<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>""",
                  lambda m: f"[{m[2]}]({m[1]})" if re.match(r"(?i)https?:|mailto:", m[1]) else m[2], text, flags=re.I | re.S)
    return re.sub(r"</?(?:u|span|small|font|mark|ins|a|abbr|cite|var|big|center)\b[^>]*>", "", text, flags=re.I)


def markdown_without_html(markdown: str) -> str:
    """The reader shows raw HTML as text, so the common tags in Markdown (README images, <br>, <sup>) become Markdown."""
    if "<" not in markdown:
        return markdown
    lines, out, i, fence_mark = markdown.split("\n"), [], 0, None
    while i < len(lines):
        line = lines[i]
        opened = FENCE.match(line)
        if fence_mark:
            out.append(line)
            if opened and opened[1][0] == fence_mark[0] and len(opened[1]) >= len(fence_mark):
                fence_mark = None
            i += 1
        elif opened:
            fence_mark = opened[1]
            out.append(line)
            i += 1
        elif HTML_BLOCK.match(line):
            block = []
            while i < len(lines) and lines[i].strip():
                block.append(lines[i])
                i += 1
            out.append(html_markdown("\n".join(block)))
        else:
            spans, last, parts = list(CODE_SPAN.finditer(line)), 0, []
            for span in spans:
                parts += [_inline_html(line[last:span.start()], line.lstrip().startswith("|")), span[0]]
                last = span.end()
            out.append("".join(parts) + _inline_html(line[last:], line.lstrip().startswith("|")))
            i += 1
    return "\n".join(out)


def _code_language(el) -> str:
    for name in (el.get("class") or []) + [c for child in el.find_all("code") for c in (child.get("class") or [])]:
        if name.startswith(("language-", "lang-")):
            return name.split("-", 1)[1]
    return ""


def html_markdown(html) -> str:
    markdown = _converter()(heading_style="ATX", bullets="-", escape_misc=True, table_infer_header=True,
                            newline_style="backslash", code_language_callback=_code_language).convert(html)
    return re.sub(r"\n{3,}", "\n\n", markdown).strip()


def fence(text: str, language: str = "") -> str:
    ticks = "`" * max(3, max((len(run) for run in re.findall(r"`+", text)), default=0) + 1)
    return f"{ticks}{language}\n{text.rstrip()}\n{ticks}"


def _check_archive(archive: zipfile.ZipFile) -> None:
    entries = archive.infolist()
    if len(entries) > MAX_ARCHIVE_ENTRIES or sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES:
        raise Unsupported("too_large")


def _open_archive(raw: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise Unsupported("broken") from None
    _check_archive(archive)
    return archive


def _docx_formulas(raw: bytes, formulas: _Formulas) -> bytes:
    """Word equations to tokens in the document text; mammoth itself drops them."""
    from lxml import etree

    w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with _open_archive(raw) as archive:
        xml = archive.read("word/document.xml")
        if b"oMath" not in xml:
            return raw
        root = etree.fromstring(xml, parser=etree.XMLParser(resolve_entities=False, huge_tree=True))

        def put(element, display: bool) -> None:
            run = etree.Element(w + "r")
            text = etree.SubElement(run, w + "t")
            text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            text.text = formulas.token(omml.equation(element), display)
            run.tail = element.tail
            element.getparent().replace(element, run)

        for para in list(root.iter(omml.M + "oMathPara")):
            put(para, True)
        for math in list(root.iter(omml.M + "oMath")):
            put(math, False)
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
            for info in archive.infolist():
                data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True) \
                    if info.filename == "word/document.xml" else archive.read(info)
                target.writestr(info, data)
        return out.getvalue()


def _docx(path: str, raw: bytes, language: str) -> Document:
    import mammoth

    formulas, assets = _Formulas(), _Assets()

    def image(element):
        with element.open() as stream:
            target = assets.add(stream.read())
        return {"src": target} if target else {}

    result = mammoth.convert_to_html(io.BytesIO(_docx_formulas(raw, formulas)), style_map=DOCX_STYLES,
                                     convert_image=mammoth.images.img_element(image))
    return Document([(path, formulas.restore(html_markdown(result.value)))], assets.items)


def _one_line(text: str) -> str:
    return " ".join(text.replace("\v", " ").split())


def _runs(paragraph) -> str:
    out = []
    for run in paragraph.runs:
        text = run.text.replace("\v", " ")
        if not text:
            continue
        body = escape_text(text)
        stripped = body.strip()
        if run.font.bold and stripped:
            body = body.replace(stripped, f"**{stripped}**", 1)
        address = run.hyperlink.address if run.hyperlink is not None else None
        if address and re.match(r"(?i)https?:|mailto:", address):
            body = f"[{body}]({address})"
        out.append(body)
    return " ".join("".join(out).split())


def _table(rows: list[list], texts: dict) -> str:
    cells = [["" if value is None else _cell(value) for value in row] for row in rows]
    cells = [row for row in cells if any(cell.strip() for cell in row)]
    if not cells:
        return ""
    width = max(max((i + 1 for i, cell in enumerate(row) if cell.strip()), default=0) for row in cells)
    notes = []
    if width > MAX_TABLE_COLUMNS:
        width = MAX_TABLE_COLUMNS
        notes.append(texts["columns_cut"].format(n=MAX_TABLE_COLUMNS))
    if len(cells) > MAX_TABLE_ROWS + 1:
        cells = cells[:MAX_TABLE_ROWS + 1]
        notes.append(texts["rows_cut"].format(n=MAX_TABLE_ROWS))

    def line(row: list[str]) -> str:
        row = (row + [""] * width)[:width]
        # A cell is inline content: only inline syntax needs escaping (no "1\." for a number like 1.5).
        return "| " + " | ".join(INLINE_SPECIALS.sub(r"\\\1", _one_line(cell)) for cell in row) + " |"

    table = [line(cells[0]), "| " + " | ".join(["---"] * width) + " |", *map(line, cells[1:])]
    return "\n".join(table) + ("\n\n" + " ".join(notes) if notes else "")


def _cell(value) -> str:
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 1e15 else f"{value:.10g}"
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d") if value.time() == time() else value.strftime("%Y-%m-%d %H:%M")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _chart(chart, texts: dict) -> str:
    try:
        title = _one_line(chart.chart_title.text_frame.text) if chart.has_title else ""
        plot = chart.plots[0]
        categories = list(plot.categories)
        series = list(plot.series)
        rows = [[""] + [s.name or "" for s in series]]
        rows += [[category] + [s.values[i] if i < len(s.values) else None for s in series]
                 for i, category in enumerate(categories)]
    except Exception:
        return ""
    return "\n\n".join(part for part in (f"**{escape_text(title)}**" if title else "", _table(rows, texts)) if part)


def _pptx(path: str, raw: bytes, language: str) -> Document:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER

    _open_archive(raw).close()
    deck = Presentation(io.BytesIO(raw))
    texts, assets, blocks = TEXTS.get(language, TEXTS["en"]), _Assets(), []
    bullet_types = {PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT, PP_PLACEHOLDER.VERTICAL_BODY,
                    PP_PLACEHOLDER.VERTICAL_OBJECT}

    def ordered(shapes):
        for shape in sorted(shapes, key=lambda s: (s.top or 0, s.left or 0)):
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                yield from ordered(shape.shapes)
            else:
                yield shape

    for number, slide in enumerate(deck.slides, start=1):
        if slide._element.get("show") == "0":
            continue  # hidden slide
        title_shape = slide.shapes.title
        title = _one_line(title_shape.text_frame.text) if title_shape is not None else ""
        heading = texts["slide"].format(n=number)
        blocks.append(f"## {heading}" + (f" · {escape_text(title)}" if title else ""))
        for shape in ordered(slide.shapes):
            if title_shape is not None and shape.shape_id == title_shape.shape_id:
                continue
            if getattr(shape, "has_table", False):
                blocks.append(_table([[cell.text for cell in row.cells] for row in shape.table.rows], texts))
            elif getattr(shape, "has_chart", False):
                blocks.append(_chart(shape.chart, texts))
            elif hasattr(shape, "image"):
                try:
                    target = assets.add(shape.image.blob)
                except Exception:
                    target = None  # linked rather than embedded picture
                if target:
                    blocks.append(f"![]({target})")
            elif shape.has_text_frame:
                bullets = shape.is_placeholder and shape.placeholder_format.type in bullet_types
                lines = []
                for paragraph in shape.text_frame.paragraphs:
                    text = _runs(paragraph)
                    if text:
                        level = paragraph.level
                        lines.append("  " * level + "- " + text if bullets or level else text)
                blocks.append(("\n" if bullets else "\n\n").join(lines))
        notes_frame = slide.notes_slide.notes_text_frame if slide.has_notes_slide else None
        notes = [line.strip() for line in (notes_frame.text if notes_frame else "").split("\n") if line.strip()]
        if notes:
            blocks.append("\n>\n".join([f"> **{texts['notes']}**"] + [f"> {escape_text(line)}" for line in notes]))
    return Document([(path, "\n\n".join(block for block in blocks if block.strip()))], assets.items)


def _sheets(path: str, raw: bytes, language: str, suffix: str) -> Document:
    texts, parts = TEXTS.get(language, TEXTS["en"]), []
    if suffix == "xls":
        import xlrd

        book = xlrd.open_workbook(file_contents=raw)
        for sheet in book.sheets():
            if sheet.visibility:
                continue
            rows = []
            for r in range(min(sheet.nrows, MAX_TABLE_ROWS + 1)):
                row = []
                for c in range(sheet.ncols):
                    cell = sheet.cell(r, c)
                    value = cell.value
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        try:
                            value = xlrd.xldate.xldate_as_datetime(value, book.datemode)
                        except Exception:
                            pass
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        value = bool(value)
                    row.append(value)
                rows.append(row)
            parts.append((sheet.name, rows))
    else:
        import openpyxl

        _open_archive(raw).close()
        book = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        for sheet in book.worksheets:
            if sheet.sheet_state != "visible":
                continue
            sheet.reset_dimensions()  # files without a stored size would otherwise read as one cell
            rows = list(itertools.islice(sheet.iter_rows(values_only=True), MAX_TABLE_ROWS + 1))
            parts.append((sheet.title, rows))
        book.close()
    blocks = []
    for name, rows in parts:
        table = _table([list(row) for row in rows], texts)
        if table:
            blocks.append(f"## {escape_text(name)}\n\n{table}" if len(parts) > 1 else table)
    return Document([(path, "\n\n".join(blocks))])


def _csv(path: str, raw: bytes, language: str, suffix: str, decode: Callable[[bytes], str]) -> Document:
    text = decode(raw)
    delimiter = "\t"
    if suffix != "tsv":
        try:
            delimiter = csv.Sniffer().sniff(text[:20_000], delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
    rows = list(itertools.islice(csv.reader(io.StringIO(text), delimiter=delimiter), MAX_TABLE_ROWS + 1))
    return Document([(path, _table(rows, TEXTS.get(language, TEXTS["en"])))])


def plain_text(text: str) -> str:
    """A .txt file as Markdown that keeps its lines, blank lines and indentation."""
    lines = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.rstrip()
        body = line.lstrip(" \t")
        indent = line[:len(line) - len(body)].replace("\t", "    ")
        # Leading spaces would start a code block; no-break spaces keep the indentation visible.
        lines.append("\u00a0" * len(indent) + escape_text(body) if body else "")
    out = []
    for i, line in enumerate(lines):
        follows = i + 1 < len(lines) and lines[i + 1]
        out.append(line + ("\\" if line and follows else ""))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _html_document(path: str, html, assets: _Assets) -> Document:
    """Saved web pages and exported HTML documents.

    The user picked this file, so all of its main content is kept: the web import's article extractor
    drops structure (nested lists, code) from pages that are documents rather than articles.
    """
    from app import web_import

    tree = web_import.parse_html(html) if isinstance(html, bytes) else _parse_html_text(html)
    for img in tree.xpath('//img[starts-with(@src, "data:image/")]'):
        target = assets.add(_data_uri(img.get("src")))
        if target:
            img.set("src", target)
        else:
            img.drop_tree()
    title = " ".join((tree.findtext(".//title") or "").split())
    web_import.prepare_tree(tree, None)
    mains = tree.xpath("//main | //*[@role='main'] | //article")
    body = mains[0] if len(mains) == 1 or (mains and mains[0].tag == "main") else tree.find("body")
    body = body if body is not None else tree
    for element in body.xpath(".//nav | .//aside | .//footer | .//form | .//noscript | .//iframe | .//template"):
        element.drop_tree()
    formulas = _Formulas()
    _tokenize_prepared_text(body, formulas)
    content = formulas.restore(html_markdown(_html_string(body)))
    if not content.strip():
        raise Unsupported("empty")
    first = re.match(r"#{1,6} +(.+)", content)
    same = first and " ".join(first[1].replace("\\", "").split()) == title
    heading = f"# {escape_text(title)}\n\n" if title and not same else ""
    return Document([(path, heading + content)], assets.items)


def _tokenize_prepared_text(tree, formulas: _Formulas) -> None:
    """Undo prepare_tree's text markup (\\( \\), \\[ \\] and \\$) for markdownify, which escapes on its own."""
    def text(value: str | None) -> str | None:
        if not value:
            return value
        value = re.sub(r"\\\[(.+?)\\\]", lambda m: formulas.token(m[1], True), value, flags=re.S)
        value = re.sub(r"\\\((.+?)\\\)", lambda m: formulas.token(m[1], False), value, flags=re.S)
        return value.replace("\\$", "$")

    for element in tree.iter():
        if isinstance(element.tag, str) and element.tag not in {"pre", "code"}:
            element.text = text(element.text)
        element.tail = text(element.tail)


def _html_string(element) -> str:
    from lxml import etree

    return etree.tostring(element, encoding="unicode", method="html")


def _parse_html_text(html: str):
    from lxml.html import HTMLParser, document_fromstring

    return document_fromstring(html, parser=HTMLParser(no_network=True, remove_comments=True))


def _data_uri(value: str) -> bytes | None:
    header, _, data = value.partition(",")
    if ";base64" not in header:
        return None
    try:
        return base64.b64decode(data, validate=False)
    except ValueError:
        return None


def _mhtml(path: str, raw: bytes) -> Document:
    """Browsers' single-file page saves: the page and its images in one MIME message."""
    from app import web_import

    message = email.message_from_bytes(raw, policy=policy.default)
    html, resources = None, {}
    for part in message.walk():
        if part.is_multipart():
            continue
        kind = part.get_content_type()
        if kind == "text/html" and html is None:
            try:
                html = part.get_content()
            except (LookupError, ValueError):
                html = (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
        elif kind.startswith("image/"):
            data = part.get_payload(decode=True) or b""
            for key in (part.get("Content-Location"), part.get("Content-ID")):
                if key:
                    resources[key.strip().strip("<>")] = data
                    resources["cid:" + key.strip().strip("<>")] = data
    if not html:
        raise Unsupported("broken")
    tree = _parse_html_text(html)
    web_import.resolve_lazy_images(tree)
    assets = _Assets()
    for img in tree.iter("img"):
        data = resources.get(img.get("src") or "")
        target = assets.add(data) if data else None
        if target:
            img.set("src", target)
            for name in web_import.LAZY_SOURCES + ("srcset", "data-srcset"):
                img.attrib.pop(name, None)
    return _html_document(path, _html_string(tree), assets)


def _epub(path: str, raw: bytes, language: str) -> Document:
    from lxml import etree
    from lxml.html import document_fromstring

    from app import web_import

    texts, assets, formulas = TEXTS.get(language, TEXTS["en"]), _Assets(), _Formulas()
    archive = _open_archive(raw)
    parser = etree.XMLParser(resolve_entities=False, recover=True)
    container = etree.fromstring(archive.read("META-INF/container.xml"), parser)
    opf_path = unquote(container.find(".//{*}rootfile").get("full-path"))
    opf = etree.fromstring(archive.read(opf_path), parser)
    names = set(archive.namelist())

    def resolve(base: str, href: str) -> str:
        return posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(urlsplit(href).path)))

    manifest = {item.get("id"): (resolve(opf_path, item.get("href") or ""), item.get("media-type") or "",
                                 item.get("properties") or "") for item in opf.iter("{*}item")}
    toc: dict[str, str] = {}
    nav = next((href for href, _, props in manifest.values() if "nav" in props.split()), None)
    if nav and nav in names:
        nav_tree = document_fromstring(archive.read(nav))
        lists = [n for n in nav_tree.iter("nav") if "toc" in n.attrib.values()] or list(nav_tree.iter("nav"))
        for link in (lists[0].iter("a") if lists else ()):
            if link.get("href"):
                toc.setdefault(resolve(nav, link.get("href")), _one_line(link.text_content()))
    spine_element = opf.find("{*}spine")
    ncx = manifest.get(spine_element.get("toc") if spine_element is not None else None)
    if not toc and ncx and ncx[0] in names:
        for point in etree.fromstring(archive.read(ncx[0]), parser).iter("{*}navPoint"):
            label, content = point.find("{*}navLabel/{*}text"), point.find("{*}content")
            if content is not None and content.get("src"):
                toc.setdefault(resolve(ncx[0], content.get("src")), _one_line(label.text or "") if label is not None else "")
    spine = [manifest[ref.get("idref")] for ref in opf.iter("{*}itemref")
             if ref.get("linear") != "no" and ref.get("idref") in manifest]
    pages: list[list[str]] = []
    for doc_path, media, _ in spine:
        if doc_path not in names or media not in {"application/xhtml+xml", "text/html"}:
            continue
        tree = document_fromstring(archive.read(doc_path))
        for image in tree.xpath("//*[local-name()='image']"):  # SVG cover pages
            href = next((v for k, v in image.attrib.items() if k.endswith("href")), "")
            svg = next((a for a in image.iterancestors() if a.tag.endswith("svg")), image)
            replacement = etree.Element("img", src=href)
            replacement.tail = svg.tail
            svg.getparent().replace(svg, replacement)
        for img in tree.iter("img"):
            member = resolve(doc_path, img.get("src") or "")
            target = assets.add(archive.read(member)) if member in names else None
            if target:
                img.set("src", target)
            else:
                img.drop_tree()
        for math in tree.xpath("//math"):
            tex = web_import._math_tex(math)
            replacement = etree.Element("span")
            replacement.text = formulas.token(tex, math.get("display") == "block") if tex else math.text_content()
            replacement.tail = math.tail
            math.getparent().replace(math, replacement)
        body = tree.find("body")
        markdown = formulas.restore(html_markdown(_html_string(body if body is not None else tree)))
        has_image = "bloom-asset/" in markdown
        if not markdown.strip():
            continue
        label = toc.get(doc_path)
        if label is not None or not pages or not toc:
            heading = re.search(r"^#{1,3} +(.+)$", markdown, re.M)
            label = label or (heading[1] if heading else (texts["cover"] if has_image and not pages else ""))
            pages.append([label or texts["section"].format(n=len(pages) + 1), markdown])
        else:
            pages[-1][1] += "\n\n" + markdown  # the rest of a chapter split across files
    archive.close()
    if not pages:
        raise Unsupported("empty")
    stem = posixpath.splitext(path)[0]
    width = max(2, len(str(len(pages))))
    named = []
    for i, (label, text) in enumerate(pages, start=1):
        label = " ".join(re.sub(r"[/\\\x00-\x1f]", " ", label).split())[:80]
        named.append((f"{stem}/{str(i).zfill(width)} {label}", text))
    return Document(named, assets.items)


def _notebook(path: str, raw: bytes, language: str, decode: Callable[[bytes], str]) -> Document:
    texts, assets = TEXTS.get(language, TEXTS["en"]), _Assets()
    notebook = json.loads(decode(raw))
    cells = notebook.get("cells")
    if cells is None:  # nbformat 3
        cells = [cell for sheet in notebook.get("worksheets", []) for cell in sheet.get("cells", [])]
    meta = notebook.get("metadata") or {}
    code_language = ((meta.get("kernelspec") or {}).get("language")
                     or (meta.get("language_info") or {}).get("name") or "python")

    def joined(value) -> str:
        return "".join(value) if isinstance(value, list) else str(value or "")

    def capped(text: str) -> str:
        text = ANSI.sub("", text)
        return text if len(text) <= MAX_OUTPUT_CHARS else text[:MAX_OUTPUT_CHARS] + "\n" + texts["output_cut"]

    blocks = []
    for cell in cells:
        kind, source = cell.get("cell_type"), joined(cell.get("source") or cell.get("input"))
        if kind == "markdown":
            for name, bundle in (cell.get("attachments") or {}).items():
                data = next((bundle[k] for k in ("image/png", "image/jpeg", "image/gif") if k in bundle), None)
                target = assets.add(base64.b64decode(joined(data))) if data else None
                source = source.replace(f"attachment:{name}", target or "")
            blocks.append(markdown_without_html(source))
        elif kind == "code":
            if source.strip():
                blocks.append(fence(source, code_language))
            for output in cell.get("outputs") or []:
                output_type = output.get("output_type")
                data = output.get("data") or output
                if output_type == "stream":
                    blocks.append(fence(capped(joined(output.get("text"))), "text"))
                elif output_type == "error":
                    blocks.append(fence(capped("\n".join(output.get("traceback") or [])), "text"))
                elif image := next((data[k] for k in ("image/png", "image/jpeg", "png", "jpeg") if k in data), None):
                    target = assets.add(base64.b64decode(joined(image)))
                    if target:
                        blocks.append(f"![]({target})")
                elif "text/markdown" in data:
                    blocks.append(joined(data["text/markdown"]))
                elif "text/html" in data:
                    blocks.append(html_markdown(joined(data["text/html"])))
                elif "text/latex" in data:
                    blocks.append(joined(data["text/latex"]))
                elif "text/plain" in data or "text" in data:
                    blocks.append(fence(capped(joined(data.get("text/plain") or data.get("text"))), "text"))
        elif kind == "raw" and source.strip():
            blocks.append(fence(source))
    return Document([(path, "\n\n".join(block.strip() for block in blocks if block.strip()))], assets.items)


def convert(path: str, raw: bytes, language: str, decode: Callable[[bytes], str]) -> Document | None:
    """Pages for a document type this module reads; None for Markdown, code and other text files."""

    try:
        return _convert(path, raw, language, decode)
    except Unsupported:
        raise
    except HTTPException as exc:  # the text decoder could not tell the encoding
        raise Unsupported("encoding") from exc
    except Exception as exc:
        logger.warning("文档 %s 无法转换：%s", path, exc, exc_info=True)
        raise Unsupported("broken") from exc


def _convert(path: str, raw: bytes, language: str, decode: Callable[[bytes], str]) -> Document | None:
    name = path.rsplit("/", 1)[-1]
    suffix = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix in UNSUPPORTED:
        raise Unsupported(UNSUPPORTED[suffix])
    if suffix in {"docx", "docm", "dotx"}:
        return _docx(path, raw, language)
    if suffix in {"pptx", "pptm", "ppsx", "potx"}:
        return _pptx(path, raw, language)
    if suffix in {"xlsx", "xlsm", "xls"}:
        return _sheets(path, raw, language, suffix)
    if suffix in {"csv", "tsv"}:
        return _csv(path, raw, language, suffix, decode)
    if suffix in {"html", "htm", "xhtml"}:
        return _html_document(path, raw, _Assets())
    if suffix in {"mhtml", "mht"}:
        return _mhtml(path, raw)
    if suffix == "epub":
        return _epub(path, raw, language)
    if suffix == "ipynb":
        return _notebook(path, raw, language, decode)
    if suffix in {"txt", "text"}:
        return Document([(path, plain_text(decode(raw)))])
    return None
