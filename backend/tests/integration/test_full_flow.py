"""Integration test: simulate a complete user learning journey.

Flow: create course → read lesson 1 → annotate → feedback → generate lesson 2
     → feedback → mark all mastery done → generate eval → generate summary
     → verify stats throughout.
"""
import json
from unittest.mock import patch, MagicMock


def _sse_done(res):
    """Extract the final `done` event payload from an SSE response."""
    for line in res.text.splitlines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if data.get("done"):
                return data
    return None


def _mock_response(content):
    r = MagicMock()
    r.choices = [MagicMock()]
    r.choices[0].message.content = content
    return r


def _mock_stream(chunks):
    result = []
    for text in chunks:
        c = MagicMock()
        c.choices = [MagicMock()]
        c.choices[0].delta.content = text
        result.append(c)
    end = MagicMock()
    end.choices = [MagicMock()]
    end.choices[0].delta.content = None
    result.append(end)
    return iter(result)


SYLLABUS = """# 测试课题 · 课程大纲

> 这份大纲定义了完成本课题后你将掌握的所有能力。

## 核心掌握项

### 模块一：基础
- [ ] 能够解释核心概念A
- [ ] 能够应用概念A解决简单问题

### 模块二：进阶
- [ ] 能够分析概念B的适用场景
- [ ] 能够综合运用A和B解决复合问题

## 不在本课题范围内

- 不涵盖概念C

## 学习进度

| 文档 | 覆盖掌握项 | 生成日期 |
|------|-----------|---------|
"""

LESSON_01 = """# 认识核心概念A

> 前置知识：无
> 难度：入门
> 预计阅读时间：5 分钟

## 正文内容

**概念A** 是本课题的基石。它描述了...

> 定义：概念A 是指...

举例说明：当我们遇到...

## 思考题

1. 概念A的三个关键特征是什么？
2. 举一个概念A在日常生活中的应用场景。

## 你的反馈

> 在这里写下你的问题、感悟、不理解的地方。
"""

LESSON_02 = """# 概念A的深入应用

> 前置知识：概念A基础
> 难度：进阶
> 预计阅读时间：8 分钟

---

## 上一篇思考题复盘

### 你的回答评估

✅ 第1题：正确，你准确地识别了三个特征。
⚠️ 第2题：部分正确，场景选择合理但分析不够深入。

### 正确答案

**第1题：** 概念A的三个关键特征
> 特征一...特征二...特征三...

**第2题：** 日常应用场景
> 一个典型场景是...

---

## 批注解答

**原文「概念A 是本课题的基石」→ 批注：为什么说是基石？**
因为所有后续概念都建立在A的基础上...

---

## 正文内容

在掌握了概念A之后，我们来看它如何应用于...

## 思考题

1. 概念A和概念B之间有什么联系？
2. 什么情况下概念A会失效？

## 你的反馈

> 在这里写下你的问题。
"""

EVAL_ARTICLE = """<!-- eval-article -->

# 测试课题 · 最终评估

> 本篇为课程评估篇，不含新内容。

---

## 上一篇思考题复盘

### 你的回答评估

✅ 第1题：完全正确。
✅ 第2题：正确，分析到位。

### 正确答案

**第1题：** A和B的联系
> 它们是互补关系...

---

## 批注解答

上一篇中没有批注。

---

## 你的反馈

> 写下你对这门课的最终感想。
"""

SUMMARY = """# 测试课题 · 学习总结

## 知识图谱

- 概念A → 概念B → 综合运用

## 大纲复盘

- ✅ 能够解释核心概念A
- ✅ 能够应用概念A解决简单问题
- ✅ 能够分析概念B的适用场景
- ✅ 能够综合运用A和B解决复合问题

## 关键洞察

学习中最重要的发现...

## 延伸方向

可以进一步探索概念C...
"""


def test_complete_learning_journey(client):
    """Simulate a full user journey from course creation to completion."""

    # ── Step 1: Create course ──
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        res = client.post("/api/courses", json={"name": "测试课题"})

    assert res.status_code == 200
    course = res.json()
    cid = course["id"]
    assert course["status"] == "learning"
    assert course["lesson_count"] == 1
    assert course["mastery_progress"] == 0.0
    assert "课程大纲" in course["syllabus_content"]

    # ── Step 2: Verify course in list ──
    courses = client.get("/api/courses").json()
    assert len(courses) == 1
    assert courses[0]["name"] == "测试课题"

    # ── Step 3: Open lesson 1, verify content ──
    res = client.post(f"/api/courses/{cid}/lessons/1/opened")
    assert res.status_code == 200

    lesson1 = client.get(f"/api/courses/{cid}/lessons/1").json()
    assert "概念A" in lesson1["content"]
    assert lesson1["is_evaluation"] is False

    # ── Step 4: Add annotation to lesson 1 (answer streams back via SSE) ──
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.return_value = _mock_stream(["因为它是后续概念的基础。"])
        mock.return_value = mc
        ann_res = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 10,
            "position_end": 30,
            "original_text": "概念A 是本课题的基石",
            "comment": "为什么说是基石？",
        })
    ann = _sse_done(ann_res)["annotation"]
    assert ann["original_text"] == "概念A 是本课题的基石"

    annotations = client.get(f"/api/courses/{cid}/lessons/1/annotations").json()
    assert len(annotations) == 1

    # ── Step 5: Submit feedback for lesson 1 ──
    fb = client.post(f"/api/courses/{cid}/lessons/1/feedback", json={
        "content": "概念A的定义清晰，但我想知道它和概念B的关系",
        "thought_answers": "第1题：三个特征是X、Y、Z\n第2题：日常应用是购物决策",
    }).json()
    assert "不太清楚" not in fb["content"]  # our actual content

    # ── Step 5b: Verify feedback can be retrieved (GET) ──
    fb_get = client.get(f"/api/courses/{cid}/lessons/1/feedback").json()
    assert fb_get["exists"] is True
    assert "概念A" in fb_get["content"]
    assert "三个特征" in fb_get["thought_answers"]

    # ── Step 6: Generate lesson 2 ──
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.return_value = _mock_stream(
            [LESSON_02[:200], LESSON_02[200:]]
        )
        mock.return_value = mc
        res = client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 200
    body = res.text
    assert '"done": true' in body
    assert '"lesson_number": 2' in body

    # Verify lesson 2 exists
    lessons = client.get(f"/api/courses/{cid}/lessons").json()
    assert len(lessons) == 2
    assert lessons[1]["number"] == 2

    # ── Step 7: Open and read lesson 2 ──
    client.post(f"/api/courses/{cid}/lessons/2/opened")
    lesson2 = client.get(f"/api/courses/{cid}/lessons/2").json()
    assert "思考题复盘" in lesson2["content"]

    # ── Step 8: Submit feedback for lesson 2 ──
    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={
        "content": "A和B的联系讲得很好",
        "thought_answers": "第1题：A和B是互补关系\n第2题：在动态环境中A会失效",
    })

    # ── Step 9: Update syllabus to all-checked → trigger eval ──
    all_checked = SYLLABUS.replace("- [ ]", "- [x]")
    client.put(f"/api/courses/{cid}/syllabus", json={"content": all_checked})

    # Verify mastery progress is now 100%
    detail = client.get(f"/api/courses/{cid}").json()
    assert detail["mastery_progress"] == 1.0

    # ── Step 10: Generate eval article ──
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.return_value = _mock_stream(
            [EVAL_ARTICLE[:100], EVAL_ARTICLE[100:]]
        )
        mock.return_value = mc
        res = client.post(f"/api/courses/{cid}/next")

    body = res.text
    assert '"is_evaluation": true' in body

    lessons = client.get(f"/api/courses/{cid}/lessons").json()
    eval_lesson = [lesson for lesson in lessons if lesson["is_evaluation"]]
    assert len(eval_lesson) == 1
    assert eval_lesson[0]["number"] == 3

    # ── Step 11: After eval, generate summary → course completed ──
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.return_value = _mock_stream(
            [SUMMARY[:100], SUMMARY[100:]]
        )
        mock.return_value = mc
        res = client.post(f"/api/courses/{cid}/next")

    body = res.text
    assert '"completed": true' in body

    # Verify course is completed
    detail = client.get(f"/api/courses/{cid}").json()
    assert detail["status"] == "completed"

    # Verify summary exists
    summary = client.get(f"/api/courses/{cid}/summary").json()
    assert "知识图谱" in summary["content"]

    # ── Step 12: Verify stats ──
    stats = client.get(f"/api/courses/{cid}/stats").json()
    assert stats["total_lessons"] >= 3  # lesson 1, 2, eval
    assert stats["total_annotations"] == 1
    assert stats["total_feedback"] == 2
    assert stats["mastery_checked"] == 4
    assert stats["mastery_total"] == 4
    assert stats["mastery_progress"] == 1.0

    # ── Step 13: Verify global stats ──
    global_stats = client.get("/api/stats").json()
    assert global_stats["total_courses"] == 1
    assert global_stats["completed_courses"] == 1
    assert global_stats["active_courses"] == 0
    assert global_stats["total_lessons_read"] >= 3
    assert global_stats["total_annotations"] == 1
    assert global_stats["total_feedback"] == 2

    # ── Step 14: Cannot generate more after completion ──
    res = client.post(f"/api/courses/{cid}/next")
    assert res.status_code == 400
    assert "已完结" in res.json()["detail"]


def test_feedback_get_empty(client):
    """GET feedback for a lesson with no feedback returns exists=False."""
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        course = client.post("/api/courses", json={"name": "空反馈测试"}).json()

    fb = client.get(f"/api/courses/{course['id']}/lessons/1/feedback").json()
    assert fb["exists"] is False
    assert fb["content"] == ""


def test_lesson_opened_event(client):
    """Recording lesson_opened creates a learning event."""
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        course = client.post("/api/courses", json={"name": "事件测试"}).json()

    cid = course["id"]
    res = client.post(f"/api/courses/{cid}/lessons/1/opened")
    assert res.status_code == 200

    stats = client.get(f"/api/courses/{cid}/stats").json()
    assert stats["first_activity"] is not None
    assert stats["last_activity"] is not None


def test_global_stats_empty(client):
    """Global stats on empty DB returns zeros."""
    stats = client.get("/api/stats").json()
    assert stats["total_courses"] == 0
    assert stats["current_streak"] == 0
    assert stats["longest_streak"] == 0


def test_delete_annotation(client):
    """User can delete an annotation they created."""
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        course = client.post("/api/courses", json={"name": "删除批注测试"}).json()

    cid = course["id"]

    # Create two annotations (each answer streams back via SSE)
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [_mock_stream(["回答一"]), _mock_stream(["回答二"])]
        mock.return_value = mc
        a1 = _sse_done(client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 10,
            "original_text": "概念A", "comment": "这个不太对",
        }))["annotation"]
        a2 = _sse_done(client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 20, "position_end": 30,
            "original_text": "基石", "comment": "为什么是基石",
        }))["annotation"]

    # Verify both exist
    anns = client.get(f"/api/courses/{cid}/lessons/1/annotations").json()
    assert len(anns) == 2

    # Delete first one
    res = client.delete(f"/api/courses/{cid}/lessons/1/annotations/{a1['id']}")
    assert res.status_code == 200

    # Verify only one remains
    anns = client.get(f"/api/courses/{cid}/lessons/1/annotations").json()
    assert len(anns) == 1
    assert anns[0]["id"] == a2["id"]

    # Delete nonexistent should 404
    res = client.delete(f"/api/courses/{cid}/lessons/1/annotations/9999")
    assert res.status_code == 404


def test_delete_course(client):
    """User can delete a course and all related data."""
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        course = client.post("/api/courses", json={"name": "待删除课程"}).json()

    cid = course["id"]

    # Add some data
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.return_value = _mock_stream(["答"])
        mock.return_value = mc
        client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 5,
            "original_text": "test", "comment": "test",
        })
    client.post(f"/api/courses/{cid}/lessons/1/feedback", json={
        "content": "test", "thought_answers": "",
    })

    # Delete
    res = client.delete(f"/api/courses/{cid}")
    assert res.status_code == 200

    # Verify gone
    assert client.get(f"/api/courses/{cid}").status_code == 404
    assert client.get("/api/courses").json() == []


def test_course_list_has_mastery_progress(client):
    """Course list includes mastery_progress."""
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        client.post("/api/courses", json={"name": "进度测试"})

    courses = client.get("/api/courses").json()
    assert courses[0]["mastery_progress"] == 0.0


def test_auto_mastery_check(client):
    """When LLM output contains <!-- mastery: ... -->, syllabus is auto-updated."""
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        course = client.post("/api/courses", json={"name": "自动勾选测试"}).json()

    cid = course["id"]

    # Verify initial progress is 0%
    detail = client.get(f"/api/courses/{cid}").json()
    assert detail["mastery_progress"] == 0.0

    # Submit feedback
    client.post(f"/api/courses/{cid}/lessons/1/feedback", json={
        "content": "ok", "thought_answers": "",
    })

    # Generate lesson 2 with mastery comment
    lesson2_with_mastery = LESSON_02 + "\n\n<!-- mastery: 能够解释核心概念A; 能够应用概念A解决简单问题 -->"
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.return_value = _mock_stream(
            [lesson2_with_mastery[:200], lesson2_with_mastery[200:]]
        )
        mock.return_value = mc
        res = client.post(f"/api/courses/{cid}/next")
        assert res.status_code == 200

    # Verify syllabus was auto-updated: 2 out of 4 items checked
    detail = client.get(f"/api/courses/{cid}").json()
    assert detail["mastery_progress"] == 0.5  # 2/4

    # Verify the syllabus content has [x] items
    syllabus = client.get(f"/api/courses/{cid}/syllabus").json()
    assert "- [x] 能够解释核心概念A" in syllabus["content"]
    assert "- [x] 能够应用概念A解决简单问题" in syllabus["content"]
    # Remaining items still unchecked
    assert "- [ ] 能够分析概念B的适用场景" in syllabus["content"]


def test_lesson_list_has_title_and_feedback_status(client):
    """Lesson list includes extracted title and has_feedback flag."""
    with patch("app.courses.get_openai_client") as mock:
        mc = MagicMock()
        mc.chat.completions.create.side_effect = [
            _mock_response(SYLLABUS),
            _mock_response(LESSON_01),
        ]
        mock.return_value = mc
        course = client.post("/api/courses", json={"name": "标题测试"}).json()

    cid = course["id"]

    # Check title extraction
    lessons = client.get(f"/api/courses/{cid}/lessons").json()
    lesson1 = [lesson for lesson in lessons if lesson["number"] == 1][0]
    assert lesson1["title"] == "认识核心概念A"
    assert lesson1["has_feedback"] is False

    # Submit feedback
    client.post(f"/api/courses/{cid}/lessons/1/feedback", json={
        "content": "很好", "thought_answers": "",
    })

    # Check has_feedback is now True
    lessons = client.get(f"/api/courses/{cid}/lessons").json()
    lesson1 = [lesson for lesson in lessons if lesson["number"] == 1][0]
    assert lesson1["has_feedback"] is True
