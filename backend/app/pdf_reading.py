"""PDF 阅读版（实验）：把 PDF 每页画成图片，交给能看图的模型逐页转成 Markdown。

正文按阅读顺序，公式写成 LaTeX，表格转成表格；插图由模型给出位置，再按位置从页面图上裁下来。
转出来的是一篇能重排的文字课文：手机上能读、能调字号、划线按字定位。排版不会和原 PDF 一模一样，
所以前端标成「实验性」，原 PDF 也和课文一起存着。

模型调用由调用方传进来（courses.py 里走统一的调用出口），这里只管画页、拼提示、裁图和整理输出。
"""

from __future__ import annotations

import base64
import contextvars
import io
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

import pypdfium2 as pdfium

logger = logging.getLogger(__name__)

PROMPT = """You are converting ONE page of a PDF into Markdown for a study app. Output only the Markdown, no code fences, no commentary.

Rules:
- Transcribe every piece of body text in natural reading order. For multi-column pages, finish the left column before the right one.
- Headings become Markdown headings and keep their numbering. The heading level follows the numbering depth: "3 Model Architecture" -> "## 3 Model Architecture", "3.2 Attention" -> "### 3.2 Attention", "3.2.1 ..." -> "#### 3.2.1 ...". Unnumbered section headings (Abstract, References, Acknowledgements) use "##". Use "#" only for the document title.
- Math: inline math as $...$, display math as $$...$$ on its own lines, no blank lines inside a $$ block. Keep equation numbers with \\tag{n}.
- Tables become Markdown tables.
- Figures, diagrams, charts and photos: do NOT transcribe the text inside them. In their place write one line exactly like
  [[FIGURE x0 y0 x1 y1]]
  where the four integers are the bounding box of the whole figure (every part of it, including axis labels and side labels, but not its caption) on a 0-1000 scale of the page: x0,x1 from the left edge, y0,y1 from the top edge. When in doubt, make the box slightly larger. Then write the caption as normal text right after it.
- Leave out running headers and footers, page numbers, line numbers, side stamps (like arXiv identifiers) and watermarks.
- Keep footnotes as normal paragraphs at the end of the page.
- Keep the original language of the document; do not translate."""

# 页面按这个分辨率画：裁插图用；给模型看的图再缩到 MODEL_IMAGE_WIDTH 宽
RENDER_DPI = 200
# 约等于 A4 / Letter 按 150 DPI 画的宽度：实测主流能看图的模型在这个大小下公式、表格、插图位置都认得准
MODEL_IMAGE_WIDTH = 1275
# 插图框四周多裁一点（0–1000 的页面比例）：模型给的框常常压着图边上的标注
FIGURE_PADDING = 15
# 一页图加提示词大约多少输入 token（实测约 1350–2750），给调用方估算输入用量；按 base64 文字估会多出几十倍
PAGE_INPUT_TOKENS = 3000
MAX_OUTPUT_TOKENS = 8000
# 一次调用最多等这么久，最多试 PAGE_ATTEMPTS 次；整份转换另有总时限。
# 正常一页 8–25 秒；实测偶尔有一页的请求在网关上卡住不回，等太久整份都跟着慢
PAGE_TIMEOUT_SECONDS = 90
PAGE_ATTEMPTS = 3
# 失败的页超过这个比例，整份算失败，不交出一篇缺一大块的课文
MAX_FAILED_SHARE = 0.3

FIGURE_RE = re.compile(r"^[ \t]*\[\[FIGURE\s+(\d{1,4})\s+(\d{1,4})\s+(\d{1,4})\s+(\d{1,4})\s*\]\][ \t]*$", re.MULTILINE)
_FENCE_RE = re.compile(r"^```(?:markdown|md)?[ \t]*\n(.*?)\n?```[ \t]*$", re.DOTALL | re.IGNORECASE)

# 模型调用：messages、输入 token 估计、这次调用最多等几秒 → 模型返回的文字
PageCall = Callable[[list[dict], int, float], str]


class PdfReadingError(RuntimeError):
    """整份 PDF 没法转：太多页失败，或者超出总时限。"""


@dataclass
class ConvertedPdf:
    markdown: str
    # 插图：占位名（写在 Markdown 的图片地址里，存好以后换成真地址）→ PNG
    figures: dict[str, bytes] = field(default_factory=dict)
    # pages：转了几页；source_pages：原 PDF 共几页（超过上限时只转前面的）
    pages: int = 0
    failed_pages: list[int] = field(default_factory=list)
    source_pages: int = 0


def page_count(raw: bytes) -> int:
    pdf = pdfium.PdfDocument(raw)
    try:
        return len(pdf)
    finally:
        pdf.close()


def _png(image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _model_png(image) -> bytes:
    if image.width > MODEL_IMAGE_WIDTH:
        image = image.resize((MODEL_IMAGE_WIDTH, round(image.height * MODEL_IMAGE_WIDTH / image.width)))
    return _png(image)


def crop_figure(image, box: tuple[int, int, int, int]) -> bytes | None:
    """按 0–1000 的页面比例裁一张插图，四周各多留 FIGURE_PADDING；框不成形（反了、太小、出界）就不要。"""
    x0, y0, x1, y1 = box
    if not (0 <= x0 < x1 <= 1000 and 0 <= y0 < y1 <= 1000) or x1 - x0 < 20 or y1 - y0 < 20:
        return None
    x0, y0 = max(0, x0 - FIGURE_PADDING), max(0, y0 - FIGURE_PADDING)
    x1, y1 = min(1000, x1 + FIGURE_PADDING), min(1000, y1 + FIGURE_PADDING)
    w, h = image.size
    return _png(image.crop((x0 * w // 1000, y0 * h // 1000, x1 * w // 1000, y1 * h // 1000)))


_DISPLAY_MATH_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_INLINE_MATH_RE = re.compile(r"(?<![\\$])\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)")


def _balance_braces(tex: str) -> str:
    """模型抄公式偶尔少写结尾的右括号（10000^{2i/d_{\\text{model}})）：缺几个就在末尾补几个，KaTeX 才不会整条报错。
    转义的 \\{ \\} 不算；右括号多出来的没法判断该删哪个，原样留着。"""
    depth, i = 0, 0
    while i < len(tex):
        if tex[i] == "\\":
            i += 2
            continue
        depth += {"{": 1, "}": -1}.get(tex[i], 0)
        i += 1
    return tex + "}" * depth if depth > 0 else tex


def tidy_page(text: str) -> str:
    """模型输出的整理：去掉整页外包的代码围栏；$$ 公式块里的空行删掉（否则前端按空行分段时会把公式切开）；
    公式里少写的右括号补上。"""
    text = text.strip()
    fenced = _FENCE_RE.match(text)
    if fenced:
        text = fenced.group(1).strip()
    lines, in_math = [], False
    for line in text.splitlines():
        if in_math and not line.strip():
            continue
        # 一行里 $$ 出现奇数次（单独的 $$、$$ 开头的第一行、$$ 结尾的最后一行）就是进出了一个公式块
        if line.count("$$") % 2:
            in_math = not in_math
        lines.append(line.rstrip())
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()

    def display(match: re.Match) -> str:
        # 多行公式块的结尾 $$ 必须单独一行：补的 } 放在最后一行内容末尾，不能放到换行后面去
        body = match.group(1)
        content = body.rstrip()
        return f"$${_balance_braces(content)}{body[len(content):]}$$"

    text = _DISPLAY_MATH_RE.sub(display, text)
    return _INLINE_MATH_RE.sub(lambda m: f"${_balance_braces(m.group(1))}$", text)


_NOT_BODY = ("#", "!", "|", "$$", ">", "<!--", "[[", "*Figure", "*Table", "Figure ", "Table ", "- ", "* ")


def join_split_sentences(pages: list[str | None]) -> list[str | None]:
    """跨页断开的句子接回去：前一页最后一段没有句末标点，后一页第一段正文以小写英文字母开头，就把这一段接到前一段末尾。
    后一页开头的插图、图注、表格、标题、公式不算正文，跳过去找；中文没有大小写可判断，不动。"""
    pages = list(pages)
    for i in range(len(pages) - 1):
        prev, nxt = pages[i], pages[i + 1]
        if not prev or not nxt:
            continue
        prev_paras, next_paras = prev.split("\n\n"), nxt.split("\n\n")
        last = prev_paras[-1].rstrip()
        if not last or last.startswith(_NOT_BODY) or re.search(r"[.!?:;)\]\"”。！？：；）]$", last):
            continue
        k = next((j for j, p in enumerate(next_paras) if p.strip() and not p.lstrip().startswith(_NOT_BODY)), None)
        if k is None or not re.match(r"[a-z]", next_paras[k].lstrip()):
            continue
        joiner = "" if last.endswith("-") else " "
        prev_paras[-1] = last + joiner + next_paras[k].strip()
        del next_paras[k]
        pages[i], pages[i + 1] = "\n\n".join(prev_paras), "\n\n".join(next_paras).strip()
    return pages


def _page_messages(png: bytes) -> list[dict]:
    url = "data:image/png;base64," + base64.b64encode(png).decode()
    return [{"role": "user", "content": [{"type": "text", "text": PROMPT}, {"type": "image_url", "image_url": {"url": url}}]}]


def _labels(language: str) -> dict[str, str]:
    if language == "en":
        return {
            "figure": "Figure on page {page}",
            "failed": "> Page {page} could not be converted. Please check the original PDF.",
            "truncated": "> The original PDF has {total} pages. PDF reading converts at most {limit} pages at a time, "
                         "so only the first {done} are here; use “View original PDF” above for the rest.",
            "skipped": "> PDF reading converts at most {limit} pages at a time and the earlier files used them up, "
                       "so this file was not converted. Use “View original PDF” above to read it.",
        }
    return {
        "figure": "第 {page} 页插图",
        "failed": "> 第 {page} 页没能转换，请对照原 PDF 阅读。",
        "truncated": "> 原 PDF 共 {total} 页，PDF 阅读版一次最多转换 {limit} 页，这里只转换了前 {done} 页；后面的内容请点上方「查看原 PDF」阅读。",
        "skipped": "> PDF 阅读版一次最多转换 {limit} 页，这次的页数在前面的文件里用完了，这个文件没有转换；请点上方「查看原 PDF」阅读。",
    }


def convert_pdf(raw: bytes, call: PageCall, *, file_key: str, language: str = "zh", deadline: float,
                concurrency: int = 6, should_stop: Callable[[BaseException], bool] = lambda exc: False,
                max_pages: int | None = None, limit: int | None = None) -> ConvertedPdf:
    """逐页转换一份 PDF。每页失败重试，仍失败就在那一页留一句说明；失败的页太多或者超时，整份抛 PdfReadingError。

    file_key 用来给插图起不重复的占位名；should_stop(exc) 为真的错误（比如余额不足）不重试、直接往外抛。
    max_pages：这份最多转前几页（一次上传的总页数有上限，按文件顺序分）；后面的页不画、不调模型，课文开头写明只转了前几页。
    0 页就整份不转，只留一句说明。limit 是写进说明里的「一次最多几页」。"""
    labels = _labels(language)
    pdf = pdfium.PdfDocument(raw)
    source_pages = len(pdf)
    limit = limit if limit is not None else max_pages
    if max_pages == 0:
        pdf.close()
        return ConvertedPdf(markdown=labels["skipped"].format(limit=limit) + "\n", source_pages=source_pages)
    # PDFium 不是线程安全的：画页要排队；画好以后调模型、裁图各页并行
    render_lock = threading.Lock()

    def one(index: int) -> tuple[str, dict[str, bytes]]:
        page = index + 1
        # 每页现画现用，不把整份 PDF 的大图都留在内存里（60 页按 200 DPI 画要六七百 MB）
        with render_lock:
            image = pdf[index].render(scale=RENDER_DPI / 72).to_pil()
        png = _model_png(image)
        for attempt in range(PAGE_ATTEMPTS):
            remaining = deadline - time.monotonic()
            if remaining < 5:
                raise PdfReadingError("PDF 转换超出时限")
            try:
                text = tidy_page(call(_page_messages(png), PAGE_INPUT_TOKENS, min(PAGE_TIMEOUT_SECONDS, remaining)))
                break
            except Exception as exc:
                if should_stop(exc) or isinstance(exc, PdfReadingError) or attempt == PAGE_ATTEMPTS - 1:
                    raise
                logger.warning("PDF 第 %d 页转换失败，重试：%s", page, exc)
        figures: dict[str, bytes] = {}

        def figure(match: re.Match) -> str:
            cropped = crop_figure(image, tuple(int(v) for v in match.groups()))
            if cropped is None:
                return ""
            key = f"{file_key}/page-{page}-figure-{len(figures) + 1}.png"
            figures[key] = cropped
            return f"![{labels['figure'].format(page=page)}]({key})"

        return FIGURE_RE.sub(figure, text).strip(), figures

    try:
        total = source_pages if max_pages is None else min(source_pages, max_pages)
        results: list[tuple[str, dict[str, bytes]] | None] = [None] * total
        failed: list[int] = []
        with ThreadPoolExecutor(max_workers=max(1, min(concurrency, total))) as pool:
            # 每页在自己的 contextvars 副本里跑：追踪靠 contextvars，线程池默认不带过去
            futures = {pool.submit(contextvars.copy_context().run, one, i): i for i in range(total)}
            for future, index in futures.items():
                try:
                    results[index] = future.result()
                except Exception as exc:
                    if should_stop(exc) or isinstance(exc, PdfReadingError):
                        for other in futures:
                            other.cancel()
                        raise
                    logger.warning("PDF 第 %d 页转换失败：%s", index + 1, exc)
                    failed.append(index + 1)
    finally:
        pdf.close()
    if total and len(failed) > total * MAX_FAILED_SHARE:
        raise PdfReadingError(f"{len(failed)} / {total} 页没能转换")

    figures: dict[str, bytes] = {}
    for result in results:
        if result is not None:
            figures.update(result[1])
    texts = join_split_sentences([result[0] if result else None for result in results])
    parts = []
    if total < source_pages:
        parts.append(labels["truncated"].format(total=source_pages, limit=limit, done=total))
    for index, text in enumerate(texts):
        page = index + 1
        body = labels["failed"].format(page=page) if text is None else text
        parts.append(f"<!-- page: {page} -->\n{body}".rstrip())
    return ConvertedPdf(markdown="\n\n".join(parts).strip() + "\n", figures=figures, pages=total,
                        failed_pages=sorted(failed), source_pages=source_pages)
