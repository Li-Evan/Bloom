import asyncio
import time
from unittest.mock import patch

import httpx

import app.courses as courses_module
from app.config import settings
from app.main import app as fastapi_app
from tests.unit.helpers import SYLLABUS, content_rows

SLOW = 1.0


def post_materials(client, content=b"Alpha is the central claim.", filename="source.txt"):
    return client.post("/api/courses/from-materials", data={"name": "资料"}, files=[("files", (filename, content, "text/plain"))])


def post_project(client, files):
    return client.post("/api/courses/from-project", data={"name": "项目"}, files=[("files", f) for f in files])


def fake_pdf(pages, delay=0.0):
    class Page:
        def extract_text(self):
            time.sleep(delay)
            return "一页文字"

    class Reader:
        def __init__(self, _stream):
            self.pages = [Page() for _ in range(pages)]

    return Reader


def timed_health_while(client_headers, path, **request):
    async def scenario():
        transport = httpx.ASGITransport(app=fastapi_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=client_headers) as http:
            started = time.monotonic()

            async def health():
                await asyncio.sleep(0.2)
                response = await http.get("/api/health")
                return response.status_code, time.monotonic() - started

            upload = asyncio.create_task(http.post(path, **request))
            (status, answered_after), created = await asyncio.gather(health(), upload)
            return status, answered_after, created.status_code, time.monotonic() - started

    return asyncio.run(scenario())


def test_a_slow_model_call_while_creating_a_course_does_not_stall_other_requests(authed_client):
    def slow_model(*_args, **_kwargs):
        time.sleep(SLOW)
        return SYLLABUS

    with patch("app.courses._call_llm", slow_model):
        health, answered_after, created, total = timed_health_while(
            authed_client.headers, "/api/courses", json={"name": "主题"},
        )

    assert (health, created) == (200, 200)
    assert total >= SLOW
    assert answered_after < SLOW / 2


def test_parsing_a_slow_pdf_in_from_project_does_not_stall_other_requests(authed_client):
    with patch("app.courses.PdfReader", fake_pdf(pages=1, delay=SLOW)):
        health, answered_after, created, total = timed_health_while(
            authed_client.headers, "/api/courses/from-project",
            data={"name": "项目"}, files=[("files", ("paper.pdf", b"%PDF", "application/pdf"))],
        )

    assert (health, created) == (200, 200)
    assert total >= SLOW
    assert answered_after < SLOW / 2


def test_from_materials_rejects_a_text_file_longer_than_the_extraction_limit_before_calling_the_model(user, authed_client):
    before = content_rows()

    with patch.object(courses_module, "MATERIAL_MAX_EXTRACTED_CHARS", 10), patch("app.courses._call_llm") as model:
        res = post_materials(authed_client, b"x" * 11)

    assert res.status_code == 400 and "字符" in res.json()["detail"]
    model.assert_not_called()
    assert content_rows() == before


def test_from_materials_has_no_page_count_limit_only_the_extracted_text_limit(user, authed_client):
    # The extracted-character limit already bounds a document; a page count limit only rejected long but small books.
    with patch("app.courses.PdfReader", fake_pdf(pages=2)), patch.object(courses_module, "MATERIAL_MAX_EXTRACTED_CHARS", 1), \
            patch("app.courses._call_llm") as model:
        res = post_materials(authed_client, b"%PDF", "paper.pdf")

    assert res.status_code == 400 and "字符" in res.json()["detail"] and "页限制" not in res.json()["detail"]
    model.assert_not_called()


def test_from_materials_still_reports_an_unreadable_pdf_as_400(authed_client):
    res = post_materials(authed_client, b"not a pdf", "paper.pdf")

    assert res.status_code == 400 and "解析失败" in res.json()["detail"]


def test_from_project_rejects_more_files_than_allowed(user, authed_client, monkeypatch):
    monkeypatch.setattr(settings, "PROJECT_MAX_FILES", 2)
    before = content_rows()

    res = post_project(authed_client, [(f"{i}.md", b"# A", "text/markdown") for i in range(3)])

    assert res.status_code == 400 and "最多" in res.json()["detail"]
    assert content_rows() == before


def test_from_project_accepts_exactly_the_allowed_number_of_files(authed_client, monkeypatch):
    monkeypatch.setattr(settings, "PROJECT_MAX_FILES", 2)

    res = post_project(authed_client, [(f"{i}.md", b"# A", "text/markdown") for i in range(2)])

    assert res.status_code == 200 and res.json()["lesson_count"] == 2


def test_from_project_rejects_an_oversized_file(authed_client):
    before = content_rows()

    with patch.object(courses_module, "MATERIAL_MAX_FILE_BYTES", 10):
        res = post_project(authed_client, [("big.md", b"x" * 11, "text/markdown")])

    assert res.status_code == 400 and "超过单文件" in res.json()["detail"]
    assert content_rows() == before


def test_from_project_rejects_files_whose_total_size_is_too_large(authed_client):
    before = content_rows()

    with patch.object(courses_module, "MATERIAL_MAX_TOTAL_FILE_BYTES", 15):
        res = post_project(authed_client, [("a.md", b"x" * 10, "text/markdown"), ("b.md", b"y" * 10, "text/markdown")])

    assert res.status_code == 400 and "总大小" in res.json()["detail"]
    assert content_rows() == before


def test_from_project_accepts_a_long_pdf(authed_client):
    with patch("app.courses.PdfReader", fake_pdf(pages=600)):
        res = post_project(authed_client, [("paper.pdf", b"%PDF", "application/pdf")])

    assert res.status_code == 200, res.text
