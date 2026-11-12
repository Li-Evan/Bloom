"""第 1 篇讲了的要点记进学习进度表，上传原文的原文篇写「原文」而不是「—」。"""
from datetime import date

import pytest

import app.courses as courses_module
import app.prompts_en as prompts_en
from app.course_language import text_for
from app.courses import _ensure_grounded_lesson_questions, _record_lesson_progress
from tests.unit.test_course_language import fake_model
from tests.unit.test_lesson_prompt_rules import ZH_TOPIC_LESSON, make_course, make_source_course, responder_for
from tests.unit.test_syllabus_progress_table import DAY, ZH_OUTLINE, syllabus_of, table_rows, today_en, today_zh


@pytest.fixture
def client(authed_client):
    return authed_client


# ---- 第一篇也写 mastery 注释 ----

def test_the_first_lesson_prompt_asks_for_the_mastery_comment_in_both_languages():
    zh, en = courses_module.FIRST_LESSON_PROMPT, prompts_en.FIRST_LESSON_PROMPT

    assert "<!-- mastery: 能够...; 能够... -->" in zh and "18. **末尾的隐藏 mastery 注释**" in zh
    assert "必须与大纲中的文字完全一致" in zh and "本篇没有讲透任何一项就不写这个注释" in zh
    assert "<!-- mastery: Explain ...; Apply ... -->" in en and "18. **The hidden mastery comment at the end**" in en
    assert "exactly identical to the text in the outline" in en and "if the lesson teaches none of them thoroughly, write no such comment" in en


def test_the_first_lessons_items_go_into_row_one_of_the_progress_table(client):
    def respond(system, user):
        if "苏格拉底式导师" in system and "生成第一篇" in system or "第一篇课文" in user:
            return ZH_TOPIC_LESSON + "\n<!-- mastery: 能够解释核心概念1; 能够解释核心概念2 -->"
        return responder_for("zh")(system, user)

    with fake_model(respond):
        res = client.post("/api/courses", json={"name": "线性代数", "learning_depth": "simple", "language": "zh"})
        assert res.status_code == 200, res.text
        assert table_rows(res.json()["syllabus_content"])[2:] == []  # 建课只生成大纲，还没有课文行
        assert client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200

    # 第 01 篇在确认大纲后由 /first 生成，同时把它讲到的要点记进第 1 行
    assert table_rows(syllabus_of(client, res.json()["id"]))[2:] == [
        f"| 第 1 篇 | 能够解释核心概念1<br>能够解释核心概念2 | {today_zh()} |",
    ]
    assert client.get(f"/api/courses/{res.json()['id']}").json()["mastery_covered"] == 0  # 第 1 篇还没读，不算进度


def test_a_first_lesson_without_a_comment_still_gets_a_dash(client):
    cid, _ = make_course(client, "zh")

    assert table_rows(syllabus_of(client, cid))[2:] == [f"| 第 1 篇 | — | {today_zh()} |"]


# ---- 原文篇 ----

def test_the_uploaded_source_lesson_says_source_text_instead_of_a_dash(client):
    # 旧数据形状的原文课：原文阅读篇占第 1 行，写「原文」
    zh = make_source_course(client, "zh", legacy=True)
    en = make_source_course(client, "en", legacy=True)

    assert table_rows(syllabus_of(client, zh))[2:] == [f"| 第 1 篇 | 原文 | {today_zh()} |"]
    assert table_rows(syllabus_of(client, en))[2:] == [f"| Lesson 1 | Source text | {today_en()} |"]
    assert text_for("zh").progress_source == "原文" and text_for("en").progress_source == "Source text"

    # 现在的原文课：原文是参考材料，不占课文编号和进度行；第 1 行是 /first 生成的第 01 篇教学课文
    current = make_source_course(client, "zh")
    rows = table_rows(syllabus_of(client, current))[2:]
    assert len(rows) == 1 and rows[0].startswith("| 第 1 篇 |") and "原文" not in rows[0]


def test_the_backfill_labels_a_source_lesson_as_source_and_upgrades_an_old_dash_row():
    old = ZH_OUTLINE + "| 第 1 篇 | — | 10月14日 |\n"
    earlier = [(1, ["原文"], date(2026, 10, 14))]

    out = _record_lesson_progress(old, "zh", 2, ["能够甲"], DAY, earlier)

    assert table_rows(out)[2:] == ["| 第 1 篇 | 原文 | 10月14日 |", "| 第 2 篇 | 能够甲 | 10月15日 |"]
    missing = _record_lesson_progress(ZH_OUTLINE, "zh", 2, [], DAY, earlier)
    assert table_rows(missing)[2] == "| 第 1 篇 | 原文 | 10月15日 |".replace("10月15日", "10月14日")


def test_only_the_source_lessons_dash_is_upgraded_other_rows_keep_theirs():
    old = ZH_OUTLINE + "| 第 1 篇 | — | 10月14日 |\n| 第 2 篇 | — | 10月14日 |\n"

    out = _record_lesson_progress(old, "zh", 3, [], DAY, [(1, ["原文"], DAY), (2, [], DAY)])

    assert table_rows(out)[2:4] == ["| 第 1 篇 | 原文 | 10月14日 |", "| 第 2 篇 | — | 10月14日 |"]


# ---- 资料课：重建思考题时不丢注释 ----

def test_rebuilding_the_grounded_questions_keeps_the_hidden_mastery_comment():
    lesson = (
        "# 课\n\n## 正文内容\n\n资料指出，甲。（来源：a.md，第 1 页）\n\n## 思考题\n\n1. 为什么甲？\n2. 如何乙？\n\n"
        "<!-- mastery: 能够解释甲 -->\n"
    )

    out = _ensure_grounded_lesson_questions(lesson, "- [ ] 能够解释甲\n", "zh")

    assert out.count("<!-- mastery: 能够解释甲 -->") == 1 and "1. 为什么甲？" in out
    assert out.rstrip().endswith("<!-- mastery: 能够解释甲 -->")


def test_the_grounded_reviewer_and_repairer_are_told_to_keep_the_comment():
    assert "`<!-- mastery: … -->`（若有）原样保留，不得删除" in courses_module.GROUNDED_LESSON_REVIEW_PROMPT
    assert "`<!-- mastery: … -->`（若有）原样保留" in courses_module.GROUNDED_LESSON_REPAIR_PROMPT
    assert "Keep the hidden `<!-- mastery: ... -->` comment at the end of the lesson (if there is one) exactly as it is" in prompts_en.GROUNDED_LESSON_REVIEW_PROMPT
    assert "Keep the hidden `<!-- mastery: ... -->` comment at the end of the lesson (if there is one) exactly as it is" in prompts_en.GROUNDED_LESSON_REPAIR_PROMPT


# ---- 覆盖要点一格用换行分隔（<br>），不是一长串「·」/「；」 ----

def test_the_covered_items_are_one_per_line_in_the_cell():
    out = _record_lesson_progress(ZH_OUTLINE, "zh", 2, ["能够甲", "能够乙", "能够丙"], DAY)

    assert table_rows(out)[2] == "| 第 2 篇 | 能够甲<br>能够乙<br>能够丙 | 10月15日 |"
    assert "；" not in table_rows(out)[2] and " · " not in table_rows(out)[2]


def test_the_break_is_the_same_in_both_languages_and_is_a_named_constant():
    from app.course_language import PROGRESS_ITEM_BREAK

    assert PROGRESS_ITEM_BREAK == "<br>"
    assert text_for("zh").progress_separator == text_for("en").progress_separator == PROGRESS_ITEM_BREAK


def test_a_pipe_inside_an_item_is_still_escaped_and_the_cell_still_has_one_break_per_item():
    out = _record_lesson_progress(ZH_OUTLINE, "zh", 2, ["能够比较 a|b", "能够乙"], DAY)

    assert table_rows(out)[2] == "| 第 2 篇 | 能够比较 a\\|b<br>能够乙 | 10月15日 |"


def test_unread_generated_items_do_not_count_and_feedback_updates_every_view(client):
    from app.models import Lesson, Syllabus
    from tests.conftest import TestSession

    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        lesson.content += "\n<!-- mastery: 能够解释核心概念1 -->"
        syllabus = db.query(Syllabus).filter_by(course_id=cid).one()
        syllabus.content = syllabus.content.replace("- [ ] 能够解释核心概念1", "- [x] 能够解释核心概念1")
        db.commit()
    for endpoint in (f"/api/courses/{cid}", f"/api/courses/{cid}/stats"):
        assert client.get(endpoint).json()["mastery_covered"] == 0
    assert client.get("/api/courses").json()[0]["mastery_covered"] == 0
    assert "- [ ] 能够解释核心概念1" in syllabus_of(client, cid)
    assert "- [ ] 能够解释核心概念1" in client.get(f"/api/courses/{cid}").json()["syllabus_content"]
    client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "读完了", "thought_answers": ""})
    assert client.get(f"/api/courses/{cid}").json()["mastery_covered"] == 1
    assert "- [x] 能够解释核心概念1" in syllabus_of(client, cid)


def test_next_lesson_counts_the_previous_comment_but_not_the_new_one(client):
    from app.models import Lesson
    from tests.conftest import TestSession
    from tests.unit.test_lesson_prompt_rules import ZH_NEXT, generate_next

    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        lesson.content += "\n<!-- mastery: 能够解释核心概念3 -->"
        db.commit()
    generate_next(client, cid, lesson_text=ZH_NEXT)
    detail = client.get(f"/api/courses/{cid}").json()
    assert detail["mastery_covered"] == 1
    assert "- [x] 能够解释核心概念3" in detail["syllabus_content"]
    assert "- [ ] 能够解释核心概念1" in detail["syllabus_content"]


def test_old_lessons_without_comments_keep_existing_checks(client):
    from app.models import Syllabus
    from tests.conftest import TestSession

    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter_by(course_id=cid).one()
        syllabus.content = syllabus.content.replace("- [ ] 能够解释核心概念1", "- [x] 能够解释核心概念1")
        db.commit()
    assert client.get(f"/api/courses/{cid}").json()["mastery_covered"] == 1
    assert "- [x] 能够解释核心概念1" in syllabus_of(client, cid)


def test_an_unread_lesson_cannot_erase_an_item_already_read_in_another_lesson(client):
    from app.models import Lesson
    from tests.conftest import TestSession
    from tests.unit.test_lesson_prompt_rules import generate_next

    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        lesson.content += "\n<!-- mastery: 能够解释核心概念1 -->"
        db.commit()
    generate_next(client, cid)
    assert client.get(f"/api/courses/{cid}").json()["mastery_covered"] == 1
    assert "- [x] 能够解释核心概念1" in syllabus_of(client, cid)
    assert "- [ ] 能够解释核心概念2" in syllabus_of(client, cid)


def test_recommendation_profile_uses_the_same_read_progress_as_the_course(client, user):
    from app.models import Lesson
    from app.recommendations import _build_learning_profile
    from tests.conftest import TestSession
    from tests.unit.test_lesson_prompt_rules import generate_next

    cid, _ = make_course(client, 'zh')
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        lesson.content += '\n<!-- mastery: 能够解释核心概念3 -->'
        db.commit()
    generate_next(client, cid)
    with TestSession() as db:
        profile = _build_learning_profile(db, user.uuid)
    assert '｜已学 1/8 个掌握项\n  已经学过：\n    - 能够解释核心概念3\n' in profile
    assert '  这门课接下来会讲（原课程会接着讲，不能推荐成新主题）：\n    - 能够解释核心概念1\n' in profile


def test_empty_annotation_state_omits_the_assessment_template_and_any_invented_recap(client):
    from tests.unit.test_lesson_prompt_rules import generate_next, tick_everything
    cid, _ = make_course(client, 'zh')
    tick_everything(cid)
    evaluation = ('<!-- eval-article -->\n# 最终评估\n## 思考题\n1. 如何应用？\n2. 为什么？\n'
                  '## 批注解答\n你划线问过一个不存在的问题，当时得到的解答是甲。')
    model = generate_next(client, cid, lesson_text=evaluation)
    assert '## 批注解答' not in model.calls[0]['system']
    assert '### 你的回答评估' not in model.calls[0]['system']
    saved = client.get(f'/api/courses/{cid}/lessons/2').json()['content']
    assert '不存在的问题' not in saved and '## 批注解答' not in saved
    assert '1. 如何应用？' in saved and '2. 为什么？' in saved
