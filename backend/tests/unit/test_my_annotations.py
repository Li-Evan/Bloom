import json
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text as sql_text

from app.main import app as fastapi_app
from app.models import Annotation, Course, Lesson
from app.notes import plain_preview
from tests.conftest import TestSession, seed_course, mock_stream

BASE = datetime(2026, 3, 1, 8, 0, 0)  # 课程引擎的时间列是不带时区的 UTC


def make_course(owner_uuid, name="间隔重复", lessons=((1, "# 第一章 记忆曲线\n\n正文", None),), is_project=False):
    with TestSession() as db:
        course = Course(user_uuid=owner_uuid, name=name, mode="topic", status="learning", is_project=is_project)
        db.add(course)
        db.flush()
        ids = {}
        for number, content, filename in lessons:
            lesson = Lesson(course_id=course.id, number=number, content=content, source_filename=filename)
            db.add(lesson)
            db.flush()
            ids[number] = lesson.id
        db.commit()
        return course.id, ids


def add_annotation(lesson_id, *, comment="这段什么意思？", answer="答案", messages="legacy", created=BASE, updated=None,
                   original_text="原文片段", null_updated=False):
    if messages == "legacy":
        messages = json.dumps(
            [{"role": "user", "content": comment}, {"role": "assistant", "content": answer}], ensure_ascii=False,
        )
    with TestSession() as db:
        row = Annotation(
            lesson_id=lesson_id, position_start=0, position_end=2, original_text=original_text, comment=comment,
            answer=answer, messages=messages, created_at=created, updated_at=updated or created,
        )
        db.add(row)
        db.commit()
        if null_updated:  # 迁移前就存在、又没被回填的行（或迁移期间旧版本写入的行）
            db.execute(sql_text("UPDATE annotations SET updated_at = NULL WHERE id = :id"), {"id": row.id})
            db.commit()
        return row.id


def get(client, **params):
    res = client.get("/api/me/annotations", params=params)
    assert res.status_code == 200, res.text
    return res.json()


def test_requires_login(client):
    assert client.get("/api/me/annotations").status_code == 401


def test_empty_for_a_new_user(authed_client):
    assert get(authed_client) == {"items": [], "page": 1, "limit": 20, "total": 0}


def test_item_shape_and_content(user, authed_client):
    course_id, lessons = make_course(user.uuid)
    aid = add_annotation(
        lessons[1], comment="什么是遗忘曲线？", original_text="遗忘曲线",
        messages=json.dumps([
            {"role": "user", "content": "什么是遗忘曲线？"},
            {"role": "assistant", "content": "**遗忘曲线**描述记忆随时间的衰减。"},
            {"role": "user", "content": "那怎么对抗？"},
            {"role": "assistant", "content": "靠间隔复习。"},
        ], ensure_ascii=False),
        created=BASE, updated=BASE + timedelta(hours=2),
    )

    item = get(authed_client)["items"][0]

    assert set(item) == {
        "id", "course_id", "course_name", "lesson_number", "lesson_title", "original_text", "question",
        "answer_preview", "message_count", "created_at", "updated_at",
    }
    assert item["id"] == aid
    assert (item["course_id"], item["course_name"]) == (course_id, "间隔重复")
    assert (item["lesson_number"], item["lesson_title"]) == (1, "第一章 记忆曲线")
    assert item["original_text"] == "遗忘曲线"
    assert item["question"] == "什么是遗忘曲线？"
    assert item["answer_preview"] == "遗忘曲线描述记忆随时间的衰减。"
    assert item["message_count"] == 4
    created = datetime.fromisoformat(item["created_at"])
    updated = datetime.fromisoformat(item["updated_at"])
    assert created.utcoffset() == timedelta(0) and updated - created == timedelta(hours=2)


def test_newest_session_activity_first_and_a_follow_up_moves_a_session_up(user, authed_client):
    _, lessons = make_course(user.uuid)
    old = add_annotation(lessons[1], created=BASE)
    middle = add_annotation(lessons[1], created=BASE + timedelta(days=1))
    new = add_annotation(lessons[1], created=BASE + timedelta(days=2))
    followed_up = add_annotation(lessons[1], created=BASE - timedelta(days=5), updated=BASE + timedelta(days=3))
    tied = add_annotation(lessons[1], created=BASE + timedelta(days=2))

    ids = [item["id"] for item in get(authed_client)["items"]]

    assert ids == [followed_up, tied, new, middle, old]


def test_a_session_without_updated_at_is_ordered_and_reported_by_its_creation_time(user, authed_client):
    _, lessons = make_course(user.uuid)
    bare = add_annotation(lessons[1], created=BASE + timedelta(days=1), null_updated=True)
    bumped = add_annotation(lessons[1], created=BASE, updated=BASE + timedelta(days=2))
    older_bare = add_annotation(lessons[1], created=BASE - timedelta(days=1), null_updated=True)

    items = get(authed_client)["items"]

    assert [i["id"] for i in items] == [bumped, bare, older_bare]
    assert items[1]["updated_at"] == items[1]["created_at"]


def test_pagination(user, authed_client):
    _, lessons = make_course(user.uuid)
    created = [add_annotation(lessons[1], created=BASE + timedelta(minutes=i)) for i in range(25)]
    newest_first = list(reversed(created))

    first = get(authed_client)
    second = get(authed_client, page=2)
    small = get(authed_client, page=3, limit=10)

    assert (first["page"], first["limit"], first["total"]) == (1, 20, 25)
    assert [i["id"] for i in first["items"]] == newest_first[:20]
    assert [i["id"] for i in second["items"]] == newest_first[20:]
    assert [i["id"] for i in small["items"]] == newest_first[20:]
    assert (small["page"], small["limit"]) == (3, 10)
    assert get(authed_client, page=4, limit=10)["items"] == []


def test_paging_limits(user, authed_client):
    assert authed_client.get("/api/me/annotations?limit=100").status_code == 200
    for query in ("?limit=101", "?limit=0", "?page=0", "?page=10001"):
        assert authed_client.get(f"/api/me/annotations{query}").status_code == 422


def test_course_filter(user, authed_client):
    first_course, first_lessons = make_course(user.uuid, "课程甲")
    second_course, second_lessons = make_course(user.uuid, "课程乙")
    in_first = add_annotation(first_lessons[1])
    in_second = [add_annotation(second_lessons[1], created=BASE + timedelta(minutes=i)) for i in range(2)]

    only_second = get(authed_client, course_id=second_course)

    assert only_second["total"] == 2
    assert [i["id"] for i in only_second["items"]] == list(reversed(in_second))
    assert {i["course_name"] for i in only_second["items"]} == {"课程乙"}
    assert get(authed_client)["total"] == 3
    assert in_first in [i["id"] for i in get(authed_client, course_id=first_course)["items"]]


def test_a_course_with_no_notes_is_an_empty_page_not_a_404(user, authed_client):
    course_id, _ = make_course(user.uuid)

    assert get(authed_client, course_id=course_id) == {"items": [], "page": 1, "limit": 20, "total": 0}


def test_other_peoples_and_missing_courses_are_404(user, other_user, authed_client):
    foreign_course, foreign_lessons = make_course(other_user.uuid, "别人的课")
    add_annotation(foreign_lessons[1])

    for course_id in (foreign_course, 99999):
        res = authed_client.get("/api/me/annotations", params={"course_id": course_id})
        assert res.status_code == 404
        assert res.json()["detail"] == "找不到这门课程"


def test_only_the_users_own_notes_are_listed_and_counted(user, other_user, other_headers, authed_client):
    _, mine = make_course(user.uuid, "我的课")
    _, theirs = make_course(other_user.uuid, "别人的课")
    own = add_annotation(mine[1], comment="我的问题")
    add_annotation(theirs[1], comment="他的问题")
    add_annotation(theirs[1], comment="他的另一个问题")

    body = get(authed_client)

    assert (body["total"], [i["id"] for i in body["items"]]) == (1, [own])
    assert "他的" not in json.dumps(body, ensure_ascii=False)
    theirs_body = TestClient(fastapi_app, headers=other_headers).get("/api/me/annotations").json()
    assert theirs_body["total"] == 2


def test_old_rows_without_a_message_thread_fall_back_to_comment_and_answer(user, authed_client):
    _, lessons = make_course(user.uuid)
    with_answer = add_annotation(lessons[1], comment="旧问题", answer="旧回答", messages="", created=BASE)
    no_answer = add_annotation(lessons[1], comment="没答完的问题", answer="", messages=None, created=BASE + timedelta(days=1))

    items = {i["id"]: i for i in get(authed_client)["items"]}

    assert (items[with_answer]["question"], items[with_answer]["answer_preview"]) == ("旧问题", "旧回答")
    assert items[with_answer]["message_count"] == 2
    assert (items[no_answer]["question"], items[no_answer]["answer_preview"]) == ("没答完的问题", "")
    assert items[no_answer]["message_count"] == 1


@pytest.mark.parametrize("messages", [
    "这不是 JSON",
    json.dumps({"role": "user"}),
    json.dumps([]),
    json.dumps([1, None, "x", {"role": "assistant", "content": 7}, {"content": "没有 role"}]),
])
def test_damaged_threads_never_break_the_list(user, authed_client, messages):
    _, lessons = make_course(user.uuid)
    add_annotation(lessons[1], comment="原问题", answer="原回答", messages=messages)

    item = get(authed_client)["items"][0]

    assert item["question"] == "原问题"
    assert isinstance(item["answer_preview"], str) and isinstance(item["message_count"], int)


def test_the_question_is_the_first_user_message_even_if_the_thread_starts_with_something_else(user, authed_client):
    _, lessons = make_course(user.uuid)
    add_annotation(lessons[1], comment="评论字段", messages=json.dumps([
        {"role": "assistant", "content": "先是回答"}, {"role": "user", "content": "再是提问"},
    ], ensure_ascii=False))

    item = get(authed_client)["items"][0]

    assert (item["question"], item["answer_preview"]) == ("再是提问", "先是回答")


def test_lesson_titles(user, authed_client):
    long_preface = "---\n" + "front matter\n" * 60 + "\n# 太靠后的标题\n"
    _, lessons = make_course(user.uuid, "项目", lessons=[
        (1, "# 有标题\n\n" + "正文" * 100_000, "docs/a.md"),
        (2, "没有任何标题的文件内容", "src/main.py"),
        (3, long_preface, "notes/long.md"),
        (4, "没有标题也没有文件名", None),
        (5, "PDF 阅读版没转出标题", "paper.PDF.md"),
    ], is_project=True)
    for number in lessons:
        add_annotation(lessons[number], created=BASE + timedelta(minutes=number))

    titles = {i["lesson_number"]: i["lesson_title"] for i in get(authed_client)["items"]}

    # 拿文件名当标题时和文件列表一样不带 .md，别的扩展名照常
    assert titles == {1: "有标题", 2: "src/main.py", 3: "notes/long", 4: "", 5: "paper.PDF"}


def test_title_lookup_never_reads_a_whole_lesson(user, authed_client):
    from sqlalchemy import event

    from tests.conftest import engine

    _, lessons = make_course(user.uuid)
    add_annotation(lessons[1])
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", record)
    try:
        get(authed_client)
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert [s for s in statements if "source_blob" in s] == []
    assert [s for s in statements if "lessons.content" in s and "substr" not in s] == []


def test_answer_preview_strips_markdown_and_keeps_200_chars(user, authed_client):
    _, lessons = make_course(user.uuid)
    answer = "## 标题\n\n**加粗**与 `code`，见[链接](https://example.com/x)。\n\n- 要点一\n- 要点二\n\n" + "长" * 400
    add_annotation(lessons[1], answer=answer, messages=json.dumps(
        [{"role": "user", "content": "问"}, {"role": "assistant", "content": answer}], ensure_ascii=False,
    ))

    preview = get(authed_client)["items"][0]["answer_preview"]

    assert preview.startswith("标题 加粗与 code，见链接。 要点一 要点二 长长")
    assert len(preview) == 200
    for mark in ("#", "**", "`", "](", "- "):
        assert mark not in preview


@pytest.mark.parametrize("markdown, expected", [
    ("", ""),
    ("   \n\n  ", ""),
    ("纯文本，没有标记。", "纯文本，没有标记。"),
    ("# 一级\n## 二级\n正文", "一级 二级 正文"),
    ("**粗** *斜* ~~删~~ `码`", "粗 斜 删 码"),
    ("[文字](http://a.b/c) 和 ![图](http://a.b/d.png)", "文字 和 图"),
    ("> 引用\n> 第二行", "引用 第二行"),
    ("1. 一\n2) 二\n* 三\n+ 四\n- 五", "一 二 三 四 五"),
    ("```python\nprint(1)\n```\n结束", "print(1) 结束"),
    ("前<!-- mastery: 隐藏 -->后<br>末", "前后末"),
    ("当 x < 3 且 y > 2 时", "当 x < 3 且 y > 2 时"),
    ("snake_case_name 与 a * b", "snake_case_name 与 a * b"),
    ("#话题 不是标题", "#话题 不是标题"),
])
def test_plain_preview(markdown, expected):
    assert plain_preview(markdown) == expected


@pytest.mark.parametrize("technical", [
    "__init__",
    'if __name__ == "__main__"',
    "List<String> … Map<K, V>",
    "2 * 3 * 4",
    "def __init__(self): pass",
    "x**2 + y**2",
    "Option<T>、Vec<u8>、Box<dyn Trait>、x < y 且 y > z",
    "Set<Object> 与 Map<String, List<Integer>>",
    "__my_var__ = 1",
])
def test_plain_preview_leaves_technical_text_alone(technical):
    assert plain_preview(technical) == technical


@pytest.mark.parametrize("markdown, expected", [
    ("`__init__` 与 `a * b` 与 `List<String>`", "__init__ 与 a * b 与 List<String>"),
    ("```python\nif __name__ == '__main__':\n    print(2 * 3)\n```", "if __name__ == '__main__': print(2 * 3)"),
    ("`**不是加粗**`", "**不是加粗**"),
    ("**调用 `__init__`** 之后", "调用 __init__ 之后"),
    ("__加粗__ 与 __two words__", "加粗 与 two words"),
    ("这是*斜体*文字，**加粗**与普通", "这是斜体文字，加粗与普通"),
    ("<b>粗</b><br/><br />行<div class=\"x\">块</div>", "粗行块"),
    ("<p>段落</p>", "段落"),
])
def test_plain_preview_still_strips_real_markup_around_code(markdown, expected):
    assert plain_preview(markdown) == expected


def test_plain_preview_truncates_to_the_limit_after_stripping():
    assert plain_preview("**" + "字" * 300 + "**") == "字" * 200
    assert plain_preview("甲乙丙丁", limit=2) == "甲乙"
    assert plain_preview("甲乙 丙", limit=3) == "甲乙"  # 不以空格收尾


# ---- updated_at 随会话的新内容刷新（走真实的问答接口）----

def _mock_stream(chunks):
    return mock_stream(chunks)


def _sse_done(res):
    for line in res.text.splitlines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if data.get("done"):
                return data


def _stream_to(client, method, url, chunks, **kwargs):
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(chunks)
        mock_get_client.return_value = mock_client
        res = getattr(client, method)(url, **kwargs)
    assert res.status_code == 200, res.text
    return res


def ask(client, course_id, question):
    res = _stream_to(client, "post", f"/api/courses/{course_id}/lessons/1/annotations", ["回答：", question], json={
        "position_start": 0, "position_end": 2, "original_text": "正文", "comment": question,
    })
    return _sse_done(res)["annotation"]["id"]


def test_follow_ups_and_saved_partial_answers_move_a_session_to_the_top(user, authed_client):
    course_id, _ = make_course(user.uuid, "接口课")

    first = ask(authed_client, course_id, "第一个问题")
    second = ask(authed_client, course_id, "第二个问题")
    assert [i["id"] for i in get(authed_client)["items"]] == [second, first]

    _stream_to(authed_client, "post", f"/api/courses/{course_id}/lessons/1/annotations/{first}/messages",
               ["追问的回答"], json={"content": "追问"})
    after_follow_up = get(authed_client)["items"]
    assert [i["id"] for i in after_follow_up] == [first, second]
    assert after_follow_up[0]["message_count"] == 4
    assert after_follow_up[0]["updated_at"] > after_follow_up[0]["created_at"]
    assert after_follow_up[0]["question"] == "第一个问题"

    res = authed_client.post(f"/api/courses/{course_id}/lessons/1/annotations/save", json={
        "annotation_id": second, "question": "被中断的追问", "partial_answer": "半截回答",
    })
    assert res.status_code == 200
    after_save = get(authed_client)["items"]
    assert [i["id"] for i in after_save] == [second, first]
    assert after_save[0]["message_count"] == 4


def test_a_new_session_is_never_updated_before_it_was_created(user, authed_client):
    course_id, _ = make_course(user.uuid)

    aid = ask(authed_client, course_id, "新问题")
    item = get(authed_client)["items"][0]

    assert item["id"] == aid
    assert datetime.fromisoformat(item["updated_at"]) >= datetime.fromisoformat(item["created_at"])


def test_deleting_a_course_or_an_annotation_removes_its_notes(user, authed_client):
    course_id, annotation_id = seed_course(user.uuid)
    other_course, _ = seed_course(user.uuid, "留下的课")

    assert get(authed_client)["total"] == 2
    assert authed_client.delete(f"/api/courses/{course_id}/lessons/1/annotations/{annotation_id}").status_code == 200
    assert get(authed_client)["total"] == 1
    assert authed_client.delete(f"/api/courses/{other_course}").status_code == 200
    assert get(authed_client)["total"] == 0
