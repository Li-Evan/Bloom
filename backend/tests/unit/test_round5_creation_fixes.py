"""建课路径的修复——调用模型前的 PDF 解析有预算、瞬时错误重试、同名文件、入口校验。"""
import hashlib
import time
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException
from openai import APITimeoutError, InternalServerError, RateLimitError

from app import courses
from app.models import Lesson, Syllabus, UploadSession
from app.notes import plain_preview
from tests.conftest import TestSession, bearer, create_user
from tests.unit.test_outline_workflow import LESSON, OUTLINE, create


def page(text):
    return SimpleNamespace(extract_text=lambda: text)


def reader_of(pages, seen=None):
    def reader(_stream):
        def counted():
            for index, item in enumerate(pages):
                if seen is not None:
                    seen.append(index)
                yield item

        class Pages(list):
            def __iter__(self):
                return counted()
        return SimpleNamespace(pages=Pages(pages))
    return reader


def provider_error(cls, status):
    return cls("gateway hiccup", response=httpx.Response(status, request=httpx.Request("POST", "https://model.test")), body=None)


# --- PDF 解析在调用模型之前，必须有预算 ------------------------------------------------------------------------------------

def test_a_pdf_with_too_many_pages_is_rejected_before_any_text_is_extracted(monkeypatch):
    seen = []
    monkeypatch.setattr(courses, "PdfReader", reader_of([page("x")] * (courses.PDF_MAX_PAGES + 1), seen))
    with pytest.raises(HTTPException) as caught:
        courses._extract_pdf_text(b"%PDF", "huge.pdf")
    assert caught.value.status_code == 400 and caught.value.detail.startswith("PDF 页数超过上限")
    assert seen == []
    with pytest.raises(HTTPException):
        courses._material_sections_from_bytes(b"%PDF", "huge.pdf")


def test_extraction_stops_as_soon_as_the_character_budget_is_spent(monkeypatch):
    seen = []
    big = "字" * 400_000
    monkeypatch.setattr(courses, "PdfReader", reader_of([page(big)] * 10, seen))
    with pytest.raises(HTTPException) as caught:
        courses._extract_pdf_text(b"%PDF", "book.pdf", courses.MATERIAL_MAX_EXTRACTED_CHARS)
    assert caught.value.status_code == 400 and caught.value.detail.startswith("资料文字超过上限")
    assert seen == [0, 1, 2], "第三页就超了 100 万字，后面的页不再解析"

    seen.clear()
    with pytest.raises(HTTPException):
        courses._material_sections_from_bytes(b"%PDF", "book.pdf")
    assert seen == [0, 1, 2]


def test_project_pdfs_keep_the_file_but_truncate_the_extracted_text(monkeypatch):
    monkeypatch.setattr(courses, "PdfReader", reader_of([page("字" * 400_000)] * 10))
    text = courses._extract_pdf_text(b"%PDF", "book.pdf", courses.MATERIAL_MAX_EXTRACTED_CHARS, truncate=True)
    assert len(text) == courses.MATERIAL_MAX_EXTRACTED_CHARS


def test_material_pdfs_skip_garbled_pages_like_source_pdfs(monkeypatch):
    garbled = "�" * 50 + "abc"
    monkeypatch.setattr(courses, "PdfReader", reader_of([page("第一页"), page(garbled), page("第三页")]))
    sections = courses._material_sections_from_bytes(b"%PDF", "paper.pdf")
    assert [s.text for s in sections] == ["第一页", "第三页"]

    monkeypatch.setattr(courses, "PdfReader", reader_of([page(garbled)]))
    with pytest.raises(HTTPException) as caught:
        courses._material_sections_from_bytes(b"%PDF", "paper.pdf")
    assert "无法可靠识别" in caught.value.detail


def test_project_text_files_with_a_bom_or_utf16_are_imported(client):
    headers = bearer(create_user("bom@example.com"))
    files = [
        ("files", ("notes.md", "﻿# 标题\n正文".encode("utf-8"), "text/markdown")),
        ("files", ("wide.md", "# Wide\nbody".encode("utf-16"), "text/markdown")),
        ("files", ("blob.bin", b"\x00\x01\x02", "application/octet-stream")),
    ]
    response = client.post("/api/courses/from-project", headers=headers, files=files)
    assert response.status_code == 200, response.text
    assert response.json()["skipped_files"] == ["blob.bin（暂不支持这种文件格式）"]
    lessons = client.get(f"/api/courses/{response.json()['id']}/lessons", headers=headers).json()
    assert [lesson["title"] for lesson in lessons] == ["标题", "Wide"]


# --- 瞬时错误在剩余时间里重试一次 -------------------------------------------------------------------------------------

@pytest.mark.parametrize("error", [provider_error(InternalServerError, 502), provider_error(RateLimitError, 429),
                                   httpx.ConnectError("reset")], ids=["5xx", "429", "connection"])
def test_a_material_step_survives_one_gateway_hiccup(error, monkeypatch):
    from openai import APIConnectionError
    if isinstance(error, httpx.ConnectError):
        error = APIConnectionError(request=httpx.Request("POST", "https://model.test"))
    calls = []

    def model(*args, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise error
        return "笔记"

    monkeypatch.setattr(courses, "_call_llm", model)
    monkeypatch.setattr(courses.time, "sleep", lambda _: None)
    assert courses._call_material_llm("s", "u", deadline=time.monotonic() + 60) == "笔记"
    assert len(calls) == 2 and all(c["max_retries"] == 0 for c in calls)


def test_a_second_hiccup_or_a_timeout_is_not_retried(monkeypatch):
    errors = [provider_error(InternalServerError, 500), provider_error(InternalServerError, 503)]
    monkeypatch.setattr(courses, "_call_llm", lambda *a, **k: (_ for _ in ()).throw(errors.pop(0)))
    monkeypatch.setattr(courses.time, "sleep", lambda _: None)
    with pytest.raises(InternalServerError):
        courses._call_material_llm("s", "u", deadline=time.monotonic() + 60)

    timeouts = []
    monkeypatch.setattr(courses, "_call_llm", lambda *a, **k: timeouts.append(1) or (_ for _ in ()).throw(
        APITimeoutError(request=httpx.Request("POST", "https://model.test"))))
    with pytest.raises(APITimeoutError):
        courses._call_material_llm("s", "u", deadline=time.monotonic() + 60)
    assert len(timeouts) == 1


def test_the_first_lesson_retries_a_hiccup_but_not_an_empty_answer_outside_material_courses(monkeypatch):
    outcomes = [provider_error(InternalServerError, 502), "课文"]
    monkeypatch.setattr(courses, "_call_llm", lambda *a, **k: (lambda o: (_ for _ in ()).throw(o) if isinstance(o, Exception) else o)(outcomes.pop(0)))
    monkeypatch.setattr(courses.time, "sleep", lambda _: None)
    assert courses._deadline_llm(time.monotonic() + 60, retry_empty=False)("s", "u") == "课文"

    empties = []
    monkeypatch.setattr(courses, "_call_llm", lambda *a, **k: empties.append(1) or (_ for _ in ()).throw(courses.EmptyModelOutput("空")))
    with pytest.raises(courses.EmptyModelOutput):
        courses._deadline_llm(time.monotonic() + 60, retry_empty=False)("s", "u")
    assert len(empties) == 1


# --- 同名文件 ---------------------------------------------------------------------------------------------------------

def test_same_named_files_from_different_folders_can_be_uploaded_and_get_distinct_names(client, monkeypatch):
    headers = bearer(create_user("dup@example.com"))
    data = b"# notes"
    manifest = {"files": [{"name": "notes.md", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}] * 2}
    assert client.post("/api/uploads", headers=headers, json=manifest).status_code == 200

    names = []

    async def extract(file, language="zh"):
        names.append(file.filename)
        return [courses.MaterialSection(file.filename, "全文", "内容")]

    def stop(*args, **kwargs):
        raise HTTPException(400, "stop before the model")

    monkeypatch.setattr(courses, "_extract_material_upload", extract)
    monkeypatch.setattr(courses, "_chunk_material_sections", stop)
    files = [("files", (name, b"# x", "text/markdown")) for name in ("a.md", "a (2).md", "a.md", "dir/a.md")]
    response = client.post("/api/courses/from-materials", headers=headers, data={"name": "课题"}, files=files)
    assert response.json()["detail"] == "stop before the model"
    assert sorted(names) == sorted(["a.md", "a (2).md", "a (3).md", "a (4).md"])


def test_an_invalid_form_does_not_consume_the_upload(client):
    headers = bearer(create_user("keep@example.com"))
    data = b"# notes"
    upload = client.post("/api/uploads", headers=headers, json={"files": [
        {"name": "notes.md", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]}).json()["id"]
    assert client.put(f"/api/uploads/{upload}/files/0/parts/0", headers=headers, content=data).status_code == 200
    bad = client.post("/api/courses/from-materials", headers=headers, data={"name": " ", "upload_id": upload})
    assert bad.status_code == 400 and bad.json()["detail"] == "请输入想学的主题"
    with TestSession() as db:
        assert db.get(UploadSession, upload) is not None


def test_nul_characters_are_rejected_before_any_model_call(authed_client, monkeypatch):
    monkeypatch.setattr(courses, "_call_llm", lambda *a, **k: pytest.fail("model must not be called"))
    res = authed_client.post("/api/courses", json={"name": "课题", "reference": "参考\x00资料"})
    assert res.status_code == 400 and "空字符" in res.json()["detail"]


# --- 首篇 -----------------------------------------------------------------------------------------------------------

def test_a_second_tab_starting_the_course_is_told_the_first_lesson_exists(authed_client):
    cid = create(authed_client)

    def other_tab_finishes_first(*args, **kwargs):
        with TestSession() as db:
            db.add(Lesson(course_id=cid, number=1, content=LESSON, is_source=False))
            db.query(Syllabus).filter_by(course_id=cid).one().content = OUTLINE + "\n| 第 1 篇 | 能够解释概念 | 10月19日 |"
            db.commit()
        return LESSON

    with patch.object(courses, "_generate_first_content", side_effect=other_tab_finishes_first):
        res = authed_client.post(f"/api/courses/{cid}/first")
    assert res.status_code == 409 and res.json()["detail"] == "第一篇已生成，请刷新课程"


# --- 其他 -------------------------------------------------------------------------------------------------------------

def test_long_pathological_inputs_stay_linear():
    started = time.perf_counter()
    plain_preview("*a " * 33_000)
    courses._length_goal("不超过1字" * 10_000, "zh", SimpleNamespace(content="# t\n正文"), source_first=False)
    assert time.perf_counter() - started < 2


@pytest.mark.parametrize("feedback,expected", [
    ("例子控制在200字以内", None), ("思考题回答控制在100字以内", None), ("keep examples under 100 words", None),
    ("整篇不超过800字", 800), ("全文最多500字，例子控制在50字", 500),
])
def test_a_cap_on_part_of_the_lesson_is_not_a_whole_lesson_cap(feedback, expected):
    goal = courses._length_goal(feedback, "zh", SimpleNamespace(content="# t\n" + "正文" * 500), source_first=False)
    assert (goal and goal.target) == expected
