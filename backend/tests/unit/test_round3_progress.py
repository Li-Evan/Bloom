"""大纲模板叫「课文」、日期本地化；学习进度表补齐更早的篇号（幂等）。"""
from datetime import date, datetime, timezone

import pytest

import app.courses as courses_module
import app.prompts_en as prompts_en
from app.course_language import text_for
from app.courses import _progress_date, _record_lesson_progress
from app.models import Lesson, Syllabus
from tests.conftest import TestSession
from tests.unit.test_lesson_prompt_rules import ZH_NEXT, generate_next, make_course
from tests.unit.test_syllabus_progress_table import DAY, ZH_OUTLINE, syllabus_of, table_rows


@pytest.fixture
def client(authed_client):
    return authed_client


@pytest.mark.parametrize("day, expected", [
    (date(2026, 10, 15), "10月15日"), (date(2026, 1, 5), "1月5日"), (date(2025, 12, 30), "2025年12月30日"), (date(2027, 2, 1), "2027年2月1日"),
])
def test_chinese_dates_drop_the_year_in_the_current_year_only(day, expected):
    assert _progress_date(day, DAY, "zh") == expected


@pytest.mark.parametrize("day, expected", [
    (date(2026, 10, 15), "Oct 15"), (date(2026, 1, 5), "Jan 5"), (date(2025, 12, 30), "Dec 30, 2025"), (date(2027, 2, 1), "Feb 1, 2027"),
])
def test_english_dates_drop_the_year_in_the_current_year_only(day, expected):
    assert _progress_date(day, DAY, "en") == expected


def test_the_outline_templates_call_a_lesson_a_lesson_and_ask_for_no_iso_dates():
    zh, en = courses_module.SYLLABUS_PROMPT, prompts_en.SYLLABUS_PROMPT

    assert "| 课文 | 覆盖掌握项 | 生成日期 |" in zh and "课文数量因人而异" in zh and "文档" not in zh
    assert "| Lesson | Mastery items covered | Date generated |" in en
    assert text_for("zh").progress_table.startswith("| 课文 |") and text_for("en").progress_table.startswith("| Lesson |")


def test_an_old_chinese_outline_gets_the_new_header_and_intro_and_english_headers_stay_english():
    old = "# 课 · 课程大纲\n\n> 文档数量因人而异，但掌握内容不打折扣。\n\n- [ ] 能够甲\n\n## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|---|---|---|\n"

    out = _record_lesson_progress(old, "zh", 1, [], DAY)

    assert "课文数量因人而异" in out and "文档" not in out and table_rows(out)[0] == "| 课文 | 覆盖掌握项 | 生成日期 |"
    en = _record_lesson_progress("# C\n\n## Learning progress\n\n| Lesson | Mastery items covered | Date generated |\n|---|---|---|\n", "en", 1, [], DAY)
    assert table_rows(en)[0] == "| Lesson | Mastery items covered | Date generated |" and table_rows(en)[2].endswith("| Oct 15 |")


def test_a_new_course_never_writes_an_iso_date_into_the_outline(client):
    cid, _ = make_course(client, "zh")

    assert f"{date.today().isoformat()}" not in syllabus_of(client, cid)
    assert f"| 第 1 篇 | — | {date.today().month}月{date.today().day}日 |" in syllabus_of(client, cid)


EARLIER = [
    (1, [], date(2025, 12, 30)),
    (2, ["能够甲"], date(2026, 10, 10)),
    (3, ["评估篇"], date(2026, 10, 12)),
    (4, ["能够乙", "能够甲"], date(2026, 10, 14)),
]
LATEST_ONLY = ZH_OUTLINE + "| 第 4 篇 | 能够乙 | 2026-10-14 |\n"


def test_the_missing_earlier_rows_are_added_in_order_with_their_own_items_and_dates():
    out = _record_lesson_progress(LATEST_ONLY, "zh", 5, ["能够甲"], DAY, EARLIER)

    assert table_rows(out)[2:] == [
        "| 第 1 篇 | — | 2025年12月30日 |", "| 第 2 篇 | 能够甲 | 10月10日 |", "| 第 3 篇 | 评估篇 | 10月12日 |",
        "| 第 4 篇 | 能够乙 | 10月14日 |",  # 已有的这一行不动（只把 ISO 日期换成本地写法）
        "| 第 5 篇 | 能够甲 | 10月15日 |",
    ]


def test_running_it_again_adds_nothing_and_changes_nothing():
    once = _record_lesson_progress(LATEST_ONLY, "zh", 5, ["能够甲"], DAY, EARLIER)

    assert _record_lesson_progress(once, "zh", 5, ["能够甲"], DAY, EARLIER) == once
    six = _record_lesson_progress(once, "zh", 6, ["能够乙"], DAY, [*EARLIER, (5, ["能够甲"], DAY)])
    assert table_rows(six)[2:-1] == table_rows(once)[2:] and len(table_rows(six)) == len(table_rows(once)) + 1


def test_a_row_that_exists_is_never_overwritten_by_the_backfill():
    outline = ZH_OUTLINE + "| 第 2 篇 | 我手改过的内容 | 10月9日 |\n"

    out = _record_lesson_progress(outline, "zh", 3, [], DAY, EARLIER[:2])

    assert "| 第 2 篇 | 我手改过的内容 | 10月9日 |" in out and "| 第 2 篇 | 能够甲 | 10月10日 |" not in out
    assert [row.split("|")[1].strip() for row in table_rows(out)[2:]] == ["第 1 篇", "第 2 篇", "第 3 篇"]


def test_lessons_after_the_current_one_are_not_backfilled_and_an_empty_earlier_list_is_the_old_behavior():
    out = _record_lesson_progress(ZH_OUTLINE, "zh", 2, [], DAY, [(1, [], DAY), (3, ["能够甲"], DAY)])

    assert [row.split("|")[1].strip() for row in table_rows(out)[2:]] == ["第 1 篇", "第 2 篇"]
    assert table_rows(_record_lesson_progress(ZH_OUTLINE, "zh", 2, [], DAY))[2:] == ["| 第 2 篇 | — | 10月15日 |"]


def test_the_english_backfill_uses_english_labels_dates_and_separators():
    outline = "# C\n\n## Learning progress\n\n| Lesson | Mastery items covered | Date generated |\n|---|---|---|\n| Lesson 3 | Explain C | 2026-10-14 |\n"
    earlier = [(1, [], date(2025, 12, 30)), (2, ["Explain A", "Apply B"], date(2026, 10, 10))]

    out = _record_lesson_progress(outline, "en", 4, [], DAY, earlier)

    assert table_rows(out)[2:] == [
        "| Lesson 1 | — | Dec 30, 2025 |", "| Lesson 2 | Explain A<br>Apply B | Oct 10 |", "| Lesson 3 | Explain C | Oct 14 |", "| Lesson 4 | — | Oct 15 |",
    ]


def set_created_at(cid, dates):
    with TestSession() as db:
        for number, day in dates.items():
            lesson = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == number).one()
            lesson.created_at = datetime(day.year, day.month, day.day, 12, tzinfo=timezone.utc).replace(tzinfo=None)
        db.commit()


def test_a_course_from_before_the_table_existed_gets_every_earlier_row_at_its_next_lesson(client):
    cid, _ = make_course(client, "zh")
    generate_next(client, cid)  # 第 2 篇：核心概念 1、2
    generate_next(client, cid, lesson_text=ZH_NEXT.replace("核心概念1; 能够解释核心概念2", "核心概念3"))  # 第 3 篇
    set_created_at(cid, {1: date(2025, 12, 30), 2: date(2026, 10, 10), 3: date(2026, 10, 12)})
    with TestSession() as db:  # 旧课：表里只有最新一篇
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        lines = [line for line in syllabus.content.splitlines() if not line.startswith(("| 第 1 篇", "| 第 2 篇"))]
        syllabus.content = "\n".join(lines) + "\n"
        db.commit()
    assert len(table_rows(syllabus_of(client, cid))) == 3

    generate_next(client, cid, lesson_text=ZH_NEXT.replace("核心概念1; 能够解释核心概念2", "核心概念4"))  # 第 4 篇

    rows = table_rows(syllabus_of(client, cid))[2:]
    assert [row.split("|")[1].strip() for row in rows] == ["第 1 篇", "第 2 篇", "第 3 篇", "第 4 篇"]
    assert rows[0].endswith("| 2025年12月30日 |") and rows[0].split("|")[2].strip() == "—"  # 第 1 篇没有注释
    assert rows[1] == "| 第 2 篇 | 能够解释核心概念1<br>能够解释核心概念2 | 10月10日 |"  # 取自第 2 篇自己的 mastery 注释
    assert rows[2].startswith("| 第 3 篇 | 能够解释核心概念3 |")  # 已有的行不动
    generate_next(client, cid, lesson_text=ZH_NEXT.replace("核心概念1; 能够解释核心概念2", "核心概念5"))  # 第 5 篇
    after = table_rows(syllabus_of(client, cid))[2:]
    assert after[:4] == rows and len(after) == 5  # 幂等：前四行一模一样


def test_an_assessment_lesson_in_the_past_is_backfilled_as_an_assessment():
    out = _record_lesson_progress(ZH_OUTLINE, "zh", 3, [], DAY, [(2, [text_for("zh").progress_assessment], DAY)])
    assert "| 第 2 篇 | 评估篇 | 10月15日 |" in out


# ---- 本地化旧行的日期不能拆坏转义的竖线 ----

def test_the_last_cell_is_the_only_thing_changed_when_an_old_row_is_localized():
    outline = ZH_OUTLINE + "| 第 2 篇 | 能够计算 \\|A\\| 的值 | 2026-10-14 |\n"

    out = _record_lesson_progress(outline, "zh", 3, [], DAY)

    assert "| 第 2 篇 | 能够计算 \\|A\\| 的值 | 10月14日 |" in out
    assert len(table_rows(out)) == 4  # 表头 + 分隔行 + 旧的一行 + 这一篇，没有被拆出多余的行


def test_inline_code_with_a_pipe_and_other_cells_are_left_exactly_as_they_were():
    row = "| 第 2 篇 | 比较 `a\\|b` 与 \\|x\\| | 2026-10-14 |"

    out = _record_lesson_progress(ZH_OUTLINE + row + "\n", "zh", 3, [], DAY)

    assert row.replace("2026-10-14", "10月14日") in out
    english = "| Lesson 2 | Use `a\\|b` in code | 2026-10-14 |"
    assert english.replace("2026-10-14", "Oct 14") in _record_lesson_progress(
        "# C\n\n## Learning progress\n\n| Lesson | Mastery items covered | Date generated |\n|---|---|---|\n" + english + "\n", "en", 3, [], DAY,
    )


@pytest.mark.parametrize("row", [
    "| 第 2 篇 | 能够甲 | 10月14日 |", "| 第 2 篇 | 能够甲 | 2026/10/14 |", "| 第 2 篇 | 2026-10-14 能够甲 | 昨天 |", "| 第 2 篇 | 能够甲 | 2026-13-45 |",
])
def test_rows_without_an_iso_date_in_the_last_cell_are_not_touched(row):
    out = _record_lesson_progress(ZH_OUTLINE + row + "\n", "zh", 3, [], DAY)

    assert row in out


def test_cells_are_split_on_unescaped_pipes_only():
    from app.courses import _row_lesson_number, _table_cells

    assert _table_cells("| 第 2 篇 | 能够计算 \\|A\\| 的值 | 10月14日 |") == ["第 2 篇", "能够计算 \\|A\\| 的值", "10月14日"]
    assert _row_lesson_number("| 第 2 篇 | 能够计算 \\|A\\| 的值 | 10月14日 |") == 2
