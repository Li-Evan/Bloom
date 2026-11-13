"""学生反馈要求「短一点 / 少推导」时，给整篇阅读内容一个字数目标（上一篇整篇 × 0.8），生成后检查，
超过目标 15% 以上整篇重写一次（发心跳、沿用 RB3 的时限，只保存一次），仍然偏长就删掉回顾里自称「更短」的句子。"""
import threading
import time
from unittest.mock import patch

import pytest

import app.courses as courses_module
from app.course_language import drop_shorter_claims, main_section, wants_shorter
from app.models import Lesson
from tests.conftest import TestSession
from tests.unit.test_course_language import sse_events
from tests.unit.test_lesson_prompt_rules import make_course, make_source_course, responder_for, set_feedback, tick_everything

BRIEF_FEEDBACK = "下一篇能多给一个具体数字的例子，少一点推导，我期末只剩几天了"
CLAIM = "按你的要求：这篇比上一篇短，推导只留结论，并加了一个具体数字的例子。"
REWRITE_MARKER = "## 需要压缩的草稿"
PREVIOUS_CHARS = 2000   # 上一篇「正文内容」的字数 → 目标 1600，超过 1840 才重写


@pytest.fixture
def client(authed_client):
    return authed_client


@pytest.fixture(autouse=True)
def join_background_workers():
    """超时被放弃的调用还在后台线程里睡着：让它们在测试结束前跑完，免得在解释器退出时才往已关闭的日志流里写。"""
    yield
    for worker in threading.enumerate():
        if worker.name.startswith(("answers-check", "lesson-rewrite")):
            worker.join(timeout=5)


@pytest.fixture(autouse=True)
def no_answers_check(monkeypatch):
    """这个文件测篇幅检查；参考答案核对另有 test_answers_check.py，需要它的用例自己打开。"""
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 10**9)


# ---- 识别反馈 ----

@pytest.mark.parametrize("feedback", [
    BRIEF_FEEDBACK,
    "短一点", "再短一些吧", "简洁一点", "精简一点", "请简短一些", "少一点推导", "少推导", "别太长", "太长了", "不要太长",
    "赶时间，快速过一遍", "考试只剩几天了", "时间很紧", "临时抱佛脚",
    "Shorter please", "Please keep it short", "less derivation, more examples", "fewer proofs", "skip the derivations",
    "too long for me", "I'm in a hurry", "I am short on time", "just a few days left", "make it shorter and more concise",
])
def test_an_explicit_request_for_something_shorter_is_recognised(feedback):
    assert wants_shorter(feedback) is True


@pytest.mark.parametrize("feedback", [
    None, "", "   ", "读懂了", "很清楚", "下一篇多给一些具体数字的例子", "希望有一个电子表格式的表格", "别太简略，多讲一点", "不要太短，我想看完整推导",
    "Clear enough. I want more worked numeric examples next time.", "Not too short please, I want the full derivation",
    "no need to be shorter", "Could you give a loan example with a spreadsheet-style table?",
])
def test_praise_questions_and_requests_for_more_are_not_a_request_for_less(feedback):
    assert wants_shorter(feedback) is False


# ---- 正文 ----

def test_the_main_section_is_what_sits_between_the_main_heading_and_the_next_second_level_heading():
    lesson = "# 课\n\n## 上一篇思考题复盘\n\n复盘很长很长\n\n## 正文内容\n\n正文一\n\n### 小节\n\n正文二\n\n## 思考题\n\n1. 问？\n\n<!-- mastery: 甲 -->"

    assert main_section(lesson).strip() == "正文一\n\n### 小节\n\n正文二"
    assert main_section("# Lesson\n\n## Review\n\nlong\n\n## Main content\n\nbody text\n\n## Reflection questions\n\n1. Q?").strip() == "body text"


def test_a_lesson_without_a_main_heading_counts_as_a_whole_without_hidden_comments():
    assert "甲" not in main_section("# 课\n\n正文\n<!-- mastery: 甲 -->") and "正文" in main_section("# 课\n\n正文\n<!-- mastery: 甲 -->")


# ---- 删掉自称更短的句子 ----

def lesson_with_note(note, tail="## 正文内容\n\n正文。\n"):
    return f"# 课\n\n---\n\n## 上一篇思考题复盘\n\n思考题是可选的，参考答案放在本篇末尾。\n\n{note}\n\n{tail}"


def test_the_shorter_clause_goes_and_the_rest_of_the_sentence_stays():
    out = drop_shorter_claims(lesson_with_note(CLAIM))

    assert "按你的要求：推导只留结论，并加了一个具体数字的例子。" in out
    assert "比上一篇短" not in out and out.endswith("## 正文内容\n\n正文。\n")


@pytest.mark.parametrize("note, expected", [
    ("按你的要求：推导只留结论，这篇比上一篇短，并加了一个例子。", "按你的要求：推导只留结论，并加了一个例子。"),
    ("按你的要求：本篇更短，只留结论。", "按你的要求：只留结论。"),
    ("按你的要求：压缩了篇幅，推导只留结论。", "按你的要求：推导只留结论。"),
    ("As you asked: this lesson is shorter than the last, the derivation keeps only the conclusion, and it adds an example.",
     "As you asked: the derivation keeps only the conclusion, and it adds an example."),
    ("As you asked: the derivation keeps only the conclusion, and it is shorter than before.", "As you asked: the derivation keeps only the conclusion."),
])
def test_the_claim_is_removed_in_both_languages_and_the_sentence_still_reads_well(note, expected):
    assert expected in drop_shorter_claims(lesson_with_note(note))


@pytest.mark.parametrize("note", ["按你的要求：这篇比上一篇短。", "按你的要求：篇幅更短", "As you asked: this lesson is shorter."])
def test_a_note_line_that_is_only_the_claim_is_removed_entirely(note):
    out = drop_shorter_claims(lesson_with_note(note))

    assert "按你的要求" not in out and "As you asked" not in out
    assert "思考题是可选的，参考答案放在本篇末尾。\n\n## 正文内容" in out  # 没有留下多余的空行


def test_a_note_without_a_claim_and_a_lesson_without_a_main_heading_are_left_alone():
    plain = lesson_with_note("按你的要求：推导只留结论，并加了一个例子。")
    no_heading = "# 课\n\n按你的要求：这篇比上一篇短。\n\n正文\n"

    assert drop_shorter_claims(plain) == plain and drop_shorter_claims(no_heading) == no_heading


def test_the_main_content_is_never_touched_even_when_it_talks_about_shorter_paths():
    tail = "## 正文内容\n\n按你的要求：这是正文里的一句话，更短的路径更好。\n\n比上一篇短的说法不能在这里删。\n"

    assert drop_shorter_claims(lesson_with_note(CLAIM, tail)).endswith(tail)


# ---- 端到端 ----

def zh_lesson(main_chars, note=CLAIM, answers=True):
    answers_block = "## 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 旧答案一\n\n" if answers else ""
    return (
        "# 第二课\n\n> 前置知识：第一课\n> 难度：入门\n> 预计阅读时间：5 分钟\n\n---\n\n## 上一篇思考题复盘\n\n"
        f"思考题是可选的，参考答案放在本篇末尾。\n\n{note}\n\n## 正文内容\n\n{'测' * main_chars}\n\n## 思考题\n\n"
        f"1. 新问题一？\n\n{answers_block}<!-- mastery: 能够解释核心概念1 -->"
    )


def course_with_previous(client, language="zh", previous_chars=PREVIOUS_CHARS, feedback=BRIEF_FEEDBACK):
    cid, _ = make_course(client, language)
    filler = "测" * previous_chars if language == "zh" else " ".join(["word"] * previous_chars)
    heading = "## 正文内容" if language == "zh" else "## Main content"
    think = "## 思考题" if language == "zh" else "## Reflection questions"
    with TestSession() as db:
        lesson = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == 1).one()
        lesson.content = f"# 第一课\n\n{heading}\n\n{filler}\n\n{think}\n\n1. 为什么？\n2. 如何？\n"
        db.commit()
    if feedback is not None:
        set_feedback(cid, "", content=feedback)
    return cid


def rewrite_responder(first, second, delay=0.0, fail=False, seen=None):
    """第一次（流式）给 first；带「需要压缩的草稿」的那次重写调用给 second（或失败）。"""
    lock = threading.Lock()

    def respond(system, user):
        if REWRITE_MARKER in user or "Draft to shorten" in user:
            with lock:
                if seen is not None:
                    seen.append(user)
            time.sleep(delay)
            if fail:
                raise RuntimeError("模型挂了")
            return second
        return first

    return respond


def run_next(client, cid, respond, language="zh"):
    clients = []
    model = None
    from tests.unit.test_course_language import FakeModel

    model = FakeModel(respond)

    def get_client(**kwargs):
        clients.append(kwargs)
        return model

    with patch("app.courses.get_openai_client", side_effect=get_client):
        res = client.post(f"/api/courses/{cid}/next")
    assert res.status_code == 200, res.text
    assert not any("error" in event for event in sse_events(res)), res.text
    return model, clients, res


def stored(client, cid, number=2):
    return client.get(f"/api/courses/{cid}/lessons/{number}").json()["content"]


def body_chars(content):
    return courses_module._reading_stats(main_section(content))[0]


def test_the_prompt_carries_a_hard_target_when_the_student_asks_for_less(client):
    cid = course_with_previous(client)

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(1500), ""))

    section = model.calls[0]["system"].split("## 上一篇的篇幅\n")[1].split("## 当前课文编号")[0]
    assert "约 " in section and "这是硬指标" in section
    assert "不超过 1605 字" in section and "上一篇整篇阅读内容约 2007 字" in section and "本篇要比它短" in section and "80%" not in section


def test_a_student_who_did_not_ask_for_less_gets_the_usual_length_section(client):
    cid = course_with_previous(client, feedback="读懂了，谢谢")

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(1500), ""))

    section = model.calls[0]["system"].split("## 上一篇的篇幅\n")[1].split("## 当前课文编号")[0]
    assert "硬指标" not in section and section.strip().startswith("约 ")


def test_a_draft_over_the_limit_is_rewritten_once_with_the_draft_and_the_shorter_one_is_stored(client):
    cid = course_with_previous(client)
    seen = []

    model, clients, res = run_next(
        client, cid, rewrite_responder(zh_lesson(2600), zh_lesson(1500, note="按你的要求：推导只留结论，并加了一个具体数字的例子。"), seen=seen),
    )

    assert len(seen) == 1
    rewrite_user = seen[0]
    assert REWRITE_MARKER in rewrite_user and "约 2662 字" in rewrite_user and "1605 字" in rewrite_user
    assert "测" * 2600 in rewrite_user  # 带着草稿
    assert [call["stream"] for call in model.calls] == [True, False]
    assert clients[-1] == {"timeout_cap": courses_module.LESSON_REWRITE_DEADLINE_SECONDS, "max_retries": 0}  # 不叠加 SDK 重试，有时限
    assert body_chars(stored(client, cid)) == 1500 and "比上一篇短" not in stored(client, cid)
    assert sse_events(res)[-1].get("done") is True


def test_a_draft_within_fifteen_percent_of_the_target_is_kept_without_a_rewrite(client):
    cid = course_with_previous(client)

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(1780), "不应该被调用"))

    assert [call["stream"] for call in model.calls] == [True]
    assert body_chars(stored(client, cid)) == 1780 and "这篇比上一篇短" in stored(client, cid)  # 在 1840 以内：声明保留


def test_a_rewrite_that_is_shorter_but_still_over_the_limit_is_used_and_the_claim_is_dropped(client):
    cid = course_with_previous(client)

    run_next(client, cid, rewrite_responder(zh_lesson(2600), zh_lesson(2300)))

    content = stored(client, cid)
    assert body_chars(content) == 2300 and "比上一篇短" not in content
    assert "按你的要求：推导只留结论，并加了一个具体数字的例子。" in content


def test_a_rewrite_that_is_not_shorter_is_discarded_and_the_claim_is_dropped(client):
    cid = course_with_previous(client)

    run_next(client, cid, rewrite_responder(zh_lesson(2600), zh_lesson(3000)))

    content = stored(client, cid)
    assert body_chars(content) == 2600 and "比上一篇短" not in content


def test_a_rewrite_that_fails_keeps_the_draft_drops_the_claim_and_still_saves(client):
    cid = course_with_previous(client)

    _, _, res = run_next(client, cid, rewrite_responder(zh_lesson(2600), "", fail=True))

    assert body_chars(stored(client, cid)) == 2600 and "比上一篇短" not in stored(client, cid)
    assert sse_events(res)[-1].get("done") is True


def test_a_slow_rewrite_sends_heartbeats_and_a_hopeless_one_is_given_up_at_the_deadline(client, monkeypatch):
    monkeypatch.setattr(courses_module, "SSE_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 0.4)
    cid = course_with_previous(client)

    _, _, slow = run_next(client, cid, rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.25))
    assert slow.text.count(": keepalive\n\n") >= 2 and body_chars(stored(client, cid)) == 1500

    cid = course_with_previous(client)
    started = time.monotonic()
    _, _, late = run_next(client, cid, rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=1.0))
    assert time.monotonic() - started < 0.9  # 到时限就放弃，不等慢调用回来
    assert body_chars(stored(client, cid)) == 2600 and "比上一篇短" not in stored(client, cid)


def test_without_a_request_for_less_a_long_draft_is_left_alone(client):
    cid = course_with_previous(client, feedback="读懂了，谢谢")

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(3500, note=""), "不应该被调用"))

    assert [call["stream"] for call in model.calls] == [True] and body_chars(stored(client, cid)) == 3500


def test_nothing_is_deleted_when_the_student_did_not_ask_for_less_even_if_the_claim_is_not_true(client):
    """只在本篇确有字数目标（学生要求过短一点）且最终仍超长时才删：没有目标就不动任何句子。"""
    cid = course_with_previous(client, feedback="希望多一些例子，节奏可以快一点")
    claim = "按你的要求：这篇比上一篇短，并加了例子。"

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(2600, note=claim), ""))

    assert claim in stored(client, cid) and [call["stream"] for call in model.calls] == [True]


def test_a_claim_that_is_true_is_kept_when_nobody_asked_for_less(client):
    cid = course_with_previous(client, feedback="希望多一些例子，节奏可以快一点")

    run_next(client, cid, rewrite_responder(zh_lesson(1500, note="按你的要求：这篇比上一篇短，并加了例子。"), ""))

    assert "这篇比上一篇短" in stored(client, cid)


def test_a_draft_that_is_both_long_and_self_correcting_is_rewritten_once_with_both_instructions(client):
    cid = course_with_previous(client)
    dirty_answers = "## 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 价格加权更大。等等——不对，再确认一下，是市值加权。\n\n"
    dirty = zh_lesson(2600).replace("## 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 旧答案一\n\n", dirty_answers)
    seen = []

    model, _, _ = run_next(client, cid, rewrite_responder(dirty, zh_lesson(1500), seen=seen))

    assert len(seen) == 1 and "不要出现「等等」" in seen[0]
    assert [call["stream"] for call in model.calls] == [True, False]  # 一次重写，不是两次
    assert body_chars(stored(client, cid)) == 1500 and "等等" not in stored(client, cid)


def test_a_rewrite_that_is_short_but_still_self_correcting_is_not_used(client):
    cid = course_with_previous(client)
    dirty_answers = "## 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 价格加权更大。等等——不对，再确认一下，是市值加权。\n\n"
    dirty = zh_lesson(2600).replace("## 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 旧答案一\n\n", dirty_answers)

    run_next(client, cid, rewrite_responder(dirty, dirty.replace(dirty.split("## 正文内容")[1].split("## 思考题")[0], "\n\n" + "测" * 1500 + "\n\n")))

    assert body_chars(stored(client, cid)) == 2600


def test_the_assessment_lesson_has_no_length_target(client):
    cid = course_with_previous(client)
    tick_everything(cid)
    evaluation = "<!-- eval-article -->\n\n# 评估\n\n## 正文内容\n\n" + "测" * 5000 + "\n"

    model, _, _ = run_next(client, cid, rewrite_responder(evaluation, "不应该被调用"))

    assert [call["stream"] for call in model.calls] == [True]


@pytest.mark.parametrize("previous, target", [(2000, 1605), (1000, 805), (700, 600), (500, 507), (310, 317)])
def test_the_target_never_shrinks_below_a_floor_but_is_never_longer_than_the_previous_lesson(client, previous, target):
    cid = course_with_previous(client, previous_chars=previous)

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(1500), ""))

    assert f"不超过 {target} 字" in model.calls[0]["system"] and f"上一篇整篇阅读内容约 {previous + 7} 字" in model.calls[0]["system"]


def test_a_student_with_a_very_short_previous_lesson_gets_no_target(client):
    cid = course_with_previous(client, previous_chars=100)

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(3000), "不应该被调用"))

    assert [call["stream"] for call in model.calls] == [True] and "硬指标" not in model.calls[0]["system"]


def test_english_courses_count_words_and_get_the_english_instructions(client):
    cid = course_with_previous(client, "en", previous_chars=1000, feedback="Shorter please, and less derivation. I have an exam in two days.")
    long_draft = (
        "# Lesson 2\n\n> Prerequisites: Lesson 1\n\n---\n\n## Review of the previous reflection questions\n\n"
        "The reflection questions are optional; the reference answers are at the end of this lesson.\n\n"
        "As you asked: this lesson is shorter than the last, the derivation keeps only the conclusion.\n\n"
        "## Main content\n\n" + " ".join(["word"] * 1500) + "\n\n## Reflection questions\n\n1. A question?\n\n"
        "<!-- mastery: Explain core concept 1 -->"
    )
    short = long_draft.replace(" ".join(["word"] * 1500), " ".join(["word"] * 700))
    seen = []

    def respond(system, user):
        if "Draft to shorten" in user:
            seen.append(user)
            return short
        if "Socratic tutor" in system and "Write lesson" in user:
            return long_draft
        return responder_for("en")(system, user)

    model, _, _ = run_next(client, cid, respond, "en")

    section = model.calls[0]["system"].split("## Length of the previous lesson\n")[1].split("## Current lesson number")[0]
    assert "within 805 words" in section and "about 1007 words" in section and "this one must be shorter" in section and "80%" not in section
    assert len(seen) == 1 and "about 1534 words" in seen[0] and "within 805 words" in seen[0] and "Output the rewritten lesson directly" in seen[0]
    content = stored(client, cid)
    assert body_chars(content) == 700 and "shorter than the last" in content  # 重写在目标以内，「更短」的说法成立，保留


def test_a_source_course_second_lesson_uses_the_absolute_cap(client):
    # 原文阅读篇之后的那一篇（旧数据形状的原文课仍走这条 source_first 路径）没有可比的上一篇，用绝对字数上限
    cid = make_source_course(client, "zh", legacy=True)
    set_feedback(cid, "", content="太长了，短一点")
    over = zh_lesson(2300)
    seen = []

    model, _, _ = run_next(client, cid, rewrite_responder(over, zh_lesson(1200), seen=seen))

    assert len(seen) == 1 and "1500 字" in seen[0]
    assert body_chars(stored(client, cid)) == 1200


# ---- 和参考答案核对叠加：总等待有上限 ----

def test_after_a_long_rewrite_the_answers_check_gets_only_what_is_left_of_the_budget(client, monkeypatch):
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 0.5)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_ATTEMPT_SECONDS", 0.01)
    monkeypatch.setattr(courses_module, "POST_GENERATION_BUDGET_SECONDS", 1.0)
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 0.9)
    cid = course_with_previous(client)
    checks = []

    def respond(system, user):
        if "参考答案的核对员" in system:
            checks.append(user)
            return "**第1题：** 旧题一\n> 核对后。\n\n"
        return rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.6)(system, user)

    started = time.monotonic()
    run_next(client, cid, respond)

    assert checks == []  # 重写用掉 0.6 秒，剩下不到 0.5 秒，不核对了
    assert time.monotonic() - started < 2.0 and body_chars(stored(client, cid)) == 1500


def test_with_a_quick_rewrite_the_answers_check_still_runs_and_both_changes_land(client, monkeypatch):
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 0.01)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_ATTEMPT_SECONDS", 0.01)
    cid = course_with_previous(client)

    def respond(system, user):
        if "参考答案的核对员" in system:
            return "**第1题：** 旧题一\n> 核对后的答案。\n\n"
        return rewrite_responder(zh_lesson(2600), zh_lesson(1500))(system, user)

    model, _, _ = run_next(client, cid, respond)

    assert [call["stream"] for call in model.calls] == [True, False, False]  # 流式 + 一次重写 + 一次核对（只有一题）
    content = stored(client, cid)
    assert body_chars(content) == 1500 and "核对后的答案。" in content and "旧答案一" not in content


def test_the_worst_case_extra_wait_is_the_budget_not_the_sum_of_the_two_deadlines(client, monkeypatch):
    monkeypatch.setattr(courses_module, "SSE_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_ATTEMPT_SECONDS", 0.01)
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 0.5)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_DEADLINE_SECONDS", 0.5)
    monkeypatch.setattr(courses_module, "POST_GENERATION_BUDGET_SECONDS", 0.7)
    cid = course_with_previous(client)

    def respond(system, user):
        if "参考答案的核对员" in system or REWRITE_MARKER in user:
            time.sleep(1.5)  # 两步都慢到超时
        return zh_lesson(2600)

    started = time.monotonic()
    _, _, res = run_next(client, cid, respond)
    elapsed = time.monotonic() - started

    assert elapsed < 1.1  # 0.5（重写）+ 0.2（核对拿到的剩余）+ 余量，而不是 0.5 + 0.5
    assert sse_events(res)[-1].get("done") is True and "测" * 2600 in stored(client, cid)


# ---- 删「更短」只动「按你的要求」那一行里的分句 ----

@pytest.mark.parametrize("review_line", [
    "**第1题：** 你的回答比上次简洁多了，✅ 对。",
    "你的推导比上一篇少了一个条件。",
    "Your answer is more concise than most.",
    "这题你写得更短的版本也对。",
    "Question 1: your answer is shorter than the reference but correct.",
    "这篇比上一篇短的说法是你的错觉。",
])
def test_ordinary_review_sentences_are_never_removed_only_the_claim_in_the_note_line_goes(review_line):
    lesson = (
        f"# 课\n\n---\n\n## 上一篇思考题复盘\n\n{review_line}\n\n{CLAIM}\n\n## 正文内容\n\n正文。\n"
    )

    out = drop_shorter_claims(lesson)

    assert review_line in out
    assert "按你的要求：推导只留结论，并加了一个具体数字的例子。" in out and "这篇比上一篇短，" not in out


def test_without_a_note_line_nothing_in_the_review_is_touched():
    lesson = "# 课\n\n## 上一篇思考题复盘\n\n你的回答比上次简洁多了。\n\nYour answer is more concise than most.\n\n## 正文内容\n\n正文。\n"

    assert drop_shorter_claims(lesson) == lesson


def test_a_final_pass_after_a_failed_rewrite_keeps_the_reviews_praise_and_drops_only_the_claim(client):
    cid = course_with_previous(client)
    note = f"**第1题：** 你的回答比上次简洁多了\n\n你的推导比上一篇少了一个条件。\n\n{CLAIM}"

    run_next(client, cid, rewrite_responder(zh_lesson(2600, note=note), "", fail=True))

    content = stored(client, cid)
    assert "你的回答比上次简洁多了" in content and "你的推导比上一篇少了一个条件。" in content
    assert "比上一篇短，" not in content and "按你的要求：推导只留结论，并加了一个具体数字的例子。" in content


@pytest.mark.parametrize("feedback", [
    "讲得简洁清楚，很喜欢", "写得很简洁，不错", "I liked how concise it was", "Love how concise these are", "not too long, keep that",
    "It was not too long, which I appreciated", "I don't need it to be shorter", "I do not want it shorter", "Great and concise!",
])
def test_praise_and_denials_are_not_a_request_for_something_shorter(feedback):
    assert wants_shorter(feedback) is False


@pytest.mark.parametrize("feedback", [
    "讲得很好，下一篇简洁一点", "很清楚。但是太长了，请短一点", "喜欢这个例子，下次少一点推导", "I liked it. Next time please make it shorter",
    "Good lesson, but more concise next time", "太长了",
])
def test_praise_together_with_a_request_is_still_a_request(feedback):
    assert wants_shorter(feedback) is True


def test_the_prompt_target_wording_matches_the_floor_raised_target(client):
    """目标被下限抬到 600（上一篇 700 的 86%）时，提示词不能还写「目标是它的 80%」。"""
    cid = course_with_previous(client, previous_chars=700)

    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(500), ""))

    section = model.calls[0]["system"].split("## 上一篇的篇幅\n")[1].split("## 当前课文编号")[0]
    assert "不超过 600 字" in section and "上一篇整篇阅读内容约 707 字" in section and "80%" not in section


def test_the_limit_never_lets_a_lesson_through_that_is_longer_than_the_previous_one_even_when_the_floor_raised_the_target(client):
    """上一篇 640，目标被下限抬到 600，目标 × 1.15 = 690 比上一篇还长：上限封顶在上一篇的 640。"""
    from app.courses import LengthGoal

    assert LengthGoal(target=600, previous=640).limit == 640
    assert LengthGoal(target=1600, previous=2000).limit == 1840  # 一般情形不变
    assert LengthGoal(target=1500, previous=None).limit == 1725  # 原文课第 2 篇没有上一篇
    cid = course_with_previous(client, previous_chars=640)
    seen = []

    run_next(client, cid, rewrite_responder(zh_lesson(660), zh_lesson(600), seen=seen))  # 比上一篇长 → 重写
    assert len(seen) == 1 and body_chars(stored(client, cid)) == 600

    cid = course_with_previous(client, previous_chars=640)
    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(580), "不应该被调用"))  # 比上一篇短 → 不重写
    assert [call["stream"] for call in model.calls] == [True]


# ---- 夸奖豁免只对「简洁 / concise」这类夸奖词生效，「夸一句 + 但太长」仍是要求 ----

@pytest.mark.parametrize("feedback", [
    "内容不错，但太长了", "例子很好，就是太长了", "讲得很好，但是我赶时间", "挺好的，就是我只剩三天了", "很喜欢，但推导太多，篇幅压缩一下",
    "The examples were great but it was too long", "Nice lesson, too long though", "great content, way too long",
    "讲得很好，不过推导能不能少一点", "写得清楚，可是太长", "Loved it, however it is way too long for me",
    "喜欢这门课。就是时间紧，下一篇压缩一点", "Perfect examples, but I'm in a hurry",
])
def test_praise_followed_by_a_but_and_a_real_request_is_still_a_request(feedback):
    assert wants_shorter(feedback) is True


@pytest.mark.parametrize("feedback", [
    "讲得简洁清楚，很喜欢", "I liked how concise it was", "not too long, keep that", "I don't need it to be shorter",
    "写得很简洁，不错", "Great and concise!", "Love how concise these are", "讲得很简洁，但是希望例子多一点",
    "The lessons are concise and clear, thanks", "挺简洁的，我喜欢",
])
def test_praise_words_alone_are_still_not_a_request(feedback):
    assert wants_shorter(feedback) is False


@pytest.mark.parametrize("feedback", [
    "内容不错，但简洁一点更好", "Good lesson, but more concise next time", "简洁一点", "讲得很好，下一篇简洁一点", "更精炼一些就好了",
])
def test_the_weak_words_count_when_the_clause_asks_for_them(feedback):
    assert wants_shorter(feedback) is True


# ---- 控制者补修：反馈的分句规则曾与 drop_shorter_claims 的同名正则重名而被覆盖，没有逗号时不按转折词切 ----

@pytest.mark.parametrize("feedback", [
    "讲得很简洁但是希望例子多一点", "Great and concise but I wish there were more examples",
    "I loved how concise it was but please add more examples", "It was concise however I wish the examples were longer",
])
def test_praising_concision_then_asking_for_something_else_without_a_comma_is_not_a_request(feedback):
    assert wants_shorter(feedback) is False


@pytest.mark.parametrize("feedback", ["没有太长，挺好", "没觉得太长，保持", "不算太长，保持", "一点也不长，刚好", "并不长"])
def test_saying_the_lesson_was_not_too_long_is_not_a_request(feedback):
    assert wants_shorter(feedback) is False


@pytest.mark.parametrize("feedback", ["希望下一篇不会太长，短一点", "太长了，不过例子很好", "too long but I loved the examples"])
def test_wishing_the_next_one_is_not_too_long_is_still_a_request(feedback):
    assert wants_shorter(feedback) is True


def test_the_feedback_clause_splitter_is_not_shadowed():
    import app.course_language as module
    assert "但是" in module._FEEDBACK_CLAUSE_SPLIT_RE.pattern
    assert "但是" not in module._CLAUSE_SPLIT_RE.pattern


def test_length_guard_counts_review_and_reference_answers_in_the_total(client):
    cid = course_with_previous(client)
    long_review = "回顾" * 1200
    draft = zh_lesson(700).replace("思考题是可选的，参考答案放在本篇末尾。", long_review)
    seen = []
    run_next(client, cid, rewrite_responder(draft, zh_lesson(800), seen=seen))
    assert len(seen) == 1
    assert long_review not in stored(client, cid)


def test_a_shorter_body_with_a_longer_review_is_not_an_improvement(client):
    cid = course_with_previous(client)
    original = zh_lesson(2600)
    worse = zh_lesson(500).replace("旧答案一", "答案" * 2000)
    run_next(client, cid, rewrite_responder(original, worse))
    assert body_chars(stored(client, cid)) == 2600


@pytest.mark.parametrize("replacement", [
    "# 很短但丢了所有内容",
    zh_lesson(500).replace("<!-- mastery: 能够解释核心概念1 -->", ""),
    zh_lesson(500).replace("## 思考题", "## 其它"),
])
def test_rewrite_cannot_meet_the_length_target_by_deleting_required_content(client, replacement):
    cid = course_with_previous(client)
    run_next(client, cid, rewrite_responder(zh_lesson(2600), replacement))
    assert body_chars(stored(client, cid)) == 2600
    assert "<!-- mastery: 能够解释核心概念1 -->" in stored(client, cid)


def test_reading_length_excludes_metadata_but_counts_all_three_reading_sections():
    content = '# 课\n> 前置知识：' + '甲' * 2000 + '\n> 难度：入门\n## 回顾\n甲\n## 正文内容\n乙乙\n## 参考答案\n丙丙丙\n<!-- mastery: ' + '丁' * 2000 + ' -->'
    assert courses_module._body_length(content) == 6


ZHANG_FEEDBACK = '这篇还是偏长，术语我一下记不住。下一篇只讲一个风险，用存钱罐的日常例子，不要新术语。整篇连回顾和参考答案请控制在500字以内；思考题暂时不作答。'


@pytest.mark.parametrize('feedback, limit', [
    (ZHANG_FEEDBACK, 500), ('整篇不超过 450 字', 450), ('请控制在500字以内', 500),
    ('Keep the whole lesson within 300 words.', 300), ('No more than 250 words please', 250),
    ('At most 400 words', 400), ('整篇≤500字', 500),
])
def test_explicit_reading_limits_override_the_floor_and_have_no_tolerance(feedback, limit):
    previous = Lesson(content=zh_lesson(1600))
    goal = courses_module._length_goal(feedback, 'zh', previous, source_first=False)
    assert goal is not None
    assert goal.target == goal.limit == limit


def test_a_number_in_an_example_is_not_a_length_request():
    previous = Lesson(content=zh_lesson(1600))
    assert courses_module._length_goal('请举500元的例子', 'zh', previous, source_first=False) is None


def test_zhangs_feedback_triggers_compression_of_the_complete_lesson(client):
    cid = course_with_previous(client, feedback=ZHANG_FEEDBACK)
    seen = []
    model, _, _ = run_next(client, cid, rewrite_responder(zh_lesson(1600), zh_lesson(400), seen=seen))
    assert len(seen) == 1
    assert '500' in model.calls[0]['system']
    assert courses_module._body_length(stored(client, cid)) <= 500


@pytest.mark.parametrize('feedback, limit', [('总共600–800字就好', 800), ('请写600-800字', 800), ('Keep it to 250–300 words.', 300)])
def test_explicit_ranges_use_the_upper_bound(feedback, limit):
    goal = courses_module._length_goal(feedback, 'zh', Lesson(content=zh_lesson(1600)), source_first=False)
    assert goal is not None and goal.target == goal.limit == limit


def test_answer_check_cannot_expand_a_capped_lesson_after_its_final_compression(client, monkeypatch):
    monkeypatch.setattr(courses_module, 'ANSWERS_CHECK_MIN_SECONDS', 0)
    def expanded(*args, **kwargs):
        yield from ()
        return args[0].replace('旧答案一', '答案' * 500)
    monkeypatch.setattr(courses_module, '_check_reference_answers', expanded)
    cid = course_with_previous(client, feedback='整篇控制在500字以内')
    seen = []
    run_next(client, cid, rewrite_responder(zh_lesson(400), zh_lesson(300), seen=seen))
    assert len(seen) == 1
    assert courses_module._body_length(stored(client, cid)) <= 500


def test_a_draft_that_still_breaks_an_explicit_cap_is_saved_and_flagged(client):
    # 重写后仍超出学生明确的上限：照样保存，done 里带 length_exceeded（上限字数）让前端提示，不丢弃
    from tests.unit.test_course_language import fake_model
    cid = course_with_previous(client, feedback='整篇控制在500字以内')
    with fake_model(rewrite_responder(zh_lesson(2000), zh_lesson(1800))):
        response = client.post(f'/api/courses/{cid}/next')
    done = sse_events(response)[-1]
    assert done.get('done') is True and done.get('length_exceeded') == 500
    assert client.get(f'/api/courses/{cid}/lessons/2').status_code == 200


def test_explicit_caps_also_apply_to_assessment_and_unanswered_answers_are_not_graded(client):
    cid = course_with_previous(client, feedback='整篇不超过500字')
    tick_everything(cid)
    evaluation = '<!-- eval-article -->\n# 最终评估\n## 思考题\n1. 如何应用已学内容？\n## 正确答案\n' + '测' * 700
    shortened = evaluation.replace('测' * 700, '测' * 300)
    seen = []
    model, _, _ = run_next(client, cid, rewrite_responder(evaluation, shortened, seen=seen))
    assert len(seen) == 1
    assert '2–3 道综合应用题' in model.calls[0]['system']
    assert '不要输出「你的回答评估」' in model.calls[0]['system']
    assert courses_module._body_length(stored(client, cid)) <= 500
    assert '## 思考题' in stored(client, cid)


def test_per_answer_limits_are_not_mistaken_for_the_whole_lesson_limit():
    previous = Lesson(content=zh_lesson(1600))
    goal = courses_module._length_goal('正文不超过800字，参考答案每题不超过100字', 'zh', previous, source_first=False)
    assert goal.target == 800
    assert courses_module._length_goal('每题不超过100字', 'zh', previous, source_first=False) is None
    assert courses_module._length_goal('不用控制在500字以内', 'zh', previous, source_first=False) is None
