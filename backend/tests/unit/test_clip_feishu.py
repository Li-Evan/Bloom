"""剪藏飞书 / Lark 文档：只要标题和正文，不要左侧目录树和界面；按块类型写成标题、段落、列表、代码、引用；去掉零宽空格。"""
from app import web_import

ZW = "​"


def line(*spans):
    return f'<div class="ace-line" data-node="true">{"".join(spans)}<span data-string="true">{ZW}</span></div>'


def s(text, style=""):
    return f'<span data-string="true" style="{style}">{text}</span>'


def block(kind, record, inner, children=""):
    kids = f'<div class="render-unit-wrapper">{children}</div>' if children else ""
    return (f'<div class="block docx-{kind}-block" data-block-type="{kind}" data-block-id="{record}" data-record-id="r{record}">'
            f'<div class="docx-block-zero-space"><span data-zero-space="true">{ZW}</span></div>'
            f'<div class="zone-container text-editor">{inner}</div>{kids}</div>')


def text(record, *spans, children=""):
    return block("text", record, line(*spans), children)


def heading(level, record, order, words):
    return (f'<div class="block docx-heading{level}-block" data-block-type="heading{level}" data-block-id="{record}" '
            f'data-record-id="r{record}"><div class="heading-block"><div class="heading heading-h{level}">'
            f'<div class="heading-order orderUnedit">{order}</div><div class="heading-content">'
            f'<div class="zone-container text-editor">{line(s(words))}</div></div></div></div></div>')


def ordered(record, number, words, children=""):
    return block("ordered", record, f'<div class="list-wrapper ordered-list"><div class="list"><div class="order orderUnedit">'
                 f'{number}</div><div class="list-content">{line(s(words))}</div></div></div>', children)


def bullet(record, words, children=""):
    return block("bullet", record, f'<div class="list-wrapper bullet-list"><div class="bullet"><div class="bullet-dot-style">•'
                 f'</div></div><div class="list-content">{line(s(words))}</div></div>', children)


CODE = (
    '<div class="block docx-code-block" data-block-type="code" data-block-id="40" data-record-id="r40">'
    '<div class="ignore-dom"><div class="code-block-header uneditable"><div class="code-block-caption">'
    f'<div class="caption-editor-area">{line(s("代码块"))}</div></div><div class="code-block-header-toolbar">'
    '<button><span>Python</span></button><button><span>复制</span></button></div></div></div>'
    '<div class="code-block-content"><div class="zone-container text-editor">'
    f'{line(s("def area(r):"))}{line(s("    return 3.14 * r ** 2  # 圆面积"))}</div></div></div>'
)
IMAGE = ('<div class="block docx-image-block" data-block-type="image" data-block-id="50" data-record-id="r50">'
         '<div class="gpf-biz-action-manager-forbidden-placeholder"><div>附件不支持打印</div></div>'
         '<img alt="飞书文档 - 图片" src="blob:https://example.feishu.cn/1234"></div>')
BOOKMARK = ('<div class="block docx-bookmark-block" data-block-type="bookmark" data-block-id="60" data-record-id="r60">'
            f'<div><span data-zero-space="true">{ZW}</span></div><div><span>https://example.com/rotary</span></div>'
            '<div><span>旋转位置编码详解 | 示例网站</span><br><span>一篇讲清楚位置编码的长文。</span></div></div>')
BODY = "".join([
    block("callout", 2, '<div class="callout-emoji-container"><span>💡</span></div>',
          text(3, s("这份笔记整理了位置编码的直觉和推导，"), s("建议先读第一节", "font-weight:bold;"), s("。"))),
    heading(1, 10, "1.", "为什么需要位置编码"),
    text(11, s("注意力本身"), s("看不出", "font-style:italic;"), s("词的先后，"),
         '<span class="outer-u-container"><span class="link-wrapper"><a class="link" href="https://arxiv.org/abs/2104.09864">'
         '<span data-string="true">原论文</span></a></span></span>', s("给了一个优雅的解法。")),
    text(12, s(ZW)),
    ordered(20, "1.", "先把每个位置写成一个角度"),
    ordered(21, "2.", "再把向量按这个角度旋转", children=bullet(22, "二维里就是乘一个旋转矩阵")),
    ordered(23, "3.", "最后做内积，只剩相对位置"),
    heading(2, 30, "1.1", "代码示例"),
    text(31, s("下面的函数里用到了 "), '<span data-string="true" class="inline-code">r ** 2</span>', s("。")),
    CODE,
    IMAGE,
    block("divider", 55, '<div class="divider-block"></div>'),
    BOOKMARK,
    text(70, s("# 这一行不是标题，只是以井号开头")),
])
PAGE = f"""<!DOCTYPE html><html><head><title>旋转位置编码笔记 - 飞书云文档</title></head><body>
<div class="wiki-ssr-sidebar__wrapper"><div class="wiki-ssr-sidebar__header-title">互联网公开 目录</div>
<div class="tree-node">🌈 通往AGI之路</div><div class="tree-node">飞书CLI使用方法</div><div class="tree-node">晚8点共学</div></div>
<div id="docx"><div class="bear-web-x-container docx-in-wiki"><div class="page-main"><div class="editor-container">
<div class="block docx-page-block" data-block-type="page" data-block-id="1" data-record-id="rpage">
<div class="layer-popup suspension-comment-area"><button class="comment-btn">评论</button></div>
<div class="page-block root-block"><div class="zone-container editor-kit-container">
<div class="page-block-header"><div class="page-block-header-top"></div>
<h1 class="page-block-content">旋转位置编码笔记{ZW}</h1><div class="note-title__time">2026年11月9日修改</div></div>
<div class="page-block-children"><div class="root-render-unit-container"><div class="render-unit-wrapper">{BODY}</div></div></div>
</div></div></div></div></div></div></div>
<div class="help-center">帮助中心 快捷键</div></body></html>"""
URL = "https://example.feishu.cn/wiki/AbCdEf123"


def test_a_feishu_page_keeps_only_its_title_and_body_written_as_markdown():
    article = web_import.extract_page(PAGE, URL)
    assert article.title == "旋转位置编码笔记"
    content = article.content
    for chrome in ("互联网公开", "通往AGI之路", "评论", "帮助中心", "2026年11月9日修改", "附件不支持打印", "复制", "代码块", ZW):
        assert chrome not in content
    assert content.startswith("> 这份笔记整理了位置编码的直觉和推导，**建议先读第一节**。")
    assert "## 1. 为什么需要位置编码" in content and "### 1.1 代码示例" in content
    assert "注意力本身*看不出*词的先后，[原论文](<https://arxiv.org/abs/2104.09864>)给了一个优雅的解法。" in content
    # Feishu's own numbering, nested items indented under their parent, adjacent items on adjacent lines
    assert ("1. 先把每个位置写成一个角度\n2. 再把向量按这个角度旋转\n\n   - 二维里就是乘一个旋转矩阵\n"
            "3. 最后做内积，只剩相对位置") in content
    assert "下面的函数里用到了 `r ** 2`。" in content
    assert "```\ndef area(r):\n    return 3.14 \\* r \\*\\* 2  # 圆面积\n```" not in content
    assert "```\ndef area(r):\n    return 3.14 * r ** 2  # 圆面积\n```" in content
    assert "\n---\n" in content
    assert "[旋转位置编码详解 \\| 示例网站](<https://example.com/rotary>)" in content
    assert "\\# 这一行不是标题" in content
    assert "blob:" not in content


def test_pages_without_feishu_blocks_still_go_through_the_general_extractor():
    plain = PAGE.replace('data-block-type="page"', 'data-kind="page"')
    article = web_import.extract_page(plain, URL)
    assert "## 1. 为什么需要位置编码" not in article.content


def test_formulas_inside_a_feishu_line_keep_their_tex():
    katex = ('<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow>'
             '<annotation encoding="application/x-tex">\\theta_i = 10000^{-2i/d}</annotation></semantics></math></span>'
             '<span class="katex-html">θi</span></span>')
    page = PAGE.replace(s("词的先后，"), s("词的先后，比如 ") + katex + s(" 这样的角度，"))
    content = web_import.extract_page(page, URL).content
    assert "比如 \\(\\theta_i = 10000^{-2i/d}\\) 这样的角度" in content
