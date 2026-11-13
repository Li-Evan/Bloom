"""2026-10-17 全面复查后的修复：后台线程生成、问答停止合并、资料来源规则、进度表、长原文问答。"""
import json
import threading
from datetime import date
from types import SimpleNamespace as NS

import pytest

import app.courses as courses_module
from app.course_language import ZH
from app.models import Annotation, Course, Lesson, Syllabus
from tests.conftest import TestSession, stream_chunk


class StreamingModel:
    """流式回答：先吐一段，等测试放行后再吐完；后台线程照样跑完。"""

    def __init__(self, parts):
        self.parts = parts
        self.release = threading.Event()
        self.chat = NS(completions=NS(create=self.create))

    def create(self, **kwargs):
        def chunks():
            yield stream_chunk(self.parts[0])
            self.release.wait(5)
            for part in self.parts[1:]:
                yield stream_chunk(part)
            yield stream_chunk(None)
        return chunks()

    def close(self):
        pass


def join(prefix):
    for worker in threading.enumerate():
        if worker.name.startswith(prefix):
            worker.join(timeout=10)


@pytest.fixture
def raw_stream(monkeypatch):
    monkeypatch.setattr(courses_module, "StreamingResponse", lambda generator, media_type=None: generator)
    monkeypatch.setattr(courses_module, "SSE_HEARTBEAT_SECONDS", 0.05)


def seed_lesson(owner_uuid):
    with TestSession() as db:
        course = Course(user_uuid=owner_uuid, name="课", mode="topic", status="learning")
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content="# 课 · 课程大纲\n\n- [ ] 能够解释概念"))
        lesson = Lesson(course_id=course.id, number=1, content="# 第一课\n\n正文内容在这里")
        db.add(lesson)
        db.commit()
        return course.id, lesson.id


def annotations(lesson_id):
    with TestSession() as db:
        return [(row.answer, json.loads(row.messages)) for row in db.query(Annotation).filter_by(lesson_id=lesson_id)]


def test_stopping_an_answer_keeps_one_annotation_with_the_complete_answer(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    model = StreamingModel(["前半段", "后半段"])
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    body = {"position_start": 0, "position_end": 2, "original_text": "正文", "comment": "这是什么？", "request_id": "ask-1"}
    db = TestSession()
    generator = courses_module.create_annotation(cid, 1, courses_module.CreateAnnotationRequest(**body), user=user, db=db)
    assert "前半段" in next(line for line in generator if line.startswith("data:"))
    generator.close()  # 用户点了停止

    saved = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={**body, "partial_answer": "前半段"})
    assert saved.status_code == 200
    model.release.set()
    join("annotation-ask")
    db.close()

    [(answer, messages)] = annotations(lesson_id)
    assert answer == "前半段后半段"
    assert messages == [{"role": "user", "content": "这是什么？"}, {"role": "assistant", "content": "前半段后半段"}]


def test_a_stop_saved_after_the_answer_finished_returns_the_complete_one(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    model = StreamingModel(["完整", "回答"])
    model.release.set()
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    body = {"position_start": 0, "position_end": 2, "original_text": "正文", "comment": "这是什么？", "request_id": "ask-1"}
    db = TestSession()
    list(courses_module.create_annotation(cid, 1, courses_module.CreateAnnotationRequest(**body), user=user, db=db))
    db.close()

    saved = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={**body, "partial_answer": "完整"})
    assert saved.json()["answer"] == "完整回答"
    assert len(annotations(lesson_id)) == 1


def test_a_follow_up_stopped_midway_is_replaced_by_the_complete_answer(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    with TestSession() as db:
        row = Annotation(lesson_id=lesson_id, position_start=0, position_end=2, original_text="正文", comment="问一",
                         answer="答一", messages=json.dumps([{"role": "user", "content": "问一"}, {"role": "assistant", "content": "答一"}]))
        db.add(row)
        db.commit()
        aid = row.id
    model = StreamingModel(["追问前半", "追问后半"])
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    db = TestSession()
    generator = courses_module.add_annotation_message(
        cid, 1, aid, courses_module.AddAnnotationMessageRequest(content="问二", request_id="follow-1"), user=user, db=db)
    next(line for line in generator if line.startswith("data:"))
    generator.close()
    authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save",
                       json={"annotation_id": aid, "question": "问二", "partial_answer": "追问前半", "request_id": "follow-1"})
    model.release.set()
    join("annotation-follow-up")
    db.close()

    [(answer, messages)] = annotations(lesson_id)
    assert answer == "追问前半追问后半"
    assert [m["content"] for m in messages] == ["问一", "答一", "问二", "追问前半追问后半"]


def test_save_rejects_reversed_positions_with_422_not_a_database_500(authed_client, user):
    cid, _ = seed_lesson(user.uuid)
    res = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save",
                             json={"position_start": 5, "position_end": 1, "comment": "q", "partial_answer": "a"})
    assert res.status_code == 422


@pytest.mark.parametrize("kind_course, expected", [
    (NS(mode="topic", source_content=None), "none"),
    (NS(mode="source", source_content="原文"), "source"),
    (NS(mode="topic", source_content=json.dumps({"version": courses_module.MATERIAL_ARCHIVE_VERSION, "knowledge_pack": "包", "sections": []})), "material"),
    (NS(mode="topic", source_content="用户粘贴的参考"), "pasted"),
])
def test_reference_kind(kind_course, expected):
    assert courses_module._reference_kind(kind_course) == expected


def test_later_lessons_of_a_course_with_reference_are_not_told_it_has_none():
    rules = courses_module._lesson_prompt_parts("zh", "standard", "", first=False, kind="pasted")["source_rules"]
    assert "没有任何参考资料" not in rules and rules == ZH.rules_reference_course
    assert courses_module._lesson_prompt_parts("zh", "standard", "", first=False, kind="none")["source_rules"] == ZH.rules_without_reference


def test_a_grounded_lesson_may_contain_a_code_block():
    lesson = (
        "# 第一课\n\n## 正文内容\n\n资料指出，循环很重要（来源：a.md，第1节）。\n\n```python\nfor i in range(3):\n    print(i)\n```\n\n"
        "这是另一个要点（来源：a.md，第2节）。\n\n## 思考题\n\n1. 为什么？\n2. 怎么办？\n"
    )
    assert courses_module._grounded_lesson_review_valid(lesson)
    assert not courses_module._grounded_lesson_review_valid(lesson.replace("```\n\n这是", "\n\n这是"))


def test_mastery_comments_match_outline_items_without_their_source_or_question_tags():
    syllabus = ("# 课\n\n- [ ] 能够解释边际效用递减规律并举例说明（来源：经济学原理.pdf，第3章）\n"
                "- [ ] 能够说明需求曲线为什么向下倾斜（来自你的问题）\n")
    lesson = "# 第二课\n\n正文\n\n<!-- mastery: 能够解释边际效用递减规律并举例说明; 能够说明需求曲线为什么向下倾斜 -->"
    assert courses_module._mastery_comment_items(syllabus, lesson) == [
        "能够解释边际效用递减规律并举例说明（来源：经济学原理.pdf，第3章）",
        "能够说明需求曲线为什么向下倾斜（来自你的问题）",
    ]


def test_the_progress_table_never_lists_the_uploaded_source_or_old_duplicate_minus_one_rows():
    syllabus = (
        "# 课\n\n- [ ] 能够解释概念\n\n## 学习进度\n\n| 课文 | 覆盖要点 | 生成日期 |\n|---|---|---|\n"
        "| 第 -1 篇 | 原文 | 10月1日 |\n| 第 -1 篇 | 原文 | 10月1日 |\n| 第 1 篇 | — | 10月1日 |\n"
    )
    updated = courses_module._record_lesson_progress(syllabus, "zh", 2, [], date(2026, 10, 2), [(1, [], date(2026, 10, 1))])
    rows = [line for line in updated.splitlines() if line.startswith("| 第")]
    assert [courses_module._row_lesson_number(line) for line in rows] == [1, 2]


def test_a_question_on_a_long_source_only_sends_the_part_around_the_selection():
    source = "甲" * 100_000 + "关键句子在这里" + "乙" * 100_000
    context = courses_module._annotation_context(source, "关键句子在这里")
    assert "关键句子在这里" in context and len(context) <= courses_module.ANNOTATION_CONTEXT_CHARS + 10
    assert courses_module._annotation_context("短课文", "短") == "短课文"


def test_a_long_course_summary_gets_each_lessons_outline_instead_of_full_text():
    def lesson(number, body):
        return NS(number=number, is_source=False,
                  content=f"# 第{number}课\n\n## 小节\n\n{body}\n\n## 思考题\n\n1. 问？\n\n<!-- mastery: 能够解释概念 -->")
    short = courses_module._summary_lessons_text([lesson(1, "短正文")], ZH)
    assert "短正文" in short
    long = courses_module._summary_lessons_text([lesson(n, "长" * 40_000) for n in (1, 2)], ZH)
    assert "长长长" not in long and "## 小节" in long and "<!-- mastery: 能够解释概念 -->" in long and "问？" in long
    source = NS(number=1, is_source=True, content="原文" * 10)
    assert "原文原文" not in courses_module._summary_lessons_text([source, lesson(2, "x")], ZH)


class LessonModel(StreamingModel):
    """下一篇：流式正文分两段，非流式的核对调用原样返回整篇。"""

    def create(self, **kwargs):
        if kwargs.get("stream"):
            return super().create(**kwargs)
        return NS(choices=[NS(message=NS(content="".join(self.parts)), finish_reason="stop")], usage=None)


def test_leaving_while_the_next_lesson_streams_still_saves_it_once(authed_client, user, raw_stream, monkeypatch):
    cid, _ = seed_lesson(user.uuid)
    model = LessonModel(["# 第二课\n\n正文第一段\n\n", "## 思考题\n\n1. 新问题？\n\n<!-- mastery: 能够解释概念 -->"])
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    db = TestSession()
    generator = courses_module.generate_next_lesson(cid, user=user, db=db)
    assert "正文第一段" in next(line for line in generator if line.startswith("data:"))
    generator.close()  # 锁屏 / 关页面
    assert cid in courses_module._LESSON_SAVING  # 生成期间再点一次会被 409 挡下
    model.release.set()
    join("lesson-next")
    db.close()

    with TestSession() as session:
        saved = session.query(Lesson).filter_by(course_id=cid, number=2).one()
    assert "正文第一段" in saved.content
    assert cid not in courses_module._LESSON_SAVING


def test_a_second_click_while_a_lesson_is_generating_gets_409(authed_client, user, raw_stream, monkeypatch):
    cid, _ = seed_lesson(user.uuid)
    model = LessonModel(["# 第二课\n\n正文\n\n", "## 思考题\n\n1. 问？\n\n<!-- mastery: 能够解释概念 -->"])
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    db = TestSession()
    generator = courses_module.generate_next_lesson(cid, user=user, db=db)
    next(line for line in generator if line.startswith("data:"))
    res = authed_client.post(f"/api/courses/{cid}/next")
    assert res.status_code == 409
    model.release.set()
    list(generator)
    join("lesson-next")
    db.close()


def test_asking_the_same_question_twice_keeps_both_answers(authed_client, user, raw_stream, monkeypatch):
    """正常问完两次同一个问题（不同的 request_id）不能互相覆盖：问了两次，就留两条。"""
    cid, lesson_id = seed_lesson(user.uuid)
    for request_id, parts in (("ask-a", ["第一次", "的回答"]), ("ask-b", ["第二次", "的回答"])):
        model = StreamingModel(parts)
        model.release.set()
        monkeypatch.setattr(courses_module, "get_openai_client", lambda model=model, **kw: model)
        body = {"position_start": 0, "position_end": 2, "original_text": "正文", "comment": "这是什么？", "request_id": request_id}
        db = TestSession()
        list(courses_module.create_annotation(cid, 1, courses_module.CreateAnnotationRequest(**body), user=user, db=db))
        db.close()
    assert sorted(answer for answer, _ in annotations(lesson_id)) == ["第一次的回答", "第二次的回答"]


def test_an_old_client_without_a_request_id_never_merges_into_another_answer(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    model = StreamingModel(["完整", "回答"])
    model.release.set()
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    body = {"position_start": 0, "position_end": 2, "original_text": "正文", "comment": "这是什么？"}
    db = TestSession()
    list(courses_module.create_annotation(cid, 1, courses_module.CreateAnnotationRequest(**body), user=user, db=db))
    db.close()
    saved = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={**body, "partial_answer": "半截"})
    assert saved.json()["answer"] == "半截"
    assert sorted(answer for answer, _ in annotations(lesson_id)) == ["半截", "完整回答"]


def test_stopping_a_repeated_follow_up_preserves_both_turns(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    with TestSession() as db:
        row = Annotation(lesson_id=lesson_id, position_start=0, position_end=2, original_text="正文", comment="问一",
                         answer="旧回答", messages=json.dumps([
                             {"role": "user", "content": "再解释一下"}, {"role": "assistant", "content": "旧回答"},
                         ]))
        db.add(row)
        db.commit()
        aid = row.id
    model = StreamingModel(["新的前半", "新的后半"])
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    with TestSession() as db:
        generator = courses_module.add_annotation_message(
            cid, 1, aid, courses_module.AddAnnotationMessageRequest(content="再解释一下", request_id="follow-new"), user=user, db=db)
        next(line for line in generator if line.startswith("data:"))
        generator.close()
        try:
            payload = {"annotation_id": aid, "question": "再解释一下", "partial_answer": "新的前半", "request_id": "follow-new"}
            first = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json=payload)
            again = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json=payload)
            assert first.status_code == again.status_code == 200
            assert [m["content"] for m in first.json()["messages"]] == ["再解释一下", "旧回答", "再解释一下", "新的前半"]
            assert again.json()["messages"] == first.json()["messages"]
        finally:
            model.release.set()
            join("annotation-follow-up")
    [(answer, messages)] = annotations(lesson_id)
    assert answer == "新的前半新的后半"
    assert [m["content"] for m in messages] == ["再解释一下", "旧回答", "再解释一下", "新的前半新的后半"]


def test_old_follow_up_stop_does_not_guess_a_match_from_the_question(authed_client, user):
    cid, lesson_id = seed_lesson(user.uuid)
    with TestSession() as db:
        row = Annotation(lesson_id=lesson_id, position_start=0, position_end=2, original_text="正文", comment="同一个问题",
                         answer="旧回答", messages=json.dumps([
                             {"role": "user", "content": "同一个问题"}, {"role": "assistant", "content": "旧回答"},
                         ]))
        db.add(row)
        db.commit()
        aid = row.id
    saved = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save",
                               json={"annotation_id": aid, "question": "同一个问题", "partial_answer": "新半截回答"})
    assert saved.status_code == 200
    assert [m["content"] for m in saved.json()["messages"]] == ["同一个问题", "旧回答", "同一个问题", "新半截回答"]


def test_initial_background_completion_preserves_a_later_follow_up(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    model = StreamingModel(["首次前半", "首次后半"])
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    body = {"position_start": 0, "position_end": 2, "original_text": "正文", "comment": "问一", "request_id": "initial"}
    with TestSession() as db:
        generator = courses_module.create_annotation(cid, 1, courses_module.CreateAnnotationRequest(**body), user=user, db=db)
        next(line for line in generator if line.startswith("data:"))
        generator.close()
        try:
            saved = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={**body, "partial_answer": "首次前半"})
            aid = saved.json()["id"]
            follow = StreamingModel(["追问", "回答"])
            follow.release.set()
            monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: follow)
            with TestSession() as follow_db:
                list(courses_module.add_annotation_message(
                    cid, 1, aid, courses_module.AddAnnotationMessageRequest(content="问二", request_id="follow-later"), user=user, db=follow_db))
        finally:
            model.release.set()
            join("annotation-ask")
    [(answer, messages)] = annotations(lesson_id)
    assert [m["content"] for m in messages] == ["问一", "首次前半首次后半", "问二", "追问回答"]
    assert answer == "追问回答"


def test_finished_follow_up_stop_matches_its_id_even_after_another_turn(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    first = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={
        "position_start": 0, "position_end": 2, "original_text": "正文", "comment": "问一", "partial_answer": "答一", "request_id": "initial",
    })
    aid = first.json()["id"]
    inputs = []
    for request_id, answer in (("follow-a", "完整回答 A"), ("follow-b", "完整回答 B")):
        model = StreamingModel([answer])
        model.release.set()
        create = model.create

        def capture_input(create=create, **kwargs):
            inputs.append(kwargs["messages"])
            return create(**kwargs)

        model.chat.completions.create = capture_input
        monkeypatch.setattr(courses_module, "get_openai_client", lambda model=model, **kw: model)
        with TestSession() as db:
            list(courses_module.add_annotation_message(
                cid, 1, aid, courses_module.AddAnnotationMessageRequest(content="相同追问", request_id=request_id), user=user, db=db))
    stopped = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={
        "annotation_id": aid, "question": "相同追问", "partial_answer": "完整", "request_id": "follow-a",
    })
    assert stopped.status_code == 200
    assert [m["content"] for m in stopped.json()["messages"]] == ["问一", "答一", "相同追问", "完整回答 A", "相同追问", "完整回答 B"]
    assert all(set(message) == {"role", "content"} for message in stopped.json()["messages"])
    assert all("request_id" not in message for messages in inputs for message in messages)
    [(answer, messages)] = annotations(lesson_id)
    assert answer == "完整回答 B" and len(messages) == 6


def test_earlier_follow_up_completion_preserves_the_latest_answer(authed_client, user, raw_stream, monkeypatch):
    cid, lesson_id = seed_lesson(user.uuid)
    first = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={
        "position_start": 0, "position_end": 2, "original_text": "正文", "comment": "问一", "partial_answer": "答一", "request_id": "initial",
    })
    aid = first.json()["id"]
    model = StreamingModel(["早期前半", "早期后半"])
    monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: model)
    with TestSession() as db:
        generator = courses_module.add_annotation_message(
            cid, 1, aid, courses_module.AddAnnotationMessageRequest(content="相同追问", request_id="earlier"), user=user, db=db)
        next(line for line in generator if line.startswith("data:"))
        generator.close()
        try:
            saved = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations/save", json={
                "annotation_id": aid, "question": "相同追问", "partial_answer": "早期前半", "request_id": "earlier",
            })
            assert saved.status_code == 200
            later = StreamingModel(["后来回答"])
            later.release.set()
            monkeypatch.setattr(courses_module, "get_openai_client", lambda **kw: later)
            with TestSession() as later_db:
                list(courses_module.add_annotation_message(
                    cid, 1, aid, courses_module.AddAnnotationMessageRequest(content="相同追问", request_id="later"), user=user, db=later_db))
        finally:
            model.release.set()
            join("annotation-follow-up")
    [(answer, messages)] = annotations(lesson_id)
    assert [m["content"] for m in messages] == ["问一", "答一", "相同追问", "早期前半早期后半", "相同追问", "后来回答"]
    assert answer == "后来回答"
