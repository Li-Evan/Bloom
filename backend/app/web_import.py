"""Authenticated, unmetered article preview. Only extracted Markdown reaches the reader."""

import http.client
import json
import ipaddress
import re
import socket
import ssl
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.models import User

router = APIRouter(prefix="/api/web-import", tags=["web-import"])
MAX_BYTES = 4 * 1024 * 1024
MAX_CHARS = 200_000
# A clip reads its address from the server too (clip_article): a slow site falls back to the browser's copy sooner than
# 网页原文 gives up, and a server copy shorter than this share of the browser's is a teaser, not the article.
CLIP_FETCH_SECONDS = 10
CLIP_SERVED_SHARE = 0.6
# The extractor drops <img> URLs without an image extension, which is every WeChat image
# (.../640?wx_fmt=jpeg). This fragment gets them through and is stripped from the output.
IMAGE_EXTENSION_MARKER = "#bloom.jpg"
WECHAT_BLOCKS = ".//section|.//p|.//h1|.//h2|.//h3|.//h4|.//h5|.//h6|.//ul|.//ol|.//table|.//pre|.//blockquote"
_slots = threading.BoundedSemaphore(4)
_lock = threading.Lock()
_requests: OrderedDict[str, list[float]] = OrderedDict()


class WebPreviewRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4096)


class WebPreview(BaseModel):
    title: str
    url: str
    content: str
    characters: int
    via_reader: bool = False


class FetchFailed(Exception):
    pass


def normalize_url(raw: str, *, any_port: bool = False) -> str:
    """any_port: the address is only recorded, never fetched (a clipped page), so a dev server or intranet port is fine."""
    raw = raw.strip()
    if re.search(r"[\x00-\x20\x7f\\]", raw):
        raise HTTPException(400, "请输入有效的公开网页链接")
    try:
        parts = urlsplit(raw)
        if (parts.scheme not in {"http", "https"} or not parts.hostname
                or parts.username is not None or parts.password is not None
                or (parts.port not in {None, 80, 443} and not any_port)):
            raise ValueError()
        host = parts.hostname.encode("idna").decode("ascii").lower()
        if ":" in host:
            host = f"[{host}]"
        netloc = host + (f":{parts.port}" if parts.port else "")
        return urlunsplit((parts.scheme, netloc, quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~"),
                           quote(parts.query, safe="%=&/?@:!$'()*+,;-._~"), ""))
    except (ValueError, UnicodeError):
        raise HTTPException(400, "请输入 http 或 https 开头的公开网页链接") from None


def public_address(host: str, port: int) -> str:
    """Validate every answer, then pin the connection to a validated IP (no second DNS lookup)."""
    try:
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise FetchFailed("DNS lookup failed") from None
    addresses = list(dict.fromkeys(item[4][0] for item in answers))
    if not addresses:
        raise FetchFailed("DNS lookup failed")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if (not ip.is_global or ip.is_multicast
                or (isinstance(ip, ipaddress.IPv6Address) and (ip.ipv4_mapped or ip.sixtofour or ip.teredo))):
            raise HTTPException(400, "只支持公开网页，不能访问本机或内网地址")
    return next((address for address in addresses if ":" not in address), addresses[0])


class PublicConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str, tls: bool, timeout: float):
        super().__init__(host, port=port, timeout=timeout)
        self.address = address
        self.tls = tls

    def connect(self):
        self.sock = socket.create_connection((self.address, self.port), self.timeout)
        if self.tls:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)


def fetch_html(url: str, deadline: float, *, reader: bool = False) -> tuple[bytes, str]:
    for _ in range(5):
        url = normalize_url(url)
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        address = public_address(parts.hostname, port)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchFailed("Timed out")
        connection = PublicConnection(parts.hostname, port, address, parts.scheme == "https", min(12, remaining))
        sockets = []
        expired = threading.Event()

        def expire():
            # socket idle timeouts do not bound a server trickling response headers.
            # shutdown also interrupts HTTPResponse's buffered makefile reader.
            expired.set()
            for sock in sockets + ([connection.sock] if connection.sock else []):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        timer = threading.Timer(remaining, expire)
        timer.daemon = True
        timer.start()
        try:
            headers = {"User-Agent": "Mozilla/5.0 (compatible; BloomReader/1.0)",
                       "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity"}
            if reader:
                # The anonymous standard Reader returns extracted Markdown in JSON.
                # Forcing browser-rendered raw HTML requires authentication.
                headers["Accept"] = "application/json"
            connection.connect()
            sockets.append(connection.sock)
            if time.monotonic() >= deadline:
                raise FetchFailed("Timed out")
            connection.request("GET", parts.path + (f"?{parts.query}" if parts.query else ""), headers=headers)
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location:
                    raise FetchFailed("Missing redirect location")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise FetchFailed(f"HTTP {response.status}")
            if response.getheader("Content-Encoding", "identity").lower() not in {"", "identity"}:
                raise FetchFailed("Unsupported content encoding")
            content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            allowed_types = {"application/json"} if reader else {"text/html", "application/xhtml+xml"}
            if content_type not in allowed_types:
                if reader:
                    raise FetchFailed("Invalid Reader response")
                raise HTTPException(422, "这个链接不是网页文章；PDF 或其他文件请下载后通过「项目文件」上传")
            body = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise FetchFailed("Timed out")
                if connection.sock:
                    connection.sock.settimeout(min(12, remaining))
                chunk = response.read1(min(64 * 1024, MAX_BYTES + 1 - len(body)))
                if expired.is_set() or time.monotonic() >= deadline:
                    raise FetchFailed("Timed out")
                if not chunk:
                    if response.length not in (None, 0):
                        raise FetchFailed("Incomplete response")
                    return bytes(body), url
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise HTTPException(422, "网页太大，请复制正文并保存为 Markdown 后上传")
        except (OSError, http.client.HTTPException) as exc:
            raise FetchFailed(type(exc).__name__) from None
        finally:
            timer.cancel()
            timer.join()
            connection.close()
    raise FetchFailed("Too many redirects")


def prepare_wechat(tree) -> None:
    """Reshape a WeChat article into the plain paragraphs and images the extractor can read."""
    from lxml import etree

    for img in tree.xpath("//img[@src]"):
        img.set("src", img.get("src") + IMAGE_EXTENSION_MARKER)
    for body in tree.xpath('//*[@id="js_content"]'):
        # Editor layouts are nested <section>s with no <p>, which fails the main extraction
        # and falls back to an algorithm that keeps no images.
        for section in body.xpath(".//section"):
            if not section.xpath(WECHAT_BLOCKS):
                section.tag = "p"
        etree.strip_tags(body, "section")
        for img in body.xpath(".//img[not(ancestor::p)]"):
            wrapper = etree.Element("p")
            img.addprevious(wrapper)
            wrapper.tail, img.tail = img.tail, None
            wrapper.append(img)
        # The extractor discards any style mentioning "hidden", so overflow: hidden loses image wrappers.
        for element in body.xpath(".//*[contains(@style, 'overflow')]"):
            element.set("style", re.sub(r"overflow[^;]*;?", "", element.get("style")))


def prepare_x(tree) -> None:
    """An X article marks its title and body (data-article-part): keep just those, so the author bar, the author card,
    view counts and replies never reach the extractor, and it does not fall back to a reader that drops links."""
    from lxml import etree

    title = tree.xpath('//*[@data-article-part="title"]')
    body = tree.xpath('//*[@data-article-part="body"]')
    page = tree.find("body")
    if not title or not body or page is None:
        return
    article = etree.Element("article")
    heading = etree.SubElement(article, "h1")
    heading.text = title[0].text_content().strip()
    article.append(body[0])
    for child in list(page):
        page.remove(child)
    page.append(article)


FEISHU_PAGE = '//*[@data-block-type="page"][@data-record-id]'
FEISHU_LINES = './/*[contains(concat(" ", normalize-space(@class), " "), " ace-line ")]'
FEISHU_ORDER = './/*[contains(concat(" ", normalize-space(@class), " "), " order ")]'
FEISHU_QUOTES = {"quote", "quote_container", "callout"}
# Pictures are blob: addresses that only work inside Feishu; embedded files, boards and sheets have no text
FEISHU_SKIPPED = {"image", "iframe", "file", "view", "mindnote", "diagram", "board", "whiteboard", "sheet", "bitable",
                  "base_refer", "isv", "chat_card", "okr", "jira_issue", "agenda"}
ZERO_WIDTH = re.compile("[\u200b\u200c\u200d\ufeff]")
# Not the backslash: convert_math already wrote \$ for dollars that are not math
MARKDOWN_SPECIAL = re.compile(r"([`*_\[\]<>~|])")
# A paragraph that starts like a heading, list item or quote would turn into one
BLOCK_START = re.compile(r"^(\s*)(#|[-+]\s|\d+[.)]\s)")


def _feishu_owner(element):
    return next(iter(element.xpath("ancestor::*[@data-block-type][1]")), None)


def _feishu_own(block, path: str) -> list:
    return [element for element in block.xpath(path) if _feishu_owner(element) is block]


def _md_text(text: str | None) -> str:
    return MARKDOWN_SPECIAL.sub(r"\\\1", ZERO_WIDTH.sub("", text or ""))


def _md_inline(element) -> str:
    """One .ace-line as Markdown: Feishu marks bold, italics and strikethrough as inline styles, inline code as a class."""
    out = [_md_text(element.text)]
    for child in element:
        if not isinstance(child.tag, str):
            out.append(_md_text(child.tail))
            continue
        style, names = child.get("style") or "", child.get("class") or ""
        href = child.get("href") or ""
        if child.get("data-formula") is not None:
            inner = child.text or ""
        elif "inline-code" in names:
            code = ZERO_WIDTH.sub("", child.text_content())
            fence = "``" if "`" in code else "`"
            inner = f"{fence}{code}{fence}" if code.strip() else code
        else:
            inner = _md_inline(child)
            core = inner.strip()
            mark = ("**" if re.search(r"font-weight\s*:\s*(bold|[6-9]00)", style)
                    else "*" if "italic" in style else "~~" if "line-through" in style else "")
            if child.tag == "a" and href.startswith(("http://", "https://")) and core:
                inner = inner.replace(core, f"[{core}](<{href.replace('>', '%3E')}>)", 1)
            elif mark and core:
                inner = inner.replace(core, f"{mark}{core}{mark}", 1)
        out.append(inner)
        out.append(_md_text(child.tail))
    # Feishu splits text into many spans: neighbouring runs of the same style join up
    return re.sub(r"\*\*\*\*|~~~~", "", "".join(out))


def _md_lines(block) -> str:
    """The block's own lines (not its child blocks' or a code block's caption), one Markdown line each."""
    lines = [_md_inline(line).strip() for line in _feishu_own(block, FEISHU_LINES)
             if not line.xpath('ancestor::*[contains(@class, "code-block-header")]')]
    return "\\\n".join(line for line in lines if line)


def _md_blocks(block) -> list[tuple[str, bool]]:
    """Markdown for the blocks inside block, each with whether it is a list item (list items sit on adjacent lines)."""
    out = []
    for child in _feishu_own(block, ".//*[@data-block-type]"):
        kind = child.get("data-block-type")
        if kind in FEISHU_SKIPPED:
            continue
        text = _md_lines(child)
        nested = _md_join(_md_blocks(child)) if kind != "code" else ""
        if kind in {"bullet", "ordered", "todo"}:
            if kind == "ordered":
                number = "".join(element.text_content() for element in _feishu_own(child, FEISHU_ORDER)).strip().rstrip(".")
                marker = f"{number}. " if number.isdigit() else "1. "
            elif kind == "todo":
                done = child.xpath('.//*[contains(@class, "checked") or contains(@class, "done")]')
                marker = "- [x] " if done and _feishu_owner(done[0]) is child else "- [ ] "
            else:
                marker = "- "
            item = marker + text
            if nested:
                item += "\n\n" + re.sub(r"(?m)^(?=.)", " " * len(marker), nested)
            out.append((item, True))
        elif level := re.fullmatch(r"heading(\d)", kind):
            order = "".join(element.text_content() for element in _feishu_own(child, './/*[contains(@class, "heading-order")]'))
            words = " ".join(part for part in (ZERO_WIDTH.sub("", order).strip(), text.replace("\\\n", " ")) if part)
            if words:
                # The document title is the # heading
                out.append(("#" * min(int(level[1]) + 1, 6) + " " + words, False))
            if nested:
                out.append((nested, False))
        elif kind == "code":
            code = "\n".join(ZERO_WIDTH.sub("", line.text_content()) for line in child.xpath(
                './/*[contains(@class, "code-block-content")]' + FEISHU_LINES[1:]))
            fence = "````" if "```" in code else "```"
            out.append((f"{fence}\n{code}\n{fence}", False))
        elif kind == "divider":
            out.append(("---", False))
        elif kind == "bookmark":
            # A link card: its address, then the page's title and description
            words = [ZERO_WIDTH.sub("", span.text_content()).strip() for span in child.iter("span")]
            words = [word for word in words if word]
            address = next((word for word in words if re.match(r"https?://\S+$", word)), "")
            name = next((word for word in words if word != address), "")
            if address:
                out.append((f"[{_md_text(name or address)}](<{address.replace('>', '%3E')}>)", False))
        elif kind in FEISHU_QUOTES:
            inner = "\n\n".join(part for part in (text, nested) if part)
            if inner:
                out.append((re.sub(r"(?m)^", "> ", inner), False))
        else:
            # Text, and blocks that only hold other blocks (grids, columns, synced blocks, tables)
            if text:
                out.append((BLOCK_START.sub(r"\1\\\2", text), False))
            if nested:
                out.append((nested, False))
    return out


def _md_join(blocks: list[tuple[str, bool]]) -> str:
    parts = []
    for index, (markdown, is_item) in enumerate(blocks):
        if index:
            parts.append("\n" if is_item and blocks[index - 1][1] else "\n\n")
        parts.append(markdown)
    return "".join(parts)


def feishu_article(tree) -> tuple[str, str] | None:
    """A Feishu / Lark document is nested <div>s with the block type on each block and one .ace-line per line, so a
    general extractor loses its headings and lists and keeps the wiki sidebar tree. The clipping extension scrolls
    through it so every block is in the page; this writes its title and blocks straight to Markdown."""
    pages = tree.xpath(FEISHU_PAGE)
    if not pages:
        return None
    title = pages[0].xpath('.//*[contains(@class, "page-block-header")]//h1')
    return ZERO_WIDTH.sub("", title[0].text_content()).strip() if title else "", _md_join(_md_blocks(pages[0]))


def _has_class(*names: str) -> str:
    return " or ".join(f"contains(concat(' ', normalize-space(@class), ' '), ' {name} ')" for name in names)


# Lazy loaders keep the real address in one of these and a placeholder in src.
LAZY_SOURCES = ("data-original-src", "data-actualsrc", "data-original", "data-src", "data-lazy-src",
                "data-lazyload", "data-echo")
# Never article text: copy buttons, heading permalinks, MediaWiki edit links and navigation boxes,
# line-number gutters that would otherwise land inside code blocks.
FURNITURE = (
    "//button | //*[" + _has_class("mw-editsection", "navbox", "vertical-navbox", "sidebar", "noprint", "ambox",
                                    "metadata", "mw-empty-elt", "shortdescription", "hatnote", "mw-jump-link", "toc",
                                    "headerlink", "header-anchor", "heading-anchor", "anchor-link", "anchorjs-link",
                                    "line-numbers-rows", "pre-numbering", "linenodiv") + "]"
    " | //td[" + _has_class("gutter", "linenos", "hljs-ln-numbers") + "]"
    " | //h1//a[@aria-hidden='true'] | //h2//a[@aria-hidden='true'] | //h3//a[@aria-hidden='true']"
    " | //h4//a[@aria-hidden='true'] | //h5//a[@aria-hidden='true'] | //h6//a[@aria-hidden='true']"
)
HEADINGS = "//h1 | //h2 | //h3 | //h4 | //h5 | //h6"
PERMALINK_TEXT = {"", "¶", "#", "§", "🔗", "⚓", "link"}
CODE_TAGS = {"pre", "code", "kbd", "samp", "script", "style", "textarea"}
# Wrappers that hold one formula together with its rendered copies (KaTeX HTML, MathJax output,
# Wikipedia's hidden MathML and fallback image); the whole wrapper becomes the TeX.
MATH_WRAPPER = re.compile(r"(?:^|\s)(?:mwe-math-element|katex-display|katex|MathJax_Display|MathJax|math-container)(?:\s|$)")
TAILWIND_LAYOUT = re.compile(r"[\[\]():]")
X_HOSTS = {"x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"}
# X page titles wrap the post: 「X 上的 Ada：“…” / X」, "Ada on X: "…" / X", 「Xユーザーの…さん: 「…」 / X」
X_PAGE_TITLE = re.compile(r"[“\"「](.+)[”\"」]\s*/\s*X\s*$")
RENDERED_DISPLAY = re.compile(r"(?:^|\s)(?:MathJax_Display|MathJax_SVG_Display|MJXc-display)(?:\s|$)")
EQUATION_NUMBER = re.compile(r"\(\s*([\w.]{1,8})\s*\)")
DISPLAY_DOLLARS = re.compile(r"\$\$(.+?)\$\$", re.S)
# Pandoc's rule: no space inside the delimiters and no digit right after the closing one ($5 and $10 stay text).
INLINE_DOLLARS = re.compile(r"(?<![\\$])\$(?=\S)([^$\n]+?)(?<=\S)(?<!\\)\$(?![\d$])")
# MathJax/KaTeX configs that turn on $...$; cnblogs loads MathJax with it from one page flag.
SINGLE_DOLLAR_CONFIG = re.compile(r"""\[\s*['"]\$['"]\s*,\s*['"]\$['"]\s*\]|left\s*:\s*['"]\$['"]|cb_enable_mathjax\s*=\s*true""")


def _codecogs(query: str) -> str:
    tex = unquote(query).replace("&space;", " ").replace("&plus;", "+").replace("&amp;", "&")
    return re.sub(r"^(?:\s*\\(?:dpi\{\d+\}|bg_\w+|bg\{\w+\}|inline|fn_\w+|large|small))+", "", tex)


def _query(parts, key: str) -> str | None:
    return parse_qs(parts.query).get(key, [None])[0]


# Formula images from LaTeX rendering services: the TeX is in the address.
FORMULA_IMAGES = {
    "latex.csdn.net": lambda parts: unquote(parts.query) if parts.path == "/eq" else None,
    "www.zhihu.com": lambda parts: _query(parts, "tex") if parts.path == "/equation" else None,
    "latex.codecogs.com": lambda parts: _codecogs(parts.query),
    "math.now.sh": lambda parts: _query(parts, "from"),
    "render.githubusercontent.com": lambda parts: _query(parts, "math"),
    "chart.googleapis.com": lambda parts: _query(parts, "chl") if _query(parts, "cht") == "tx" else None,
}


def _drop(element) -> None:
    parent = element.getparent()
    if parent is not None:
        element.drop_tree()


def _largest_source(srcset: str) -> str | None:
    best, best_size = None, -1.0
    for candidate in srcset.split(","):
        parts = candidate.split()
        if not parts:
            continue
        try:
            size = float(parts[1][:-1]) if len(parts) > 1 else 1.0
        except ValueError:
            size = 1.0
        if size > best_size:
            best, best_size = parts[0], size
    return best


def resolve_lazy_images(tree) -> None:
    for img in tree.iter("img"):
        lazy = next((value for value in map(img.get, LAZY_SOURCES) if value and not value.startswith("data:")), None)
        src = img.get("src") or ""
        if not lazy and (not src or src.startswith("data:")):
            srcset = img.get("data-srcset") or img.get("srcset")
            parent = img.getparent()
            if not srcset and parent is not None and parent.tag == "picture":
                srcset = next((s.get("srcset") for s in parent.iter("source") if s.get("srcset")), None)
            lazy = _largest_source(srcset) if srcset else None
        if lazy:
            img.set("src", lazy)


def _alone(element) -> bool:
    """The element is the only content of its block, so its formula is a display equation."""
    parent = element.getparent()
    if parent is None:
        return False
    others = (parent.text or "") + "".join((c.tail or "") + ("" if c is element else c.text_content()) for c in parent)
    return not others.strip()


def _mediawiki_tex(math) -> str:
    """Wikipedia's current pages keep a formula's TeX only in data-mw: {"name": "math", "body": {"extsrc": "…"}}."""
    try:
        data = json.loads(math.get("data-mw") or "{}")
        source = data["body"]["extsrc"] if data.get("name") == "math" else ""
    except (ValueError, AttributeError, KeyError, TypeError):
        return ""
    return source if isinstance(source, str) else ""


def _math_tex(math) -> str:
    tex = math.xpath('.//annotation[@encoding="application/x-tex"]/text()')
    tex = (tex[0] if tex else math.get("alttext") or _mediawiki_tex(math)).strip()
    wrapped = re.fullmatch(r"\{\\(?:displaystyle|textstyle)\s*(.*)\}", tex, re.S)
    return (wrapped[1] if wrapped else tex).strip()


def _put_formula(element, tex: str, display: bool) -> None:
    from lxml import etree

    # data-formula: Markdown written straight from the page (feishu_article) must not escape the TeX
    replacement = etree.Element("span", {"data-formula": ""})
    # The extractor reads \( \) and \[ \] as math and leaves their LaTeX unescaped; inline ones stay on one line.
    tex = " ".join(tex.split())
    replacement.text = f" \\[{tex}\\] " if display else f"\\({tex}\\)"
    replacement.tail = element.tail
    element.getparent().replace(element, replacement)


def _equation_table(table) -> bool:
    """LaTeXML-style numbered equations: a table whose rows hold only display math and an equation number."""
    rows = []
    for row in table.iter("tr"):
        maths = row.xpath(".//math")
        if not maths:
            continue
        rest = "".join(t for cell in row.iter("td", "th") if not cell.xpath(".//math") for t in cell.itertext()).strip()
        if any(m.get("display") != "block" for m in maths) or (rest and not EQUATION_NUMBER.fullmatch(rest)):
            return False
        number = EQUATION_NUMBER.fullmatch(rest)[1] if rest else ""
        tex = " ".join(_math_tex(m) for m in maths)
        rows.append(tex + (f" \\tag{{{number}}}" if number else ""))
    if not rows:
        return False
    from lxml import etree

    block = etree.Element("div")
    for tex in rows:
        _put_formula(etree.SubElement(etree.SubElement(block, "p"), "span"), tex, True)
    block.tail = table.tail
    table.getparent().replace(table, block)
    return True


def _convert_dollars(text: str | None, single: bool) -> str | None:
    if not text or "$" not in text:
        return text
    text = DISPLAY_DOLLARS.sub(lambda m: f" \\[{' '.join(m[1].split())}\\] ", text)
    if single:
        text = INLINE_DOLLARS.sub(lambda m: f"\\({m[1]}\\)", text)
    return text


def drop_rendered_math(tree) -> None:
    """A page from the user's browser (app/clippings.py) arrives after its math renderer ran.

    MathJax 2 keeps each formula's TeX in <script type="math/tex" id="MathJax-Element-N"> next to its rendered copy
    (id "MathJax-Element-N-Frame", display ones inside a wrapper, after an empty preview): drop the copy, or the formula
    comes out twice. MathJax 3 keeps no TeX in the page; the extension writes it to data-bloom-tex on each container.
    """
    frames = {element.get("id"): element for element in tree.xpath('//*[starts-with(@id, "MathJax-Element-")]')}
    for script in tree.xpath('//script[starts-with(@type, "math/tex")][starts-with(@id, "MathJax-Element-")]'):
        frame = frames.get(script.get("id") + "-Frame")
        if frame is None or frame.getparent() is None:
            continue
        parent = frame.getparent()
        target = parent if RENDERED_DISPLAY.search(parent.get("class") or "") else frame
        preview = target.getprevious()
        if preview is not None and "MathJax_Preview" in (preview.get("class") or ""):
            _drop(preview)
        _drop(target)
    for element in tree.xpath("//*[@data-bloom-tex]"):
        if element.getparent() is not None:
            _put_formula(element, element.get("data-bloom-tex"), element.get("data-bloom-display") == "block")


def convert_math(tree) -> None:
    """Every formula becomes \\( \\) or \\[ \\] TeX; a leftover $ is escaped so the reader never takes prose for math."""
    drop_rendered_math(tree)
    for table in tree.xpath("//table[.//math]"):
        _equation_table(table)
    root = tree.getroottree().getroot()
    for math in tree.xpath("//math"):
        if math.getroottree().getroot() is not root:
            continue  # inside a wrapper that an earlier formula already replaced
        tex = _math_tex(math)
        target, node = math, math.getparent()
        for _ in range(5):
            if node is None:
                break
            if node.tag in {"mjx-container", "mjx-assistive-mml"} or MATH_WRAPPER.search(node.get("class") or ""):
                target = node
            node = node.getparent()
        if target.getparent() is None:
            continue
        display = (math.get("display") == "block" or math.get("mode") == "display" or target.get("display") == "true"
                   or bool(re.search(r"display|block", target.get("class") or "")))
        if tex:
            _put_formula(target, tex, display)
        else:
            from lxml import etree

            text = etree.Element("span")
            text.text, text.tail = "".join(math.itertext()).strip(), target.tail
            target.getparent().replace(target, text)
    for script in tree.xpath('//script[starts-with(@type, "math/tex")]'):
        _put_formula(script, script.text or "", "mode=display" in script.get("type"))
    for img in tree.xpath("//img[@src]"):
        try:
            parts = urlsplit(img.get("src"))
        except ValueError:
            continue
        read = FORMULA_IMAGES.get(parts.hostname or "")
        tex = (read(parts) or "").strip() if read else ""
        if tex:
            _put_formula(img, tex, _alone(img))
    # Pages that load a math renderer write raw TeX in the text; $...$ only when the page turned it on.
    scripts = tree.xpath("//script")
    sources = " ".join(s.get("src") or "" for s in scripts).lower()
    code = " ".join(s.text or "" for s in scripts)
    single = bool(SINGLE_DOLLAR_CONFIG.search(code))
    renderer = single or "mathjax" in sources or "katex" in sources or "MathJax" in code or "renderMathInElement" in code

    def walk(element, skip: bool) -> None:
        if not isinstance(element.tag, str):
            return
        skip = skip or element.tag in CODE_TAGS
        if not skip:
            element.text = _escape_dollars(_convert_dollars(element.text, single) if renderer else element.text)
        for child in element:
            walk(child, skip)
            if not skip:
                child.tail = _escape_dollars(_convert_dollars(child.tail, single) if renderer else child.tail)

    walk(tree, False)


def _escape_dollars(text: str | None) -> str | None:
    return re.sub(r"(?<!\\)\$", r"\\$", text) if text and "$" in text else text


def drop_furniture(tree) -> None:
    for element in tree.xpath(FURNITURE):
        _drop(element)
    for heading in tree.xpath(HEADINGS):
        for link in heading.iter("a"):
            if link.text_content().strip() in PERMALINK_TEXT and not link.xpath(".//img"):
                _drop(link)
        # Template whitespace inside a heading would turn the Markdown heading into an empty line and an indented block.
        for node in heading.iter():
            if node.text:
                node.text = re.sub(r"\s+", " ", node.text)
            if node is not heading and node.tail:
                node.tail = re.sub(r"\s+", " ", node.tail)
        heading.text = (heading.text or "").lstrip()
    # Pandoc/Quarto put an anchor on every code line; the extractor reads that as a link list and drops the block.
    for link in tree.xpath("//pre//a"):
        link.drop_tag()
    # Highlighters lay code out as a table of a gutter and one <pre>; keep just the <pre>.
    for table in tree.xpath("//table[count(.//pre) = 1]"):
        pre = table.xpath(".//pre")[0]
        if not "".join(t for t in table.itertext() if t not in pre.itertext()).strip():
            pre.tail = table.tail
            table.getparent().replace(table, pre)


def parse_html(html: bytes):
    from lxml import etree
    from lxml.html import HTMLParser, document_fromstring
    from trafilatura.utils import decode_file

    try:
        return document_fromstring(decode_file(html), parser=HTMLParser(no_network=True, remove_comments=True))
    except (etree.ParserError, ValueError):
        raise FetchFailed("Invalid HTML") from None


def prepare_tree(tree, url: str | None) -> None:
    """Clean a page for extraction. Without a URL (an uploaded file) relative image paths stay for the caller."""
    resolve_lazy_images(tree)
    if url:
        # Resolve against the actual page directory and its <base>, before the extractor
        # rewrites relative links against the site root.
        tree.make_links_absolute(url, resolve_base_href=True)
    for element in tree.xpath("//a[@href] | //img[@src]"):
        attr = "src" if element.tag == "img" else "href"
        try:
            scheme = urlsplit(element.get(attr, "")).scheme
        except ValueError:
            scheme = "invalid"
        if scheme not in {"http", "https", "mailto"} and not (url is None and attr == "src" and scheme == ""):
            element.attrib.pop(attr, None)
    if url and urlsplit(url).hostname == "mp.weixin.qq.com":
        prepare_wechat(tree)
    if url and urlsplit(url).hostname in X_HOSTS:
        prepare_x(tree)
    drop_furniture(tree)
    convert_math(tree)
    # A link without a usable address keeps its words, not its brackets ("[Terminal Bench 2.0]")
    for link in tree.xpath("//a[not(@href)]"):
        link.drop_tag()
    # Tailwind writes layout as class names with brackets and colons (sm:w-[calc(…var(--x-sidebar-wide)…)]). The extractor
    # reads words inside class names as boilerplate ("sidebar", "nav") and drops what they wrap: on X that was the whole
    # article, so it fell back to a reader that keeps no links. Such names never say what an element is.
    for element in tree.xpath("//*[@class]"):
        names = element.get("class")
        if TAILWIND_LAYOUT.search(names):
            element.set("class", " ".join(name for name in names.split() if not TAILWIND_LAYOUT.search(name)))


def _plain(text: str) -> str:
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text).replace("\\", "")
    return " ".join(text.split()).casefold()


def tree_markdown(tree, url: str | None) -> tuple[str, str]:
    from trafilatura import extract_with_metadata

    doc = extract_with_metadata(tree, url=url, output_format="markdown", include_comments=False,
                                include_tables=True, include_images=True, include_links=True,
                                include_formatting=True)
    content = (doc.text or "").replace(IMAGE_EXTENSION_MARKER, "").strip() if doc else ""
    # extract_with_metadata emits YAML front matter; metadata belongs in the UI, not the lesson.
    content = re.sub(r"\A---\n.*?\n---(?:\n|$)", "", content, count=1, flags=re.S).strip()
    title = re.sub(r"\s+", " ", ((doc.title or "") if doc else "").replace("\x00", "")).strip()
    # The reader shows the title above the article; drop the article's own copy of it. Page titles often
    # add the site name ("Article - Wikipedia", "Article_CSDN博客"): then the heading is the better title.
    first = re.match(r"#{1,6} +(.+?) *(?:\n|$)", content)
    if title and first:
        heading, whole = _plain(first[1]), _plain(title)
        if heading == whole or (heading and whole.startswith(heading)
                                and re.match(r"\s*[-|_–—·:：]", whole[len(heading):])):
            title = re.sub(r"\\([^\w\s])", r"\1", re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", first[1])).strip()
            content = content[first.end():].lstrip()
    return title, content


def x_article(title: str, content: str) -> tuple[str, str]:
    """An X post or article: the post itself as the title, without "Ada on X: … / X"; the author line above it goes."""
    match = X_PAGE_TITLE.search(title)
    title = (match[1] if match else re.sub(r"\s*/\s*X\s*$", "", title)).strip() or title
    if len(title) > 100:
        title = title[:99].rstrip() + "…"
    # Logged in, X shows the article title as a plain line under the author's avatar and name: drop that header
    blocks = content.split("\n\n")
    for index, block in enumerate(blocks[:6]):
        if _plain(re.sub(r"^#{1,6} +", "", block.strip())) == _plain(title):
            content = "\n\n".join(blocks[index + 1:]).lstrip()
            break
    return title, content


def extract_article(html: bytes, url: str, *, via_reader: bool = False, rendered: bool = False) -> WebPreview:
    tree = parse_html(html)
    if rendered:
        # The browser ran the page's scripts, so <noscript> never showed. Kept, its "JavaScript is not available" (X, many
        # single-page apps) becomes the article's title and first line.
        for element in tree.xpath("//noscript"):
            _drop(element)
    prepare_tree(tree, url)
    title, content = feishu_article(tree) or tree_markdown(tree, url)
    if urlsplit(url).hostname in X_HOSTS:
        title, content = x_article(title, content)
    return checked_article(title, content, url, via_reader=via_reader)


def checked_article(title: str, content: str, url: str, *, via_reader: bool = False) -> WebPreview:
    title = re.sub(r"\s+", " ", title.replace("\x00", "")).strip()
    content = content.strip()
    # Error/challenge pages can contain plenty of prose; length alone is insufficient.
    blocked = re.search(r"just a moment|access denied|verify you are human|captcha|checking your browser|"
                        r"安全验证|访问受限|验证身份|请完成验证", title, re.I)
    if len(content) < 100 or blocked:
        raise FetchFailed("No readable article")
    if len(content) > MAX_CHARS:
        raise HTTPException(422, "正文过长，请保存为 Markdown 文件后使用「项目文件」导入")
    # The final reader shows raw HTML as text and rejects unsafe Markdown protocols; the extractor
    # still writes <sup>, <sub> and <u>, and Reader responses may carry any tag.
    from app.document_import import markdown_without_html

    content = markdown_without_html(content.replace("\x00", ""))
    return WebPreview(title=(title or urlsplit(url).hostname)[:200], url=url, content=content,
                      characters=len(content), via_reader=via_reader)


def preview_article(raw_url: str) -> WebPreview:
    url = normalize_url(raw_url)
    # Validate even when using an external renderer. Private targets must never reach it.
    parts = urlsplit(url)
    try:
        public_address(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
        html, url = fetch_html(url, time.monotonic() + 20)
        return extract_article(html, url)
    except FetchFailed:
        pass
    try:
        # Free anonymous Reader only: no key, paid model, cookies, or user credentials.
        parts = urlsplit(url)
        public_address(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
        raw, _ = fetch_html("https://r.jina.ai/" + url, time.monotonic() + 25, reader=True)
        data = json.loads(raw)["data"]
        if not isinstance(data, dict) or not isinstance(data.get("content"), str) or not isinstance(data.get("title"), str):
            raise FetchFailed("Invalid Reader response")
        returned_url = data.get("url") or url
        if not isinstance(returned_url, str):
            raise FetchFailed("Invalid Reader URL")
        final_url = normalize_url(returned_url)
        final = urlsplit(final_url)
        public_address(final.hostname, final.port or (443 if final.scheme == "https" else 80))
        return checked_article(data["title"], data["content"], final_url, via_reader=True)
    except (FetchFailed, ValueError, KeyError, TypeError):
        raise HTTPException(422, "没能提取这篇网页的正文：可能要登录、有访问限制，或正文还没加载出来") from None


def extract_page(html: str, raw_url: str) -> WebPreview:
    """A page the user's own browser already loaded (the clipping extension): no fetch, the same extraction."""
    url = normalize_url(raw_url, any_port=True)
    data = html.encode("utf-8", "replace")
    if len(data) > MAX_BYTES:
        raise HTTPException(422, "网页太大，请复制正文并保存为 Markdown 后上传")
    try:
        return extract_article(data, url, rendered=True)
    except FetchFailed:
        raise HTTPException(422, "没有提取到正文：页面可能还没加载完、停在安全验证，或者要登录后才显示正文。等页面显示出正文后再点一次") from None


def _same_page(a: str, b: str) -> bool:
    pa, pb = urlsplit(a), urlsplit(b)
    return ((pa.hostname or "").removeprefix("www.") == (pb.hostname or "").removeprefix("www.")
            and pa.path.rstrip("/") == pb.path.rstrip("/"))


def clip_article(html: str, raw_url: str) -> WebPreview:
    """A clipped page comes out the way 网页原文 imports it: when the server reads the same address by itself, that article
    is the clip. A logged-in browser often lays a page out differently (X loses links and bold) and scripts add bits the
    article never had. The browser's copy is kept for what the server can't read (403 to bots, login, pages built by
    scripts, intranet) or reads clearly less of (a paywall teaser)."""
    url = normalize_url(raw_url, any_port=True)
    page = error = None
    try:
        page = extract_page(html, url)
    except HTTPException as exc:
        error = exc
    try:
        data, final = fetch_html(url, time.monotonic() + CLIP_FETCH_SECONDS)
        # Redirected elsewhere (a login or consent page) is not the page the user clipped
        served = extract_article(data, final) if _same_page(url, final) else None
    except (FetchFailed, HTTPException):
        served = None
    if served and (page is None or served.characters >= CLIP_SERVED_SHARE * page.characters):
        return served.model_copy(update={"url": url})
    if page is None:
        raise error
    return page


@contextmanager
def extraction_slot(user_uuid: str):
    # Per-instance bounds protect parser memory; authenticated users get 6 attempts/minute.
    now = time.monotonic()
    with _lock:
        recent = [stamp for stamp in _requests.pop(user_uuid, []) if now - stamp < 60]
        _requests[user_uuid] = recent
        while len(_requests) > 4096:
            _requests.popitem(last=False)
        if len(recent) >= 6:
            raise HTTPException(429, "提取太频繁，请一分钟后再试")
        recent.append(now)
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, "正在处理较多网页，请稍后再试")
    try:
        yield
    finally:
        _slots.release()


@router.post("/preview", response_model=WebPreview)
def preview(request: WebPreviewRequest, user: User = Depends(get_current_user)):
    with extraction_slot(user.uuid):
        return preview_article(request.url)
