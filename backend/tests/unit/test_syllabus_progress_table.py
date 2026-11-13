"""RB5：每生成一篇（含首篇），在大纲「学习进度」表追加一行「篇号 | 本篇覆盖的掌握项 | 日期」，占位行去掉。"""
from datetime import date

import pytest

import app.courses as courses_module
from app.courses import _count_mastery_items, _record_lesson_progress
from app.models import Course, Syllabus
from tests.conftest import TestSession
from tests.unit.test_course_language import fake_model, next_lesson, syllabus_text
from tests.unit.test_lesson_prompt_rules import ZH_NEXT, generate_next, make_course, responder_for, tick_everything

DAY = date(2026, 10, 15)
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def today_zh():
    return f"{date.today().month}月{date.today().day}日"


def today_en():
    return f"{MONTHS[date.today().month - 1]} {date.today().day}"
ZH_OUTLINE = (
    "# 课 · 课程大纲\n\n## 核心掌握项\n\n### 主线\n- [ ] 能够甲\n- [ ] 能够乙\n\n## 不在本课题范围内\n\n- 其它\n\n"
    "## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|------|-----------|---------|\n"
)
ZH_PLACEHOLDERS = ZH_OUTLINE + "| 第1篇 | 待生成 | 待生成 |\n| 第2篇 | 待生成 | 待生成 |\n| 第3篇 | 待生成 | 待生成 |\n"


@pytest.fixture
def client(authed_client):
    return authed_client


def table_rows(syllabus):
    section = syllabus.split("## 学习进度")[1] if "## 学习进度" in syllabus else syllabus.split("## Learning progress")[1]
    return [line for line in section.splitlines() if line.startswith("|")]


# ---- 纯函数 ----

def test_the_first_lesson_adds_one_row_and_the_placeholder_rows_go_away():
    out = _record_lesson_progress(ZH_PLACEHOLDERS, "zh", 1, [], DAY)

    assert table_rows(out) == [
        "| 课文 | 覆盖掌握项 | 生成日期 |", "|------|-----------|---------|", "| 第 1 篇 | — | 10月15日 |",
    ]
    assert "待生成" not in out
    assert out.startswith(ZH_OUTLINE.split("## 学习进度")[0])  # 前面的内容不动


def test_the_next_lessons_append_in_order_with_the_covered_items_and_the_date():
    out = _record_lesson_progress(ZH_OUTLINE, "zh", 1, [], DAY)
    out = _record_lesson_progress(out, "zh", 2, ["能够甲", "能够乙"], date(2026, 10, 16))
    out = _record_lesson_progress(out, "zh", 3, ["评估篇"], date(2026, 10, 17))

    assert table_rows(out)[2:] == [
        "| 第 1 篇 | — | 10月15日 |", "| 第 2 篇 | 能够甲<br>能够乙 | 10月16日 |", "| 第 3 篇 | 评估篇 | 10月17日 |",
    ]


def test_english_rows_use_english_labels_and_line_breaks():
    out = _record_lesson_progress(syllabus_text(), "en", 1, [], DAY)
    out = _record_lesson_progress(out, "en", 2, ["Explain A", "Apply B"], DAY)

    rows = table_rows(out)
    assert rows[0] == "| Lesson | Mastery items covered | Date generated |"
    assert rows[2:] == ["| Lesson 1 | — | Oct 15 |", "| Lesson 2 | Explain A<br>Apply B | Oct 15 |"]


@pytest.mark.parametrize("placeholder", [
    "| 第1篇 | 待生成 | 待生成 |", "| 第1篇 | TBD | TBD |", "| Lesson 1 | Pending | Pending |", "| 1 | To be generated | To be generated |",
    "| 1 |  |  |", "| 1 | - | - |", "| 1 | 待定 | — |", "|  | 待生成 | 待生成 |",
])
def test_every_kind_of_placeholder_row_is_dropped(placeholder):
    out = _record_lesson_progress(ZH_OUTLINE + placeholder + "\n", "zh", 1, [], DAY)

    assert table_rows(out)[2:] == ["| 第 1 篇 | — | 10月15日 |"]


def test_real_rows_that_were_written_earlier_are_kept():
    outline = ZH_OUTLINE + "| 第 1 篇 | — | 2026-10-14 |\n| 第 2 篇 | 能够甲 | 2026-10-15 |\n| 第3篇 | 待生成 | 待生成 |\n"

    out = _record_lesson_progress(outline, "zh", 3, ["能够乙"], DAY)

    assert table_rows(out)[2:] == ["| 第 1 篇 | — | 10月14日 |", "| 第 2 篇 | 能够甲 | 10月15日 |", "| 第 3 篇 | 能够乙 | 10月15日 |"]  # 旧的 ISO 日期换成本地写法


def test_a_pipe_inside_an_item_is_escaped_so_the_table_does_not_break():
    out = _record_lesson_progress(ZH_OUTLINE, "zh", 2, ["能够比较 a|b 两种写法"], DAY)

    assert "| 第 2 篇 | 能够比较 a\\|b 两种写法 | 10月15日 |" in out
    assert len(table_rows(out)[-1].replace("\\|", "").split("|")) == 5


def test_the_section_in_the_middle_of_the_outline_keeps_what_follows():
    outline = ZH_OUTLINE + "\n## 备注\n\n文字\n"

    out = _record_lesson_progress(outline, "zh", 1, [], DAY)

    assert "| 第 1 篇 | — | 10月15日 |\n\n## 备注\n\n文字\n" in out


def test_a_heading_without_a_table_gets_one():
    out = _record_lesson_progress("# 课 · 课程大纲\n\n- [ ] 能够甲\n\n## 学习进度\n", "zh", 1, [], DAY)

    assert table_rows(out) == ["| 课文 | 覆盖掌握项 | 生成日期 |", "|------|-----------|---------|", "| 第 1 篇 | — | 10月15日 |"]


def test_a_table_without_a_separator_row_is_replaced_by_the_standard_header():
    out = _record_lesson_progress("# 课\n\n## 学习进度\n\n| a | b |\n", "zh", 1, [], DAY)

    assert table_rows(out)[0] == "| 课文 | 覆盖掌握项 | 生成日期 |" and table_rows(out)[-1] == "| 第 1 篇 | — | 10月15日 |"


def test_an_outline_without_the_section_is_left_alone():
    outline = "# 课 · 课程大纲\n\n- [ ] 能够甲\n"

    assert _record_lesson_progress(outline, "zh", 1, [], DAY) == outline


def test_the_english_heading_variants_are_found():
    assert "| Lesson 1 | — |" in _record_lesson_progress("# C\n\n## Learning progress\n", "en", 1, [], DAY)
    assert "| Lesson 1 | — |" in _record_lesson_progress("# C\n\n## study progress\n\n| a | b | c |\n|---|---|---|\n", "en", 1, [], DAY)


def test_the_rows_never_change_the_mastery_counts():
    out = _record_lesson_progress(ZH_PLACEHOLDERS, "zh", 1, ["能够甲"], DAY)

    assert _count_mastery_items(out) == _count_mastery_items(ZH_OUTLINE) == (0, 2)


def test_the_covered_items_come_from_the_lessons_mastery_comment_whether_or_not_they_were_ticked_before():
    outline = "- [x] 能够甲\n- [ ] 能够乙\n- [ ] Explain A; and B\n- [x] 能够丁\n"
    lesson = "正文\n<!-- mastery: 能够乙; 能够甲; 不在大纲里的项; Explain A; and B -->"

    assert courses_module._mastery_comment_items(outline, lesson) == ["能够乙", "能够甲", "Explain A; and B"]
    assert courses_module._mastery_comment_items(outline, "没有注释") == []
    assert courses_module._mastery_comment_items(outline, "<!-- mastery: 全是对不上的 -->") == []
    assert courses_module._mastery_comment_items(outline, "<!-- mastery: 能够丁; 能够丁 -->") == ["能够丁"]


def test_a_lesson_that_only_revisits_ticked_items_still_records_them(client):
    cid, _ = make_course(client, "zh")
    generate_next(client, cid)  # 第 2 篇勾上核心概念 1、2
    revisit = ZH_NEXT.replace("<!-- mastery: 能够解释核心概念1; 能够解释核心概念2 -->", "<!-- mastery: 能够解释核心概念2 -->")

    generate_next(client, cid, lesson_text=revisit)  # 第 3 篇只回顾已勾过的项

    assert table_rows(syllabus_of(client, cid))[4] == f"| 第 3 篇 | 能够解释核心概念2 | {today_zh()} |"


def test_calling_again_for_the_same_lesson_replaces_its_row_instead_of_appending():
    out = _record_lesson_progress(ZH_OUTLINE, "zh", 1, [], DAY)
    out = _record_lesson_progress(out, "zh", 2, ["能够甲"], DAY)
    out = _record_lesson_progress(out, "zh", 2, ["能够甲", "能够乙"], date(2026, 10, 16))

    assert table_rows(out)[2:] == ["| 第 1 篇 | — | 10月15日 |", "| 第 2 篇 | 能够甲<br>能够乙 | 10月16日 |"]


@pytest.mark.parametrize("old_first_cell", ["第2篇", "第 2 篇", "2", "02", "Lesson 2"])
def test_an_older_row_for_the_same_lesson_in_any_spelling_is_replaced(old_first_cell):
    outline = ZH_OUTLINE + f"| {old_first_cell} | 旧 | 2026-10-01 |\n"

    out = _record_lesson_progress(outline, "zh", 2, ["新"], DAY)

    assert table_rows(out)[2:] == ["| 第 2 篇 | 新 | 10月15日 |"]


def test_a_section_without_a_table_keeps_its_other_content():
    outline = "# 课\n\n## 学习进度\n\n每生成一篇课文，这里会多一行。\n\n- 备注一\n- 备注二\n\n## 后记\n\n结束\n"

    out = _record_lesson_progress(outline, "zh", 1, [], DAY)

    assert "每生成一篇课文，这里会多一行。\n\n- 备注一\n- 备注二" in out and "## 后记\n\n结束" in out
    assert out.index("| 第 1 篇 |") < out.index("每生成一篇课文")  # 表放在标题下面，原有内容接在后面
    assert table_rows(out)[:2] == ["| 课文 | 覆盖掌握项 | 生成日期 |", "|------|-----------|---------|"]


def test_a_crlf_outline_is_recognised_and_stays_crlf():
    crlf = ZH_PLACEHOLDERS.replace("\n", "\r\n")

    out = _record_lesson_progress(crlf, "zh", 1, [], DAY)

    assert "\r\n| 第 1 篇 | — | 10月15日 |" in out and "待生成" not in out
    assert "\n" not in out.replace("\r\n", "")  # 没有混进单独的 LF
    assert out.startswith("# 课 · 课程大纲\r\n")
    no_table = "# 课\r\n\r\n## 学习进度\r\n"
    created = _record_lesson_progress(no_table, "en", 1, [], DAY)
    assert "| Lesson 1 | — |" in created and "\n" not in created.replace("\r\n", "")


def test_items_are_separated_with_a_line_break_so_they_do_not_mix_with_semicolons_inside_items():
    out = _record_lesson_progress(syllabus_text(), "en", 2, ["Explain A; and B", "Apply C"], DAY)

    assert "| Lesson 2 | Explain A; and B<br>Apply C | Oct 15 |" in out


# ---- 端到端 ----

def syllabus_of(client, cid):
    return client.get(f"/api/courses/{cid}/syllabus").json()["content"]


def test_creating_a_topic_course_records_the_first_lesson(client):
    cid, _ = make_course(client, "zh")

    rows = table_rows(syllabus_of(client, cid))

    assert rows[2:] == [f"| 第 1 篇 | — | {today_zh()} |"]
    assert client.get(f"/api/courses/{cid}").json()["syllabus_content"] == syllabus_of(client, cid)


def test_a_model_outline_full_of_placeholder_rows_ends_up_with_one_real_row(client):
    def responder(system, user):
        if "课程大纲设计专家" in system:
            return ZH_PLACEHOLDERS
        return "# 第一课\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 为什么？\n2. 如何？\n"

    with fake_model(responder):
        res = client.post("/api/courses", json={"name": "任意", "learning_depth": "simple"})
        assert res.status_code == 200, res.text
        assert client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200

    # 生成第 01 篇后：占位行全部去掉，只剩第 1 篇这一行
    after_first = syllabus_of(client, res.json()["id"])
    assert "待生成" not in after_first and len(table_rows(after_first)) == 3
    # 大纲优先：建课后学生先在大纲页确认大纲，这时展示的大纲里也不能有模型写的「待生成」占位行
    assert "待生成" not in res.json()["syllabus_content"]


def test_each_next_lesson_appends_its_row_with_the_items_it_ticked(client):
    cid, _ = make_course(client, "zh")

    generate_next(client, cid)  # ZH_NEXT 的 mastery 注释：核心概念1、核心概念2

    rows = table_rows(syllabus_of(client, cid))
    assert rows[2] == f"| 第 1 篇 | — | {today_zh()} |"
    assert rows[3] == f"| 第 2 篇 | 能够解释核心概念1<br>能够解释核心概念2 | {today_zh()} |"
    assert len(rows) == 4
    generate_next(client, cid, lesson_text=ZH_NEXT.replace("核心概念1; 能够解释核心概念2", "核心概念3"))
    assert table_rows(syllabus_of(client, cid))[4] == f"| 第 3 篇 | 能够解释核心概念3 | {today_zh()} |"


def test_a_lesson_that_ticked_nothing_gets_a_dash(client):
    cid, _ = make_course(client, "zh")

    generate_next(client, cid, lesson_text=ZH_NEXT.replace("<!-- mastery: 能够解释核心概念1; 能够解释核心概念2 -->", "<!-- mastery: 对不上的项 -->"))

    assert table_rows(syllabus_of(client, cid))[3] == f"| 第 2 篇 | — | {today_zh()} |"


def test_the_assessment_lesson_gets_an_assessment_row_without_ticking_anything(client):
    cid, _ = make_course(client, "zh")
    tick_everything(cid)

    generate_next(client, cid, lesson_text="<!-- eval-article -->\n\n# 评估\n\n正文")

    rows = table_rows(syllabus_of(client, cid))
    assert rows[-1] == f"| 第 2 篇 | 评估篇 | {today_zh()} |"
    assert _count_mastery_items(syllabus_of(client, cid)) == (8, 8)


def test_the_summary_adds_no_row(client):
    cid, _ = make_course(client, "zh")
    tick_everything(cid)
    generate_next(client, cid, lesson_text="<!-- eval-article -->\n\n# 评估\n\n正文")
    before = table_rows(syllabus_of(client, cid))

    generate_next(client, cid, lesson_text="# 学习总结\n\n- 总结")

    assert table_rows(syllabus_of(client, cid)) == before


def test_english_courses_record_english_rows(client):
    from tests.unit.test_course_language import create_topic

    created, _ = create_topic(client)
    cid = created["id"]
    next_lesson(client, cid)

    rows = table_rows(syllabus_of(client, cid))
    assert rows[2] == f"| Lesson 1 | — | {today_en()} |"
    assert rows[3].startswith("| Lesson 2 | Explain core concept 1 (Source: concepts.md, Core concepts)<br>Explain core concept 2")


def test_a_source_course_records_the_reading_lesson_then_the_generated_ones(client):
    # 旧数据形状的原文课：原文阅读篇占第 1 行
    cid = make_source_course_zh(client, legacy=True)

    assert table_rows(syllabus_of(client, cid))[2:] == [f"| 第 1 篇 | 原文 | {today_zh()} |"]  # 原文篇写「原文」，不是「—」
    generate_next(client, cid)
    assert len(table_rows(syllabus_of(client, cid))) == 4

    # 现在的原文课：原文是参考材料，不占进度行；第 01 篇（/first）和之后生成的课文各记一行
    current = make_source_course_zh(client)
    assert [row.split(" | ")[0] for row in table_rows(syllabus_of(client, current))[2:]] == ["| 第 1 篇"]
    generate_next(client, current)
    assert [row.split(" | ")[0] for row in table_rows(syllabus_of(client, current))[2:]] == ["| 第 1 篇", "| 第 2 篇"]


def make_source_course_zh(client, legacy=False):
    from tests.unit.test_lesson_prompt_rules import make_source_course

    return make_source_course(client, "zh", legacy=legacy)


def test_an_old_outline_with_placeholder_rows_loses_them_at_the_next_lesson_and_gets_the_earlier_rows_backfilled(client, user):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="旧课", mode="topic", status="learning", language="zh")
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content=ZH_PLACEHOLDERS))
        from app.models import Lesson

        db.add(Lesson(course_id=course.id, number=1, content="# 旧第一课\n\n## 思考题\n\n1. 问？"))
        db.commit()
        cid = course.id

    with fake_model(responder_for("zh")):
        assert client.post(f"/api/courses/{cid}/next").status_code == 200

    rows = table_rows(syllabus_of(client, cid))
    assert rows[2:] == [f"| 第 1 篇 | — | {today_zh()} |", f"| 第 2 篇 | — | {today_zh()} |"]  # 第 1 篇补齐了（C4）


def test_the_outline_prompt_asks_for_a_header_only_progress_table():
    assert "「学习进度」表只写表头和分隔行，不要填任何数据行，也不要写「待生成」" in courses_module.SYLLABUS_PROMPT
    from app import prompts_en

    assert 'write only the table header and its separator row; fill in no data rows and no placeholder rows such as "To be generated"' in prompts_en.SYLLABUS_PROMPT
