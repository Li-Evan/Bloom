import io
import time
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from PIL import Image

from app import pdf_reading
from app.config import settings
from app.courses import _token_limit_key
from app.models import Course, Lesson, ProjectImage
from tests.conftest import TestSession


def pdf_bytes(pages: int = 2) -> bytes:
    """几页纯色的 PDF（Letter 比例），第 1 页左上角有一块深色，当作插图。"""
    images = []
    for i in range(pages):
        image = Image.new("RGB", (612, 792), "white")
        if i == 0:
            image.paste((20, 60, 120), (61, 79, 306, 316))
        images.append(image)
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:])
    return buf.getvalue()


def reply(text: str, finish_reason: str = "stop"):
    return SimpleNamespace(
        id="resp", choices=[SimpleNamespace(message=SimpleNamespace(content=text), finish_reason=finish_reason)],
        usage=SimpleNamespace(prompt_tokens=2700, completion_tokens=500, model_dump=lambda: {"prompt_tokens": 2700, "completion_tokens": 500}),
    )


def test_tidy_page_drops_wrapper_fence_and_blank_lines_inside_display_math():
    raw = "```markdown\n## 1 Intro\n\n$$\n\na = b\n\n\\tag{1}\n$$\n\nInline $x$ and $$y = 1$$ stay.\n\n\n\nEnd\n```"
    assert pdf_reading.tidy_page(raw) == "## 1 Intro\n\n$$\na = b\n\\tag{1}\n$$\n\nInline $x$ and $$y = 1$$ stay.\n\nEnd"


def test_tidy_page_closes_braces_the_model_forgot_but_leaves_escaped_and_extra_ones():
    # 实测有模型把位置编码抄成了 10000^{2i/d_{\text{model}})，少一个 }，KaTeX 整条报错
    raw = "$$PE = sin(pos/10000^{2i/d_{\\text{model}})$$\n\nInline $a^{b$, set $\\{x\\}$, extra $c}$ and $5 and $10."
    assert pdf_reading.tidy_page(raw) == (
        "$$PE = sin(pos/10000^{2i/d_{\\text{model}})}$$\n\nInline $a^{b}$, set $\\{x\\}$, extra $c}$ and $5 and $10."
    )
    # 多行公式块：补的 } 放在最后一行内容末尾，结尾的 $$ 仍单独一行（实测 }$$ 连在一起时整块渲染失败）
    block = "$$\nPE = sin(pos/10000^{2i/d_{\\text{model}})\n$$"
    assert pdf_reading.tidy_page(block) == "$$\nPE = sin(pos/10000^{2i/d_{\\text{model}})}\n$$"


def test_crop_figure_pads_the_box_and_rejects_boxes_that_are_not_a_figure():
    page = Image.new("RGB", (1000, 2000), "white")
    png = pdf_reading.crop_figure(page, (100, 100, 500, 300))
    with Image.open(io.BytesIO(png)) as figure:
        # 四周各多 15/1000：宽 (500+15)-(100-15) = 430，高 2000×(315-85)/1000 = 460
        assert figure.size == (430, 460)
    for bad in [(500, 100, 100, 300), (0, 0, 10, 10), (100, 100, 1200, 300)]:
        assert pdf_reading.crop_figure(page, bad) is None


def test_convert_pdf_keeps_page_order_crops_figures_retries_and_marks_a_lost_page():
    calls = []

    def call(messages, input_tokens, timeout):
        content = messages[0]["content"]
        assert content[0]["type"] == "text" and content[1]["image_url"]["url"].startswith("data:image/png;base64,")
        assert input_tokens == pdf_reading.PAGE_INPUT_TOKENS and 0 < timeout <= pdf_reading.PAGE_TIMEOUT_SECONDS
        calls.append(time.monotonic())
        # 一次只转一页（concurrency=1）：第 1、2 页成功，第 3 页三次都失败，第 4 页成功
        if len(calls) == 1:
            return "# Title\n\n[[FIGURE 100 100 500 400]]\nFigure 1: A box.\n\nBody $x$."
        if len(calls) in (3, 4, 5):
            raise RuntimeError("model hiccup")
        return f"Page text {len(calls)}."

    result = pdf_reading.convert_pdf(pdf_bytes(4), call, file_key="pdf-1", deadline=time.monotonic() + 60, concurrency=1)
    # 第 3 页失败后重试到 PAGE_ATTEMPTS 次，仍失败：那一页留一句说明；1/4 页没超过 30%，整份照样交付
    assert pdf_reading.PAGE_ATTEMPTS == 3 and len(calls) == 6
    assert result.pages == 4 and result.failed_pages == [3]
    assert list(result.figures) == ["pdf-1/page-1-figure-1.png"]
    assert result.markdown == (
        "<!-- page: 1 -->\n# Title\n\n![第 1 页插图](pdf-1/page-1-figure-1.png)\nFigure 1: A box.\n\nBody $x$.\n\n"
        "<!-- page: 2 -->\nPage text 2.\n\n"
        "<!-- page: 3 -->\n> 第 3 页没能转换，请对照原 PDF 阅读。\n\n"
        "<!-- page: 4 -->\nPage text 6.\n"
    )


def test_convert_pdf_fails_whole_file_when_too_many_pages_fail():
    with pytest.raises(pdf_reading.PdfReadingError):
        pdf_reading.convert_pdf(pdf_bytes(3), lambda *a: (_ for _ in ()).throw(RuntimeError("down")),
                                file_key="f", deadline=time.monotonic() + 60, concurrency=3)


@pytest.fixture
def images(monkeypatch, tmp_path):
    """插图存成 IMAGE_STORE_DIR 下的文件：测试里指到临时目录，返回这个目录。"""
    store = tmp_path / "images"
    monkeypatch.setattr(settings, "IMAGE_STORE_DIR", str(store))
    return store


def stored(store):
    return sorted(path.name for path in store.iterdir()) if store.exists() else []


def fake_model(texts):
    """按调用顺序返回 texts（用完重复最后一个）；记下每次请求的参数。"""
    requests = []

    def create(**kwargs):
        requests.append(kwargs)
        return reply(texts[min(len(requests), len(texts)) - 1])

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), close=lambda: None), requests


@pytest.mark.parametrize("model", ["vision-model", "gpt-4.1-mini"])
def test_pdf_reading_course_has_one_markdown_lesson_per_pdf_with_stored_figures_and_original(
    authed_client, user, images, monkeypatch, model,
):
    monkeypatch.setattr(settings, "PDF_READING_MODEL", model)
    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", {"thinking": {"type": "disabled"}})
    # 每页都回同样的内容（各页并行，调用先后不固定）：每页一张插图
    client, requests = fake_model(["# Paper\n\n[[FIGURE 100 100 500 400]]\nFigure 1: A box.\n\nText $a^2$."])
    raw = pdf_bytes(2)
    with patch("app.courses.get_openai_client", return_value=client):
        response = authed_client.post(
            "/api/courses/from-pdf-reading",
            files=[("files", ("paper.pdf", raw, "application/pdf")), ("files", ("paper.pdf", raw, "application/pdf"))],
        )
    assert response.status_code == 200, response.text
    course = response.json()
    assert course["is_project"] and course["lesson_count"] == 2 and course["name"] == "Paper"
    assert course["source_filename"] == "paper.pdf.md"
    # 每页一次，用 PDF_READING_MODEL；输出上限的参数名按模型（GPT 要 max_completion_tokens），LLM_EXTRA_BODY 照带
    key = _token_limit_key(model)
    assert key == ("max_completion_tokens" if model.startswith("gpt-") else "max_tokens") and len(requests) == 4
    assert all(r["model"] == model and r[key] == pdf_reading.MAX_OUTPUT_TOKENS for r in requests)
    assert all({"max_tokens", "max_completion_tokens"} - {key} - set(r) for r in requests)
    assert all(r["extra_body"] == {"thinking": {"type": "disabled"}} for r in requests)
    with TestSession() as db:
        lessons = db.query(Lesson).filter_by(course_id=course["id"]).order_by(Lesson.number).all()
        assert [l.source_filename for l in lessons] == ["paper.pdf.md", "paper (2).pdf.md"]
        assert all(l.is_source and l.source_blob == raw for l in lessons)
        figures = {f.id for f in db.query(ProjectImage).filter_by(course_id=course["id"])}
        assert len(figures) == 4 and len(stored(images)) == 4
        first = lessons[0].content
        assert first.startswith("<!-- page: 1 -->\n# Paper\n\n![第 1 页插图](/api/project-images/")
        assert "<!-- page: 2 -->\n# Paper\n\n![第 2 页插图](/api/project-images/" in first
        linked = {part.split(")", 1)[0] for lesson in lessons for part in lesson.content.split("(/api/project-images/")[1:]}
        assert linked == figures
        assert db.get(Course, course["id"]).is_project
    original = authed_client.get(f"/api/courses/{course['id']}/lessons/1/file")
    assert original.status_code == 200 and original.headers["content-type"] == "application/pdf" and original.content == raw


def test_pdf_reading_keeps_text_when_the_figures_cannot_be_saved(authed_client, monkeypatch, tmp_path):
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("")
    monkeypatch.setattr(settings, "IMAGE_STORE_DIR", str(blocked))
    client, _ = fake_model(["# Paper\n\n[[FIGURE 100 100 500 400]]\nFigure 1.", "Page two."])
    with patch("app.courses.get_openai_client", return_value=client):
        response = authed_client.post("/api/courses/from-pdf-reading", files={"files": ("doc.pdf", pdf_bytes(2), "application/pdf")})
    assert response.status_code == 200, response.text
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=response.json()["id"]).one()
        assert "> 这里的插图没能保存，请对照原 PDF。\nFigure 1." in lesson.content and "/api/project-images/" not in lesson.content


def test_pdf_reading_rejects_other_files_and_broken_pdfs_before_calling_the_model(authed_client, user):
    with patch("app.courses.get_openai_client") as client:
        not_pdf = authed_client.post("/api/courses/from-pdf-reading", files={"files": ("notes.md", b"# hi", "text/markdown")})
        broken = authed_client.post("/api/courses/from-pdf-reading", files={"files": ("doc.pdf", b"not a pdf", "application/pdf")})
    assert not_pdf.status_code == 400 and "只接受 PDF" in not_pdf.json()["detail"]
    assert broken.status_code == 400 and "打不开" in broken.json()["detail"]
    assert not client.called
    with TestSession() as db:
        assert db.query(Course).filter_by(user_uuid=user.uuid).count() == 0


def test_pdf_reading_failure_leaves_no_course(authed_client, user):
    def create(**_):
        raise RuntimeError("gateway down")

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), close=lambda: None)
    with patch("app.courses.get_openai_client", return_value=client):
        response = authed_client.post("/api/courses/from-pdf-reading", files={"files": ("doc.pdf", pdf_bytes(1), "application/pdf")})
    assert response.status_code >= 500, response.text
    assert isinstance(response.json()["detail"], str)
    with TestSession() as db:
        assert db.query(Course).filter_by(user_uuid=user.uuid).count() == 0


def test_sentences_split_across_pages_are_joined_back_but_only_when_clearly_unfinished():
    pages = [
        "## 3.2 Attention\n\nThe output is computed as a weighted sum",
        "![第 4 页插图](f.png)\nFigure 2: Two attention variants.\n\nof the values, where the weight is computed.\n\n### 3.2.1 Next",
        "Ends properly.",
        "Starts with a capital.",
        "English-",
        "to-German translation.",
        "这一句没有结束",
        "所以中文不接",
        None,
        "lowercase after a lost page",
    ]
    joined = pdf_reading.join_split_sentences(pages)
    assert joined[0] == "## 3.2 Attention\n\nThe output is computed as a weighted sum of the values, where the weight is computed."
    assert joined[1] == "![第 4 页插图](f.png)\nFigure 2: Two attention variants.\n\n### 3.2.1 Next"
    assert joined[2:4] == ["Ends properly.", "Starts with a capital."]
    assert joined[4:6] == ["English-to-German translation.", ""]
    assert joined[6:] == ["这一句没有结束", "所以中文不接", None, "lowercase after a lost page"]


def test_convert_pdf_converts_only_the_first_pages_when_capped_and_says_so_at_the_top():
    calls = []

    def call(messages, input_tokens, timeout):
        calls.append(1)
        return f"Page {len(calls)}."

    capped = pdf_reading.convert_pdf(pdf_bytes(3), call, file_key="f", deadline=time.monotonic() + 60, concurrency=1,
                                     max_pages=2, limit=2)
    assert len(calls) == 2 and capped.pages == 2 and capped.source_pages == 3
    assert capped.markdown.startswith("> 原 PDF 共 3 页，PDF 阅读版一次最多转换 2 页，这里只转换了前 2 页")
    assert "<!-- page: 2 -->" in capped.markdown and "<!-- page: 3 -->" not in capped.markdown
    # 分到 0 页：不画、不调模型，只留一句说明
    skipped = pdf_reading.convert_pdf(pdf_bytes(2), call, file_key="g", deadline=time.monotonic() + 60, max_pages=0, limit=30)
    assert len(calls) == 2 and skipped.pages == 0 and skipped.source_pages == 2
    assert skipped.markdown.startswith("> PDF 阅读版一次最多转换 30 页，这次的页数在前面的文件里用完了")
    # 没超过上限：开头不加说明
    whole = pdf_reading.convert_pdf(pdf_bytes(1), call, file_key="h", deadline=time.monotonic() + 60, max_pages=5, limit=5)
    assert whole.markdown.startswith("<!-- page: 1 -->")


def test_pdf_reading_over_the_page_cap_converts_the_first_pages_across_files_in_order(authed_client, user, monkeypatch):
    # 上限 3 页，三个文件各 2 页：第一个转完，第二个只转第 1 页，第三个不转；只按转了的 3 页调模型
    monkeypatch.setattr(settings, "PDF_READING_MAX_PAGES", 3)
    client, requests = fake_model(["Page text."])
    files = [("files", (f"doc{i}.pdf", pdf_bytes(2), "application/pdf")) for i in (1, 2, 3)]
    with patch("app.courses.get_openai_client", return_value=client):
        response = authed_client.post("/api/courses/from-pdf-reading", files=files)
    assert response.status_code == 200, response.text
    assert len(requests) == 3
    with TestSession() as db:
        lessons = db.query(Lesson).filter_by(course_id=response.json()["id"]).order_by(Lesson.number).all()
        assert [l.source_filename for l in lessons] == ["doc1.pdf.md", "doc2.pdf.md", "doc3.pdf.md"]
        assert all(l.source_blob for l in lessons)
        first, second, third = (l.content for l in lessons)
        assert first.startswith("<!-- page: 1 -->") and "<!-- page: 2 -->" in first
        assert second.startswith("> 原 PDF 共 2 页，PDF 阅读版一次最多转换 3 页，这里只转换了前 1 页")
        assert "<!-- page: 2 -->" not in second
        assert third.startswith("> PDF 阅读版一次最多转换 3 页，这次的页数在前面的文件里用完了") and "<!-- page:" not in third
