from unittest.mock import patch, MagicMock


def _make_mock_response(content):
    """Create a mock OpenAI non-streaming response."""
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = content
    return response


def _make_mock_stream(content_chunks):
    """Create a mock OpenAI streaming response."""
    chunks = []
    for text in content_chunks:
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = text
        chunks.append(chunk)
    final = MagicMock()
    final.choices = [MagicMock()]
    final.choices[0].delta.content = None
    chunks.append(final)
    return iter(chunks)


def _setup_course(client, syllabus_content=None):
    """Create a course with mocked LLM, return course_id."""
    if syllabus_content is None:
        syllabus_content = "# 测试 · 课程大纲\n\n## 核心掌握项\n\n### 模块一\n- [ ] 能够解释概念"
    syllabus_resp = _make_mock_response(syllabus_content)
    lesson_resp = _make_mock_response("# 第一章\n\n正文\n\n## 思考题\n\n1. 问题")

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [syllabus_resp, lesson_resp]
        mock_get_client.return_value = mock_client
        data = client.post("/api/courses", json={"name": "测试课程"}).json()

    return data["id"]


# --- Annotation Tests ---

def test_create_annotation(client):
    course_id = _setup_course(client)

    with patch("app.courses._call_llm_messages", return_value="这是测试回答。"):
        res = client.post(f"/api/courses/{course_id}/lessons/1/annotations", json={
            "position_start": 10,
            "position_end": 20,
            "original_text": "正文",
            "comment": "这里不太理解",
        })
    assert res.status_code == 200
    data = res.json()
    assert data["original_text"] == "正文"
    assert data["comment"] == "这里不太理解"
    assert data["position_start"] == 10
    assert data["position_end"] == 20


def test_get_annotations(client):
    course_id = _setup_course(client)

    with patch("app.courses._call_llm_messages", return_value="这是测试回答。"):
        client.post(f"/api/courses/{course_id}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 5, "original_text": "文本1", "comment": "???为什么",
        })
        client.post(f"/api/courses/{course_id}/lessons/1/annotations", json={
            "position_start": 10, "position_end": 15, "original_text": "文本2", "comment": "???不懂",
        })

    res = client.get(f"/api/courses/{course_id}/lessons/1/annotations")
    assert res.status_code == 200
    annotations = res.json()
    assert len(annotations) == 2


def test_annotation_nonexistent_lesson(client):
    course_id = _setup_course(client)
    res = client.post(f"/api/courses/{course_id}/lessons/99/annotations", json={
        "position_start": 0, "position_end": 5, "original_text": "text", "comment": "comment",
    })
    assert res.status_code == 404


def test_annotation_invalid_positions(client):
    """position_end < position_start should be rejected."""
    course_id = _setup_course(client)
    res = client.post(f"/api/courses/{course_id}/lessons/1/annotations", json={
        "position_start": 20,
        "position_end": 5,
        "original_text": "text",
        "comment": "comment",
    })
    assert res.status_code == 422


# --- Feedback Tests ---

def test_create_feedback(client):
    course_id = _setup_course(client)

    res = client.post(f"/api/courses/{course_id}/lessons/1/feedback", json={
        "content": "这一章讲得很好，但第二个概念还是不太清楚",
        "thought_answers": '{"q1": "我的答案是..."}',
    })
    assert res.status_code == 200
    data = res.json()
    assert "不太清楚" in data["content"]


def test_update_feedback(client):
    """Submitting feedback twice should update, not duplicate."""
    course_id = _setup_course(client)

    client.post(f"/api/courses/{course_id}/lessons/1/feedback", json={
        "content": "初始反馈",
        "thought_answers": "",
    })
    res = client.post(f"/api/courses/{course_id}/lessons/1/feedback", json={
        "content": "更新后的反馈",
        "thought_answers": '{"q1": "更新答案"}',
    })
    assert res.status_code == 200
    assert res.json()["content"] == "更新后的反馈"


def test_feedback_nonexistent_lesson(client):
    course_id = _setup_course(client)
    res = client.post(f"/api/courses/{course_id}/lessons/99/feedback", json={
        "content": "test", "thought_answers": "",
    })
    assert res.status_code == 404


def test_feedback_plain_text_thought_answers(client):
    """thought_answers accepts plain text (not just JSON)."""
    course_id = _setup_course(client)
    res = client.post(f"/api/courses/{course_id}/lessons/1/feedback", json={
        "content": "反馈",
        "thought_answers": "第1题：我觉得答案是X\n第2题：答案是Y",
    })
    assert res.status_code == 200


# --- Generate Next Lesson Tests ---

def test_generate_next_lesson(client):
    course_id = _setup_course(client)

    # Submit feedback first
    client.post(f"/api/courses/{course_id}/lessons/1/feedback", json={
        "content": "我理解了基本概念",
        "thought_answers": '{"q1": "答案"}',
    })

    next_stream = _make_mock_stream(["# 第二章\n\n## 上一篇思考题复盘\n\n✅ 正确\n\n## 正文\n\n新内容"])

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = next_stream
        mock_get_client.return_value = mock_client

        res = client.post(f"/api/courses/{course_id}/next")
        assert res.status_code == 200
        assert "text/event-stream" in res.headers["content-type"]
        body = res.text
        assert '"done": true' in body

    # Verify new lesson exists
    lessons = client.get(f"/api/courses/{course_id}/lessons").json()
    assert len(lessons) == 2
    assert lessons[1]["number"] == 2


def test_generate_next_completed_course(client):
    course_id = _setup_course(client)

    from sqlalchemy import update
    from app.models import Course
    import app.database as app_database
    with app_database.SessionLocal() as db:
        db.execute(update(Course).where(Course.id == course_id).values(status="completed"))
        db.commit()

    res = client.post(f"/api/courses/{course_id}/next")
    assert res.status_code == 400
    assert "已完结" in res.json()["detail"]


def test_generate_eval_when_all_mastery_done(client):
    """When all syllabus items are checked, next should generate eval article."""
    all_checked = "# 测试 · 课程大纲\n\n## 核心掌握项\n\n### 模块一\n- [x] 能够解释概念"
    course_id = _setup_course(client, syllabus_content=all_checked)

    # Update syllabus to all-checked
    client.put(f"/api/courses/{course_id}/syllabus", json={"content": all_checked})

    eval_stream = _make_mock_stream(["<!-- eval-article -->\n\n# 最终评估\n\n评估内容"])

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = eval_stream
        mock_get_client.return_value = mock_client

        res = client.post(f"/api/courses/{course_id}/next")
        assert res.status_code == 200
        body = res.text
        assert '"done": true' in body
        assert '"is_evaluation": true' in body

    # Verify eval lesson created
    lessons = client.get(f"/api/courses/{course_id}/lessons").json()
    assert len(lessons) == 2
    assert lessons[1]["is_evaluation"] is True


def test_get_summary_not_found(client):
    """Summary should 404 when course not completed."""
    course_id = _setup_course(client)
    res = client.get(f"/api/courses/{course_id}/summary")
    assert res.status_code == 404


def test_summary_generation_after_eval(client):
    """After eval article, next should generate summary and mark course completed."""
    course_id = _setup_course(client)

    # Manually add an eval lesson
    from app.models import Lesson
    import app.database as app_database
    with app_database.SessionLocal() as db:
        eval_lesson = Lesson(
            course_id=course_id, number=2,
            content="<!-- eval-article -->\n# 评估", is_evaluation=True,
        )
        db.add(eval_lesson)
        db.commit()

    summary_stream = _make_mock_stream(["# 学习总结\n\n知识图谱..."])

    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = summary_stream
        mock_get_client.return_value = mock_client

        res = client.post(f"/api/courses/{course_id}/next")
        assert res.status_code == 200
        body = res.text
        assert '"done": true' in body
        assert '"completed": true' in body

    # Verify summary exists and course is completed
    res = client.get(f"/api/courses/{course_id}/summary")
    assert res.status_code == 200
    assert "总结" in res.json()["content"]

    detail = client.get(f"/api/courses/{course_id}").json()
    assert detail["status"] == "completed"


# --- Issue #3: 思考题抽取与复盘对齐 ---

def test_extract_thought_questions():
    """抽取函数应只取出 ## 思考题 区块的全部题目，不混入正文或反馈区。"""
    from app.courses import _extract_thought_questions
    content = (
        "# 第一章\n\n## 正文内容\n\n一些正文。\n\n"
        "## 思考题\n\n1. 第一题问什么？\n2. 第二题问什么？\n3. 第三题问什么？\n\n"
        "## 你的反馈\n\n> 写反馈\n"
    )
    q = _extract_thought_questions(content)
    assert "1. 第一题问什么？" in q
    assert "2. 第二题问什么？" in q
    assert "3. 第三题问什么？" in q
    assert "一些正文" not in q
    assert "写反馈" not in q


def test_extract_thought_questions_absent():
    """没有思考题区块或空内容时返回空字符串。"""
    from app.courses import _extract_thought_questions
    assert _extract_thought_questions("# 标题\n\n没有思考题区块") == ""
    assert _extract_thought_questions("") == ""


def test_next_lesson_prompt_contains_full_questions_when_long(client):
    """回归 issue #3：思考题位于长课文末尾（超过旧的 2000 字符截断）时，
    生成下一篇的 prompt 必须包含完整的真实思考题，而不是被截断丢失。"""
    course_id = _setup_course(client)

    from app.models import Lesson
    import app.database as app_database

    body = "这是一段用于撑长正文的内容。" * 300  # 远超 2000 字符
    q1 = "数组和元组在内存布局上的本质区别是什么？"
    q2 = "什么场景下应该用 loop 而不是 while？请举一个具体例子。"
    q3 = "为什么累加变量 total 必须声明为 mut？不加会发生什么？"
    long_content = (
        f"# 第一章\n\n## 正文内容\n\n{body}\n\n"
        f"## 思考题\n\n1. {q1}\n2. {q2}\n3. {q3}\n\n"
        f"## 你的反馈\n\n> 在此写反馈\n"
    )

    with app_database.SessionLocal() as db:
        lesson = db.query(Lesson).filter(
            Lesson.course_id == course_id, Lesson.number == 1
        ).first()
        lesson.content = long_content
        db.commit()

    client.post(f"/api/courses/{course_id}/lessons/1/feedback", json={
        "content": "懂了", "thought_answers": "",
    })

    next_stream = _make_mock_stream(["# 第二章\n\n## 上一篇思考题复盘\n\n内容"])
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = next_stream
        mock_get_client.return_value = mock_client

        res = client.post(f"/api/courses/{course_id}/next")
        assert res.status_code == 200
        _ = res.text  # 消费流，触发生成

        call_args = mock_client.chat.completions.create.call_args
        messages = call_args.kwargs["messages"]
        prompt_text = "\n".join(m["content"] for m in messages)

    assert q1 in prompt_text, "第1题应出现在 prompt 中"
    assert q2 in prompt_text, "第2题应出现在 prompt 中"
    assert q3 in prompt_text, "第3题应出现在 prompt 中（旧实现会因 2000 字符截断而丢失）"
