"""课文与大纲提示词的新规则（中英文都有）。"""
import pytest

import app.course_language as language_module
import app.courses as courses_module
import app.prompts_en as prompts_en

LESSON_NAMES = ["first_lesson", "next_lesson", "source_lesson"]


@pytest.mark.parametrize("name", LESSON_NAMES)
def test_the_chinese_lesson_prompts_list_only_what_was_really_taught_in_the_mastery_comment(name):
    prompt = getattr(courses_module.PROMPTS["zh"], name)

    assert "**mastery 注释只列真正讲透的要点**" in prompt
    assert "既有解释又有例子（或推导）" in prompt and "只提了一句、说「后面专门讲」的不要列" in prompt
    assert "这部分超出原大纲，按你的要求加讲" in prompt and "不要把它记成覆盖了某一个大纲项" in prompt


@pytest.mark.parametrize("name", LESSON_NAMES)
def test_the_english_lesson_prompts_say_the_same(name):
    prompt = getattr(courses_module.PROMPTS["en"], name)

    assert "**The mastery comment lists only what the lesson really teaches**" in prompt
    assert "both explains it and gives an example (or a derivation) for it" in prompt
    assert "This goes beyond the original outline; added because you asked" in prompt
    assert "do not record it as covering any outline item" in prompt


@pytest.mark.parametrize("name", LESSON_NAMES)
def test_the_chinese_lesson_prompts_ask_for_checked_arithmetic_and_concrete_numbers(name):
    prompt = getattr(courses_module.PROMPTS["zh"], name)

    assert "**算式先验算再写**" in prompt and "总数是否守恒" in prompt and "前后出现的同一个数字必须一致" in prompt
    assert "「滚了几轮」「翻了几倍」「相当于多少年」这类说法必须给出具体数字" in prompt


@pytest.mark.parametrize("name", LESSON_NAMES)
def test_the_english_lesson_prompts_ask_for_the_same(name):
    prompt = getattr(courses_module.PROMPTS["en"], name)

    assert "**Check every calculation before you write it**" in prompt and "does the total stay the same" in prompt
    assert "every later mention of the same number must agree" in prompt
    assert "must come with the concrete numbers" in prompt


@pytest.mark.parametrize("name", LESSON_NAMES)
def test_the_chinese_lesson_prompts_keep_reflection_questions_to_taught_terms_and_ban_structure_talk(name):
    prompt = getattr(courses_module.PROMPTS["zh"], name)

    assert "**思考题只用正文讲过的术语，也不写本篇自己的结构自述**" in prompt
    assert "思考题里出现的术语和概念，本篇正文（或前几篇）必须已经解释过" in prompt
    assert "不要写「本篇只配一个例子」「下面分三步」「本节很短」这类描述本篇结构、篇幅、例子数的话" in prompt
    assert "唯一的例外是学生写了反馈时的那一行「按你的要求：……」" in prompt


@pytest.mark.parametrize("name", LESSON_NAMES)
def test_the_english_lesson_prompts_say_the_same_about_terms_and_structure_talk(name):
    prompt = getattr(courses_module.PROMPTS["en"], name)

    assert "**Reflection questions use only terms the body has taught, and the lesson does not describe its own structure**" in prompt
    assert "every term or concept in a reflection question must already be explained in this lesson (or an earlier one)" in prompt
    assert "this lesson uses only one example" in prompt and 'the only exception is the "As you asked:" line' in prompt


def test_the_new_rules_are_numbered_without_gaps_in_every_prompt():
    import re

    for language in ("zh", "en"):
        for name in LESSON_NAMES:
            prompt = getattr(courses_module.PROMPTS[language], name)
            rules = prompt.split("## 规则" if language == "zh" else "## Rules")[-1]
            numbers = [int(n) for n in re.findall(r"(?m)^(\d+)\. ", rules)]
            assert numbers and numbers == list(range(numbers[0], numbers[0] + len(numbers))), (language, name, numbers)


def test_the_english_prompts_still_have_no_chinese():
    from tests.unit.test_course_language import CJK

    for name in LESSON_NAMES:
        assert not CJK.search(getattr(courses_module.PROMPTS["en"], name)), name
    assert language_module.EN is not None and prompts_en is not None


# ---- D8：大纲里来自学生自己问题的掌握项加标记 ----

def test_the_chinese_outline_rules_for_material_and_source_courses_tag_the_items_from_the_students_questions():
    pack = courses_module._build_syllabus_prompt("simple", "zh")
    source = courses_module._build_syllabus_prompt("simple", "zh", source_course=True)

    assert "在条目末尾（「来源」括注之前）加上标记「（来自你的问题）」" in pack
    assert "在条目末尾加上标记「（来自你的问题）」" in source and "（「来源」括注之前）" not in source  # 原文课的掌握项没有来源括注
    for prompt in (pack, source):
        assert "让学生一眼看出哪些是他自己提的；其它掌握项不加这个标记" in prompt
    assert "（来自你的问题）" not in courses_module._build_syllabus_prompt("simple", "zh", has_reference=False)  # 没有资料的主题课没有这类问题


def test_the_english_outline_rules_say_the_same():
    from tests.unit.test_course_language import CJK

    pack = courses_module._build_syllabus_prompt("simple", "en")
    source = courses_module._build_syllabus_prompt("simple", "en", source_course=True)

    assert 'ends with the tag "(from your questions)" (before its source note)' in pack
    assert 'ends with the tag "(from your questions)", so the student can see' in source
    assert "(from your questions)" not in courses_module._build_syllabus_prompt("simple", "en", has_reference=False)
    assert not CJK.search(pack) and not CJK.search(source)


def test_the_reviewer_and_the_repairer_keep_the_tag_only_with_evidence():
    # 校对 / 修复不再「原样保留」草稿里的标记：资料里找不到学生明确提问的就删掉，中英文一致
    assert "没有证据的标记必须删除" in courses_module.GROUNDED_SYLLABUS_REVIEW_PROMPT
    assert "没有证据的标记必须删除" in courses_module.GROUNDED_SYLLABUS_REPAIR_PROMPT
    rule = "a tag without such evidence must be removed, never kept just because the draft has it"
    for prompt in (prompts_en.GROUNDED_SYLLABUS_REVIEW_PROMPT, prompts_en.GROUNDED_SYLLABUS_REPAIR_PROMPT):
        assert rule in prompt and "exactly as it is" not in prompt


def test_a_tagged_item_is_still_ticked_when_the_lesson_comment_leaves_the_tag_off():
    from app.courses import _mastery_comment_items

    outline = "- [ ] 能够区分库存周转率和库存天数两个指标，并说出各自适合的场景（来自你的问题）\n- [ ] 能够解释安全库存的作用\n"
    lesson = "正文\n<!-- mastery: 能够区分库存周转率和库存天数两个指标，并说出各自适合的场景 -->"

    assert _mastery_comment_items(outline, lesson) == ["能够区分库存周转率和库存天数两个指标，并说出各自适合的场景（来自你的问题）"]


def test_a_tagged_grounded_outline_passes_the_structure_check():
    draft = (
        "# 课 · 课程大纲\n\n## 核心掌握项\n\n- [ ] 能够解释甲（来自你的问题）（来源：a.md，第 1 页）\n- [ ] 能够解释乙（来源：a.md，第 2 页）\n"
        "- [ ] 能够解释丙（来源：a.md，第 3 页）\n- [ ] 能够解释丁（来源：a.md，第 4 页）\n- [ ] 能够解释戊（来源：a.md，第 5 页）\n"
        "- [ ] 能够解释己（来源：a.md，第 6 页）\n- [ ] 能够解释庚（来源：a.md，第 7 页）\n- [ ] 能够解释辛（来源：a.md，第 8 页）\n\n"
        "## 不在本课题范围内\n\n- 其它\n\n## 学习进度\n\n| 课文 | 覆盖掌握项 | 生成日期 |\n|---|---|---|\n"
    )

    assert courses_module._grounded_syllabus_review_valid(draft, draft, "simple") is True
