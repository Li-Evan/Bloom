"""课文元信息里的「预计阅读时间」由代码按字数重算：首篇、下一篇、评估篇，三档深度一致。"""
import pytest

import app.courses as courses_module
from app.models import Syllabus
from tests.conftest import TestSession
from tests.unit.test_course_language import fake_model, next_lesson, sse_events, syllabus_text

ZH_BODY = "系统思考" * 300  # 1200 个汉字 → 3 分钟


def zh_lesson(minutes_line="> 预计阅读时间：20 分钟"):
    return f"# 标题\n\n> 前置知识：无\n> 难度：入门\n{minutes_line}\n\n## 正文内容\n\n{ZH_BODY}\n\n## 思考题\n\n1. 为什么？\n2. 如何？\n"


def en_lesson(minutes_line="> Estimated reading time: 15 minutes", words=500):
    body = "word " * words
    return f"# Title\n\n> Prerequisites: none\n> Difficulty: Beginner\n{minutes_line}\n\n## Main content\n\n{body}\n\n## Reflection questions\n\n1. Why?\n2. How?\n"


def test_the_chinese_line_is_recomputed_from_the_length():
    out = courses_module._stamp_reading_time(zh_lesson())

    assert "> 预计阅读时间：4 分钟" in out and "20 分钟" not in out  # 1200 字 + 标题、题目等约 1210 字 → 4 分钟
    assert out.count("预计阅读时间") == 1


def test_the_english_line_is_recomputed_with_the_240_words_a_minute_rule():
    out = courses_module._stamp_reading_time(en_lesson())

    assert "> Estimated reading time: 3 minutes" in out and "15 minutes" not in out


def test_one_minute_is_singular_and_the_estimate_is_at_least_one():
    out = courses_module._stamp_reading_time(en_lesson(words=10))

    assert "> Estimated reading time: 1 minute\n" in out


@pytest.mark.parametrize("line,expected", [
    ("> 预计阅读时间: 20分钟", "> 预计阅读时间: 4 分钟"),
    (">预计阅读时间：二十分钟", ">预计阅读时间：4 分钟"),
    ("> 预计阅读时间： ", "> 预计阅读时间： 4 分钟"),
    ("预计阅读时间：20 分钟", "预计阅读时间：4 分钟"),
    ("**预计阅读时间：** 20 分钟", "**预计阅读时间：** 4 分钟"),
    ("**预计阅读时间**：20 分钟", "**预计阅读时间**：4 分钟"),
    ("> **预计阅读时间：20 分钟**", "> **预计阅读时间：4 分钟**"),
    ("- 预计阅读时间：20 分钟", "- 预计阅读时间：4 分钟"),
    ("> 预计阅读时长：20 分钟", "> 预计阅读时长：4 分钟"),
    ("> 阅读时间：20 分钟", "> 阅读时间：4 分钟"),
], ids=lambda value: value[:22])
def test_the_chinese_item_is_found_in_every_spelling_and_only_its_value_changes(line, expected):
    out = courses_module._stamp_reading_time(zh_lesson(line))

    assert f"\n{expected}\n\n" in out


@pytest.mark.parametrize("line,expected", [
    ("> estimated reading time: about 12 min", "> estimated reading time: 3 minutes"),
    (">Estimated Reading Time:15 minutes", ">Estimated Reading Time:3 minutes"),
    ("**Estimated reading time:** 15 minutes", "**Estimated reading time:** 3 minutes"),
    ("**Estimated reading time**: 15 minutes", "**Estimated reading time**: 3 minutes"),
    ("Estimated reading time： 15 minutes", "Estimated reading time： 3 minutes"),
    ("> Reading time: 9 min", "> Reading time: 3 minutes"),
    ("> Estimated read time: 9", "> Estimated read time: 3 minutes"),
    ("Estimated reading time: 15 minutes", "Estimated reading time: 3 minutes"),
], ids=lambda value: value[:24])
def test_the_english_item_is_found_in_every_spelling_and_only_its_value_changes(line, expected):
    out = courses_module._stamp_reading_time(en_lesson(line))

    assert f"\n{expected}\n\n" in out


@pytest.mark.parametrize("line,expected", [
    ("前置知识：无 | 难度：入门 | 预计阅读时间：8 分钟", "前置知识：无 | 难度：入门 | 预计阅读时间：4 分钟"),
    ("> 前置知识：无 ｜ 预计阅读时间：8 分钟 ｜ 难度：入门", "> 前置知识：无 ｜ 预计阅读时间：4 分钟 ｜ 难度：入门"),
    ("预计阅读时间：8 分钟 · 难度：入门", "预计阅读时间：4 分钟 · 难度：入门"),
])
def test_in_a_line_with_several_items_only_the_reading_time_changes(line, expected):
    assert f"\n{expected}\n\n" in courses_module._stamp_reading_time(zh_lesson(line))


def test_the_english_line_with_several_items_changes_only_its_item():
    line = "Prerequisites: none | Difficulty: Beginner | Estimated reading time: 9 minutes"

    out = courses_module._stamp_reading_time(en_lesson(line))

    assert "\nPrerequisites: none | Difficulty: Beginner | Estimated reading time: 3 minutes\n\n" in out


@pytest.mark.parametrize("ending", ["  ", "   ", "\\", " \\", "\t "])
def test_a_hard_line_break_at_the_end_of_the_line_is_kept(ending):
    out = courses_module._stamp_reading_time(zh_lesson(f"> 预计阅读时间：20 分钟{ending}"))
    out_en = courses_module._stamp_reading_time(en_lesson(f"> Estimated reading time: 15 minutes{ending}"))

    assert f"\n> 预计阅读时间：4 分钟{ending}\n" in out
    assert f"\n> Estimated reading time: 3 minutes{ending}\n" in out_en


def test_a_sentence_in_the_body_that_happens_to_say_reading_time_is_not_touched():
    lesson = zh_lesson("> 预计阅读时间：20 分钟").replace(
        "## 思考题", "## 正文二\n\n合理安排阅读时间：每天半小时。\n\n阅读时间：越短越好。\n\n## 思考题",
    )

    out = courses_module._stamp_reading_time(lesson)

    assert "合理安排阅读时间：每天半小时。" in out and "\n阅读时间：越短越好。\n" in out
    assert "> 预计阅读时间：4 分钟" in out


def test_only_the_first_matching_item_is_rewritten():
    meta = "> 预计阅读时间：20 分钟\n> 阅读时间：30 分钟"

    out = courses_module._stamp_reading_time(zh_lesson(meta))

    assert "> 预计阅读时间：4 分钟\n> 阅读时间：30 分钟" in out


def test_both_spellings_are_recognised_whatever_the_course_language():
    zh_in_english_text = en_lesson("> 预计阅读时间：5 分钟")
    en_in_chinese_text = zh_lesson("> Estimated reading time: 5 minutes")

    assert "> 预计阅读时间：3 分钟" in courses_module._stamp_reading_time(zh_in_english_text)
    assert "> Estimated reading time: 4 minutes" in courses_module._stamp_reading_time(en_in_chinese_text)


def test_a_lesson_without_the_line_is_left_alone_and_nothing_is_added():
    plain = "# 标题\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 为什么？\n"

    assert courses_module._stamp_reading_time(plain) == plain
    assert courses_module._stamp_reading_time("") == ""


def test_hidden_comments_do_not_count_and_only_the_first_line_is_rewritten():
    lesson = zh_lesson() + "\n<!-- mastery: " + "能够解释概念; " * 200 + "-->\n\n> 预计阅读时间：5 分钟\n"

    out = courses_module._stamp_reading_time(lesson)

    assert "> 预计阅读时间：4 分钟" in out
    assert out.count("预计阅读时间：5 分钟") == 1  # 第二处不动
    assert "<!-- mastery:" in out


@pytest.mark.parametrize("depth", ["simple", "standard", "deep"])
def test_the_first_lesson_is_stamped_at_every_depth(authed_client, depth):
    def responder(system, user):
        return syllabus_text() if "course syllabus design expert" in system else en_lesson()

    with fake_model(responder):
        res = authed_client.post("/api/courses", json={"name": "Interest", "learning_depth": depth, "language": "en"})
        assert res.status_code == 200, res.text
        assert authed_client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200  # 第 01 篇在确认大纲后生成

    stored = authed_client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"]
    assert "> Estimated reading time: 3 minutes" in stored and "15 minutes" not in stored


def test_the_first_lesson_of_a_chinese_course_is_stamped(authed_client):
    def responder(system, user):
        return "# 大纲\n\n- [ ] 能够解释甲" if "课程大纲设计专家" in system else zh_lesson()

    with fake_model(responder):
        res = authed_client.post("/api/courses", json={"name": "系统思考", "learning_depth": "standard"})
        assert authed_client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200  # 第 01 篇在确认大纲后生成

    stored = authed_client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"]
    assert "> 预计阅读时间：4 分钟" in stored


def test_the_next_lesson_is_stamped(authed_client):
    from tests.unit.test_course_language import create_topic

    created, _ = create_topic(authed_client)

    next_lesson(authed_client, created["id"], lambda system, user: en_lesson("> Estimated reading time: 40 minutes"))

    stored = authed_client.get(f"/api/courses/{created['id']}/lessons/2").json()["content"]
    assert "> Estimated reading time: 3 minutes" in stored and "40 minutes" not in stored


def test_an_assessment_lesson_with_the_line_is_stamped_and_one_without_is_untouched(authed_client):
    from tests.unit.test_course_language import create_topic

    created, _ = create_topic(authed_client)
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == created["id"]).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    eval_text = "<!-- eval-article -->\n\n# Final Assessment\n\n> Estimated reading time: 30 minutes\n\n" + "word " * 100
    model = next_lesson(authed_client, created["id"], lambda system, user: eval_text)

    stored = authed_client.get(f"/api/courses/{created['id']}/lessons/2").json()
    assert stored["is_evaluation"] is True and stored["content"].startswith("<!-- eval-article -->")
    assert "> Estimated reading time: 1 minute" in stored["content"]
    assert model.calls

    created2, _ = create_topic(authed_client, name="Second")
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == created2["id"]).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    plain_eval = "<!-- eval-article -->\n\n# Final Assessment\n\n> This lesson is the course assessment.\n\nbody"
    next_lesson(authed_client, created2["id"], lambda system, user: plain_eval)
    assert authed_client.get(f"/api/courses/{created2['id']}/lessons/2").json()["content"] == plain_eval


def test_the_streamed_chunks_are_unchanged_but_the_stored_lesson_has_the_recomputed_line(authed_client):
    from tests.unit.test_course_language import create_topic

    created, _ = create_topic(authed_client)
    with fake_model(lambda system, user: en_lesson("> Estimated reading time: 40 minutes")):
        res = authed_client.post(f"/api/courses/{created['id']}/next")

    events = sse_events(res)
    assert any(e.get("done") for e in events) and not any("error" in e for e in events)
    streamed = "".join(e.get("content", "") for e in events)
    assert "40 minutes" in streamed  # 流式预览是模型的原话；入库的是重算后的
    assert "3 minutes" in authed_client.get(f"/api/courses/{created['id']}/lessons/2").json()["content"]


# ---- 值只取「数字 + 单位」，其后的内容原样保留 ----

@pytest.mark.parametrize("line,expected", [
    ("预计阅读时间：8 分钟，难度：入门", "预计阅读时间：4 分钟，难度：入门"),
    ("预计阅读时间：8 分钟,难度：入门", "预计阅读时间：4 分钟,难度：入门"),
    ("预计阅读时间：8 分钟；难度：入门", "预计阅读时间：4 分钟；难度：入门"),
    ("预计阅读时间：8 分钟;难度：入门", "预计阅读时间：4 分钟;难度：入门"),
    ("预计阅读时间：8 分钟、难度：入门", "预计阅读时间：4 分钟、难度：入门"),
    ("> 预计阅读时间：约 8-10 分钟，难度：入门", "> 预计阅读时间：4 分钟，难度：入门"),
    ("> 预计阅读时间：8 分钟左右，难度：入门", "> 预计阅读时间：4 分钟，难度：入门"),
    ("> 预计阅读时间：[X 分钟]，难度：入门", "> 预计阅读时间：4 分钟，难度：入门"),
    ("> 预计阅读时间：二十分钟、难度：入门", "> 预计阅读时间：4 分钟、难度：入门"),
    ("预计阅读时间：8 分钟，难度：入门，前置知识：无", "预计阅读时间：4 分钟，难度：入门，前置知识：无"),
])
def test_the_text_after_the_value_is_kept_in_chinese(line, expected):
    assert f"\n{expected}\n\n" in courses_module._stamp_reading_time(zh_lesson(line))


@pytest.mark.parametrize("line,expected", [
    ("Estimated reading time: 9 minutes, Difficulty: Beginner", "Estimated reading time: 3 minutes, Difficulty: Beginner"),
    ("Estimated reading time: 9 min; Difficulty: Beginner", "Estimated reading time: 3 minutes; Difficulty: Beginner"),
    ("Estimated reading time: about 12 min, Difficulty: Beginner", "Estimated reading time: 3 minutes, Difficulty: Beginner"),
    ("> Reading time: 8-10 minutes, Difficulty: Beginner", "> Reading time: 3 minutes, Difficulty: Beginner"),
    ("**Estimated reading time:** ~15 mins；Difficulty: Beginner", "**Estimated reading time:** 3 minutes；Difficulty: Beginner"),
])
def test_the_text_after_the_value_is_kept_in_english(line, expected):
    assert f"\n{expected}\n\n" in courses_module._stamp_reading_time(en_lesson(line))


@pytest.mark.parametrize("line,expected", [
    ("> 预计阅读时间：很短", "> 预计阅读时间：4 分钟"),
    ("> 预计阅读时间：", "> 预计阅读时间：4 分钟"),
    ("前置知识：无 | 预计阅读时间：很短 | 难度：入门", "前置知识：无 | 预计阅读时间：4 分钟 | 难度：入门"),
    ("预计阅读时间：很短，难度：入门", "预计阅读时间：4 分钟，难度：入门"),
])
def test_a_value_that_is_not_a_number_with_a_unit_is_replaced_up_to_the_next_separator(line, expected):
    assert f"\n{expected}\n\n" in courses_module._stamp_reading_time(zh_lesson(line))


def test_the_english_free_form_value_is_replaced_too():
    out = courses_module._stamp_reading_time(en_lesson("Estimated reading time: a few minutes, Difficulty: Beginner"))

    assert "\nEstimated reading time: 3 minutes, Difficulty: Beginner\n\n" in out
