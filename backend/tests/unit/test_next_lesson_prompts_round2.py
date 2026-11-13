"""照做反馈里的明确要求、回顾的措辞、学生资料里的疑问、术语第一次出现就解释。

都是发给模型的提示词内容（中英同步）；真实模型的验证在报告里。
"""
import pytest

import app.course_language as language_module
import app.courses as courses_module
import app.prompts_en as prompts_en
from app.models import Annotation, Feedback, Lesson
from tests.conftest import TestSession, seed_source_course
from tests.unit.test_course_language import CJK, fake_model, syllabus_text
from tests.unit.test_lesson_prompt_rules import generate_next, make_course, make_source_course, responder_for


@pytest.fixture
def client(authed_client):
    return authed_client


def set_feedback(cid, content, answers="", lesson=1):
    with TestSession() as db:
        row = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == lesson).one()
        db.add(Feedback(lesson_id=row.id, content=content, thought_answers=answers))
        db.commit()


# ---------------------------------------------------------------------------
# RB1：下一篇照做学生反馈里的明确要求
# ---------------------------------------------------------------------------

def test_the_chinese_next_lesson_prompt_demands_that_explicit_requests_are_met_and_acknowledged():
    prompt = courses_module.NEXT_LESSON_PROMPT

    assert "**【高优先级】照做学生反馈里的明确要求，不能只在嘴上答应。**" in prompt
    for phrase in ("「短一点 / 少推导 / 赶时间」→ 本篇字数不超过上面「上一篇的篇幅」", "公式推导比上一篇少",
                   "点名了例子、场景、数据", "必须在正文里出现并贯穿讲解，不是一笔带过",
                   "「按你的要求：……」", "某条要求做不到，就在这句话里说明原因", "学生没有明确要求时，不写这一行"):
        assert phrase in prompt
    assert "## 上一篇的篇幅\n{last_length}" in prompt


def test_the_english_next_lesson_prompt_demands_the_same():
    prompt = prompts_en.NEXT_LESSON_PROMPT

    assert "**[High priority] Do what the student's feedback explicitly asks; do not just acknowledge it.**" in prompt
    for phrase in ('"shorter / less derivation / short on time" means this lesson is no longer than "Length of the previous lesson"',
                   "has less derivation than the previous one", "a named example, scenario or data",
                   "must appear in the body and carry the explanation, not get a passing mention",
                   'starts with "As you asked:"', "if a request cannot be met, say why", "write no such line"):
        assert phrase in prompt
    assert "## Length of the previous lesson\n{last_length}" in prompt


def test_the_prompt_tells_the_model_how_long_the_previous_lesson_was(client):
    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == 1).one()
        lesson.content = "# 标题\n\n## 正文内容\n\n" + "系统思考" * 500 + "\n\n## 思考题\n\n1. 为什么？\n<!-- mastery: 能够解释甲 -->"
        expected = 2004
        db.commit()

    system = generate_next(client, cid).calls[0]["system"]

    assert f"## 上一篇的篇幅\n约 {expected} 字" in system and expected >= 2000


def test_the_english_prompt_gives_the_length_in_words(client):
    from tests.unit.test_course_language import next_lesson

    cid, _ = make_course(client, "en", name="Eigenvalues")

    system = next_lesson(client, cid).calls[0]["system"]

    assert "## Length of the previous lesson\nabout " in system and " words\n" in system.split("## Length of the previous lesson\n")[1][:30]


def test_the_students_feedback_reaches_the_next_lesson_prompt_verbatim(client):
    cid, _ = make_course(client, "zh")
    set_feedback(cid, "少一点推导，我期末只剩几天了；多给一个具体数字的例子")

    system = generate_next(client, cid).calls[0]["system"]

    assert "反馈内容：少一点推导，我期末只剩几天了；多给一个具体数字的例子" in system


def test_the_source_course_lesson_two_prompt_now_sees_the_students_feedback_and_the_same_rule(client):
    cid = make_source_course(client, "en", legacy=True)  # 原文阅读篇之后的那一篇走原文课提示词
    set_feedback(cid, "Please use my backlog and OKR examples, and answer my no-authority question.")

    with fake_model(responder_for("en")) as model:
        res = client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 200, res.text
    system = model.calls[0]["system"]
    assert "## The student's feedback\nFeedback: Please use my backlog and OKR examples, and answer my no-authority question." in system
    assert "9. **Do what the student's feedback explicitly asks**" in system and 'starts with "As you asked:"' in system
    assert not CJK.search(system)


def test_the_chinese_source_lesson_prompt_has_the_feedback_section(client):
    cid = make_source_course(client, "zh", legacy=True)  # 原文阅读篇之后的那一篇走原文课提示词
    set_feedback(cid, "多用 OKR 的例子")

    system = generate_next(client, cid).calls[0]["system"]

    assert "## 学生的反馈\n反馈内容：多用 OKR 的例子" in system
    assert "9. **照做学生反馈里的明确要求**" in system and "「按你的要求：……」" in system


# ---------------------------------------------------------------------------
# RB2：回顾的措辞
# ---------------------------------------------------------------------------

def test_the_unanswered_sentence_says_the_questions_are_optional_in_both_languages():
    assert language_module.ZH.review_unanswered.endswith("> 上一篇的思考题是可选的，参考答案放在本篇末尾。")
    assert language_module.EN.review_unanswered.endswith(
        "> The previous lesson's reflection questions are optional; the reference answers are at the end of this lesson."
    )
    for text in (language_module.ZH.review_unanswered, language_module.EN.review_unanswered):
        assert "还没作答" not in text and "have not answered" not in text
    assert "按你的要求" not in language_module.ZH.review_unanswered and "As you asked" not in language_module.EN.review_unanswered


def test_a_highlight_answer_is_never_called_the_students_own_answer():
    zh, en = language_module.ZH.annotation_section, language_module.EN.annotation_section

    assert "是系统当场给出的解答，不是学生自己的回答" in zh
    assert "不要说「你的回答」，也不要评价它对不对" in zh
    assert "已经有「答」的提问学生已经看过解答，这里一条都不要提" in zh
    assert "it is not an answer from the student, so never call it \"your answer\" and never judge whether it is correct" in en
    assert "the student has read it: do not mention it here at all" in en


def test_the_unanswered_chinese_lesson_prompt_uses_the_neutral_wording(client):
    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter(Lesson.course_id == cid).one()
        db.add(Annotation(
            lesson_id=lesson.id, position_start=0, position_end=2, original_text="特征值", comment="左乘是什么意思", answer="就是……",
        ))
        db.commit()

    system = generate_next(client, cid).calls[0]["system"]

    assert "思考题是可选的，参考答案放在本篇末尾。" in system and "你还没作答" not in system
    assert "「答」是系统当场给出的解答，学生已经看过" in system and "- 原文「特征值」\n  问：左乘是什么意思\n  答：就是……" in system


# ---------------------------------------------------------------------------
# RB4：学生资料里自己提的问题不能被放进「不在本课题范围内」
# ---------------------------------------------------------------------------

def test_the_source_and_material_outline_rules_turn_the_students_open_questions_into_goals():
    zh_source = courses_module._build_syllabus_prompt("simple", "zh", source_course=True)
    zh_pack = courses_module._build_syllabus_prompt("simple", "zh")
    en_source = courses_module._build_syllabus_prompt("simple", "en", source_course=True)
    en_pack = courses_module._build_syllabus_prompt("simple", "en")

    for prompt in (zh_source, zh_pack):
        assert "学生资料里明确提出的疑问和想深入的点" in prompt
        assert "必须转成掌握项（或在相关掌握项里点名），不得放进「不在本课题范围内」，除非它完全超出资料的主题" in prompt
    for prompt in (en_source, en_pack):
        assert "Questions the student explicitly raises in the material" in prompt
        assert 'never list it under "Out of scope", unless it falls completely outside the subject of the material' in prompt
        assert not CJK.search(prompt)
    # 没有任何资料的主题课不涉及
    assert "学生资料里明确提出的疑问" not in courses_module._build_syllabus_prompt("simple", "zh", has_reference=False)


def test_the_grounded_outline_review_and_the_lesson_rules_keep_the_same_promise():
    assert "尤其是学生资料里明确提出的疑问和想深入的点" in courses_module.GROUNDED_SYLLABUS_REVIEW_PROMPT
    assert "above all questions the student explicitly raises in the material" in prompts_en.GROUNDED_SYLLABUS_REVIEW_PROMPT
    assert "学生资料里自己列出的疑问和想弄清的问题，要在本篇或后续课文里逐步回答" in language_module.ZH.rules_with_reference
    assert "Questions the student lists in the material and wants answered" in language_module.EN.rules_with_reference
    assert "10. **学生自己提的问题要回答**" in courses_module.SOURCE_LESSON_PROMPT
    assert "10. **Answer the student's own questions**" in prompts_en.SOURCE_LESSON_PROMPT


def test_the_outline_prompt_actually_sent_for_a_source_course_carries_the_rule(client):
    # 原文课已经不能新建；库里已有的原文课改大纲时，发出的大纲提示词仍带这条规则
    cid = seed_source_course(
        client, "n.md", "# Notes\n\nQuestions I still have\n\n- How do I tell a loop from a trend?", name="Notes",
        syllabus=syllabus_text(), learning_depth="simple", language="en",
    )["id"]
    with fake_model(responder_for("en")) as model:
        client.post(f"/api/courses/{cid}/syllabus/regenerate", json={"content": "Simpler"})

    assert "never list it under \"Out of scope\"" in model.calls[0]["system"]


# ---------------------------------------------------------------------------
# RB6：术语第一次出现就解释
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name,marker", [
    ("first_lesson", "**术语第一次出现就解释**"), ("next_lesson", "**术语第一次出现就解释**"), ("source_lesson", "**术语第一次出现就解释**"),
])
def test_the_chinese_lesson_prompts_ask_for_a_plain_sentence_on_first_use_of_a_term(name, marker):
    prompt = getattr(courses_module.PROMPTS["zh"], name)

    assert marker in prompt and "专业术语和缩写" in prompt and "一句大白话解释" in prompt and "外行" in prompt


@pytest.mark.parametrize("name", ["first_lesson", "next_lesson", "source_lesson"])
def test_the_english_lesson_prompts_ask_for_the_same(name):
    prompt = getattr(courses_module.PROMPTS["en"], name)

    assert "**Explain a term the first time it appears**" in prompt
    assert "technical term or abbreviation" in prompt and "plain-language sentence" in prompt and "new to the field" in prompt


def test_the_zh_and_en_lesson_prompts_use_the_same_placeholders():
    import string

    def fields(template):
        return sorted({name for _, name, _, _ in string.Formatter().parse(template) if name})

    for name in ("first_lesson", "next_lesson", "source_lesson", "eval_lesson", "syllabus"):
        assert fields(getattr(courses_module.PROMPTS["zh"], name)) == fields(getattr(courses_module.PROMPTS["en"], name)), name


# ---- 「按你的要求：……」这一行放进输出格式（不是只写在规则里），学生写了反馈才有 ----

def test_the_adjustment_line_is_part_of_the_output_format_when_the_student_wrote_feedback(client):
    cid, _ = make_course(client, "zh")
    set_feedback(cid, "少一点推导")

    system = generate_next(client, cid).calls[0]["system"]
    review = system.split("## 输出格式", 1)[1].split("## 正文内容", 1)[0]  # 没作答：没有复盘小节，回顾部分就是那行小字 + 「按你的要求」

    assert "> 上一篇的思考题是可选的，参考答案放在本篇末尾。" in review and "\n## 上一篇思考题复盘\n" not in review
    assert "[学生写了反馈。反馈里如果有明确要求" in review and "「按你的要求：……」" in review
    assert "这一行是必须写的，正文也必须真的照做" in review and "反馈只是感想、没有明确要求，就不写这一行" in review


def test_without_feedback_text_the_format_has_no_adjustment_line(client):
    cid, _ = make_course(client, "zh")

    assert "[学生写了反馈" not in generate_next(client, cid).calls[0]["system"].split("## 输出格式", 1)[1]
    cid2, _ = make_course(client, "zh")
    set_feedback(cid2, "   ", answers="1. 我的答案")
    assert "[学生写了反馈" not in generate_next(client, cid2).calls[0]["system"].split("## 输出格式", 1)[1]


def test_the_english_format_carries_the_same_line(client):
    from tests.unit.test_course_language import next_lesson

    cid, _ = make_course(client, "en", name="Eigenvalues")
    set_feedback(cid, "Shorter please, less derivation")

    system = next_lesson(client, cid).calls[0]["system"]
    review = system.split("## Output format", 1)[1].split("## Main content", 1)[0]

    assert "> The previous lesson's reflection questions are optional; the reference answers are at the end of this lesson." in review
    assert "\n## Review of the previous reflection questions\n" not in review
    assert '[The student wrote feedback. If it makes an explicit request' in review and 'starts with "As you asked:"' in review
    assert "This line is mandatory" in review and not CJK.search(system)


def test_the_source_lesson_format_carries_it_inside_the_review_section(client):
    cid = make_source_course(client, "zh", legacy=True)  # 原文阅读篇之后的那一篇走原文课提示词
    set_feedback(cid, "多用 OKR 的例子")

    system = generate_next(client, cid).calls[0]["system"]
    review = system.split("## 划线问题复盘\n\n", 1)[1].split("## 正文内容", 1)[0]

    assert "[学生写了反馈。" in review and review.index("[学生写了反馈。") < review.index("---")  # 在分隔线之前，属于复盘小节


def test_the_source_lesson_has_no_shorter_than_the_previous_lesson_rule_only_an_absolute_cap():
    zh, en = courses_module.SOURCE_LESSON_PROMPT, prompts_en.SOURCE_LESSON_PROMPT

    assert "本篇比上一篇短" not in zh and "本篇整篇阅读内容（含回顾、正文、思考题、参考答案，除标题和元信息）控制在约 1500 字以内" in zh
    assert "shorter than the previous one" not in en and "stays within about 1000 words, with at most 2 review lines" in en
    assert "「划线问题复盘」小节里只放「按你的要求」那一行" in zh
    assert 'holds only the "As you asked:" line' in en


def test_the_assessment_and_the_source_review_never_call_a_highlight_answer_the_students_own():
    for prompt in (courses_module.EVAL_LESSON_PROMPT, courses_module.SOURCE_LESSON_PROMPT):
        assert "不是学生自己的回答" in prompt and "不要说「你的回答」" in prompt
    for prompt in (prompts_en.EVAL_LESSON_PROMPT, prompts_en.SOURCE_LESSON_PROMPT):
        assert "not an answer from the student" in prompt and 'never call it "your answer"' in prompt
        assert not CJK.search(prompt)
    # 原文课第 2 篇的「划线问题复盘」归纳共性困惑时会提到当时的解答；评估篇只回答当时没答的提问
    assert "你划线问『……』时得到的解答是……" in courses_module.SOURCE_LESSON_PROMPT
    assert "the answer you got when you highlighted" in prompts_en.SOURCE_LESSON_PROMPT
    assert "已经有「答」的提问学生已经看过解答，这里一条都不要提" in courses_module.EVAL_LESSON_PROMPT
    assert "so do not mention it here at all" in prompts_en.EVAL_LESSON_PROMPT
