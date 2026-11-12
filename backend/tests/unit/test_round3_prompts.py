"""划线回答与课文提示词的新规则；篇幅要求的提示词部分（不要自称「更短」）。"""
import pytest

import app.courses as courses_module
import app.prompts_en as prompts_en
from app.course_language import text_for
from tests.unit.test_course_language import fake_model, sse_events
from tests.unit.test_lesson_prompt_rules import make_course


@pytest.fixture
def client(authed_client):
    return authed_client


def test_the_highlight_answer_prompts_ask_for_latex_formulas_and_explained_metaphors():
    zh, en = courses_module.ANNOTATION_ANSWER_PROMPT, prompts_en.ANNOTATION_ANSWER_PROMPT

    assert "行内公式写成 $…$，单独成行的写成 $$…$$" in zh and "不要写成纯文本" in zh and "$Av=\\lambda v$" in zh
    assert "紧跟一句大白话讲清这个比喻在说什么" in zh
    assert "inline formulas as $…$ and display formulas on their own line as $$…$$" in en and "never plain text" in en and "$Av=\\lambda v$" in en
    assert "follow it at once with one plain-language sentence" in en


def test_the_formula_and_metaphor_rules_reach_the_model_for_a_question_and_a_follow_up(client):
    cid, _ = make_course(client, "zh")
    with fake_model(lambda system, user: "左乘就是先作用。") as model:
        res = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 4, "original_text": "特征值", "comment": "为什么？",
        })
    annotation = next(e for e in sse_events(res) if e.get("done"))["annotation"]
    with fake_model(lambda system, user: "好的。") as follow_up:
        client.post(f"/api/courses/{cid}/lessons/1/annotations/{annotation['id']}/messages", json={"content": "再讲讲"})

    for call in (model.calls[0], follow_up.calls[0]):
        assert "$$…$$" in call["system"] and "紧跟一句大白话讲清这个比喻在说什么" in call["system"]

@pytest.mark.parametrize("prompt", [
    courses_module.FIRST_LESSON_PROMPT, courses_module.NEXT_LESSON_PROMPT, courses_module.SOURCE_LESSON_PROMPT,
])
def test_the_chinese_lesson_prompts_ask_for_one_question_per_reflection_question_and_at_most_three(prompt):
    assert "每题只问一个问题，不要把几个问题连在一起问" in prompt  # 输出格式里
    assert "最多 3 题，每题只问一个问题" in prompt or prompt is courses_module.SOURCE_LESSON_PROMPT


def test_the_chinese_prompts_with_a_rules_list_state_the_limit_in_the_rules_too():
    assert "最多 3 题，每题只问一个问题（需要的话可以带一句提示）" in courses_module.FIRST_LESSON_PROMPT
    assert "最多 3 题，每题只问一个问题（需要的话可以带一句提示）" in courses_module.NEXT_LESSON_PROMPT


@pytest.mark.parametrize("prompt", [prompts_en.FIRST_LESSON_PROMPT, prompts_en.NEXT_LESSON_PROMPT, prompts_en.SOURCE_LESSON_PROMPT])
def test_the_english_lesson_prompts_ask_for_one_question_per_item(prompt):
    assert "ask one question per item, never several questions chained together" in prompt


def test_the_english_rules_state_the_limit_too():
    assert "at most 3 questions, each asking exactly one question" in prompts_en.FIRST_LESSON_PROMPT
    assert "at most 3 questions, each asking exactly one question" in prompts_en.NEXT_LESSON_PROMPT

@pytest.mark.parametrize("prompt", [courses_module.FIRST_LESSON_PROMPT, courses_module.NEXT_LESSON_PROMPT, courses_module.SOURCE_LESSON_PROMPT])
def test_the_chinese_lesson_prompts_ask_for_room_on_regulatory_and_fee_numbers(prompt):
    assert "**法规、费率、税率等具体数字要留余地**" in prompt
    assert "不低于 / 不超过 / 通常为 / 一般为" in prompt and "以合同、法规原文或官方公告为准" in prompt
    assert "不要用「高达」「最多」「仅需」这类可能说反方向的词" in prompt


@pytest.mark.parametrize("prompt", [prompts_en.FIRST_LESSON_PROMPT, prompts_en.NEXT_LESSON_PROMPT, prompts_en.SOURCE_LESSON_PROMPT])
def test_the_english_lesson_prompts_ask_for_room_on_regulatory_and_fee_numbers(prompt):
    assert "**Leave room on regulatory, fee and tax numbers**" in prompt
    assert '"not less than / not more than / usually / typically ..., check the contract, the statute or the official notice"' in prompt
    assert 'never use words like "as high as", "up to" or "only"' in prompt

@pytest.mark.parametrize("prompt", [courses_module.FIRST_LESSON_PROMPT, courses_module.NEXT_LESSON_PROMPT, courses_module.SOURCE_LESSON_PROMPT])
def test_the_chinese_lesson_prompts_ask_for_honest_headings_and_kept_promises(prompt):
    assert "**小节标题与内容一致，开头的承诺必须兑现**" in prompt
    assert "结尾必须真的给出，而且就是承诺的那一种；做不到就不要承诺" in prompt


@pytest.mark.parametrize("prompt", [prompts_en.FIRST_LESSON_PROMPT, prompts_en.NEXT_LESSON_PROMPT, prompts_en.SOURCE_LESSON_PROMPT])
def test_the_english_lesson_prompts_ask_for_honest_headings_and_kept_promises(prompt):
    assert "**Section titles match their content, and promises at the start must be kept**" in prompt
    assert "must really appear at the end, in exactly the form promised; if you cannot deliver it, do not promise it" in prompt


def test_the_source_lesson_may_retitle_the_review_when_it_answers_the_students_own_questions():
    assert "把这一节的标题改成「你的问题回应」" in courses_module.SOURCE_LESSON_PROMPT
    assert 'retitle that section "Responses to your questions"' in prompts_en.SOURCE_LESSON_PROMPT

def test_the_feedback_note_asks_for_what_was_done_not_a_length_claim_in_both_languages():
    zh, en = text_for("zh").feedback_note, text_for("en").feedback_note

    assert "不要写「比上一篇短」「更短」这类篇幅自评" in zh and "这篇比上一篇短，推导只留结论" not in zh
    assert 'do not write "shorter than the last"' in en and "this lesson is shorter than the last, the derivation" not in en
    for prompt in (courses_module.NEXT_LESSON_PROMPT, courses_module.SOURCE_LESSON_PROMPT):
        assert "不要写「比上一篇短」「更短」这类篇幅自评" in prompt
    for prompt in (prompts_en.NEXT_LESSON_PROMPT, prompts_en.SOURCE_LESSON_PROMPT):
        assert 'without writing "shorter than the last"' in prompt
