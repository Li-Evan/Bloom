import json
from unittest.mock import patch, MagicMock


def _sse_done(res):
    """Extract the final `done` event payload from an SSE (text/event-stream) response."""
    for line in res.text.splitlines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if data.get("done"):
                return data
    return None


def _make_mock_response(content):
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = content
    return response


def _mock_stream(chunks):
    result = []
    for text in chunks:
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = text
        result.append(chunk)
    end = MagicMock()
    end.choices = [MagicMock()]
    end.choices[0].delta.content = None
    result.append(end)
    return iter(result)


def _mock_create_course(client, name="博弈论基础"):
    syllabus_resp = _make_mock_response("# 测试课程 · 课程大纲\n\n## 核心掌握项\n\n### 模块一\n- [ ] 能够解释基本概念\n- [ ] 能够应用核心定理")
    lesson_resp = _make_mock_response("# 第一章\n\n正文内容\n\n## 思考题\n\n1. 问题一\n2. 问题二")

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [syllabus_resp, lesson_resp]
        mock_get_client.return_value = mock_client

        res = client.post("/api/courses", json={"name": name})
        assert res.status_code == 200
        return res.json()


def test_create_course(client):
    data = _mock_create_course(client)
    assert data["name"] == "博弈论基础"
    assert data["status"] == "learning"
    assert data["lesson_count"] == 1
    assert "课程大纲" in data["syllabus_content"]


def test_create_course_passes_learning_depth_to_prompts(client):
    syllabus_resp = _make_mock_response("# 深入课程 · 课程大纲\n\n## 核心掌握项\n\n### 模块一\n- [ ] 能够解释底层机制")
    lesson_resp = _make_mock_response("# 第一章\n\n正文内容")

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [syllabus_resp, lesson_resp]
        mock_get_client.return_value = mock_client

        res = client.post("/api/courses", json={"name": "机器学习", "learning_depth": "deep"})

    assert res.status_code == 200
    calls = mock_client.chat.completions.create.call_args_list
    syllabus_messages = calls[0].kwargs["messages"]
    lesson_messages = calls[1].kwargs["messages"]
    assert "学习深度：深入" in syllabus_messages[0]["content"]
    assert "12-15 条掌握项" in syllabus_messages[0]["content"]
    assert "学习深度：深入" in syllabus_messages[1]["content"]
    assert "按「深入」学习深度" in lesson_messages[1]["content"]


def test_list_courses(client):
    _mock_create_course(client)
    res = client.get("/api/courses")
    assert res.status_code == 200
    courses = res.json()
    assert len(courses) == 1
    assert courses[0]["name"] == "博弈论基础"


def test_get_course_detail(client):
    data = _mock_create_course(client)
    res = client.get(f"/api/courses/{data['id']}")
    assert res.status_code == 200
    detail = res.json()
    assert detail["name"] == "博弈论基础"
    assert "课程大纲" in detail["syllabus_content"]


def test_get_course_nonexistent(client):
    res = client.get("/api/courses/9999")
    assert res.status_code == 404


def test_get_syllabus(client):
    data = _mock_create_course(client)
    res = client.get(f"/api/courses/{data['id']}/syllabus")
    assert res.status_code == 200
    assert "课程大纲" in res.json()["content"]


def test_update_syllabus(client):
    data = _mock_create_course(client)
    new_content = "# 更新后的大纲\n\n- [x] 已掌握的内容"
    res = client.put(f"/api/courses/{data['id']}/syllabus", json={"content": new_content})
    assert res.status_code == 200
    assert res.json()["content"] == new_content


def test_list_lessons(client):
    data = _mock_create_course(client)
    res = client.get(f"/api/courses/{data['id']}/lessons")
    assert res.status_code == 200
    lessons = res.json()
    assert len(lessons) == 1
    assert lessons[0]["number"] == 1


def test_get_lesson(client):
    data = _mock_create_course(client)
    res = client.get(f"/api/courses/{data['id']}/lessons/1")
    assert res.status_code == 200
    assert "第一章" in res.json()["content"]


def test_get_lesson_nonexistent(client):
    data = _mock_create_course(client)
    res = client.get(f"/api/courses/{data['id']}/lessons/99")
    assert res.status_code == 404


def test_source_course_txt_highlight_answer_and_next_lesson(client):
    syllabus_resp = _make_mock_response(
        "# 原文学习 · 课程大纲\n\n## 核心掌握项\n\n### 材料主线\n- [ ] 能够解释原文的中心论证\n- [ ] 能够判断原文论证的关键前提"
    )

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = syllabus_resp
        mock_get_client.return_value = mock_client

        res = client.post(
            "/api/courses/from-source",
            data={"name": "原文学习"},
            files={"file": ("source.txt", b"Alpha is the central claim.\nBeta is the premise.", "text/plain")},
        )

    assert res.status_code == 200
    course = res.json()
    cid = course["id"]
    assert course["mode"] == "source"
    assert course["source_filename"] == "source.txt"
    assert course["lesson_count"] == 1

    lesson = client.get(f"/api/courses/{cid}/lessons/1").json()
    assert lesson["is_source"] is True
    assert "Alpha is the central claim" in lesson["content"]

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(["Alpha 是原文", "的中心主张。"])
        mock_get_client.return_value = mock_client

        ann = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0,
            "position_end": 5,
            "original_text": "Alpha",
            "comment": "这里是什么意思？",
            "answer_immediately": True,
        })

    assert ann.status_code == 200
    done = _sse_done(ann)
    assert done is not None and "中心主张" in done["annotation"]["answer"]

    generated = """# 从中心主张开始

## 划线问题复盘

你问的是 Alpha 的含义。

## 正文内容

Alpha 是材料的中心主张。

## 思考题

1. Beta 为什么能支撑 Alpha？

## 你的反馈

> 写下反馈。

<!-- mastery: 能够解释原文的中心论证 -->
"""

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream([generated[:80], generated[80:]])
        mock_get_client.return_value = mock_client

        res = client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 200
    assert '"lesson_number": 2' in res.text

    next_lesson = client.get(f"/api/courses/{cid}/lessons/2").json()
    assert next_lesson["is_source"] is False
    assert "划线问题复盘" in next_lesson["content"]


def test_source_course_passes_learning_depth_to_syllabus_prompt(client):
    syllabus_resp = _make_mock_response(
        "# 原文学习 · 课程大纲\n\n## 核心掌握项\n\n### 主干\n- [ ] 能够解释原文主线"
    )

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = syllabus_resp
        mock_get_client.return_value = mock_client

        res = client.post(
            "/api/courses/from-source",
            data={"name": "原文学习", "learning_depth": "simple"},
            files={"file": ("source.txt", b"Alpha is the central claim.", "text/plain")},
        )

    assert res.status_code == 200
    messages = mock_client.chat.completions.create.call_args.kwargs["messages"]
    assert "学习深度：简单" in messages[0]["content"]
    assert "8-10 条掌握项" in messages[0]["content"]
    assert "学习深度：简单" in messages[1]["content"]


def test_highlight_creates_session_with_thread(client):
    data = _mock_create_course(client)
    cid = data["id"]

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(["这是对划线", "内容的即时回答。"])
        mock_get_client.return_value = mock_client

        ann = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0,
            "position_end": 4,
            "original_text": "正文内容",
            "comment": "这段在讲什么？",
            "anchor_top": 320,
        })

    assert ann.status_code == 200
    body = _sse_done(ann)["annotation"]
    # Every highlight now produces an answered Q&A session (streamed back via SSE)
    assert "即时回答" in body["answer"]
    assert body["anchor_top"] == 320
    assert len(body["messages"]) == 2
    assert body["messages"][0]["role"] == "user"
    assert body["messages"][0]["content"] == "这段在讲什么？"
    assert body["messages"][1]["role"] == "assistant"


def test_highlight_session_followup(client):
    data = _mock_create_course(client)
    cid = data["id"]

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(["第一轮回答。"])
        mock_get_client.return_value = mock_client
        ann_res = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 4,
            "original_text": "正文内容", "comment": "第一个问题",
        })

    aid = _sse_done(ann_res)["annotation"]["id"]

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(["追问的", "回答。"])
        mock_get_client.return_value = mock_client
        res = client.post(
            f"/api/courses/{cid}/lessons/1/annotations/{aid}/messages",
            json={"content": "那再追问一下呢？"},
        )

    assert res.status_code == 200
    body = _sse_done(res)["annotation"]
    assert len(body["messages"]) == 4
    assert body["messages"][2]["content"] == "那再追问一下呢？"
    assert "追问的回答" in body["messages"][3]["content"]
    assert "追问的回答" in body["answer"]


def test_highlight_followup_nonexistent_annotation(client):
    data = _mock_create_course(client)
    cid = data["id"]
    res = client.post(
        f"/api/courses/{cid}/lessons/1/annotations/9999/messages",
        json={"content": "追问"},
    )
    assert res.status_code == 404


def test_source_course_md_upload(client):
    syllabus_resp = _make_mock_response(
        "# Markdown 原文 · 课程大纲\n\n## 核心掌握项\n\n### 材料主线\n- [ ] 能够解释 Markdown 材料的中心论证"
    )

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = syllabus_resp
        mock_get_client.return_value = mock_client

        res = client.post(
            "/api/courses/from-source",
            data={"name": ""},
            files={"file": ("source.md", b"# Title\n\nMarkdown body.", "text/markdown")},
        )

    assert res.status_code == 200
    course = res.json()
    assert course["name"] == "source"
    assert course["mode"] == "source"
    assert course["source_filename"] == "source.md"

    lesson = client.get(f"/api/courses/{course['id']}/lessons/1").json()
    assert lesson["is_source"] is True
    assert "# Title" in lesson["content"]


def test_project_pdf_upload_keeps_file_and_uses_extracted_text_for_highlight_context(client):
    class FakePdfPage:
        def extract_text(self):
            return "PDF context paragraph for highlight answers."

    class FakePdfReader:
        def __init__(self, _stream):
            self.pages = [FakePdfPage()]

    with patch("app.courses.PdfReader", FakePdfReader):
        res = client.post(
            "/api/courses/from-project",
            data={"name": "PDF 项目"},
            files=[("files", ("paper.pdf", b"%PDF fake bytes", "application/pdf"))],
        )

    assert res.status_code == 200
    course = res.json()
    cid = course["id"]

    lesson = client.get(f"/api/courses/{cid}/lessons/1").json()
    assert lesson["is_source"] is True
    assert lesson["source_filename"] == "paper.pdf"
    assert "PDF context paragraph" in lesson["content"]

    file_res = client.get(f"/api/courses/{cid}/lessons/1/file")
    assert file_res.status_code == 200
    assert file_res.content == b"%PDF fake bytes"
    assert file_res.headers["content-type"].startswith("application/pdf")

    pdf_position = '{"page":1,"rects":[{"page":1,"x":0.1,"y":0.2,"w":0.3,"h":0.04}]}'
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(["PDF 划线回答。"])
        mock_get_client.return_value = mock_client

        ann = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0,
            "position_end": 13,
            "original_text": "PDF context",
            "comment": "这段 PDF 在讲什么？",
            "anchor_top": 240,
            "pdf_position": pdf_position,
        })

    assert ann.status_code == 200
    system_prompt = mock_client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    assert "PDF context paragraph for highlight answers." in system_prompt
    assert "\nNone\n" not in system_prompt
    body = _sse_done(ann)["annotation"]
    assert body["pdf_position"] == pdf_position
    assert body["anchor_top"] == 240
    assert "PDF 划线回答" in body["answer"]
