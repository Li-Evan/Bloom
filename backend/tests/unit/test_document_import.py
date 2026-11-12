import base64
import io
import json
import zipfile
from email.message import EmailMessage

import openpyxl
import pytest
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.util import Inches

from app import document_import as docs
from app import omml
from app.courses import _decode_text_bytes
from app.models import Lesson, ProjectImage
from app.project_archive import rewrite_images
from tests.conftest import TestSession
from tests.unit.test_project_archives import archive, images, stored as stored_files  # noqa: F401  (fixture)

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def png(color="green", size=(8, 8)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def convert(path, raw, language="zh"):
    return docs.convert(path, raw, language, _decode_text_bytes)


def equation(xml: str) -> str:
    return omml.equation(etree.fromstring(f'<m:oMath xmlns:m="{MATH}">{xml}</m:oMath>'))


def r(text):
    return f"<m:r><m:t>{text}</m:t></m:r>"


@pytest.mark.parametrize("xml, latex", [
    (f"<m:f><m:num>{r('a')}</m:num><m:den>{r('b')}</m:den></m:f>", r"\frac{a}{b}"),
    (f"<m:sSubSup><m:e>{r('x')}</m:e><m:sub>{r('i')}</m:sub><m:sup>{r('2')}</m:sup></m:sSubSup>", "{x}_{i}^{2}"),
    (f'<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>{r("i=1")}</m:sub><m:sup>{r("n")}</m:sup>'
     f"<m:e>{r('α')}</m:e></m:nary>", r"\sum_{i=1}^{n}{\alpha }"),
    (f"<m:rad><m:deg>{r('3')}</m:deg><m:e>{r('x')}</m:e></m:rad>", r"\sqrt[3]{x}"),
    (f'<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>{r("x")}</m:e></m:rad>', r"\sqrt{x}"),
    (f'<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>{r("a")}</m:e><m:e>{r("b")}</m:e></m:d>',
     r"\left[ a | b \right]"),
    (f"<m:m><m:mr><m:e>{r('a')}</m:e><m:e>{r('b')}</m:e></m:mr><m:mr><m:e>{r('c')}</m:e><m:e>{r('d')}</m:e></m:mr></m:m>",
     r"\begin{matrix}a & b \\ c & d\end{matrix}"),
    (f"<m:func><m:fName><m:limLow><m:e>{r('lim')}</m:e><m:lim>{r('x→0')}</m:lim></m:limLow></m:fName>"
     f"<m:e>{r('f(x)')}</m:e></m:func>", r"\lim_{x\to 0}{f(x)}"),
    (f'<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>{r("v")}</m:e></m:acc>', r"\vec{v}"),
    (r("a≤b×c"), r"a\le b\times c"),
])
def test_word_equations_become_latex(xml, latex):
    assert equation(xml) == latex


def docx(body: str, *, image: bytes | None = None) -> bytes:
    rels = ('<Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
            'Target="media/image1.png"/>') if image else ""
    files = [
        ("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
         '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
         '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
        ("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
         '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
         'Target="word/document.xml"/></Relationships>'),
        ("word/_rels/document.xml.rels", '<?xml version="1.0"?><Relationships '
         f'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>'),
        ("word/document.xml", f'<?xml version="1.0"?><w:document xmlns:w="{W}" xmlns:m="{MATH}" '
         'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
         'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
         'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
         'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
         f"<w:body>{body}</w:body></w:document>"),
    ]
    if image:
        files.append(("word/media/image1.png", image))
    return archive(files)


def p(text, style=None, bold=False):
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    run_props = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return f'<w:p>{props}<w:r>{run_props}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


PICTURE = ('<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="图" descr="示意图"/><a:graphic><a:graphicData>'
           '<pic:pic><pic:blipFill><a:blip r:embed="rImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>'
           "</wp:inline></w:drawing></w:r></w:p>")


def test_word_document_keeps_structure_equations_and_pictures():
    body = (p("第一章 概念", "Heading1") + p("重点", bold=True)
            + f'<w:p><w:r><w:t xml:space="preserve">更新规则 </w:t></w:r><m:oMath>{r("θ")}<m:sSub><m:e>{r("x")}</m:e>'
              f'<m:sub>{r("t")}</m:sub></m:sSub></m:oMath><w:r><w:t xml:space="preserve"> 价格 $5 和 $10</w:t></w:r></w:p>'
            + f"<w:p><m:oMathPara><m:oMath><m:f><m:num>{r('a_1')}</m:num><m:den>{r('2')}</m:den></m:f></m:oMath></m:oMathPara></w:p>"
            + "<w:tbl><w:tr><w:tc>" + p("项目") + "</w:tc><w:tc>" + p("值") + "</w:tc></w:tr>"
              "<w:tr><w:tc>" + p("a|b") + "</w:tc><w:tc>" + p("1.5") + "</w:tc></w:tr></w:tbl>"
            + PICTURE + p("def f():", "SourceCode"))
    document = convert("资料/笔记.docx", docx(body, image=png()))
    markdown = document.pages[0][1]
    assert document.pages[0][0] == "资料/笔记.docx" and len(document.assets) == 1
    assert "# 第一章 概念" in markdown and "**重点**" in markdown
    assert r"更新规则 $\theta {x}_{t}$ 价格 \$5 和 \$10" in markdown
    assert "$$\n\\frac{a\\_1}{2}\n$$" in markdown
    assert "| 项目 | 值 |\n| --- | --- |\n| a\\|b | 1.5 |" in markdown
    assert "![示意图](bloom-asset/0.png)" in markdown
    assert "```\ndef f():\n```" in markdown


def test_assets_attach_to_stored_addresses_and_unreadable_ones_disappear():
    markdown = "![a](bloom-asset/0.png) 和 ![b](bloom-asset/1.jpg)"
    assert docs.attach_assets(markdown, ["/api/project-images/x", None]) == "![a](/api/project-images/x) 和 "


def test_embedded_images_are_deduplicated_and_unshowable_ones_dropped():
    assets = docs._Assets()
    bmp = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(bmp, format="BMP")
    assert assets.add(png()) == assets.add(png()) == "bloom-asset/0.png"
    assert assets.add(bmp.getvalue()) == "bloom-asset/1.png"  # converted for browsers
    assert assets.add(b"\x01\x00\x00\x00 EMF drawing") is None
    assert len(assets.items) == 2


def deck() -> bytes:
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[1])
    slide.shapes.title.text = "三种变体"
    frame = slide.placeholders[1].text_frame
    frame.text = "批量"
    frame.paragraphs[0].runs[0].font.bold = True
    child = frame.add_paragraph()
    child.text, child.level = "全部样本 *星号*", 1
    slide.notes_slide.notes_text_frame.text = "提问：为什么？"
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    slide.shapes.title.text = "对比"
    table = slide.shapes.add_table(2, 2, Inches(1), Inches(1), Inches(4), Inches(1)).table
    for (row, col), value in {(0, 0): "方法", (0, 1): "样本", (1, 0): "SGD", (1, 1): "1"}.items():
        table.cell(row, col).text = value
    picture = io.BytesIO(png("blue", (40, 20)))
    slide.shapes.add_picture(picture, Inches(5), Inches(1))
    picture.seek(0)
    slide.shapes.add_picture(picture, Inches(5), Inches(3))
    hidden = presentation.slides.add_slide(presentation.slide_layouts[5])
    hidden.shapes.title.text = "隐藏页"
    hidden._element.set("show", "0")
    output = io.BytesIO()
    presentation.save(output)
    return output.getvalue()


def test_slides_keep_titles_bullets_notes_tables_and_pictures():
    document = convert("课件.pptx", deck())
    markdown = document.pages[0][1]
    assert "## 第 1 页 · 三种变体\n\n- **批量**\n  - 全部样本 \\*星号\\*" in markdown
    assert "> **备注**\n>\n> 提问：为什么？" in markdown
    assert "## 第 2 页 · 对比" in markdown and "| SGD | 1 |" in markdown
    assert markdown.count("![](bloom-asset/0.png)") == 2 and len(document.assets) == 1
    assert "隐藏页" not in markdown
    assert "## Slide 1 · " in convert("deck.pptx", deck(), "en").pages[0][1]


def test_spreadsheets_become_tables_per_visible_sheet():
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "成绩"
    sheet.append(["姓名", "分数", "通过"])
    sheet.append(["张三", 92.5, True])
    sheet.append(["李四", 78.0, None])
    book.create_sheet("说明")["A1"] = "备注"
    book.create_sheet("隐藏")["A1"] = "不应出现"
    book["隐藏"].sheet_state = "hidden"
    output = io.BytesIO()
    book.save(output)
    markdown = convert("成绩.xlsx", output.getvalue()).pages[0][1]
    assert "## 成绩\n\n| 姓名 | 分数 | 通过 |\n| --- | --- | --- |\n| 张三 | 92.5 | TRUE |\n| 李四 | 78 |  |" in markdown
    assert "## 说明" in markdown and "不应出现" not in markdown


def test_csv_delimiters_are_detected():
    markdown = convert("数据.csv", "城市;人口\n北京;2189\n".encode()).pages[0][1]
    assert markdown == "| 城市 | 人口 |\n| --- | --- |\n| 北京 | 2189 |"
    assert convert("a.tsv", b"a\tb\n1\t2\n").pages[0][1].endswith("| 1 | 2 |")


def epub() -> bytes:
    xhtml = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>{}</body></html>'
    return archive([
        ("mimetype", "application/epub+zip"),
        ("META-INF/container.xml", '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
         '<rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
        ("OEBPS/content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest>'
         '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
         '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>'
         '<item id="c1b" href="text/ch1-part2.xhtml" media-type="application/xhtml+xml"/>'
         '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>'
         '<item id="img" href="images/fig.png" media-type="image/png"/></manifest>'
         '<spine><itemref idref="c1"/><itemref idref="c1b"/><itemref idref="c2"/></spine></package>'),
        ("OEBPS/nav.xhtml", xhtml.format('<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>'
                                         '<li><a href="text/ch1.xhtml">第一章 起源</a></li>'
                                         '<li><a href="text/ch2.xhtml#top">第二章 发展</a></li></ol></nav>')),
        ("OEBPS/text/ch1.xhtml", xhtml.format('<h1>第一章</h1><p>开头，见<a href="ch2.xhtml">下一章</a>。</p>'
                                              '<p><img src="../images/fig.png" alt="插图"/></p>')),
        ("OEBPS/text/ch1-part2.xhtml", xhtml.format("<p>第一章的后半部分。</p>")),
        ("OEBPS/text/ch2.xhtml", xhtml.format('<h1>第二章</h1><p>公式 <math display="block"><semantics><mi>x</mi>'
                                              '<annotation encoding="application/x-tex">x_1^2</annotation></semantics></math></p>')),
        ("OEBPS/images/fig.png", png()),
    ])


def test_ebooks_split_into_chapters_from_the_table_of_contents():
    document = convert("书/三体.epub", epub())
    assert [path for path, _ in document.pages] == ["书/三体/01 第一章 起源", "书/三体/02 第二章 发展"]
    first, second = document.pages[0][1], document.pages[1][1]
    assert "开头，见下一章。" in first and "![插图](bloom-asset/0.png)" in first
    assert first.endswith("第一章的后半部分。")
    assert "$$\nx_1^2\n$$" in second or "$x_1^2$" in second
    assert len(document.assets) == 1


def test_notebooks_keep_code_outputs_and_images():
    picture = base64.b64encode(png()).decode()
    notebook = {"metadata": {"kernelspec": {"language": "python"}}, "cells": [
        {"cell_type": "markdown", "source": ["# 实验\n", "![图](attachment:a.png)"], "attachments": {"a.png": {"image/png": picture}}},
        {"cell_type": "code", "source": "print(1)", "outputs": [{"output_type": "stream", "text": ["1\n"]}]},
        {"cell_type": "code", "source": "df", "outputs": [{"output_type": "execute_result", "data": {
            "text/html": "<table><tr><th>a</th></tr><tr><td>1</td></tr></table>", "text/plain": "a\n1"}}]},
        {"cell_type": "code", "source": "plot()", "outputs": [
            {"output_type": "display_data", "data": {"image/png": picture}},
            {"output_type": "error", "traceback": ["\x1b[0;31mValueError\x1b[0m: bad"]}]},
    ]}
    document = convert("实验.ipynb", json.dumps(notebook).encode())
    markdown = document.pages[0][1]
    assert markdown.startswith("# 实验\n![图](bloom-asset/0.png)")
    assert "```python\nprint(1)\n```\n\n```text\n1\n```" in markdown
    assert "| a |\n| --- |\n| 1 |" in markdown
    assert "![](bloom-asset/0.png)" in markdown and "```text\nValueError: bad\n```" in markdown


SAVED_PAGE = f'''<html><head><title>梯度下降</title><script>MathJax = {{tex: {{inlineMath: [['$', '$']]}}}}</script></head>
<body><nav>首页 导航</nav><main><h1>梯度下降</h1><p>规则 $\\theta_t$，价格 $5 和 $10。</p>
<ul><li>一<ul><li>嵌套</li></ul></li></ul><pre><code>x = 1</code></pre>
<p><img src="梯度下降_files/fig.png" alt="图"><img src="data:image/png;base64,{base64.b64encode(png()).decode()}" alt="内嵌"></p>
<a href="other.html">站内链接</a></main><footer>页脚</footer></body></html>'''


def test_saved_web_pages_keep_their_whole_main_content():
    document = convert("资料/梯度下降.html", SAVED_PAGE.encode())
    markdown = document.pages[0][1]
    assert markdown.startswith("# 梯度下降\n\n规则 $\\theta_t$，价格 \\$5 和 \\$10。")
    assert "- 一\n  - 嵌套" in markdown and "```\nx = 1\n```" in markdown
    assert "![内嵌](bloom-asset/0.png)" in markdown
    # The page's own image folder resolves to the uploaded copy.
    linked, used = rewrite_images(markdown, "资料/梯度下降.html", {"资料/梯度下降_files/fig.png": "/api/project-images/f"})
    assert used == {"资料/梯度下降_files/fig.png"} and "![图](/api/project-images/f)" in linked
    assert "站内链接" in markdown and "other.html" not in markdown
    assert "导航" not in markdown and "页脚" not in markdown


def test_single_file_web_pages_bring_their_images():
    message = EmailMessage()
    message["Subject"] = "saved"
    message.set_content('<html><head><title>页面</title></head><body><p>正文段落。</p>'
                        '<img src="https://example.com/a.png" alt="图"></body></html>', subtype="html")
    message.add_related(png(), maintype="image", subtype="png", headers=["Content-Location: https://example.com/a.png"])
    document = convert("页面.mhtml", message.as_bytes())
    assert "正文段落。" in document.pages[0][1] and "![图](bloom-asset/0.png)" in document.pages[0][1]


def test_plain_text_reads_as_written():
    text = "第一行 *不是强调*\n第二行\n\n# 不是标题\n    缩进的行\n1. 不是列表\n价格 $5"
    markdown = convert("笔记.txt", text.encode()).pages[0][1]
    assert markdown == ("第一行 \\*不是强调\\*\\\n第二行\n\n\\# 不是标题\\\n    缩进的行\\\n"
                        "1\\. 不是列表\\\n价格 \\$5")


@pytest.mark.parametrize("name, reason", [
    ("旧.doc", "Word 97-2003 格式，请另存为 .docx 后上传"),
    ("旧.ppt", "PowerPoint 97-2003 格式，请另存为 .pptx 后上传"),
    ("讲座.mp4", "暂不支持音频和视频"),
    ("坏.docx", "文件已损坏或已加密，无法读取"),
])
def test_unreadable_files_say_why(name, reason):
    with pytest.raises(docs.Unsupported) as error:
        convert(name, b"not really this format")
    assert error.value.reason("zh") == reason


def test_html_inside_markdown_becomes_markdown():
    readme = ('<p align="center">\n  <img src="docs/logo.png" alt="Logo" width="200">\n</p>\n\n'
              "公式 x<sup>2</sup> 与 H<sub>2</sub>O，引用<sup>[[1]](https://a.test)</sup>，<b>重点</b>，按 <kbd>Ctrl</kbd>。<br>\n"
              '<img src="shot one.png">\n\n| a | b<br>c |\n|---|---|\n\n```html\n<b>代码里不动</b>\n```\n`<br>` 行内代码不动')
    markdown = docs.markdown_without_html(readme)
    assert markdown.startswith("![Logo](docs/logo.png)\n\n")
    assert "公式 x² 与 H₂O，引用[[1]](https://a.test)，**重点**，按 `Ctrl`。\\\n![](<shot one.png>)" in markdown
    assert "| a | b c |" in markdown
    assert "```html\n<b>代码里不动</b>\n```" in markdown and "`<br>` 行内代码不动" in markdown


def test_markdown_and_code_stay_with_the_caller():
    assert convert("a.md", b"# x") is None and convert("a.py", b"print(1)") is None


def test_project_import_converts_documents_and_explains_skips(authed_client, images):  # noqa: F811  (fixture)
    deck_bytes = deck()
    raw = archive([("课程/课件.pptx", deck_bytes), ("课程/讲义.docx", docx(p("讲义正文") + PICTURE, image=png("red"))),
                   ("课程/旧讲义.doc", b"\xd0\xcf\x11\xe0legacy"), ("课程/说明.md", "# 说明")])
    response = authed_client.post("/api/courses/from-project", files={"files": ("课程.zip", raw)})
    assert response.status_code == 200, response.text
    course = response.json()
    assert course["lesson_count"] == 3
    assert course["skipped_files"] == ["课程/旧讲义.doc（Word 97-2003 格式，请另存为 .docx 后上传）"]
    assert len(stored_files(images)) == 2  # one picture per document; the deck's repeated picture is stored once
    with TestSession() as db:
        lessons = {lesson.source_filename: lesson.content for lesson in db.query(Lesson).filter_by(course_id=course["id"])}
        stored = {record.id for record in db.query(ProjectImage).filter_by(course_id=course["id"])}
    assert set(lessons) == {"课程/课件.pptx", "课程/讲义.docx", "课程/说明.md"}
    assert "bloom-asset" not in lessons["课程/课件.pptx"] + lessons["课程/讲义.docx"]
    assert all(f"/api/project-images/{image_id}" in lessons["课程/课件.pptx"] + lessons["课程/讲义.docx"] for image_id in stored)


def test_project_import_with_nothing_readable_names_the_reasons(authed_client):
    response = authed_client.post("/api/courses/from-project", files={"files": ("旧.doc", b"\xd0\xcf\x11\xe0legacy")})
    assert response.status_code == 400
    assert response.json()["detail"] == "没有可读取的文件内容（原因：旧.doc（Word 97-2003 格式，请另存为 .docx 后上传））"


def test_zip_bombs_inside_documents_are_refused():
    big = io.BytesIO()
    with zipfile.ZipFile(big, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", b"0" * (docs.MAX_ARCHIVE_BYTES + 1))
    with pytest.raises(docs.Unsupported) as error:
        convert("炸弹.docx", big.getvalue())
    assert error.value.key == "too_large"
