"""解析与校验同时认中文和英文结构：模型按课程语言输出什么结构，代码都要能读懂。

中文写法的断言在 test_courses.py / test_prompts.py 里；这里是英文写法、中英两套的对称性，以及两套文字表的一致性。
"""
import re
import string
from datetime import datetime

import pytest

import app.course_language as language_module
import app.courses as courses_module
import app.prompts_en as prompts_en
import app.recommendations as recommendations_module
from app.models import Course, LearningRecommendation
from app.schemas import Language
from tests.conftest import TestSession

CJK = re.compile(r"[一-鿿]")

EN_LESSON = """# Compound interest

> Prerequisites: none
> Difficulty: Beginner
> Estimated reading time: 8 minutes

## Main content

According to the materials, interest can itself earn interest (Source: notes.md, Intro) and the effect grows with time (Source: notes.md, Growth).

## Reflection questions

1. Why does the growth curve bend upwards?
2. How would you compare simple and compound interest for ten years?
"""

EN_SYLLABUS = """# Compound interest · Course Outline

> This outline defines everything you will be able to do after completing this topic.
> Learning depth: Standard
> The number of lessons varies from person to person, but the mastery goals are never reduced.

## Core mastery items

After completing this topic, you will be able to:

### Foundations
- [ ] Explain why interest can earn interest (Source: notes.md, Intro)
- [ ] Apply the compounding formula to a savings plan (Source: notes.md, Growth)
- [ ] Derive the doubling time from the growth rate (Source: notes.md, Growth)
- [ ] Compare nominal and effective rates (Source: notes.md, Rates)

### Judgment
- [ ] Judge when simple interest is a good enough model (Source: notes.md, Limits)
- [ ] Explain how inflation changes the real return (Source: notes.md, Limits)
- [ ] Apply the rule of 72 to a quick estimate (Source: notes.md, Growth)
- [ ] Judge which loan offer costs less (Source: notes.md, Rates)

## Out of scope

- Tax treatment of interest

## Learning progress

| Lesson | Mastery items covered | Date generated |
|--------|----------------------|----------------|
"""


# ---- 思考题抽取 ----

@pytest.mark.parametrize("heading", [
    "## Reflection questions", "## Reflection Questions", "## reflection question", "## Thought questions", "##  Thought Question",
    "## Reflection questions:", "## Reflection Questions：", "## Thought questions :", "## Questions for reflection",
    "## Question for Reflection:", "## Reflection", "## Reflection:",
])
def test_english_reflection_headings_are_extracted(heading):
    lesson = f"# T\n\n## Main content\n\nBody\n\n{heading}\n\n1. First?\n2. Second?\n\n## Your feedback\n\n> old"

    assert courses_module._extract_thought_questions(lesson) == "1. First?\n2. Second?"


def test_the_trailing_mastery_comment_is_left_out_of_english_questions():
    lesson = "# T\n\n## Reflection questions\n\n1. First?\n\n<!-- mastery: Explain A; Apply B -->"

    assert courses_module._extract_thought_questions(lesson) == "1. First?"


def test_the_review_section_of_the_previous_questions_is_not_taken_for_the_questions():
    lesson = (
        "# T\n\n## Review of the previous reflection questions\n\n### Correct answers\n\n**Question 1:** x\n\n"
        "## Main content\n\nBody\n\n## Reflection questions\n\n1. Real question?"
    )

    assert courses_module._extract_thought_questions(lesson) == "1. Real question?"
    assert courses_module._extract_thought_questions("# T\n\n## Review of the previous reflection questions\n\nonly") == ""


@pytest.mark.parametrize("heading", [
    "## Reflection questions:", "## Reflection Questions：", "## Questions for reflection", "### Reflection", "## Reflection",
])
def test_a_decorated_questions_heading_is_normalized_instead_of_getting_a_second_templated_section(heading):
    syllabus = "- [ ] Explain A (Source: a.md, Intro)\n- [ ] Explain B (Source: a.md, Intro)"
    lesson = (
        "# L\n\n## Main content\n\nAccording to the materials, x (Source: a.md, Intro) and y (Source: a.md, Growth).\n\n"
        f"{heading}\n\n1. First question?\n2. Second question?\n"
    )

    ensured = courses_module._ensure_grounded_lesson_questions(lesson, syllabus, "en")

    assert ensured.count("Reflection") == 1 and "## Reflection questions" in ensured
    assert "Based on this lesson" not in ensured
    assert courses_module._extract_thought_questions(ensured) == "1. First question?\n2. Second question?"
    assert courses_module._grounded_lesson_review_valid(ensured) is True
    assert courses_module._grounded_lesson_review_valid(lesson.replace(heading, "## Reflection questions")) is True
    if heading.startswith("## "):
        assert courses_module._grounded_lesson_review_valid(lesson) is True  # 二级标题不整理也算有思考题小节


def test_a_report_in_front_of_a_lesson_whose_only_questions_heading_is_a_bare_reflection_is_salvaged():
    lesson = "# Lesson\n\n## Main content\n\nBody\n\n## Reflection\n\n1. Why?\n"

    assert courses_module._extract_lesson_artifact(f"Review notes.\n\n```markdown\n{lesson}```") == lesson.strip()


def test_other_headings_do_not_pass_for_the_questions_section():
    assert courses_module._extract_thought_questions("## Reflections\n\n1. x?") == ""
    assert courses_module._extract_thought_questions("## Reflection on growth\n\n1. x?") == ""
    assert courses_module._extract_thought_questions("## Reflection and review:\n\n1. x?") == ""
    assert courses_module._extract_thought_questions("### Reflection questions\n\n1. x?") == ""
    assert courses_module._extract_thought_questions("## Questions\n\n1. x?") == ""


# ---- 问句规整 ----

def test_numbered_english_questions_ending_with_a_period_get_a_question_mark():
    content = "## Reflection questions\n\n1. Why does the curve bend.\n2. Explain the idea in your own words.\n3. The sky is blue.\n"

    normalized = courses_module._normalize_lesson_questions(content)

    assert "1. Why does the curve bend?" in normalized
    assert "2. Explain the idea in your own words?" in normalized
    assert "3. The sky is blue." in normalized


def test_chinese_questions_are_normalized_exactly_as_before():
    content = "## 思考题\n\n1. 为什么概念需要条件，请说明。\n2. 这是一个陈述。\n"

    normalized = courses_module._normalize_lesson_questions(content)

    assert "1. 为什么概念需要条件，请说明？" in normalized and "2. 这是一个陈述。" in normalized


# ---- 资料课首课结构整理 ----

def test_the_english_structure_is_normalized_in_english():
    lesson = "# Lesson\n\n## Content\n\nA made-up opening.\n\n### Reflection Questions\n\n- Why?\n"

    normalized = courses_module._normalize_grounded_lesson_structure(lesson, "en")

    assert "## Reflection questions" in normalized and "###" not in normalized
    assert "## Main content\n\nAccording to the materials, what follows is built on" in normalized
    assert "A made-up opening." in normalized
    assert not CJK.search(normalized)


@pytest.mark.parametrize("opening", [
    "According to the materials, X.", "according to the uploaded materials X.", "According to the provided sources, X.",
    "According to your materials, X.", "The materials indicate that X.", "The uploaded materials state X.",
    "The source document explains X.",
])
def test_an_english_body_that_already_cites_the_materials_is_left_alone(opening):
    lesson = f"# Lesson\n\n## Main content\n\n{opening}\n\n## Reflection questions\n\n1. Why?\n"

    assert courses_module._normalize_grounded_lesson_structure(lesson, "en") == lesson


def test_a_chinese_body_keeps_its_chinese_grounding_line():
    lesson = "# 第一课\n\n## 正文内容\n\n从一个例子开始。\n\n## 思考题\n\n- 为什么？\n"

    normalized = courses_module._normalize_grounded_lesson_structure(lesson)

    assert "## 正文内容\n\n资料指出，以下内容依据上传材料" in normalized


def test_an_english_lesson_wrapped_in_a_reviewer_report_is_salvaged():
    wrapped = f"Review notes: fixed two facts.\n\n```markdown\n{EN_LESSON}```"

    assert courses_module._extract_lesson_artifact(wrapped) == EN_LESSON.strip()
    report_first = f"# Review report\n\nNothing wrong with the questions.\n\n{EN_LESSON}"
    assert courses_module._extract_lesson_artifact(report_first).startswith("# Review report")


def test_missing_english_questions_are_added_before_the_old_feedback_section_or_at_the_end():
    syllabus = "\n".join(f"- [ ] Explain core concept {i} (Source: a.md, Concepts)" for i in range(1, 4))
    lesson = "# Lesson\n\n## Main content\n\nAccording to the materials, facts.\n\n## Your feedback\n\n> old\n"

    ensured = courses_module._ensure_grounded_lesson_questions(lesson, syllabus, "en")

    assert ensured.index("## Main content") < ensured.index("## Reflection questions") < ensured.index("## Your feedback")
    questions = courses_module._extract_thought_questions(ensured)
    assert questions.count("?") == 3
    assert "Explain core concept 1" in questions and "(Source:" not in questions
    assert not CJK.search(questions)

    at_the_end = courses_module._ensure_grounded_lesson_questions("# L\n\n## Main content\n\nBody\n", syllabus, "en")
    assert at_the_end.rstrip().endswith("?") and "## Reflection questions" in at_the_end


def test_fallback_questions_do_not_keep_the_space_that_preceded_the_source_note():
    syllabus = (
        "- [ ] Explain A (Source: a.md, “Intro (part 1)”)\n"
        "- [ ] Judge B   (source: a.md, Growth)  \n"
        "- [ ] Apply C (Source: a.md, Rates)\n"
    )
    lesson = "# L\n\n## Main content\n\nBody\n"

    questions = courses_module._extract_thought_questions(courses_module._ensure_grounded_lesson_questions(lesson, syllabus, "en"))

    assert questions.splitlines() == [
        "- Based on this lesson, how would you explain or judge this mastery goal: “Explain A”?",
        "- Based on this lesson, how would you explain or judge this mastery goal: “Judge B”?",
        "- Based on this lesson, how would you explain or judge this mastery goal: “Apply C”?",
    ]


def test_chinese_fallback_questions_are_byte_identical_to_before_even_with_a_space_before_the_note():
    syllabus = "- [ ] 能够解释A （来源：a.md，概念）\n- [ ] 能够解释B（来源：a.md，概念） \n"
    lesson = "# 第一课\n\n## 正文内容\n\n资料指出一些事实。\n"

    questions = courses_module._extract_thought_questions(courses_module._ensure_grounded_lesson_questions(lesson, syllabus))

    assert questions.splitlines() == [
        "- 根据本篇正文，如何解释或判断这一掌握目标：“能够解释A ”？",
        "- 根据本篇正文，如何解释或判断这一掌握目标：“能够解释B”？",
    ]


def test_english_question_lines_without_a_question_mark_get_an_ascii_one():
    lesson = "# L\n\n## Main content\n\nAccording to the materials, x.\n\n## Reflection questions\n\n- Explain the idea.\n- Compare the cases.\n- Is it true?\n"

    ensured = courses_module._ensure_grounded_lesson_questions(lesson, "", "en")

    assert "- Explain the idea?" in ensured and "- Compare the cases?" in ensured and "- Is it true?" in ensured
    assert "？" not in ensured


def test_english_questions_written_as_plain_lines_become_a_numbered_list_instead_of_fallback_questions():
    lesson = (
        "# L\n\n## Main content\n\nAccording to the materials, x (Source: a.md, Intro) and y (Source: a.md, Growth).\n\n"
        "## Reflection questions\n\n"
        "Which account keeps the same yearly interest?  \nWhat changes between year one and year two?  \n"
        "Why is the $2.50 difference not a higher rate?\n\nA closing remark without a question mark.\n"
    )
    syllabus = "- [ ] Explain A (Source: a.md, Intro)\n- [ ] Explain B (Source: a.md, Intro)"

    ensured = courses_module._ensure_grounded_lesson_questions(lesson, syllabus, "en")

    assert courses_module._extract_thought_questions(ensured) == (
        "1. Which account keeps the same yearly interest?\n2. What changes between year one and year two?\n"
        "3. Why is the $2.50 difference not a higher rate?"
    )
    assert "Based on this lesson" not in ensured
    assert courses_module._grounded_lesson_review_valid(ensured) is True


def test_english_plain_and_marked_question_lines_mix_and_a_single_question_still_falls_back():
    syllabus = "- [ ] Explain A (Source: a.md, Intro)\n- [ ] Explain B (Source: a.md, Intro)"
    mixed = "# L\n\n## Reflection questions\n\n- First one?\nSecond one?\n"
    single = "# L\n\n## Reflection questions\n\nOnly one question?\n"

    assert courses_module._extract_thought_questions(
        courses_module._ensure_grounded_lesson_questions(mixed, syllabus, "en")
    ) == "1. First one?\n2. Second one?"
    fallback = courses_module._extract_thought_questions(courses_module._ensure_grounded_lesson_questions(single, syllabus, "en"))
    assert fallback.splitlines()[0] == "- Based on this lesson, how would you explain or judge this mastery goal: “Explain A”?"


def test_chinese_plain_question_lines_are_still_replaced_by_fallback_questions_as_before():
    syllabus = "- [ ] 能够解释概念A（来源：a.md，概念）\n- [ ] 能够解释概念B（来源：a.md，概念）"
    lesson = "# 第一课\n\n## 正文内容\n\n资料指出一些事实。\n\n## 思考题\n\n第一个问题是什么？\n第二个问题是什么？\n"

    ensured = courses_module._ensure_grounded_lesson_questions(lesson, syllabus)

    assert courses_module._extract_thought_questions(ensured) == (
        "- 根据本篇正文，如何解释或判断这一掌握目标：“能够解释概念A”？\n- 根据本篇正文，如何解释或判断这一掌握目标：“能够解释概念B”？"
    )


# ---- 资料课首课校验 ----

def test_a_well_formed_english_grounded_lesson_is_valid():
    assert courses_module._grounded_lesson_review_valid(EN_LESSON) is True
    assert courses_module._grounded_lesson_candidate_score(EN_LESSON)[0] == 2 * 10 + 2


@pytest.mark.parametrize("name, lesson", [
    ("no grounding opening", EN_LESSON.replace("According to the materials,", "Interest can")),
    ("one source only", EN_LESSON.replace(" (Source: notes.md, Growth)", "")),
    ("no questions section", EN_LESSON.split("## Reflection questions")[0]),
    ("one question", EN_LESSON.replace("2. How would you compare simple and compound interest for ten years?\n", "")),
    ("four questions", EN_LESSON + "3. A third?\n4. A fourth?\n"),
    ("answer given", EN_LESSON.replace("1. Why does the growth curve bend upwards?", "1. Why does it bend? The correct answer is exponential growth.")),
    ("fenced", "```markdown\n" + EN_LESSON + "```"),
])
def test_an_english_lesson_that_breaks_the_rules_is_invalid(name, lesson):
    assert courses_module._grounded_lesson_review_valid(lesson) is False, name


@pytest.mark.parametrize("question", [
    "Which is the correct answer for a 5% rate over 2 years?",
    "What is the correct answer when the rate doubles?",
    "Why would someone think the correct answer is simple interest?",
    "Explain why the answer is not unique?",
    "Is it enough to say the answer is yes? Why or why not?",
    "Whether the correct answer is yes or no, how would you justify it?",
    "If the correct answer is B, why does A fail?",
    "How do you check an answer that seems too large?",
    "What does the answer to this calculation tell you about the rate?",
])
def test_a_question_that_merely_mentions_an_answer_is_not_a_leak(question):
    lesson = EN_LESSON.replace("1. Why does the growth curve bend upwards?", f"1. {question}")

    assert courses_module._grounded_lesson_review_valid(lesson) is True, question


@pytest.mark.parametrize("question", [
    "Why does it bend? The correct answer is exponential growth.",
    "Why does it bend? The correct answers are growth and time.",
    "Why does it bend? The answer is exponential growth.",
    "Why does it bend? Correct answer: exponential growth.",
    "Why does it bend? Answer: exponential growth.",
    "Why does it bend? (answer: exponential growth)",
])
def test_a_question_followed_by_its_answer_is_a_leak(question):
    lesson = EN_LESSON.replace("1. Why does the growth curve bend upwards?", f"1. {question}")

    assert courses_module._grounded_lesson_review_valid(lesson) is False, question


def test_the_chinese_leak_check_is_unchanged():
    zh = "# 第一课\n\n## 正文内容\n\n资料指出甲（来源：a.md，概念）乙（来源：a.md，案例）\n\n## 思考题\n\n1. {q}\n2. 如何应用？\n"

    assert courses_module._grounded_lesson_review_valid(zh.format(q="概念是什么？")) is True
    assert courses_module._grounded_lesson_review_valid(zh.format(q="概念是什么？答案是 A")) is False
    assert courses_module._grounded_lesson_review_valid(zh.format(q="哪个是正确答案？")) is False  # 原有的严格，没动


def test_the_phrase_the_answer_is_inside_a_real_question_is_not_a_leak():
    lesson = EN_LESSON.replace(
        "1. Why does the growth curve bend upwards?", "1. If the answer is yes, why does the curve bend upwards?",
    )

    assert courses_module._grounded_lesson_review_valid(lesson) is True
    leaked = EN_LESSON.replace("1. Why does the growth curve bend upwards?", "1. Why does it bend? The answer is exponential growth.")
    assert courses_module._grounded_lesson_review_valid(leaked) is False


# ---- 大纲 ----

def test_an_english_syllabus_passes_the_grounded_review_check():
    assert courses_module._grounded_syllabus_review_valid(EN_SYLLABUS, EN_SYLLABUS, "simple") is True
    assert courses_module._grounded_syllabus_review_valid(EN_SYLLABUS, EN_SYLLABUS, "deep") is False  # 8 items < 12


@pytest.mark.parametrize("name, reviewed", [
    ("missing source", EN_SYLLABUS.replace(" (Source: notes.md, Rates)", "", 1)),
    ("missing out of scope", EN_SYLLABUS.replace("## Out of scope", "## Notes")),
    ("missing progress", EN_SYLLABUS.replace("## Learning progress", "## Table")),
    ("missing mastery heading", EN_SYLLABUS.replace("## Core mastery items", "## Items")),
    ("too many items", EN_SYLLABUS.replace("## Out of scope", "".join(f"- [ ] Explain x{i} (Source: a)\n" for i in range(5)) + "\n## Out of scope")),
    ("fenced", EN_SYLLABUS + "\n```"),
    ("not a title", "intro\n" + EN_SYLLABUS),
])
def test_an_english_syllabus_that_breaks_the_rules_is_rejected(name, reviewed):
    assert courses_module._grounded_syllabus_review_valid(EN_SYLLABUS, reviewed, "simple") is False, name


@pytest.mark.parametrize("heading", ["## Out of scope", "## Out of Scope for This Topic", "## Not covered in this topic"])
def test_the_out_of_scope_section_accepts_a_few_natural_titles(heading):
    reviewed = EN_SYLLABUS.replace("## Out of scope", heading)

    assert courses_module._grounded_syllabus_review_valid(EN_SYLLABUS, reviewed, "simple") is True


def test_a_syllabus_wrapped_in_an_english_audit_report_is_salvaged():
    wrapped = f"Audit report: two items changed.\n\n{EN_SYLLABUS}"

    assert courses_module._extract_syllabus_artifact(wrapped).startswith("# Compound interest · Course Outline")
    fenced = f"Report\n\n```markdown\n{EN_SYLLABUS}\n```"
    assert courses_module._extract_syllabus_artifact(fenced).startswith("# Compound interest · Course Outline")
    assert courses_module._extract_syllabus_artifact("# Something · Syllabus\n\nx") == "# Something · Syllabus\n\nx"


def test_overlong_english_syllabi_are_trimmed_per_module():
    overlong = """# T · Course Outline
## Core mastery items
### A
- [ ] A1 (Source: a)
- [ ] A2 (Source: a)
- [ ] A3 (Source: a)
### B
- [ ] B1 (Source: b)
- [ ] B2 (Source: b)
- [ ] B3 (Source: b)
## Out of scope
- X
## Learning progress
| Lesson | Mastery items covered | Date generated |
"""
    trimmed = courses_module._trim_syllabus_mastery_items(overlong, 4)

    assert courses_module._count_mastery_items(trimmed)[1] == 4
    assert "### A" in trimmed and "### B" in trimmed
    assert trimmed.count("- [ ] A") == 2 and trimmed.count("- [ ] B") == 2


# ---- 知识包 ----

EN_PACK_BODY = "\n".join(f"{h}\ncontent" for h in language_module.PACK_HEADINGS_EN[1:-1])
INDEX = "notes.md: Intro and Growth sections. All key definitions, mechanisms, examples and boundaries trace back to a file and section."


def test_an_english_knowledge_pack_is_valid_and_so_is_a_chinese_one():
    english = f"{language_module.PACK_HEADINGS_EN[0]}\n{EN_PACK_BODY}\n{language_module.PACK_HEADINGS_EN[-1]}\n{INDEX}\n"
    chinese = f"{language_module.PACK_HEADINGS_ZH[0]}\n" + "\n".join(f"{h}\n内容" for h in language_module.PACK_HEADINGS_ZH[1:-1]) + \
        f"\n{language_module.PACK_HEADINGS_ZH[-1]}\n" + "来源索引内容" * 20

    assert courses_module._material_knowledge_pack_valid(english) is True
    assert courses_module._material_knowledge_pack_valid(english.lower()) is True
    assert courses_module._material_knowledge_pack_valid(chinese) is True


@pytest.mark.parametrize("name, pack", [
    ("hollow index", f"{language_module.PACK_HEADINGS_EN[0]}\n{EN_PACK_BODY}\n{language_module.PACK_HEADINGS_EN[-1]}\nshort\n"),
    ("missing section", f"{language_module.PACK_HEADINGS_EN[0]}\n" + "\n".join(f"{h}\nx" for h in language_module.PACK_HEADINGS_EN[1:4]) + f"\n{language_module.PACK_HEADINGS_EN[-1]}\n{INDEX}"),
    ("not at the start", f"Here is the pack:\n{language_module.PACK_HEADINGS_EN[0]}\n{EN_PACK_BODY}\n{language_module.PACK_HEADINGS_EN[-1]}\n{INDEX}"),
    ("half chinese half english", f"{language_module.PACK_HEADINGS_ZH[0]}\n{EN_PACK_BODY}\n{language_module.PACK_HEADINGS_EN[-1]}\n{INDEX}"),
    ("empty", ""),
])
def test_a_broken_knowledge_pack_is_rejected(name, pack):
    assert courses_module._material_knowledge_pack_valid(pack) is False, name


# ---- 掌握项勾选 ----

def test_english_mastery_items_are_checked_when_the_lesson_lists_them():
    lesson = "# L\n\n## Reflection questions\n\n1. Why?\n\n<!-- mastery: Explain why interest can earn interest (Source: notes.md, Intro); Judge when simple interest is a good enough model (Source: notes.md, Limits) -->"

    updated = courses_module._auto_check_mastery(EN_SYLLABUS, lesson)

    assert "- [x] Explain why interest can earn interest (Source: notes.md, Intro)" in updated
    assert "- [x] Judge when simple interest is a good enough model (Source: notes.md, Limits)" in updated
    assert "- [ ] Apply the compounding formula to a savings plan (Source: notes.md, Growth)" in updated


def test_a_mastery_item_that_contains_a_semicolon_is_still_recognized():
    syllabus = (
        "## Core mastery items\n- [ ] Explain the effect; give one example (Source: a.md, Intro)\n"
        "- [ ] Apply the formula (Source: a.md, Growth)\n- [ ] Judge the limits\n"
    )
    lesson = "x\n<!-- mastery: Apply the formula (Source: a.md, Growth); Explain the effect; give one example (Source: a.md, Intro) -->"

    updated = courses_module._auto_check_mastery(syllabus, lesson)

    assert "- [x] Explain the effect; give one example (Source: a.md, Intro)" in updated
    assert "- [x] Apply the formula (Source: a.md, Growth)" in updated
    assert "- [ ] Judge the limits" in updated


def test_mastery_items_without_semicolons_behave_exactly_as_before():
    syllabus = "- [ ] 能够解释概念A\n- [ ] 能够应用概念B\n- [ ] 能够判断概念C"

    updated = courses_module._auto_check_mastery(syllabus, "x\n<!-- mastery: 能够解释概念A; 能够判断概念C; 能够凭空发明 -->")

    assert updated == "- [x] 能够解释概念A\n- [ ] 能够应用概念B\n- [x] 能够判断概念C"
    assert courses_module._auto_check_mastery(syllabus, "no comment") == syllabus
    assert courses_module._auto_check_mastery(syllabus, "<!-- mastery: ; -->") == syllabus


def test_titles_and_progress_are_the_same_for_both_languages():
    assert courses_module._extract_title(EN_LESSON) == "Compound interest"
    assert courses_module._count_mastery_items(EN_SYLLABUS) == (0, 8)


# ---- 来源标注 ----

@pytest.mark.parametrize("text, count", [
    ("（来源：a.md，概念）（来源：b.md，案例）", 2),
    ("(Source: a.md, Concepts) (source: b.md, Cases) Sources: c.md", 3),
    ("A resource: nothing here, open-source: no", 0),
    ("", 0),
])
def test_source_marks_are_counted_in_both_languages(text, count):
    assert language_module.count_source_marks(text) == count
    assert language_module.has_source_mark(text) is (count > 0)


# ---- 提示词与文字表 ----

def _fields(template):
    return sorted({name for _, name, _, _ in string.Formatter().parse(template) if name})


EN_PROMPTS = {
    "syllabus": prompts_en.SYLLABUS_PROMPT,
    "first_lesson": prompts_en.FIRST_LESSON_PROMPT,
    "material_chunk": prompts_en.MATERIAL_CHUNK_PROMPT,
    "material_reduce": prompts_en.MATERIAL_REDUCE_PROMPT,
    "material_synthesis": prompts_en.MATERIAL_SYNTHESIS_PROMPT,
    "syllabus_review": prompts_en.GROUNDED_SYLLABUS_REVIEW_PROMPT,
    "lesson_review": prompts_en.GROUNDED_LESSON_REVIEW_PROMPT,
    "syllabus_repair": prompts_en.GROUNDED_SYLLABUS_REPAIR_PROMPT,
    "lesson_repair": prompts_en.GROUNDED_LESSON_REPAIR_PROMPT,
    "source_lesson": prompts_en.SOURCE_LESSON_PROMPT,
    "next_lesson": prompts_en.NEXT_LESSON_PROMPT,
    "annotation_answer": prompts_en.ANNOTATION_ANSWER_PROMPT,
    "eval_lesson": prompts_en.EVAL_LESSON_PROMPT,
    "summary": prompts_en.SUMMARY_PROMPT,
}


def test_the_prompt_registry_covers_every_language_and_every_prompt():
    import typing

    languages = set(typing.get_args(Language))
    assert languages == set(courses_module.PROMPTS) == set(language_module._TEXTS)
    assert set(recommendations_module.RECOMMENDATION_PROMPTS) == languages
    for name in EN_PROMPTS:
        assert getattr(courses_module.PROMPTS["en"], name) is EN_PROMPTS[name]
        assert getattr(courses_module.PROMPTS["zh"], name)
    assert courses_module.PROMPTS["zh"].syllabus is courses_module.SYLLABUS_PROMPT
    assert courses_module.PROMPTS["zh"].next_lesson is courses_module.NEXT_LESSON_PROMPT


@pytest.mark.parametrize("name", sorted(EN_PROMPTS))
def test_each_english_prompt_has_the_same_placeholders_as_the_chinese_one(name):
    assert _fields(EN_PROMPTS[name]) == _fields(getattr(courses_module.PROMPTS["zh"], name))


@pytest.mark.parametrize("name", sorted(EN_PROMPTS))
def test_english_prompts_contain_no_chinese_and_require_english_output(name):
    prompt = EN_PROMPTS[name]

    assert not CJK.search(prompt)
    assert re.search(r"\bin English\b|\bEnglish\b", prompt), "must say the output is English"


@pytest.mark.parametrize("name", ["syllabus", "first_lesson", "source_lesson", "next_lesson", "eval_lesson", "summary"])
def test_english_prompts_with_a_format_example_use_english_structure(name):
    prompt = EN_PROMPTS[name]

    assert "Learning depth" in prompt or "Prerequisites" in prompt or "Final Assessment" in prompt or "Learning Summary" in prompt
    if name in ("first_lesson", "source_lesson", "next_lesson"):
        assert "## Reflection questions" in prompt and "## Main content" in prompt
        assert "## 思考题" not in prompt and "## 正文内容" not in prompt
    if name == "syllabus":
        assert "## Core mastery items" in prompt and "## Out of scope" in prompt and "## Learning progress" in prompt
    if name == "next_lesson":
        assert "<!-- mastery: Explain the core concept A; Apply concept A to solve a simple problem -->" in prompt
        assert "separating items with a semicolon" in prompt


def test_the_english_syllabus_prompt_keeps_semicolons_out_of_mastery_items():
    assert "Do not use semicolons inside a mastery item" in prompts_en.SYLLABUS_PROMPT


def test_the_english_lesson_prompts_never_ask_for_a_feedback_section():
    for name in ("first_lesson", "source_lesson", "next_lesson", "eval_lesson", "lesson_review", "lesson_repair"):
        prompt = EN_PROMPTS[name]
        assert "## Your feedback" not in prompt
        assert 'Your feedback" style placeholder section' in prompt, name


def test_the_text_tables_have_the_same_templates_in_both_languages():
    zh, en = language_module.ZH, language_module.EN
    for field in zh.__dataclass_fields__:
        zh_value, en_value = getattr(zh, field), getattr(en, field)
        assert zh_value and en_value, field
        assert _fields(zh_value) == _fields(en_value), field


def test_the_english_text_table_has_no_chinese():
    for field in language_module.EN.__dataclass_fields__:
        assert not CJK.search(getattr(language_module.EN, field)), field


def test_the_recommendation_prompts_match_in_shape():
    zh, en = recommendations_module.RECOMMENDATION_PROMPTS["zh"], recommendations_module.RECOMMENDATION_PROMPTS["en"]

    assert zh is recommendations_module.RECOMMENDATION_PROMPT
    assert not CJK.search(en)
    assert "write every title, rationale and bridge in English" in en
    assert 'address the learner as "you"' in en
    import json
    json_block = en[en.index("[\n"):en.rindex("]") + 1]
    assert isinstance(json.loads(json_block), list)


# ---- 材料定位与来源标记跟课程语言走 ----

def test_markdown_locators_and_source_markers_follow_the_language():
    raw = "intro text\n\n# Chapter\n\n## Part\n\nbody".encode()

    zh = courses_module._extract_markdown_sections(raw, "a.md")
    en = courses_module._extract_markdown_sections(raw, "a.md", "en")

    assert [s.locator for s in zh] == ["文档开头", "Chapter", "Chapter > Part"]
    assert [s.locator for s in en] == ["Start of document", "Chapter", "Chapter > Part"]
    assert courses_module._extract_markdown_sections(b"plain", "b.md", "en")[0].locator == "Start of document"
    chunks_en = courses_module._chunk_material_sections(en, "en")
    assert chunks_en[0].startswith("[Source: a.md; Location: Start of document]")
    assert courses_module._chunk_material_sections(zh)[0].startswith("[来源：a.md；位置：文档开头]")


def test_overlong_sections_are_split_with_a_localized_part_suffix():
    section = courses_module.MaterialSection("big.md", "Chapter", "word " * 9000)

    zh = courses_module._split_long_material_section(section)
    en = courses_module._split_long_material_section(section, "en")

    assert zh[0].locator == "Chapter（分段 1）" and zh[1].locator == "Chapter（分段 2）"
    assert en[0].locator == "Chapter (part 1)" and en[1].locator == "Chapter (part 2)"


def test_pdf_pages_are_located_in_the_course_language():
    from unittest.mock import patch

    class FakePage:
        def extract_text(self):
            return "page text"

    class FakeReader:
        def __init__(self, _stream):
            self.pages = [FakePage(), FakePage()]

    with patch("app.courses.PdfReader", FakeReader):
        en = courses_module._material_sections_from_bytes(b"%PDF", "paper.pdf", "en")
        zh = courses_module._material_sections_from_bytes(b"%PDF", "paper.pdf")

    assert [s.locator for s in en] == ["Page 1", "Page 2"]
    assert [s.locator for s in zh] == ["第 1 页", "第 2 页"]


def test_relevant_chunks_are_marked_in_the_course_language():
    sections = [courses_module.MaterialSection("notes.md", "Growth", "compound interest grows exponentially")]
    archive_en = courses_module._serialize_material_archive("# Course Reference Pack\nx", sections, "en")

    selected = courses_module._select_relevant_material_sections(archive_en, "compound interest", language="en")

    assert selected.startswith("[Source: notes.md; Location: Growth]")
    assert courses_module._select_relevant_material_sections(archive_en, "compound interest").startswith("[来源：notes.md；位置：Growth]")


# ---- 划线问答记录 ----

def test_highlight_records_are_formatted_in_the_course_language():
    from app.models import Annotation

    annotation = Annotation(
        lesson_id=1, position_start=0, position_end=1, original_text="compounding", comment="What is it?", answer="A thing.",
        messages="",
    )

    assert courses_module._format_annotations([], "en") == "No highlight Q&A records."
    assert courses_module._format_annotations([], "zh") == "无划线问答记录。"
    assert courses_module._format_annotations([annotation], "en") == "- Original text “compounding”\n  Q: What is it?\n  A: A thing."
    assert courses_module._format_annotations([annotation]) == "- 原文「compounding」\n  问：What is it?\n  答：A thing."


def test_the_models_default_to_chinese():
    with TestSession() as db:
        course = Course(user_uuid="u", name="n")
        recommendation = LearningRecommendation(user_uuid="u", title="t", rationale="r")
        db.add_all([course, recommendation])
        db.commit()
        db.refresh(course)
        db.refresh(recommendation)

        assert course.language == "zh" and recommendation.language == "zh"
        assert isinstance(course.created_at, datetime)
