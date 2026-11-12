import json

import pytest

from app import lesson_chat
from app.lesson_chat import material_window, recent, trimmed
from app.models import LearningEvent, Lesson, LessonChat
from tests.conftest import TestSession, seed_course, seed_source_course
from tests.unit.test_course_language import fake_model, sse_events


def answer(system, user):
    return "这篇讲的是复利：利息也会生利息。"


def path(course_id, lesson=1):
    return f"/api/courses/{course_id}/lessons/{lesson}/chat"


def ask(question, anchor=""):
    return {"question": question, "anchor": anchor}


def saved(client, course_id, lesson=1, headers=None):
    res = client.get(path(course_id, lesson), headers=headers)
    assert res.status_code == 200, res.text
    return res.json()["messages"]


@pytest.fixture
def course_id(user):
    return seed_course(user.uuid)[0]


def test_whole_lesson_goes_with_the_question_and_the_answer_is_saved(authed_client, user, course_id):
    with fake_model(answer) as model:
        res = authed_client.post(path(course_id), json=ask("这篇讲了什么？"))

    assert res.status_code == 200, res.text
    events = sse_events(res)
    assert "".join(e.get("content", "") for e in events) == answer("", "")
    assert events[-1] == {"done": True, "answer": answer("", ""), "partial": False}
    [call] = model.calls
    assert call["stream"]
    # 整篇课文在系统提示词里
    assert "# 第一章\n\n正文\n\n## 思考题\n\n1. 问题？" in call["system"]
    assert "材料很长" not in call["system"]
    assert [(m["role"], m["content"]) for m in call["messages"][1:]] == [("user", "这篇讲了什么？")]
    with TestSession() as db:
        assert db.query(LearningEvent).filter_by(course_id=course_id, event_type="lesson_chat_answered").count() == 1
    assert saved(authed_client, course_id) == [
        {"role": "user", "content": "这篇讲了什么？"}, {"role": "assistant", "content": answer("", "")},
    ]


def test_follow_up_questions_carry_the_saved_conversation_from_any_device(authed_client, course_id):
    with fake_model(answer) as model:
        authed_client.post(path(course_id), json=ask("这篇讲了什么？"))
        authed_client.post(path(course_id), json=ask("举个例子？"))

    # 第二问只交了问题本身，前面一轮是后端从库里接上的
    assert [(m["role"], m["content"]) for m in model.calls[1]["messages"][1:]] == [
        ("user", "这篇讲了什么？"), ("assistant", answer("", "")), ("user", "举个例子？"),
    ]
    assert [m["content"] for m in saved(authed_client, course_id)] == [
        "这篇讲了什么？", answer("", ""), "举个例子？", answer("", ""),
    ]
    # 每篇一份
    assert saved(authed_client, course_id, 0) == []


def test_english_course_gets_the_english_prompt(authed_client, course_id):
    with TestSession() as db:
        from app.models import Course
        db.get(Course, course_id).language = "en"
        db.commit()
    with fake_model(answer) as model:
        authed_client.post(path(course_id), json=ask("What is this about?"))
    assert "Answer in English" in model.calls[0]["system"]


def test_long_material_sends_the_part_around_where_the_reader_is(authed_client, auth_headers, monkeypatch):
    client = authed_client
    text = "开头。" * 400 + "中间这段讲的是梯度下降的步长。" + "结尾。" * 400
    course = seed_source_course(client, "long.md", text, headers=auth_headers)
    monkeypatch.setattr(lesson_chat, "ANNOTATION_CONTEXT_CHARS", 1000)
    with fake_model(answer) as model:
        res = client.post(path(course["id"], -1), json=ask("步长是什么？", anchor="中间这段讲的是 梯度下降的步长。"),
                          headers=auth_headers)

    assert sse_events(res)[-1]["partial"] is True
    system = model.calls[0]["system"]
    assert "材料很长，下面只附上学生正在读的位置前后的一段" in system
    assert "中间这段讲的是梯度下降的步长。" in system
    assert system.count("开头。") < 400 and system.count("结尾。") < 400
    assert saved(client, course["id"], -1, auth_headers)[-1] == {"role": "assistant", "content": answer("", ""), "partial": True}


def test_material_window_centres_on_the_anchor_and_falls_back_to_the_start():
    text = "".join(f"第{i}段。" for i in range(1000))
    assert material_window(text, "", len(text)) == (text, False)

    middle, partial = material_window(text, "第500段。", 200)
    assert partial and middle.startswith("……\n") and middle.endswith("\n……") and "第500段。" in middle
    # 往前带四分之一、往后带四分之三
    assert middle.index("第500段。") == len("……\n") + 50

    start, partial = material_window(text, "找不到的句子", 200)
    assert partial and start.startswith("第0段。") and start.endswith("\n……")

    end, _ = material_window(text, "第999段。", 200)
    assert end.endswith("第999段。") and len(end) == 200 + len("……\n")


def test_recent_drops_the_oldest_turns_but_keeps_the_last_question():
    turns = [{"role": "user" if i % 2 == 0 else "assistant", "content": str(i) * 10} for i in range(7)]
    assert [m["content"] for m in recent(turns, budget=35)] == ["4" * 10, "5" * 10, "6" * 10]
    # 截到的第一条是回答时不要它：对话从一个问题开始
    assert [m["content"] for m in recent(turns, budget=25)] == ["6" * 10]
    assert recent([{"role": "user", "content": "x" * 100}], budget=10) == [{"role": "user", "content": "x" * 100}]
    # 存着的「只带了一部分」不交给模型
    assert recent([{"role": "user", "content": "问"}, {"role": "assistant", "content": "答", "partial": True},
                   {"role": "user", "content": "再问"}])[1] == {"role": "assistant", "content": "答"}


def test_only_the_latest_turns_are_kept_and_the_kept_part_starts_with_a_question():
    turns = [{"role": "user" if i % 2 == 0 else "assistant", "content": str(i)} for i in range(lesson_chat.MAX_STORED + 3)]
    kept = trimmed(turns)
    assert kept[0]["role"] == "user" and kept[-1] == turns[-1] and len(kept) == lesson_chat.MAX_STORED - 1


@pytest.mark.parametrize("body", [
    {},
    {"question": ""},
    {"question": "  \n "},
    {"question": "x" * (lesson_chat.MAX_MESSAGE_CHARS + 1)},
    {"question": "问", "extra": 1},
    {"question": "问", "anchor": "x" * (lesson_chat.ANCHOR_CHARS + 1)},
    # 对话存在浏览器里时（2026-11-08）页面交整段对话；现在只收这次的问题
    {"messages": [{"role": "user", "content": "问"}]},
])
def test_bad_requests_are_refused_before_calling_the_model(authed_client, user, course_id, body):
    with fake_model(answer) as model:
        assert authed_client.post(path(course_id), json=body).status_code == 422
    assert model.calls == []


def test_someone_elses_course_or_a_missing_lesson_is_not_found(client, auth_headers, other_headers, course_id):
    with fake_model(answer) as model:
        assert client.post(path(course_id), json=ask("问"), headers=other_headers).status_code == 404
        assert client.post(path(course_id, 9), json=ask("问"), headers=auth_headers).status_code == 404
    assert model.calls == []
    for headers, lesson in ((other_headers, 1), (auth_headers, 9)):
        assert client.get(path(course_id, lesson), headers=headers).status_code == 404
        assert client.delete(path(course_id, lesson), headers=headers).status_code == 404


def test_model_failure_is_an_error_event_and_nothing_is_saved(authed_client, user, course_id):
    def broken(system, user):
        raise RuntimeError("gateway down")

    with fake_model(broken):
        res = authed_client.post(path(course_id), json=ask("问"))
    [event] = sse_events(res)
    assert event["error"].startswith("没能回答这条提问，请稍后重试（原因：")
    with TestSession() as db:
        assert db.query(LearningEvent).filter_by(course_id=course_id, event_type="lesson_chat_answered").count() == 0
    # 没答成的不存
    assert saved(authed_client, course_id) == []


def test_a_lesson_without_readable_text_is_refused_before_calling_the_model(authed_client, user, course_id):
    from app.models import Lesson
    with TestSession() as db:
        db.query(Lesson).filter_by(course_id=course_id, number=1).update({"content": "  \n"})
        db.commit()
    with fake_model(answer) as model:
        res = authed_client.post(path(course_id), json=ask("这篇讲了什么？"))
    assert res.status_code == 400 and res.json()["detail"] == lesson_chat.NO_TEXT
    assert model.calls == []


def test_clearing_deletes_only_my_conversation_on_this_lesson(client, auth_headers, user, other_user, course_id):
    turn = {"messages": [{"role": "user", "content": "问"}]}
    with TestSession() as db:
        lesson_ids = dict(db.query(Lesson.number, Lesson.id).filter_by(course_id=course_id))
        for user_uuid, number in ((user.uuid, 1), (other_user.uuid, 1), (user.uuid, 0)):
            db.add(LessonChat(lesson_id=lesson_ids[number], user_uuid=user_uuid, messages=json.dumps(turn["messages"], ensure_ascii=False)))
        db.commit()

    assert client.delete(path(course_id), headers=auth_headers).status_code == 200
    assert saved(client, course_id, headers=auth_headers) == []
    assert saved(client, course_id, 0, auth_headers) == turn["messages"]
    with TestSession() as db:  # 别人在同一篇上的那份（直接写进库里的）不受影响
        [other] = db.query(LessonChat).filter_by(lesson_id=lesson_ids[1], user_uuid=other_user.uuid).all()
        assert json.loads(other.messages) == turn["messages"]


def test_conversations_go_with_their_lesson():
    # 和划线翻译一样，课文删了靠外键一起删
    [fk] = LessonChat.__table__.c.lesson_id.foreign_keys
    assert fk.column.table.name == "lessons" and fk.ondelete == "CASCADE"
