"""RB3：参考答案里的自我更正字样——提示词禁止、保存前轻量检查、命中就再生成一次。"""
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import app.course_language as language_module
import app.courses as courses_module
import app.prompts_en as prompts_en
from app.course_language import answers_part, has_self_correction
from app.models import Feedback, Lesson, Syllabus
from tests.conftest import TestSession, mock_stream
from tests.unit.test_course_language import CJK, create_topic, fake_model, sse_events
from tests.unit.test_lesson_prompt_rules import EN_NEXT_UNANSWERED, ZH_NEXT, generate_next, make_course

CLEAN_ZH_ANSWER = "**第1题：** 旧题一\n> 价格加权涨约 9.1%，市值加权约 2%，所以价格加权更大。\n"
DIRTY_ZH_ANSWER = "**第1题：** 旧题一\n> 市值加权下涨幅更大。等等——这样看反而是价格加权更大。再确认一下题目，价格加权涨约 9.1%。\n"


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
    """这个文件测的是「自我更正 → 整篇重写」；参考答案单独核对（C2）另有 test_answers_check.py，这里让它跳过。"""
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 10**9)


def zh_lesson(answer):
    return ZH_NEXT.split("## 上一篇思考题参考答案")[0] + "## 上一篇思考题参考答案\n\n" + answer + "\n<!-- mastery: 能够解释核心概念1 -->"


def en_lesson(answer):
    return EN_NEXT_UNANSWERED.split("## Reference answers")[0] + "## Reference answers to the previous reflection questions\n\n" + answer + "\n"


# ---- 提示词 ----

def test_the_prompts_forbid_self_corrections_and_demand_checking_the_numbers():
    zh, en = language_module.ZH.answers_section, language_module.EN.answers_section

    for phrase in ("先在心里算清、查清", "禁止出现「等等」「再确认一下」「我算错了」「重新算一下」", "必须用题目给出的数据算出来并核对一遍"):
        assert phrase in zh.replace("每题的答案先在心里算清、查清", "先在心里算清、查清")
    for phrase in ("Work out and check each answer first", 'never write self-corrections such as "Wait", "Let me re-check" or "I made a mistake"',
                   "compute from the data the question gives and verify the result"):
        assert phrase in en
    assert "禁止出现「等等」「再确认一下」「我算错了」这类自我更正的话" in courses_module.EVAL_LESSON_PROMPT
    assert 'never write self-corrections such as "Wait" or "Let me re-check"' in prompts_en.EVAL_LESSON_PROMPT
    assert not CJK.search(en)


def test_the_unanswered_prompt_carries_the_answer_discipline(client):
    cid, _ = make_course(client, "zh")

    system = generate_next(client, cid).calls[0]["system"]

    assert "禁止出现「等等」「再确认一下」" in system


# ---- 检测 ----

@pytest.mark.parametrize("answer", [
    DIRTY_ZH_ANSWER,
    "> 结论是 A。等等，我算错了。",
    "> 结论是 A。我刚才算错了，应该是 B。",
    "> 抱歉，刚才算错了，是 B。",
    "> 结论是 A。糟糕，上面写错了，要重新算一下。",
    "> 等一下——让我重新核对：112 − 110 = 2，2 ÷ 110 ≈ 1.82%。那为什么上面写 9.09%？",
    "> It is A. Wait — let me re-check the data.",
    "> It is A. Wait, that's wrong: it is B.",
    "> 结论是 A。\n等等！不对。",
    "> 结论是 A。让我重新算一下。",
    "> The answer is A. Wait, that is wrong: it is B.",
    "> It is A. Let me re-check the data.",
    "> It is A. Let me recompute.",
    "> It is A. On second thought it is B.",
    "> It is A. I made a mistake above.",
    "> It is A. Scratch that.",
    "> It is A. Actually, no: it is B.",
    "> It is A. Actually, the correct value is B.",
])
def test_self_corrections_in_the_reference_answers_are_detected(answer):
    lesson = "# 课\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 问？\n\n## 上一篇思考题参考答案\n\n" + answer

    assert has_self_correction(lesson) is True


@pytest.mark.parametrize("answer", [
    CLEAN_ZH_ANSWER,
    "> 苹果、香蕉等等，都是水果。",
    "> 先求导，再令导数为零，得到 x = 2。",
    "> 它等于 3，因为等差数列的公差是 1。",
    "> The answer is A, because the weights wait for no one.",
    "> It is A. Waiting costs nothing, so the rate is zero.",
    "> Actually useful here is the identity sin²+cos²=1.",
    "> The corrected formula uses the adjusted close.",
])
def test_ordinary_answers_are_not_flagged(answer):
    lesson = "# 课\n\n## 思考题\n\n1. 问？\n\n## 上一篇思考题参考答案\n\n" + answer

    assert has_self_correction(lesson) is False


def test_only_the_reference_answer_section_is_checked():
    lesson = "# 课\n\n## 正文内容\n\n有人会说「等等——这不对」，我们来看看为什么。Wait, what? 这是个常见的疑问。\n\n## 思考题\n\n1. 问？\n"

    assert has_self_correction(lesson) is False
    assert answers_part(lesson) == ""
    eval_lesson = "<!-- eval-article -->\n\n# 评估\n\n### 正确答案\n\n**第1题：** 题\n> 等等——不对，是 B。\n"
    assert has_self_correction(eval_lesson) is True
    assert has_self_correction("# L\n\n### Correct answers\n\n**Question 1:** Q\n> Wait, let me re-check: it is B.\n") is True
    # 隐藏的注释不算
    assert has_self_correction("# 课\n\n## 上一篇思考题参考答案\n\n> 干净\n<!-- mastery: 等等——不对 -->") is False


# ---- 重试 ----

def run_next(client, cid, responder):
    """返回 (model, 流式事件)。"""
    with fake_model(responder) as model:
        res = client.post(f"/api/courses/{cid}/next")
    assert res.status_code == 200, res.text
    events = sse_events(res)
    assert not any("error" in event for event in events), res.text
    return model, events


def stored(client, cid, number=2):
    return client.get(f"/api/courses/{cid}/lessons/{number}").json()["content"]


def test_a_dirty_first_answer_is_retried_once_and_the_clean_retry_is_stored(client):
    cid, _ = make_course(client, "zh")
    replies = iter([zh_lesson(DIRTY_ZH_ANSWER), zh_lesson(CLEAN_ZH_ANSWER)])

    model, events = run_next(client, cid, lambda system, user: next(replies))

    assert [call["stream"] for call in model.calls] == [True, False]  # 第一次流式，重试不流式
    assert model.calls[0]["system"] == model.calls[1]["system"] and model.calls[0]["user"] == model.calls[1]["user"]
    content = stored(client, cid)
    assert "等等" not in content and "价格加权涨约 9.1%，市值加权约 2%" in content
    assert any("等等——" in event.get("content", "") for event in events)  # 流式预览是第一次的原话


def test_a_retry_that_is_still_dirty_keeps_the_first_text(client):
    cid, _ = make_course(client, "zh")
    first, second = zh_lesson(DIRTY_ZH_ANSWER), zh_lesson(DIRTY_ZH_ANSWER.replace("等等——", "等一下，"))
    replies = iter([first, second])

    model, _ = run_next(client, cid, lambda system, user: next(replies))

    assert len(model.calls) == 2
    assert "等等——这样看反而是价格加权更大" in stored(client, cid)  # 保留第一次的


def test_a_retry_that_fails_keeps_the_first_text_and_still_saves(client):
    cid, _ = make_course(client, "zh")
    calls = []

    def responder(system, user):
        calls.append(user)
        if len(calls) == 1:
            return zh_lesson(DIRTY_ZH_ANSWER)
        raise RuntimeError("model down")

    model, events = run_next(client, cid, responder)

    assert len(model.calls) == 2
    assert "等等——" in stored(client, cid)
    assert any(event.get("done") for event in events)


def test_an_empty_retry_keeps_the_first_text(client):
    cid, _ = make_course(client, "zh")
    replies = iter([zh_lesson(DIRTY_ZH_ANSWER), ""])

    run_next(client, cid, lambda system, user: next(replies))

    assert "等等——" in stored(client, cid)


def test_a_clean_first_answer_is_not_retried(client):
    cid, _ = make_course(client, "zh")

    model, _ = run_next(client, cid, lambda system, user: zh_lesson(CLEAN_ZH_ANSWER))

    assert len(model.calls) == 1 and model.calls[0]["stream"] is True


def test_a_retry_that_turns_into_a_different_kind_of_lesson_is_not_used(client):
    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    dirty_eval = "<!-- eval-article -->\n\n# 评估\n\n### 正确答案\n\n**第1题：** 题\n> 等等——不对，是 B。\n"
    replies = iter([dirty_eval, zh_lesson(CLEAN_ZH_ANSWER)])  # 重试变成了普通课文，不是评估篇

    run_next(client, cid, lambda system, user: next(replies))

    lesson = client.get(f"/api/courses/{cid}/lessons/2").json()
    assert lesson["is_evaluation"] is True and "等等——" in lesson["content"]


def test_a_dirty_assessment_is_retried_and_stays_an_assessment(client):
    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    dirty = "<!-- eval-article -->\n\n# 评估\n\n### 正确答案\n\n**第1题：** 题\n> 等等——不对，是 B。\n"
    clean = "<!-- eval-article -->\n\n# 评估\n\n### 正确答案\n\n**第1题：** 题\n> 是 B。\n"
    replies = iter([dirty, clean])

    run_next(client, cid, lambda system, user: next(replies))

    lesson = client.get(f"/api/courses/{cid}/lessons/2").json()
    assert lesson["is_evaluation"] is True and "等等" not in lesson["content"] and "是 B。" in lesson["content"]


def test_english_lessons_are_checked_and_retried_too(client):
    created, _ = create_topic(client)
    cid = created["id"]
    dirty = en_lesson("**Question 1:** Q\n> Weighted by market cap it is larger. Wait, that is wrong: price-weighted is larger. Let me re-check.\n")
    clean = en_lesson("**Question 1:** Q\n> Price-weighted is larger: 9.1% against 2%.\n")
    replies = iter([dirty, clean])

    model, _ = run_next(client, cid, lambda system, user: next(replies))

    assert len(model.calls) == 2
    content = stored(client, cid)
    assert "Wait" not in content and "Price-weighted is larger: 9.1% against 2%." in content
    assert not CJK.search(model.calls[1]["system"])


def test_the_retry_still_goes_through_the_same_wrapper_stripping_and_reading_time(client):
    cid, _ = make_course(client, "zh")
    wrapped = f"```markdown\n{zh_lesson(CLEAN_ZH_ANSWER)}\n```\n\n希望对你有帮助"
    replies = iter([zh_lesson(DIRTY_ZH_ANSWER), wrapped])

    run_next(client, cid, lambda system, user: next(replies))

    content = stored(client, cid)
    assert "```" not in content and "希望对你有帮助" not in content and "等等" not in content
    assert "> 预计阅读时间：1 分钟" in content  # 模型报的 5 分钟被重算


def test_an_answered_lesson_has_no_reference_answer_section_so_nothing_is_checked(client):
    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == 1).one()
        db.add(Feedback(lesson_id=lesson.id, content="清楚", thought_answers="1. 我的答案"))
        db.commit()
    answered = "# 第二课\n\n## 上一篇思考题复盘\n\n**第1题：** ✅ 对。\n\n## 正文内容\n\n新内容。\n\n## 思考题\n\n1. 新问题？\n"

    model, _ = run_next(client, cid, lambda system, user: answered)

    assert len(model.calls) == 1  # 没有参考答案小节，不检查、不重试


# ---- 收窄误报面 ----

FALSE_POSITIVES = [
    # 中文：讲「怎么错」「会怎么复核」的正常句子
    "常见错误是把分母算错了。",
    "学生容易写错了符号。",
    "订单提交后会重新核对账户余额。",
    "监管机构会再确认一下披露信息。",
    "该算法需要重新算一遍。",
    "更正：原公告日期为 2024 年 5 月 1 日。",
    "纠正：这是一种常见误解。",
    "需要等一下再确认成交。",
    "买入后会有一个重新核对持仓的步骤。",
    "他说“等等——不对，我算错了”，然后离开。",
    "「再确认一下」是客服的口头禅。",
    # 英文
    "Wait-free algorithms guarantee progress.",
    "Threads wait, then retry.",
    "The process must wait. Then it proceeds.",
    "Wait, then retry the operation.",
    "Investors should hold on to the shares.",
    "I made a trade yesterday.",
    "Actually, no new information arrives.",
    "Actually, useful here is the identity sin²+cos²=1.",
    'He wrote "wait, that is wrong" in the margin.',
    'The note says "Let me re-check" and nothing else.',
    "Correction: the quarterly report restated revenue.",
]


@pytest.mark.parametrize("sentence", FALSE_POSITIVES)
def test_ordinary_sentences_are_not_flagged_as_self_corrections(sentence):
    lesson = "# 课\n\n## 思考题\n\n1. 问？\n\n## 上一篇思考题参考答案\n\n**第1题：** 题\n> " + sentence + "\n"

    assert has_self_correction(lesson) is False, sentence


@pytest.mark.parametrize("sentence", ["，".join(FALSE_POSITIVES[:2]), " ".join(FALSE_POSITIVES[12:15])])
def test_several_ordinary_sentences_together_are_still_fine(sentence):
    assert has_self_correction("# 课\n\n## 上一篇思考题参考答案\n\n> " + sentence + "\n") is False


def test_the_real_samples_are_still_caught():
    zhang = "市值加权下涨幅更大。等等——这样看反而是价格加权更大。再确认一下题目，价格加权涨约 9.1%。"
    probe = "等一下——让我重新核对：112 − 110 = 2，2 ÷ 110 ≈ 1.82%。那为什么上面写 9.09%？"

    for sample in (zhang, probe):
        assert has_self_correction("# 课\n\n## 上一篇思考题参考答案\n\n> " + sample) is True


# ---- 重试期间的 SSE 心跳、总时限、不叠加 SDK 重试 ----

class SlowRetryModel:
    """第一次（流式）立刻给出带自我更正的课文，第二次（非流式）睡 retry_delay 秒再给干净的。"""

    def __init__(self, first, second, retry_delay):
        self.first, self.second, self.retry_delay = first, second, retry_delay
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def close(self):
        pass

    def create(self, **kwargs):
        self.calls.append({"stream": bool(kwargs.get("stream"))})
        if kwargs.get("stream"):
            return mock_stream([self.first], end=False)
        time.sleep(self.retry_delay)
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = self.second
        response.choices[0].finish_reason = "stop"
        return response


def run_with_slow_retry(client, cid, retry_delay, second, monkeypatch, *, heartbeat=0.05, deadline=0.4):
    monkeypatch.setattr(courses_module, "SSE_HEARTBEAT_SECONDS", heartbeat)
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", deadline)
    model = SlowRetryModel(zh_lesson(DIRTY_ZH_ANSWER), second, retry_delay)
    clients = []

    def get_client(**kwargs):
        clients.append(kwargs)
        return model

    with patch("app.courses.get_openai_client", side_effect=get_client):
        res = client.post(f"/api/courses/{cid}/next")
    assert res.status_code == 200, res.text
    return model, clients, res


def test_heartbeat_lines_are_sent_while_the_retry_is_slow(client, monkeypatch):
    cid, _ = make_course(client, "zh")

    model, _, res = run_with_slow_retry(client, cid, 0.25, zh_lesson(CLEAN_ZH_ANSWER), monkeypatch)

    assert res.text.count(": keepalive\n\n") >= 2  # 慢的重试期间一直有数据，不会 120 秒没动静
    events = sse_events(res)
    assert events[-1].get("done") and not any("error" in event for event in events)
    assert "等等" not in stored(client, cid)  # 重试在时限内回来了，用重试的
    assert [call["stream"] for call in model.calls] == [True, False]


def test_heartbeats_come_after_the_streamed_content_and_before_done(client, monkeypatch):
    cid, _ = make_course(client, "zh")

    _, _, res = run_with_slow_retry(client, cid, 0.25, zh_lesson(CLEAN_ZH_ANSWER), monkeypatch)

    lines = [line for line in res.text.split("\n\n") if line]
    first_beat = lines.index(": keepalive")
    assert lines[0].startswith("data: ") and lines[-1].startswith("data: ") and '"done": true' in lines[-1]
    assert 0 < first_beat < len(lines) - 1


def test_a_retry_that_exceeds_the_deadline_is_given_up_and_the_first_text_is_saved(client, monkeypatch):
    cid, _ = make_course(client, "zh")

    started = time.monotonic()
    _, _, res = run_with_slow_retry(client, cid, 1.5, zh_lesson(CLEAN_ZH_ANSWER), monkeypatch, deadline=0.3)
    elapsed = time.monotonic() - started

    assert elapsed < 1.2  # 到总时限就放弃，不等慢调用回来
    events = sse_events(res)
    assert events[-1].get("done") and not any("error" in event for event in events)
    assert "等等——" in stored(client, cid)  # 保存第一版，没有报错


def test_the_retry_call_has_no_sdk_retries_and_a_timeout_equal_to_the_deadline(client, monkeypatch):
    cid, _ = make_course(client, "zh")

    _, clients, _ = run_with_slow_retry(client, cid, 0.0, zh_lesson(CLEAN_ZH_ANSWER), monkeypatch, deadline=7)

    retry_client = clients[-1]
    assert retry_client == {"timeout_cap": 7, "max_retries": 0}
    assert clients[0].get("stream") is True and "max_retries" not in clients[0]


def test_the_real_client_for_the_retry_never_retries_and_caps_its_timeout(monkeypatch):
    monkeypatch.setattr(courses_module.settings, "LLM_MAX_RETRIES", 3)
    monkeypatch.setattr(courses_module.settings, "LLM_REQUEST_TIMEOUT_SECONDS", 300)

    client = courses_module.get_openai_client(timeout_cap=45, max_retries=0)

    assert client.max_retries == 0 and client.timeout.read == 45
    assert courses_module.get_openai_client().max_retries == 3  # 其它非流式调用不受影响


def test_the_retry_runs_off_the_request_thread_so_the_heartbeat_can_flow(client, monkeypatch):
    cid, _ = make_course(client, "zh")
    threads = []
    real = courses_module._call_llm

    def spy(*args, **kwargs):
        threads.append(threading.current_thread().name)
        return real(*args, **kwargs)

    monkeypatch.setattr(courses_module, "_call_llm", spy)
    run_with_slow_retry(client, cid, 0.05, zh_lesson(CLEAN_ZH_ANSWER), monkeypatch)

    assert threads and threads[-1].startswith("lesson-rewrite")


def test_a_retry_that_finishes_before_the_first_heartbeat_sends_none(client, monkeypatch):
    cid, _ = make_course(client, "zh")

    _, _, res = run_with_slow_retry(client, cid, 0.0, zh_lesson(CLEAN_ZH_ANSWER), monkeypatch, heartbeat=5, deadline=10)

    assert ": keepalive" not in res.text and "等等" not in stored(client, cid)


def test_the_sse_comment_lines_are_ignored_by_the_client_side_parsers(client):
    """前端和测试里的解析都只认 data: 开头的行；注释行（: keepalive）不会被当成事件。"""
    assert [event for event in sse_events(SimpleNamespace(text=": keepalive\n\ndata: {\"content\": \"x\"}\n\n: keepalive\n\n"))] == [{"content": "x"}]
    assert courses_module.SSE_HEARTBEAT == ": keepalive\n\n"
