"""下一篇 / 评估篇生成后，参考答案小节逐题单独核对一次（可以打开推理，失败回退普通模式），结构合法才替换，失败 / 超时保留原文。

等待期间发 SSE 心跳；和篇幅重写（C1）、自我更正重写（RB3）共用一个总等待上限。
"""
import re
import threading
import time

import pytest

import app.courses as courses_module
from app.config import settings
from app.course_language import accept_checked_block, answer_blocks, split_answers_section
from tests.unit.test_course_language import fake_model, sse_events
from tests.unit.test_lesson_prompt_rules import ZH_NEXT, EN_NEXT_UNANSWERED, make_course, tick_everything

REASONING = {"thinking": {"type": "enabled"}}
PLAIN = {"thinking": {"type": "disabled"}}
CHECKER_ZH = "参考答案的核对员"
CHECKER_EN = "checker of reference answers"

BLOCK_1 = "**第1题：** 旧题一\n> 旧答案一\n\n"
BLOCK_2 = "**第2题：** 旧题二\n> 旧答案二\n\n"
FIXED_2 = "**第2题：** 旧题二\n> 核对后的答案二：乙更大。\n\n"


@pytest.fixture
def client(authed_client):
    return authed_client


@pytest.fixture
def user_row(user):
    return user


@pytest.fixture(autouse=True)
def join_background_workers():
    """超时被放弃的调用还在后台线程里睡着：让它们在测试结束前跑完，免得在解释器退出时才往已关闭的日志流里写。"""
    yield
    for worker in threading.enumerate():
        if worker.name.startswith(("answers-check", "lesson-rewrite")):
            worker.join(timeout=5)


# ---- 找出小节、拆成题块 ----

def test_the_answers_section_runs_up_to_the_hidden_comment():
    before, section, after = split_answers_section(ZH_NEXT)

    assert section.startswith("## 上一篇思考题参考答案\n\n**第1题：**") and section.endswith("> 旧答案二")
    assert after.startswith("\n\n<!-- mastery:") and before.endswith("1. 新问题一？\n2. 新问题二？\n\n")
    assert before + section + after == ZH_NEXT


def test_an_english_unanswered_lesson_is_found_too():
    _, section, after = split_answers_section(EN_NEXT_UNANSWERED)

    assert section.startswith("## Reference answers to the previous reflection questions") and "**Question 2:** Old two" in section
    assert after.startswith("\n\n<!-- mastery:")


EVAL_REVIEW = (
    "<!-- eval-article -->\n\n# 评估\n\n---\n\n## 上一篇思考题复盘\n\n### 你的回答评估\n\n**第1题** 未作答。\n\n"
    "### 正确答案\n\n**第1题：** 题一\n> 答案一\n\n**第2题：** 题二\n> 答案二\n\n---\n\n## 批注解答\n\n没有。\n"
)


def test_a_correct_answers_subsection_inside_the_assessment_review_stops_at_the_rule():
    before, section, after = split_answers_section(EVAL_REVIEW)

    assert section.startswith("### 正确答案") and section.endswith("> 答案二")
    assert after.startswith("\n\n---\n\n## 批注解答") and "### 你的回答评估" in before


def test_a_rule_or_heading_inside_a_code_fence_does_not_end_the_section():
    lesson = "# 课\n\n## 参考答案\n\n**第1题：** 题\n> 答\n\n```\n---\n## 不是标题\n```\n\n**第2题：** 题二\n> 答二\n\n## 后面\n\n文字\n"

    _, section, after = split_answers_section(lesson)

    assert "**第2题：** 题二" in section and "## 不是标题" in section and after.startswith("\n\n## 后面")


@pytest.mark.parametrize("lesson", [
    "# 课\n\n## 正文内容\n\n没有答案小节\n",
    "# 课\n\n## 上一篇思考题参考答案\n\n只有一段话，没有按题号分块。\n",
])
def test_no_section_or_no_question_blocks_means_nothing_to_check(lesson):
    assert split_answers_section(lesson) is None


def test_a_label_that_wraps_the_whole_question_in_bold_is_a_block_too():
    """真实模型常这样写：**第1题：题目？** 换行 > 答案。"""
    lesson = (
        "# 课\n\n## 上一篇思考题参考答案\n\n**第1题：两个特征值之积为 0，行列式是多少？**\n> 行列式为 0。\n\n"
        "**Question 2 — what about B?**\n> B is larger.\n\n<!-- mastery: 甲 -->"
    )

    _, section, after = split_answers_section(lesson)
    head, blocks = answer_blocks(section)

    assert [number for number, _ in blocks] == [1, 2] and after.startswith("\n\n<!-- mastery")
    assert blocks[0][1] == "**第1题：两个特征值之积为 0，行列式是多少？**\n> 行列式为 0。\n\n"
    assert accept_checked_block(blocks[0][1], "**第1题：两个特征值之积为 0，行列式是多少？**\n> 行列式为 0，所以不可逆。") == (
        "**第1题：两个特征值之积为 0，行列式是多少？**\n> 行列式为 0，所以不可逆。\n\n"
    )


def test_the_blocks_put_back_together_are_the_original_section():
    _, section, _ = split_answers_section(ZH_NEXT)

    head, blocks = answer_blocks(section)

    assert [number for number, _ in blocks] == [1, 2]
    assert head == "## 上一篇思考题参考答案\n\n" and head + "".join(block for _, block in blocks) == section
    assert blocks[0][1].startswith("**第1题：** 旧题一") and blocks[1][1].endswith("旧答案二")


# ---- 核对结果合法才收 ----

ORIGINAL = "**第2题：** 旧题二\n> 旧答案二：甲更大。\n\n"


def test_a_well_formed_corrected_block_is_accepted_and_keeps_the_trailing_blank_line():
    assert accept_checked_block(ORIGINAL, "**第2题：** 旧题二\n> 核对后：乙更大。") == "**第2题：** 旧题二\n> 核对后：乙更大。\n\n"


def test_fences_and_reasoning_tags_around_the_block_are_removed():
    reply = "<think>想一想</think>\n```markdown\n**第2题：** 旧题二\n> 乙更大。\n```"

    assert accept_checked_block(ORIGINAL, reply) == "**第2题：** 旧题二\n> 乙更大。\n\n"


@pytest.mark.parametrize("reply", [
    "",
    "   \n",
    "> 只有答案，没有题号行",
    "**第3题：** 旧题二\n> 题号变了",
    "**第2题：** 旧题二\n> 答案\n\n**第3题：** 多出来一题\n> 另一个答案",
    "**第2题：** 旧题二\n题目下面没有引用块，答案直接写在这里",
    "# 整篇课文\n\n## 正文内容\n\n**第2题：** 旧题二\n> 答案",
    "**第2题：** 旧题二\n> 乙更大。等等——不对，再确认一下，是甲。",
    "**第2题：** old two\n> The B side is larger.",
    "**第2题：** x\n> y",
    "**第2题：** 旧题二\n> " + "很长的答案。" * 400,
])
def test_a_reply_that_is_not_one_clean_block_for_this_question_is_rejected(reply):
    assert accept_checked_block(ORIGINAL, reply) is None


# ---- 端到端：下一篇生成后核对 ----

def lesson_text(block_1=BLOCK_1, block_2=BLOCK_2):
    return ZH_NEXT.replace(BLOCK_1, block_1).replace(BLOCK_2, block_2)


def question_number(user):
    return int(re.search(r"\*\*第(\d+)题", user.split("## 待核对的这一题的参考答案")[1]).group(1))


def own_block(user):
    return user.split("## 待核对的这一题的参考答案\n")[1] + "\n\n"


def responder(lesson, fixes=None, fail=(), delays=None, seen=None):
    """第一次（流式）给 lesson；核对调用按题号给 fixes 里的修正（没有就原样返回这一题）。fail 里的题号返回空内容；delays 是 {题号: 秒}。"""
    fixes, delays = fixes or {}, delays or {}
    counts = {}
    lock = threading.Lock()

    def respond(system, user):
        if CHECKER_ZH not in system:
            return lesson
        number = question_number(user)
        with lock:
            counts[number] = counts.get(number, 0) + 1
        if seen is not None:
            seen.append((number, counts[number]))
        time.sleep(delays.get(number, 0))
        if number in fail:
            return ""
        return fixes.get(number, own_block(user))

    return respond


def run_next(client, cid, respond):
    with fake_model(respond) as model:
        res = client.post(f"/api/courses/{cid}/next")
    assert res.status_code == 200, res.text
    events = sse_events(res)
    assert not any("error" in event for event in events), res.text
    return model, res


def stored(client, cid, number=2):
    return client.get(f"/api/courses/{cid}/lessons/{number}").json()["content"]


def check_calls(model):
    return [call for call in model.calls if CHECKER_ZH in call["system"]]


def test_the_corrected_question_replaces_the_draft_and_the_others_stay(client, user_row):
    cid, _ = make_course(client, "zh")

    model, res = run_next(client, cid, responder(lesson_text(), {2: FIXED_2}))

    content = stored(client, cid)
    assert "核对后的答案二：乙更大。" in content and "旧答案二" not in content
    assert BLOCK_1 in content  # 第 1 题原样
    assert content.index("## 上一篇思考题参考答案") < content.index("<!-- mastery:")  # 小节在注释之前，注释仍是最后
    assert content.rstrip().endswith("-->")
    assert [c["stream"] for c in model.calls] == [True, False, False]  # 一次流式生成 + 每题一次核对
    assert sse_events(res)[-1].get("done") is True


def test_each_question_is_checked_on_its_own_with_the_questions_the_lesson_and_only_that_answer(client):
    cid, _ = make_course(client, "zh")

    model, _ = run_next(client, cid, responder(lesson_text()))

    calls = check_calls(model)
    assert sorted(question_number(call["user"]) for call in calls) == [1, 2]
    for call in calls:
        user = call["user"]
        assert user.startswith("## 上一篇的思考题（全部）\n") and "## 这些题所在的课文\n" in user
        number = question_number(user)
        other = "旧答案二" if number == 1 else "旧答案一"
        assert other not in user.split("## 待核对的这一题的参考答案")[1]  # 只带这一题的答案
        # 输出上限的参数名按模型名定（_token_limit_key）：测试模型 test-model 不是 GPT / o 系列，用 max_tokens
        assert call["kwargs"]["max_tokens"] == courses_module.MAX_TOKENS_ANSWERS_CHECK
        assert "max_completion_tokens" not in call["kwargs"]


def test_the_reasoning_body_is_used_for_the_check_calls_only(client, monkeypatch):
    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", PLAIN)
    monkeypatch.setattr(settings, "LLM_REASONING_EXTRA_BODY", REASONING)
    cid, _ = make_course(client, "zh")

    model, _ = run_next(client, cid, responder(lesson_text()))

    streamed, *checks = model.calls
    assert streamed["kwargs"]["extra_body"] == PLAIN
    assert len(checks) == 2 and all(call["kwargs"]["extra_body"] == REASONING for call in checks)


def test_without_a_reasoning_body_the_check_uses_the_global_one_like_every_other_call(client, monkeypatch):
    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", PLAIN)
    monkeypatch.setattr(settings, "LLM_REASONING_EXTRA_BODY", {})
    cid, _ = make_course(client, "zh")

    model, _ = run_next(client, cid, responder(lesson_text()))

    assert all(call["kwargs"]["extra_body"] == PLAIN for call in model.calls)


def test_a_reasoning_attempt_that_comes_back_empty_falls_back_to_one_plain_attempt(client, monkeypatch):
    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", PLAIN)
    monkeypatch.setattr(settings, "LLM_REASONING_EXTRA_BODY", REASONING)
    cid, _ = make_course(client, "zh")
    attempts = {}

    def respond(system, user):
        if CHECKER_ZH not in system:
            return lesson_text()
        number = question_number(user)
        attempts[number] = attempts.get(number, 0) + 1
        if number == 2 and attempts[number] == 1:
            return ""  # 推理把预算吃光：content 为空、finish_reason=length
        return FIXED_2 if number == 2 else own_block(user)

    model, _ = run_next(client, cid, respond)

    second_question = [c for c in check_calls(model) if question_number(c["user"]) == 2]
    assert [c["kwargs"]["extra_body"] for c in second_question] == [REASONING, PLAIN]  # 推理空了，普通模式补上
    assert "核对后的答案二：乙更大。" in stored(client, cid)
    assert len([c for c in check_calls(model) if question_number(c["user"]) == 1]) == 1  # 第 1 题一次就成


def test_a_truncated_reply_is_a_failure_not_a_half_answer(client):
    cid, _ = make_course(client, "zh")
    from unittest.mock import MagicMock
    from tests.conftest import mock_stream

    def create(**kwargs):
        system = kwargs["messages"][0]["content"]
        reply = lesson_text() if CHECKER_ZH not in system else "**第2题：** 旧题二\n> 核对到一半就被截"
        if kwargs.get("stream"):
            return mock_stream([reply], end=False)
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = reply
        response.choices[0].finish_reason = "stop" if CHECKER_ZH not in system else "length"
        return response

    client_stub = MagicMock()
    client_stub.chat.completions.create.side_effect = create
    from unittest.mock import patch

    with patch("app.courses.get_openai_client", return_value=client_stub):
        res = client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 200 and "旧答案二" in stored(client, cid) and "核对到一半" not in stored(client, cid)


def test_a_check_that_fails_every_time_keeps_the_draft_and_the_lesson_is_still_saved(client, user_row):
    cid, _ = make_course(client, "zh")

    model, res = run_next(client, cid, responder(lesson_text(), fail={1, 2}))

    assert stored(client, cid) == courses_module._stamp_reading_time(lesson_text())
    assert sse_events(res)[-1].get("done") is True


def test_an_invalid_reply_for_one_question_only_spares_that_question(client):
    cid, _ = make_course(client, "zh")
    wrong_number = "**第9题：** 旧题二\n> 题号不对"

    run_next(client, cid, responder(lesson_text(), {1: "**第1题：** 旧题一\n> 核对后的答案一。\n\n", 2: wrong_number}))

    content = stored(client, cid)
    assert "核对后的答案一。" in content and "旧答案二" in content and "题号不对" not in content


def test_a_lesson_the_student_answered_has_no_reference_answers_so_nothing_is_checked(client):
    cid, _ = make_course(client, "zh")
    answered = ZH_NEXT.split("## 上一篇思考题参考答案")[0] + "<!-- mastery: 能够解释核心概念1 -->"

    model, _ = run_next(client, cid, responder(answered))

    assert check_calls(model) == []


def test_the_assessment_lesson_is_checked_too(client):
    from app.models import Annotation, Lesson
    from tests.conftest import TestSession

    cid, _ = make_course(client, "zh")
    tick_everything(cid)
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        # 当时没得到解答的提问，评估篇才保留「批注解答」小节
        db.add(Annotation(lesson_id=lesson.id, position_start=0, position_end=1, original_text="甲", comment="为何？"))
        db.commit()

    model, _ = run_next(client, cid, responder(EVAL_REVIEW, {2: "**第2题：** 题二\n> 核对后的答案二。\n\n"}))

    assert len(check_calls(model)) == 2
    content = stored(client, cid)
    assert "核对后的答案二。" in content and "答案一" in content and content.lstrip().startswith("<!-- eval-article -->")
    assert "## 批注解答" in content and "### 你的回答评估" in content


def test_english_lessons_are_checked_with_the_english_prompt(client):
    from tests.unit.test_course_language import create_topic

    created, _ = create_topic(client)
    cid = created["id"]

    def respond(system, user):
        if CHECKER_EN in system:
            assert "## The reference answer to check (one question)" in user
            return "**Question 1:** Old one\n> Checked answer one.\n\n" if "Question 1" in user.split("(one question)")[1] else user.split("(one question)\n")[1]
        return EN_NEXT_UNANSWERED

    with fake_model(respond) as model:
        res = client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 200
    assert len([c for c in model.calls if CHECKER_EN in c["system"]]) == 2
    assert "Checked answer one." in stored(client, cid) and "Old answer two" in stored(client, cid)


def test_the_stored_reading_time_is_recomputed_after_the_answers_change(client):
    cid, _ = make_course(client, "zh")
    long_fix = "**第2题：** 旧题二\n> " + "核对后补充的说明。" * 400 + "\n\n"

    run_next(client, cid, responder(lesson_text(), {2: long_fix}))

    from app.courses import _reading_stats

    minutes = _reading_stats(re.sub(r"<!--.*?-->", "", stored(client, cid), flags=re.DOTALL))[1]
    assert f"预计阅读时间：{minutes} 分钟" in stored(client, cid)


# ---- 时限、心跳、总等待上限 ----

@pytest.fixture
def fast(monkeypatch):
    monkeypatch.setattr(courses_module, "SSE_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_ATTEMPT_SECONDS", 0.01)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_DEADLINE_SECONDS", 0.4)


def test_heartbeats_flow_while_the_check_is_slow_and_the_result_is_used(client, fast):
    cid, _ = make_course(client, "zh")

    _, res = run_next(client, cid, responder(lesson_text(), {2: FIXED_2}, delays={1: 0.25, 2: 0.25}))

    assert res.text.count(": keepalive\n\n") >= 2
    lines = [line for line in res.text.split("\n\n") if line]
    assert lines[0].startswith("data: ") and lines[-1].startswith("data: ") and '"done": true' in lines[-1]
    assert "核对后的答案二：乙更大。" in stored(client, cid)


def test_a_check_that_is_too_slow_is_given_up_and_the_draft_is_saved(client, fast, user_row):
    cid, _ = make_course(client, "zh")

    started = time.monotonic()
    _, res = run_next(client, cid, responder(lesson_text(), {2: FIXED_2}, delays={1: 1.0, 2: 1.0}))
    elapsed = time.monotonic() - started

    assert elapsed < 0.9  # 到总时限就放弃，不等慢调用回来
    assert "旧答案二" in stored(client, cid) and "核对后" not in stored(client, cid)
    assert sse_events(res)[-1].get("done") is True


def test_the_questions_that_came_back_in_time_are_kept_when_another_one_is_late(client, fast):
    cid, _ = make_course(client, "zh")

    run_next(client, cid, responder(
        lesson_text(), {1: "**第1题：** 旧题一\n> 核对后的答案一。\n\n", 2: FIXED_2}, delays={2: 1.0},
    ))

    content = stored(client, cid)
    assert "核对后的答案一。" in content and "旧答案二" in content


def test_the_questions_are_checked_in_parallel_not_one_after_another(client, fast, monkeypatch):
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_DEADLINE_SECONDS", 3)
    cid, _ = make_course(client, "zh")

    started = time.monotonic()
    run_next(client, cid, responder(lesson_text(), delays={1: 0.4, 2: 0.4}))

    assert time.monotonic() - started < 0.75  # 两题各 0.4 秒，并行是 0.4 多一点，串行是 0.8


def test_at_most_the_configured_number_of_questions_is_checked(client, monkeypatch):
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MAX_QUESTIONS", 1)
    cid, _ = make_course(client, "zh")
    seen = []

    run_next(client, cid, responder(lesson_text(), {1: "**第1题：** 旧题一\n> 核对后的答案一。\n\n", 2: FIXED_2}, seen=seen))

    assert seen == [(1, 1)]
    assert "核对后的答案一。" in stored(client, cid) and "旧答案二" in stored(client, cid)


def test_the_check_is_skipped_when_the_waiting_budget_is_used_up(client, monkeypatch):
    monkeypatch.setattr(courses_module, "POST_GENERATION_BUDGET_SECONDS", 5)  # 剩下的时间不到 ANSWERS_CHECK_MIN_SECONDS（15 秒）
    cid, _ = make_course(client, "zh")

    model, res = run_next(client, cid, responder(lesson_text(), {2: FIXED_2}))

    assert check_calls(model) == [] and "旧答案二" in stored(client, cid)
    assert sse_events(res)[-1].get("done") is True


def test_the_defaults_keep_the_total_extra_wait_bounded():
    assert courses_module.POST_GENERATION_BUDGET_SECONDS < (
        courses_module.LESSON_REWRITE_DEADLINE_SECONDS + courses_module.ANSWERS_CHECK_DEADLINE_SECONDS
    )
    assert courses_module.ANSWERS_CHECK_DEADLINE_SECONDS <= 40 and courses_module.LESSON_REWRITE_DEADLINE_SECONDS <= 45
    assert courses_module.ANSWERS_CHECK_MIN_SECONDS < courses_module.ANSWERS_CHECK_DEADLINE_SECONDS
    # 前端「120 秒无数据」判定：任何字节都重置计时，所以心跳间隔远小于它
    assert courses_module.SSE_HEARTBEAT_SECONDS * 4 <= 120


# ---- 设置 ----

def test_the_reasoning_body_setting_is_parsed_like_the_global_one():
    from app.config import llm_extra_body

    example = '{"thinking":{"type":"enabled"}}'
    assert llm_extra_body(example, name="LLM_REASONING_EXTRA_BODY", example=example) == REASONING
    assert llm_extra_body("", name="LLM_REASONING_EXTRA_BODY", example=example) == {}
    with pytest.raises(RuntimeError) as error:
        llm_extra_body("{bad", name="LLM_REASONING_EXTRA_BODY", example=example)
    assert "LLM_REASONING_EXTRA_BODY 不是合法的 JSON" in str(error.value) and '"enabled"' in str(error.value)
    with pytest.raises(RuntimeError) as error:
        llm_extra_body("[1]", name="LLM_REASONING_EXTRA_BODY", example=example)
    assert "LLM_REASONING_EXTRA_BODY 必须是 JSON 对象" in str(error.value) and '"enabled"' in str(error.value)
    with pytest.raises(RuntimeError) as error:  # 没传 example 时是 LLM_EXTRA_BODY 的示例
        llm_extra_body("[1]")
    assert '"disabled"' in str(error.value)


def test_a_developers_local_env_cannot_leak_the_reasoning_body_into_the_tests():
    """conftest 的 autouse fixture 清空它：本机 .env 里设了 LLM_REASONING_EXTRA_BODY，测试也当它没设。"""
    assert settings.LLM_REASONING_EXTRA_BODY == {}


def test_a_per_call_extra_body_overrides_the_global_one_for_that_call_only(monkeypatch):
    from unittest.mock import MagicMock

    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", PLAIN)
    client_stub = MagicMock()
    messages = [{"role": "user", "content": "hi"}]

    courses_module._chat_completion(client_stub, messages)
    assert client_stub.chat.completions.create.call_args.kwargs["extra_body"] == PLAIN
    courses_module._chat_completion(client_stub, messages, extra_body=REASONING)
    assert client_stub.chat.completions.create.call_args.kwargs["extra_body"] == REASONING
    courses_module._chat_completion(client_stub, messages)
    assert client_stub.chat.completions.create.call_args.kwargs["extra_body"] == PLAIN  # 下一次调用不受影响


def test_the_check_call_treats_a_truncated_reply_as_empty():
    from unittest.mock import MagicMock

    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = "半截答案"
    response.choices[0].finish_reason = "length"

    assert courses_module._completion_text(response) == "半截答案"  # 其它调用照旧：只记警告
    with pytest.raises(courses_module.EmptyModelOutput):
        courses_module._completion_text(response, fail_on_length=True)


# ---- 行内的 mastery 注释不能被核对吃掉，也不能被放行 ----

COMMENT = "<!-- mastery: 能够解释核心概念1; 能够解释核心概念2 -->"


def inline_comment_lesson():
    """模型把 mastery 注释接在最后一题答案的同一行末尾。"""
    return lesson_text().replace("> 旧答案二\n\n" + COMMENT, "> 旧答案二" + COMMENT)


def test_an_inline_comment_at_the_end_of_the_last_answer_is_not_part_of_the_section():
    lesson = inline_comment_lesson()
    assert "> 旧答案二" + COMMENT in lesson

    before, section, after = split_answers_section(lesson)

    assert section.endswith("> 旧答案二") and after == COMMENT and before + section + after == lesson
    _, blocks = answer_blocks(section)
    assert "mastery" not in blocks[-1][1]


def test_the_inline_comment_survives_the_check_and_still_ticks_the_outline(client):
    from app.courses import _count_mastery_items
    from tests.unit.test_syllabus_progress_table import syllabus_of

    cid, _ = make_course(client, "zh")

    run_next(client, cid, responder(inline_comment_lesson(), {2: FIXED_2}))

    content = stored(client, cid)
    assert "核对后的答案二：乙更大。" in content
    assert content.count(COMMENT) == 1 and content.rstrip().endswith(COMMENT)
    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    assert _count_mastery_items(syllabus_of(client, cid))[0] == 2  # 核心概念 1、2 都勾上了


@pytest.mark.parametrize("reply", [
    "**第2题：** 旧题二\n> 乙更大。" + COMMENT,
    "**第2题：** 旧题二\n> 乙更大。\n\n" + COMMENT,
    "**第2题：** 旧题二\n> 乙更大。\n<!--",
    "**第2题：** 旧题二\n> 乙更大。-->",
    "**第2题：** 旧题二\n> 乙更大。\n\n---\n\n另外补充一段不属于这一题的话。",
    "**第2题：** 旧题二\n> 乙更大。\n\n***\n\n别的内容",
    "**第2题：** 旧题二\n> 乙更大。\n\n## 批注解答\n\n别的小节",
])
def test_a_reply_with_a_comment_a_rule_or_another_section_is_rejected(reply):
    assert accept_checked_block(ORIGINAL, reply) is None


def test_a_rule_inside_a_code_fence_is_not_a_separator():
    original = "**第2题：** 旧题二\n> 答案\n\n```\n---\n```\n\n"

    assert accept_checked_block(original, "**第2题：** 旧题二\n> 新答案\n\n```\n---\n```") is not None


def test_if_the_replacement_would_change_any_hidden_comment_the_whole_check_is_abandoned(client, monkeypatch):
    """最后一道保险：就算校验漏掉了什么，替换之后全文的隐藏注释必须和替换前一模一样，否则放弃替换。"""
    cid, _ = make_course(client, "zh")

    def respond(system, user):
        return "核对调用的回复（被下面的假校验直接放行）" if CHECKER_ZH in system else lesson_text()

    monkeypatch.setattr(
        courses_module, "accept_checked_block",
        lambda original, reply: "**第2题：** 旧题二\n> 偷偷带进来的答案 <!-- x -->\n\n" if "旧答案二" in original else None,
    )
    run_next(client, cid, respond)

    content = stored(client, cid)
    assert "旧答案二" in content and "偷偷带进来的答案" not in content and "<!-- x -->" not in content
    assert content.count("<!--") == 1


# ---- 行内代码里的 <!-- 不是隐藏注释 ----

def test_a_comment_marker_inside_inline_code_does_not_cut_the_section():
    from app.course_language import _inline_comment_start

    lesson = (
        "# 课\n\n## 上一篇思考题参考答案\n\n**第1题：** 怎么写注释？\n> 写成 `<!-- x -->` 就是 HTML 注释，浏览器不显示它。\n\n"
        "**第2题：** 第二题\n> 第二个答案，也提到 ``<!-- y -->`` 这种写法。" + COMMENT
    )

    before, section, after = split_answers_section(lesson)

    assert "**第2题：**" in section and section.endswith("这种写法。") and after == COMMENT
    assert "浏览器不显示它" in section  # 第 1 题没有被行内代码里的 <!-- 截断
    assert _inline_comment_start("> 写成 `<!-- x -->` 就是注释") == -1
    assert _inline_comment_start("> 答案<!-- m -->") == 4 and _inline_comment_start("> 答案 `a` <!-- m -->") == 9


def test_an_answer_that_talks_about_comments_in_inline_code_survives_the_check_unchanged_in_count(client):
    from tests.unit.test_syllabus_progress_table import syllabus_of

    lesson = lesson_text().replace("旧答案二", "旧答案二，用 `<!-- x -->` 写注释")
    cid, _ = make_course(client, "zh")
    fixed = "**第2题：** 旧题二\n> 核对后的答案二，用 `<!-- x -->` 写注释。\n\n"

    run_next(client, cid, responder(lesson, {2: fixed}))

    content = stored(client, cid)
    assert "核对后的答案二，用 `<!-- x -->` 写注释。" in content and content.count("<!--") == 2  # 行内代码里一处 + 末尾的 mastery 注释
    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    assert "- [x] 能够解释核心概念1" in syllabus_of(client, cid)
