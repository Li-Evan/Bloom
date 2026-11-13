import time
import socket
import threading
import http.client
import json
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app import web_import as web
from app.models import Course, Lesson, Syllabus
from tests.conftest import TestSession, bearer, create_user


PARAGRAPH = "这是一篇关于学习的文章，保留原文内容才能在阅读时提出准确的问题。" * 8
HTML = f'''<html><head><meta charset="utf-8"><title>网页原文</title></head><body>
<nav><a href="/">首页</a>导航广告</nav><article><h1>网页原文</h1><p>{PARAGRAPH}</p>
<h2>代码示例</h2><pre><code>print("hello")\nx = 2</code></pre>
<img src="/photo.png" alt="示例图片"><p>关于这个概念，可以通过<a href="/reference">进一步阅读</a>查看完整的说明和更多详细的例子。</p>
<table><tr><th>项目</th><th>值</th></tr><tr><td>正文</td><td>一</td></tr></table>
</article><footer>无关页脚</footer></body></html>'''.encode()


@pytest.fixture(autouse=True)
def clear_rate_limit():
    web._requests.clear()


def test_extract_preserves_article_structure_and_resolves_urls():
    article = web.extract_article(HTML, "https://example.com/article")
    assert article.title == "网页原文"
    assert PARAGRAPH in article.content
    assert '```\nprint("hello")\nx = 2\n```' in article.content
    assert "## 代码示例" in article.content
    assert "![示例图片](https://example.com/photo.png)" in article.content
    assert "https://example.com/reference" in article.content
    assert "| 项目 | 值 |" in article.content
    assert "导航广告" not in article.content
    assert "无关页脚" not in article.content
    assert "fingerprint:" not in article.content
    assert not article.content.startswith("# 网页原文")


WECHAT_IMAGE = "https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg"
EXTENSIONLESS_HTML = HTML.replace(b'<img src="/photo.png" alt="\xe7\xa4\xba\xe4\xbe\x8b\xe5\x9b\xbe\xe7\x89\x87">',
                                  f'<img src="data:image/svg+xml,x" data-src="{WECHAT_IMAGE}" alt="pic">'.encode())


def test_wechat_images_without_file_extension_survive():
    article = web.extract_article(EXTENSIONLESS_HTML, "https://mp.weixin.qq.com/s/abc")
    assert f"![pic]({WECHAT_IMAGE})" in article.content


def wechat_page(body: str) -> bytes:
    return f'''<html><head><meta charset="utf-8"><title>公众号文章</title></head><body>
<div id="js_content" style="visibility: hidden; opacity: 0;">{body}</div></body></html>'''.encode()


def test_wechat_section_layout_keeps_text_images_and_order():
    # Real editor markup: nested <section>s and no <p>; image wrappers carry overflow: hidden.
    second = "https://mmbiz.qpic.cn/mmbiz_png/def/640?wx_fmt=png"
    article = web.extract_article(wechat_page(f'''<section><section style="text-align: center;">
<section style="display: inline-block; overflow: hidden !important;"><img data-src="{WECHAT_IMAGE}"></section></section>
<section><span>{PARAGRAPH}</span></section><section><section style="overflow: hidden;"><img data-src="{second}"></section></section>
<section><strong>结尾段落也要保留下来。</strong></section></section>'''), "https://mp.weixin.qq.com/s/abc")
    content = article.content
    assert content.index(WECHAT_IMAGE) < content.index(PARAGRAPH) < content.index(second) < content.index("结尾段落")
    assert web.IMAGE_EXTENSION_MARKER not in content


def test_wechat_really_hidden_content_stays_out():
    html = wechat_page(f'<section><p>{PARAGRAPH}</p><section style="display: none; overflow: hidden;">隐藏的内容</section></section>')
    assert "隐藏的内容" not in web.extract_article(html, "https://mp.weixin.qq.com/s/abc").content


def test_other_sites_keep_the_extractor_image_filter():
    # Elsewhere an extensionless <img> is usually a formula or a pixel, not part of the article.
    assert "qpic.cn" not in web.extract_article(EXTENSIONLESS_HTML, "https://example.com/a").content


def test_utf8_article_without_charset_meta_is_not_mojibake():
    article = web.extract_article(HTML.replace(b'<meta charset="utf-8">', b''), "https://example.com/")
    assert article.title == "网页原文"
    assert PARAGRAPH in article.content


def test_web_component_comments_are_not_imported_as_title_text():
    html = HTML.replace(b"<h2>", b"<h2><!--lit-node 1-->")
    article = web.extract_article(html, "https://example.com/")
    assert "lit-node" not in article.content
    assert "## 代码示例" in article.content


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com", "https://u:p@example.com", "https://example.com:8000",
                                    "https://example.com\\@127.0.0.1", "https://example.com/\r\nHost:localhost"])
def test_rejects_invalid_urls(url):
    with pytest.raises(HTTPException) as error:
        web.normalize_url(url)
    assert error.value.status_code == 400


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "0.0.0.0", "224.0.0.1"])
def test_rejects_private_dns_and_mixed_answers(monkeypatch, ip):
    monkeypatch.setattr(web.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443)), (2, 1, 6, "", (ip, 443))])
    with pytest.raises(HTTPException):
        web.public_address("example.com", 443)


def test_connection_pins_checked_ip_and_preserves_tls_hostname(monkeypatch):
    connect = Mock(return_value=Mock())
    context = Mock()
    monkeypatch.setattr(web.socket, "create_connection", connect)
    monkeypatch.setattr(web.ssl, "create_default_context", lambda: context)
    connection = web.PublicConnection("example.com", 443, "93.184.216.34", True, 5)
    connection.connect()
    connect.assert_called_once_with(("93.184.216.34", 443), 5)
    context.wrap_socket.assert_called_once_with(connect.return_value, server_hostname="example.com")


def mock_connection(monkeypatch, *, status=200, headers=None, chunks=None):
    response = Mock(status=status)
    response.length = None
    response.getheader.side_effect = lambda key, default=None: (headers or {"Content-Type": "text/html"}).get(key, default)
    response.read1.side_effect = chunks or [HTML, b""]
    connection = Mock()
    connection.getresponse.return_value = response
    monkeypatch.setattr(web, "PublicConnection", Mock(return_value=connection))
    return connection


def test_revalidates_redirects_and_never_falls_back_for_private_targets(monkeypatch):
    monkeypatch.setattr(web, "public_address", Mock(side_effect=["93.184.216.34", "93.184.216.34", HTTPException(400, "private")]))
    connection = mock_connection(monkeypatch, status=302, headers={"Location": "http://127.0.0.1/"})
    with pytest.raises(HTTPException):
        web.preview_article("https://example.com")
    assert connection.request.call_count == 1


def test_rejects_oversized_response_and_closes_connection(monkeypatch):
    monkeypatch.setattr(web, "public_address", lambda *args: "93.184.216.34")
    monkeypatch.setattr(web, "MAX_BYTES", 20)
    connection = mock_connection(monkeypatch, chunks=[b"a" * 21])
    with pytest.raises(HTTPException) as error:
        web.fetch_html("https://example.com", time.monotonic() + 10)
    assert error.value.status_code == 422
    connection.close.assert_called_once()


def test_plain_fetch_and_free_reader_fallback(monkeypatch):
    monkeypatch.setattr(web, "public_address", lambda *args: "93.184.216.34")
    payload = json.dumps({"data": {"title": "网页原文", "url": "https://example.com/", "content": PARAGRAPH}}).encode()
    fetch = Mock(side_effect=[web.FetchFailed(), (payload, "https://r.jina.ai/https://example.com/")])
    monkeypatch.setattr(web, "fetch_html", fetch)
    article = web.preview_article("https://example.com")
    assert article.via_reader
    assert fetch.call_args.args[0] == "https://r.jina.ai/https://example.com/"
    assert fetch.call_args.kwargs == {"reader": True}
    assert article.url == "https://example.com/"


def test_failed_fetch_does_not_create_empty_lesson(monkeypatch):
    monkeypatch.setattr(web, "public_address", lambda *args: "93.184.216.34")
    monkeypatch.setattr(web, "fetch_html", Mock(side_effect=web.FetchFailed()))
    with pytest.raises(HTTPException) as error:
        web.preview_article("https://example.com")
    assert error.value.status_code == 422


@pytest.mark.parametrize("payload", [b"not json", b'{"data":null}', b'{"data":{"content":42,"title":"x"}}'])
def test_invalid_reader_payload_is_a_clear_failure(monkeypatch, payload):
    monkeypatch.setattr(web, "public_address", lambda *args: "93.184.216.34")
    monkeypatch.setattr(web, "fetch_html", Mock(side_effect=[web.FetchFailed(), (payload, "https://r.jina.ai/")]))
    with pytest.raises(HTTPException) as error:
        web.preview_article("https://example.com")
    assert error.value.status_code == 422


@pytest.mark.parametrize("html", [b"<html><title>Login</title><p>Sign in</p></html>", HTML.replace("网页原文".encode(), b"Just a moment")])
def test_rejects_empty_or_challenge_pages(html):
    with pytest.raises(web.FetchFailed):
        web.extract_article(html, "https://example.com")


def test_preview_requires_auth_and_saves_nothing_by_itself(client, monkeypatch):
    assert client.post("/api/web-import/preview", json={"url": "https://example.com"}).status_code == 401
    user = create_user("web-import@bloom.test")
    monkeypatch.setattr(web, "preview_article", lambda url: web.extract_article(HTML, url))
    result = client.post("/api/web-import/preview", headers=bearer(user), json={"url": "https://example.com"})
    assert result.status_code == 200
    with TestSession() as db:
        assert db.query(Course).count() == 0
    # Saving the same preview uses the existing project import and preserves its text.
    saved = client.post("/api/courses/from-project", headers=bearer(user), data={"name": result.json()["title"]},
                        files=[("files", ("article.md", result.json()["content"].encode(), "text/markdown"))])
    assert saved.status_code == 200
    with TestSession() as db:
        assert db.query(Lesson).one().content == result.json()["content"]
        assert db.query(Syllabus).count() == 0


def test_authenticated_rate_limit(client, monkeypatch):
    user = create_user("web-rate@bloom.test")
    monkeypatch.setattr(web, "preview_article", lambda url: web.extract_article(HTML, url))
    statuses = [client.post("/api/web-import/preview", headers=bearer(user), json={"url": "https://example.com"}).status_code for _ in range(7)]
    assert statuses == [200] * 6 + [429]


@pytest.mark.parametrize("base,expected", [("", "https://example.com/posts/details"),
    ('<base href="https://cdn.example.com/docs/">', "https://cdn.example.com/docs/details")])
def test_relative_links_respect_directory_and_html_base(base, expected):
    html = HTML.replace(b"<title>", (base + "<title>").encode()).replace(b'href="/reference"', b'href="details"')
    assert expected in web.extract_article(html, "https://example.com/posts/article").content


def test_mathml_text_and_latex_annotation_survive():
    html = HTML.replace(b"</article>", ('<p>公式是 <math><mi>x</mi><mo>=</mo><mn>2</mn></math>，这是一个例子。</p>'
        '<p>另一个公式 <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>也应该保留。</p></article>').encode())
    article = web.extract_article(html, "https://example.com/posts/article")
    assert "x=2" in article.content
    assert "$x^2$" in article.content


def article_with(snippet: str, head: str = "", url: str = "https://example.com/posts/article") -> str:
    html = HTML.replace(b"</article>", f"{snippet}</article>".encode()).replace(b"</head>", f"{head}</head>".encode())
    return web.extract_article(html, url).content


def test_wikipedia_formulas_come_from_their_hidden_mathml():
    content = article_with(
        '<p>损失函数为 <span class="mwe-math-element mwe-math-element-block"><span class="mwe-math-mathml-a11y" '
        'style="display: none;"><math display="block" alttext="{\\displaystyle L=-\\sum _{t}\\ln p_{t}}"><mi>L</mi></math>'
        '</span><img class="mwe-math-fallback-image-display" src="https://wikimedia.org/api/rest_v1/media/math/render/svg/x"></span>'
        '，再看行内 <span class="mwe-math-element"><span class="mwe-math-mathml-a11y" style="display: none;">'
        '<math alttext="{\\displaystyle d_{k}}"><mi>d</mi></math></span></span> 的作用。</p>')
    assert "$$\nL=-\\sum _{t}\\ln p_{t}\n$$" in content
    assert "行内 $d_{k}$ 的作用" in content
    assert "displaystyle" not in content and "render/svg" not in content


def test_wikipedia_formulas_without_alttext_come_from_data_mw():
    # Wikipedia since late 2026: no alttext, no annotation, no fallback image; the TeX is only in data-mw
    content = article_with(
        '<p>注意力定义为<math class="mwe-math-element mwe-math-element-block" display="block" '
        'data-mw=\'{"name":"math","attrs":{"display":"block"},"body":{"extsrc":"\\\\text{softmax}\\\\left(\\\\frac{QK^T}{\\\\sqrt{d_k}}\\\\right)V"}}\'>'
        '<mtext>softmax</mtext><mi>Q</mi></math>其中 <math class="mwe-math-element mwe-math-element-inline" '
        'data-mw=\'{"name":"math","attrs":{},"body":{"extsrc":"d_k"}}\'><msub><mi>d</mi><mi>k</mi></msub></math> 是维度，'
        '坏掉的 <math class="mwe-math-element" data-mw=\'{"name":"math","body":"x"}\'><mi>y</mi></math> 留下文字。</p>')
    assert "$$\n\\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V\n$$" in content
    assert "其中 $d_k$ 是维度" in content
    assert "坏掉的 y 留下文字" in content
    assert "softmaxQ" not in content


def test_rendered_katex_keeps_only_the_tex():
    content = article_with(
        '<p>注意力 <span class="katex"><span class="katex-mathml"><math><semantics><mi>Q</mi>'
        '<annotation encoding="application/x-tex">QK^T</annotation></semantics></math></span>'
        '<span class="katex-html" aria-hidden="true">QKT重复的渲染</span></span> 结束。</p>')
    assert "注意力 $QK^T$ 结束" in content and "重复的渲染" not in content


def test_numbered_equation_tables_become_display_math():
    content = article_with(
        '<table class="ltx_equation"><tr><td></td><td><math display="block" alttext="a=b">'
        '<annotation encoding="application/x-tex">a=b_{1}</annotation></math></td><td><span>(1)</span></td></tr></table>'
        '<table><tr><th>指标</th><th>值</th></tr><tr><td><math alttext="x"><mi>x</mi></math></td><td>0.5</td></tr></table>')
    assert "$$\na=b_{1} \\tag{1}\n$$" in content
    assert "| $x$ | 0.5 |" in content  # an ordinary data table with formulas stays a table


@pytest.mark.parametrize("src, tex", [
    ("https://latex.csdn.net/eq?w%5ET%20x%2Bb", "w^T x+b"),
    ("https://www.zhihu.com/equation?tex=%5Cfrac%7B1%7D%7B2%7D", r"\frac{1}{2}"),
    ("https://latex.codecogs.com/svg.image?%5Cdpi%7B110%7D&space;x^2&plus;1", "x^2+1"),
])
def test_formula_images_become_tex(src, tex):
    assert f"公式 ${tex}$ 在这里" in article_with(f'<p>公式 <img src="{src}" alt="{tex}"> 在这里，后面还有更多文字说明。</p>')


def test_raw_tex_is_math_only_where_the_page_renders_it():
    snippet = "<p>参数 $f_{t-1}(x)$ 与 $$\\sum_i x_i$$，价格 $5 和 $10。</p><pre><code>echo $HOME</code></pre>"
    config = "<script>MathJax = {tex: {inlineMath: [['$', '$'], ['\\\\(', '\\\\)']]}};</script>"
    rendered = article_with(snippet, config)
    assert "参数 $f_{t-1}(x)$ 与" in rendered and "$$\n\\sum_i x_i\n$$" in rendered
    assert "价格 \\$5 和 \\$10" in rendered and "echo $HOME" in rendered
    plain = article_with(snippet)
    assert "参数 \\$f\\_{t-1}(x)\\$" in plain and "echo $HOME" in plain


def test_page_furniture_is_removed():
    content = article_with(
        '<h2>第二节 <a class="headerlink" href="#s2">¶</a><span class="mw-editsection">[<a href="/edit">编辑</a>]</span></h2>'
        '<p>第二节的正文内容，说明这一节讲什么，需要足够长才能保留下来。</p>'
        '<figure class="highlight"><table><tr><td class="gutter"><pre>1\n2</pre></td>'
        '<td class="code"><pre>a = 1\nb = 2</pre></td></tr></table></figure>'
        '<div class="sourceCode"><pre><code><span><a href="#cb1-1" aria-hidden="true"></a>print(1)</span></code></pre>'
        '<button>复制代码</button></div>')
    assert "## 第二节\n" in content and "¶" not in content and "编辑" not in content
    assert "```\na = 1\nb = 2\n```" in content and "1\n2" not in content
    assert "print(1)" in content and "复制代码" not in content


def test_title_heading_with_template_whitespace_is_dropped():
    html = HTML.replace(b"<h1>\xe7\xbd\x91\xe9\xa1\xb5\xe5\x8e\x9f\xe6\x96\x87</h1>",
                        '<h1>\n    \n    <a href="/p">网页原文</a>\n    </h1>'.encode())
    content = web.extract_article(html, "https://example.com/").content
    assert not content.startswith("#") and PARAGRAPH in content


def test_site_name_in_the_page_title_gives_way_to_the_article_heading():
    html = HTML.replace(b"<title>\xe7\xbd\x91\xe9\xa1\xb5\xe5\x8e\x9f\xe6\x96\x87</title>",
                        "<title>网页原文 - 某某博客</title>".encode())
    article = web.extract_article(html, "https://example.com/")
    assert article.title == "网页原文" and not article.content.startswith("#")


@pytest.mark.parametrize("attributes", [
    'src="data:image/gif;base64,R0lGOD" data-actualsrc="https://pic.example.com/real.png"',
    'srcset="https://pic.example.com/small.png 320w, https://pic.example.com/real.png 1280w"',
])
def test_lazy_images_use_the_real_address(attributes):
    assert "https://pic.example.com/real.png" in article_with(f'<p><img {attributes} alt="图"></p>')


def test_total_deadline_interrupts_trickling_response_headers(monkeypatch):
    client_socket, server_socket = socket.socketpair()
    connection = http.client.HTTPConnection("example.com", timeout=1)
    connection.connect = lambda: setattr(connection, "sock", client_socket)
    monkeypatch.setattr(web, "PublicConnection", lambda *args: connection)
    monkeypatch.setattr(web, "public_address", lambda *args: "93.184.216.34")

    def trickle():
        try:
            server_socket.recv(4096)
            for char in b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n":
                server_socket.send(bytes([char]))
                time.sleep(0.02)
        except OSError:
            pass
        finally:
            server_socket.close()

    worker = threading.Thread(target=trickle, daemon=True)
    worker.start()
    start = time.monotonic()
    with pytest.raises(web.FetchFailed):
        web.fetch_html("https://example.com", start + 0.15)
    assert time.monotonic() - start < 0.6
    worker.join(timeout=1)


@pytest.mark.parametrize("stall", [True, False])
def test_incomplete_body_is_never_returned_as_a_complete_article(monkeypatch, stall):
    client_socket, server_socket = socket.socketpair()
    connection = http.client.HTTPConnection("example.com", timeout=1)
    connection.connect = lambda: setattr(connection, "sock", client_socket)
    monkeypatch.setattr(web, "PublicConnection", lambda *args: connection)
    monkeypatch.setattr(web, "public_address", lambda *args: "93.184.216.34")

    def partial_body():
        try:
            server_socket.recv(4096)
            server_socket.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2000\r\nConnection: close\r\n\r\n" + b"a" * 500)
            if stall:
                time.sleep(0.3)
        finally:
            server_socket.close()

    worker = threading.Thread(target=partial_body, daemon=True)
    worker.start()
    with pytest.raises(web.FetchFailed):
        web.fetch_html("https://example.com", time.monotonic() + 0.15)
    worker.join(timeout=1)
