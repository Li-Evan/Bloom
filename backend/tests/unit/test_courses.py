import json
import threading
import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

import app.courses as courses_module
from tests.conftest import mock_stream, seed_source_course


@pytest.fixture
def client(authed_client):
    return authed_client


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
    return mock_stream(chunks)


def _mock_create_course(client, name="博弈论基础", start=True):
    syllabus_resp = _make_mock_response("# 测试课程 · 课程大纲\n\n## 核心掌握项\n\n### 模块一\n- [ ] 能够解释基本概念\n- [ ] 能够应用核心定理")
    lesson_resp = _make_mock_response("# 第一章\n\n正文内容\n\n## 思考题\n\n1. 问题一\n2. 问题二")

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [syllabus_resp, lesson_resp]
        mock_get_client.return_value = mock_client

        res = client.post("/api/courses", json={"name": name})
        assert res.status_code == 200
        if start:
            assert client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200
            return client.get(f"/api/courses/{res.json()['id']}").json()
        return res.json()


def test_create_course(client):
    data = _mock_create_course(client, start=False)
    assert data["name"] == "博弈论基础"
    assert data["status"] == "learning"
    assert data["lesson_count"] == 0
    assert "课程大纲" in data["syllabus_content"]


def test_create_course_passes_learning_depth_to_prompts(client):
    syllabus_resp = _make_mock_response("# 深入课程 · 课程大纲\n\n## 核心掌握项\n\n### 模块一\n- [ ] 能够解释底层机制")
    lesson_resp = _make_mock_response("# 第一章\n\n正文内容")

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [syllabus_resp, lesson_resp]
        mock_get_client.return_value = mock_client

        res = client.post("/api/courses", json={"name": "机器学习", "learning_depth": "deep"})
        assert client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200

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
    data = _mock_create_course(client, start=False)
    new_content = "# 更新后的大纲\n\n- [ ] 能够掌握新的内容"
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
    course = seed_source_course(
        client, "source.txt", "Alpha is the central claim.\nBeta is the premise.", name="原文学习",
        syllabus="# 原文学习 · 课程大纲\n\n## 核心掌握项\n\n### 材料主线\n- [ ] 能够解释原文的中心论证\n- [ ] 能够判断原文论证的关键前提",
    )
    cid = course["id"]
    assert course["mode"] == "source"
    assert course["source_filename"] == "source.txt"
    assert course["lesson_count"] == 0

    lesson = client.get(f"/api/courses/{cid}/lessons/-1").json()
    assert lesson["is_source"] is True
    assert "Alpha is the central claim" in lesson["content"]

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(["Alpha 是原文", "的中心主张。"])
        mock_get_client.return_value = mock_client

        ann = client.post(f"/api/courses/{cid}/lessons/-1/annotations", json={
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

    with patch.object(courses_module, "_generate_first_content", return_value=generated):
        res = client.post(f"/api/courses/{cid}/first")
    assert res.status_code == 200
    assert res.json()["number"] == 1
    assert res.json()["is_source"] is False


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


def test_project_lesson_can_be_marked_read_and_updates_progress(client):
    res = client.post(
        "/api/courses/from-project",
        data={"name": "阅读项目"},
        files=[
            ("files", ("a.txt", b"First uploaded document.", "text/plain")),
            ("files", ("b.txt", b"Second uploaded document.", "text/plain")),
        ],
    )
    assert res.status_code == 200
    cid = res.json()["id"]

    lessons = client.get(f"/api/courses/{cid}/lessons").json()
    assert [lesson["is_read"] for lesson in lessons] == [False, False]
    assert client.get(f"/api/courses/{cid}").json()["mastery_progress"] == 0.0

    marked = client.post(f"/api/courses/{cid}/lessons/1/completed")
    assert marked.status_code == 200
    body = marked.json()
    assert body["is_read"] is True
    assert body["course_completed"] is False
    assert body["mastery_progress"] == 0.5

    # Repeating the action is idempotent and does not change progress.
    repeated = client.post(f"/api/courses/{cid}/lessons/1/completed")
    assert repeated.status_code == 200
    assert repeated.json()["mastery_progress"] == 0.5

    lessons = client.get(f"/api/courses/{cid}/lessons").json()
    assert [lesson["is_read"] for lesson in lessons] == [True, False]
    course = client.get(f"/api/courses/{cid}").json()
    assert course["status"] == "learning"
    assert course["mastery_progress"] == 0.5

    completed = client.post(f"/api/courses/{cid}/lessons/2/completed")
    assert completed.status_code == 200
    assert completed.json()["course_completed"] is True

    course = client.get(f"/api/courses/{cid}").json()
    assert course["status"] == "completed"
    assert course["mastery_progress"] == 1.0


def test_mark_read_nonexistent_lesson(client):
    data = _mock_create_course(client)
    res = client.post(f"/api/courses/{data['id']}/lessons/99/completed")
    assert res.status_code == 404


def test_material_chunk_analysis_honors_requested_concurrency():
    sections = [
        courses_module.MaterialSection("generic.md", f"章节 {index}", "x" * 450)
        for index in range(6)
    ]
    lock = threading.Lock()
    active = 0
    peak = 0

    def fake_call(system_prompt, _user_message, **_kwargs):
        nonlocal active, peak
        if system_prompt == courses_module.MATERIAL_SYNTHESIS_PROMPT:
            return """# 课程参考知识包
## 资料目录
generic.md
## 核心问题与总论点
核心问题
## 概念与定义
概念
## 论证与机制
机制
## 例子、证据与应用
例子
## 边界、反例、争议与限制
边界
## 前置知识与建议教学顺序
顺序
## 来源索引
generic.md：章节 1-6。这里保留足够完整的来源定位内容，用于验证知识包不是被模型截断的半成品，并供后续课程回查原文。每一项核心定义、机制、例子与边界都能通过该索引重新定位到上传材料中的对应章节。
"""
        assert system_prompt == courses_module.MATERIAL_CHUNK_PROMPT
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.03)
        with lock:
            active -= 1
        return "忠实分块笔记（来源：generic.md，章节）"

    with (
        patch.object(courses_module, "MATERIAL_CHUNK_TARGET_CHARS", 500),
        patch.object(courses_module, "_call_llm", side_effect=fake_call),
    ):
        result = courses_module._build_material_knowledge_pack("任意课题", sections, concurrency=3)

    assert "课程参考知识包" in result
    assert peak == 3


def test_material_archive_preserves_raw_sections_and_retrieves_relevant_source():
    sections = [
        courses_module.MaterialSection("concepts.md", "核心概念", "可逆效应使用左逆函数恢复状态。"),
        courses_module.MaterialSection("examples.md", "数据库案例", "连接池消费者必须先于提供者完成停用。"),
    ]
    archive = courses_module._serialize_material_archive("# 课程参考知识包\n完整摘要", sections)

    payload = courses_module._load_material_archive(archive)
    assert payload is not None
    assert len(payload["sections"]) == 2
    assert courses_module._stored_reference_pack(archive).startswith("# 课程参考知识包")

    selected = courses_module._select_relevant_material_sections(archive, "连接池消费者如何停用")
    assert "examples.md" in selected
    assert "连接池消费者" in selected

    oversized = courses_module._serialize_material_archive(
        "# 课程参考知识包\n摘要",
        [courses_module.MaterialSection("large.md", "全文", "连接池" * 20_000)],
    )
    bounded = courses_module._select_relevant_material_sections(oversized, "连接池", max_chars=1_000)
    assert len(bounded) <= 1_000

    future = json.dumps({"version": 99, "knowledge_pack": "# 未来知识包", "sections": [{"text": "raw"}]})
    assert courses_module._stored_reference_pack(future) == "# 未来知识包"
    assert courses_module._select_relevant_material_sections(future, "raw") == ""


def test_lesson_excerpts_put_the_cited_section_first_and_skip_unrelated_ones():
    sections = [
        courses_module.MaterialSection("notes.md", "Intro > 背景", "连接池的背景介绍。"),
        courses_module.MaterialSection("notes.md", "Intro > 停用顺序", "消费者先于提供者停用。"),
        courses_module.MaterialSection("other.md", "附录", "完全无关。"),
    ]
    archive = courses_module._serialize_material_archive("# 课程参考知识包\n摘要", sections)

    selected = courses_module._select_relevant_material_sections(
        archive, "连接池", cited="能够解释停用顺序（来源：notes.md，停用顺序）",
    )

    assert selected.split("\n\n")[0] == "[来源：notes.md；位置：Intro > 停用顺序]\n消费者先于提供者停用。"
    assert "连接池的背景介绍" in selected and "完全无关" not in selected
    assert courses_module.LESSON_MATERIAL_MAX_CHARS == 12_000


def test_a_cited_page_does_not_pull_in_the_pages_whose_number_merely_starts_the_same():
    """英文课的位置是「Page 12」：以前「Page 1」是它的开头，第 1 页被当成写到的那一页排到最前。"""
    sections = [
        courses_module.MaterialSection("rates.pdf", "Page 1", "Cover page and table of contents."),
        courses_module.MaterialSection("rates.pdf", "Page 12", "Refund rate is refunded orders divided by paid orders."),
        courses_module.MaterialSection("rates.pdf", "Page 120", "Index."),
    ]
    archive = courses_module._serialize_material_archive("# Course reference pack\nsummary", sections)

    selected = courses_module._select_relevant_material_sections(
        archive, "refund", language="en", cited="Can explain the refund rate (Source: rates.pdf, Page 12)",
    )

    assert selected == "[Source: rates.pdf; Location: Page 12]\nRefund rate is refunded orders divided by paid orders."


def test_create_topic_course_from_multiple_markdown_materials_and_uses_the_pack_for_the_first_lesson_only(client):
    calls = []
    lock = threading.Lock()

    def fake_call(system_prompt, user_message, **_kwargs):
        with lock:
            calls.append((system_prompt, user_message))
        if system_prompt == courses_module.MATERIAL_CHUNK_PROMPT:
            assert "[来源：concepts.md；位置：核心概念]" in user_message
            assert "[来源：examples.md；位置：案例]" in user_message
            return "定义与案例彼此关联（来源：concepts.md，核心概念；examples.md，案例）"
        if system_prompt == courses_module.MATERIAL_SYNTHESIS_PROMPT:
            return """# 课程参考知识包
## 资料目录
concepts.md、examples.md
## 核心问题与总论点
可追溯知识（来源：concepts.md，核心概念）
## 概念与定义
核心概念
## 论证与机制
概念机制
## 例子、证据与应用
应用案例
## 边界、反例、争议与限制
资料边界
## 前置知识与建议教学顺序
先概念后案例
## 来源索引
concepts.md：核心概念章节；examples.md：案例章节。两个文件的关键位置均已保留，后续大纲和课文可以据此追溯原始材料内容。所有核心定义、论证机制、应用案例与资料边界均可通过此索引定位回对应文件和 Markdown 标题。
"""
        # 大纲校对的提示词末尾接上课程设计的保留规则（course_planning.REVIEW_RULE），所以按开头认
        if system_prompt.startswith(courses_module.GROUNDED_SYLLABUS_REVIEW_PROMPT):
            assert "参考知识包是唯一事实来源" in system_prompt
            items = "\n".join(
                f"- [ ] 能够解释资料核心概念 {index}（来源：concepts.md，核心概念）"
                for index in range(1, 13)
            )
            return f"""# 通用资料课 · 课程大纲

## 核心掌握项

### 主线
{items}

## 不在本课题范围内

- 外部内容

## 学习进度

| 文档 | 覆盖掌握项 | 生成日期 |
|------|-----------|---------|
"""
        if system_prompt == courses_module.GROUNDED_LESSON_REVIEW_PROMPT:
            assert "自造例子只能使用匿名抽象对象" in system_prompt
            return """# 第一课

## 正文内容

资料指出核心概念与案例有关（来源：concepts.md，核心概念）（来源：examples.md，案例）

## 思考题

1. 如何解释核心概念？
2. 如何把它用于案例？

## 你的反馈

> 写下反馈。
"""
        if "课程大纲设计专家" in system_prompt:
            assert "每条掌握项末尾必须附上" in system_prompt
            assert "不得发明材料没有给出的定理推论" in system_prompt
            assert "可追溯知识" in user_message
            items = "\n".join(f"- [ ] 能够解释资料核心概念 {index}" for index in range(1, 13))
            return f"# 通用资料课 · 课程大纲\n\n## 核心掌握项\n\n### 主线\n{items}"
        if "苏格拉底式导师" in system_prompt:
            assert "事实与假设分离" in system_prompt
            assert "问题闭环" in system_prompt
            assert "可追溯知识" in system_prompt
            return """# 第一课

## 正文内容

资料指出核心概念与案例有关（来源：concepts.md，核心概念）（来源：examples.md，案例）

## 思考题

1. 如何解释核心概念？
2. 如何把它用于案例？

## 你的反馈

> 写下反馈。
"""
        raise AssertionError("unexpected prompt")

    with patch.object(courses_module, "_call_llm", side_effect=fake_call):
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "通用资料课", "learning_depth": "deep", "parse_concurrency": "3"},
            files=[
                ("files", ("concepts.md", "# 核心概念\n\n定义内容。".encode(), "text/markdown")),
                ("files", ("examples.md", "# 案例\n\n应用案例。".encode(), "text/markdown")),
            ],
        )

    assert res.status_code == 200
    course = res.json()
    assert course["name"] == "通用资料课"
    assert course["learning_depth"] == "deep"
    assert course["source_filename"] == "2 项参考资料"
    with patch.object(courses_module, "_call_llm", side_effect=fake_call):
        first = client.post(f"/api/courses/{course['id']}/first")
        assert first.status_code == 200, first.text

    streamed = _mock_stream([
        "# 第二课\n\n继续讲解（来源：concepts.md，核心概念）\n\n",
        "## 思考题\n\n1. 新问题\n\n<!-- mastery: 能够解释资料核心概念 -->",
    ])
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = streamed
        mock_get_client.return_value = mock_client
        next_res = client.post(f"/api/courses/{course['id']}/next")

    assert next_res.status_code == 200
    # 知识包在建课时生成、只在首篇（/first）里整包使用；第二篇起不带整包知识包和整份原文，
    # 只带和这一篇相关的资料片段
    first_lesson_prompt = next(system for system, _ in calls if "苏格拉底式导师" in system)
    assert "# 课程参考知识包" in first_lesson_prompt and "可追溯知识" in first_lesson_prompt
    next_system_prompt = mock_client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    assert "# 课程参考知识包" not in next_system_prompt
    assert "可追溯知识" not in next_system_prompt
    assert '"version": 1' not in next_system_prompt
    assert "## 与本篇最相关的资料片段\n[来源：concepts.md；位置：核心概念]\n# 核心概念\n\n定义内容。" in next_system_prompt
    assert "## 资料片段的用法（必须遵守）" in next_system_prompt and "本篇不再附上资料" not in next_system_prompt
    assert "### 第1篇\n# 第一课" in next_system_prompt


def test_material_course_rejects_out_of_range_concurrency(client):
    res = client.post(
        "/api/courses/from-materials",
        data={"name": "测试", "parse_concurrency": "17"},
        files=[("files", ("source.md", b"# Source\n\nBody", "text/markdown"))],
    )
    assert res.status_code == 400
    assert "1-16" in res.json()["detail"]


def test_material_course_keeps_both_same_named_files(client):
    seen = []
    from fastapi import HTTPException

    def sections(raw, filename, language="zh"):
        seen.append(filename)
        raise HTTPException(status_code=400, detail="stop after extraction")
    with patch.object(courses_module, "_material_sections_from_bytes", side_effect=sections):
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "测试"},
            files=[
                ("files", ("a/same.md", b"# One", "text/markdown")),
                ("files", ("b/same.md", b"# Two", "text/markdown")),
            ],
        )
    assert res.json()["detail"] == "stop after extraction"
    assert sorted(seen) == ["same (2).md", "same.md"]


def test_material_course_rejects_known_oversized_upload_before_parsing(client):
    with patch.object(courses_module, "MATERIAL_MAX_FILE_BYTES", 5):
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "测试"},
            files=[("files", ("large.md", b"123456", "text/markdown"))],
        )
    assert res.status_code == 400
    assert "单个参考文件" in res.json()["detail"]


def test_material_pdf_extraction_preserves_page_locators():
    class FakePdfPage:
        def __init__(self, text):
            self.text = text

        def extract_text(self):
            return self.text

    class FakePdfReader:
        def __init__(self, _stream):
            self.pages = [FakePdfPage("第一页"), FakePdfPage("第二页")]

    with patch("app.courses.PdfReader", FakePdfReader):
        sections = courses_module._material_sections_from_bytes(b"%PDF fake", "paper.pdf")

    assert [section.locator for section in sections] == ["第 1 页", "第 2 页"]
    assert [section.text for section in sections] == ["第一页", "第二页"]


def test_a_text_material_is_one_whole_section_and_hash_lines_are_not_headings():
    raw = "# 不是标题\n正文第一段\n\n## 也不是标题\n正文第二段".encode("gb18030")

    sections = courses_module._material_sections_from_bytes(raw, "notes.txt")

    assert [(s.source_name, s.locator) for s in sections] == [("notes.txt", "全文")]
    assert sections[0].text == "# 不是标题\n正文第一段\n\n## 也不是标题\n正文第二段"
    with pytest.raises(HTTPException) as caught:
        courses_module._material_sections_from_bytes(b"x", "slides.pptx")
    assert "PDF、TXT 或 Markdown" in caught.value.detail


def test_material_pdf_accepts_up_to_the_page_limit():
    class FakePdfReader:
        def __init__(self, _stream):
            self.pages = [MagicMock(extract_text=MagicMock(return_value=f"第 {i} 页内容")) for i in range(courses_module.PDF_MAX_PAGES)]

    with patch("app.courses.PdfReader", FakePdfReader):
        sections = courses_module._material_sections_from_bytes(b"%PDF fake", "paper.pdf")

    assert len(sections) == courses_module.PDF_MAX_PAGES == 500


def test_grounded_review_validators_reject_truncation_and_answered_questions():
    draft = """# 课程大纲

## 核心掌握项
- [ ] 能够解释概念（来源：source.md，概念）
- [ ] 能够应用概念（来源：source.md，案例）

## 不在本课题范围内
- 外部知识

## 学习进度
| 文档 | 覆盖掌握项 | 生成日期 |
|------|-----------|---------|
"""
    truncated_review = """以下是校对报告

```markdown
# 课程大纲
## 核心掌握项
- [ ] 复述概念（来源：source.md，概念）
```
"""
    answered_lesson = """# 第一课

正文（来源：source.md，概念）（来源：source.md，案例）

## 思考题
1. 概念的答案是 A。
2. 案例的答案是 B。

## 你的反馈
> 反馈
"""

    assert courses_module._grounded_syllabus_review_valid(draft, truncated_review, "deep") is False
    assert courses_module._grounded_lesson_review_valid(answered_lesson) is False

    wrapped = f"校对说明\n\n```markdown\n{draft}\n```"
    assert courses_module._extract_syllabus_artifact(wrapped).startswith("# 课程大纲")

    overlong = """# 课程大纲
## 核心掌握项
### A
- [ ] A1（来源：a）
- [ ] A2（来源：a）
- [ ] A3（来源：a）
### B
- [ ] B1（来源：b）
- [ ] B2（来源：b）
- [ ] B3（来源：b）
## 不在本课题范围内
- X
## 学习进度
| 文档 | 覆盖掌握项 | 生成日期 |
"""
    trimmed = courses_module._trim_syllabus_mastery_items(overlong, 4)
    assert courses_module._count_mastery_items(trimmed)[1] == 4
    assert "### A" in trimmed and "### B" in trimmed
    assert trimmed.count("- [ ] A") == 2 and trimmed.count("- [ ] B") == 2

    punctuated = answered_lesson.replace("1. 概念的答案是 A。", "1. 为什么概念需要条件，请说明。")
    normalized = courses_module._normalize_lesson_questions(punctuated)
    assert "1. 为什么概念需要条件，请说明？" in normalized

    grounded = courses_module._normalize_grounded_lesson_structure(
        "# 第一课\n\n## 正文内容\n\n从一个例子开始。\n\n## 思考题\n\n- 为什么？\n\n## 你的反馈\n"
    )
    assert "## 正文内容\n\n资料指出，以下内容依据上传材料" in grounded

    wrapped_lesson = f"校对说明\n\n```markdown\n{grounded}\n```"
    assert courses_module._extract_lesson_artifact(wrapped_lesson).startswith("# 第一课")

    sparse_questions = grounded.replace("- 为什么？", "- 为什么？\n- 第二题？\n- 第三题？\n- 第四题？")
    ensured = courses_module._ensure_grounded_lesson_questions(sparse_questions, draft)
    ensured_questions = courses_module._extract_thought_questions(ensured)
    assert sum("？" in line or "?" in line for line in ensured_questions.splitlines()) == 3
