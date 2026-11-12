"""模型返回空内容（带隐藏推理的模型把 max_tokens 吃光：content 为空、finish_reason=length）：每一步都按模型失败处理。

- 资料建课的每一步（分块提炼、归并、综合、大纲与首课的草稿 / 复核 / 修复）：空内容重试一次，再空就失败、什么都不保存，绝不拿空笔记继续。
  大纲优先流程之后，前六步在建课请求里，首课三步在确认大纲后的 POST /courses/{id}/first 里；首课失败不留课文，大纲保留。
- 其余调模型的步骤（普通主题课、原文课、推荐）：空内容直接失败、不保存。
- 流式步骤（下一篇、评估篇、总结、划线问答与追问）本来就不保存空内容：这里在模型客户端这一层再确认一遍。
最后核对每一步的 max_tokens：装得下提示词允许的最长输出，且不超过 8192。
"""
import re
import threading
from unittest.mock import MagicMock, patch

import pytest

import app.courses as courses_module
from app.courses import EmptyModelOutput, MaterialTimeout
from app.models import Annotation, Course, LearningRecommendation, Lesson, Syllabus
from tests.conftest import TestSession
from tests.unit.test_course_language import (
    EN_LESSON, create_topic, fake_model, next_lesson, respond_en, respond_zh, sse_events, syllabus_text,
)


@pytest.fixture
def client(authed_client):
    return authed_client


def completion(content, finish_reason="stop"):
    return MagicMock(choices=[MagicMock(message=MagicMock(content=content), finish_reason=finish_reason)])


# ---------------------------------------------------------------------------
# 单次调用：什么算空
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("content, finish_reason", [
    ("", "length"), ("", "stop"), (None, "length"), (None, "stop"), ("  \n\t ", "stop"), ("```markdown\n```", "stop"), ("```", "stop"),
])
@pytest.mark.parametrize("call", [
    lambda: courses_module._call_llm("系统", "用户"),
    lambda: courses_module._call_llm("系统", "用户", max_tokens=100, timeout=5),
    lambda: courses_module._call_llm_messages("系统", [{"role": "user", "content": "问"}]),
], ids=["call_llm", "call_llm_budget", "call_llm_messages"])
def test_empty_content_is_a_model_failure(call, content, finish_reason):
    with patch("app.courses.get_openai_client") as get_client:
        get_client.return_value.chat.completions.create.return_value = completion(content, finish_reason)
        with pytest.raises(EmptyModelOutput) as error:
            call()

    assert "空内容" in str(error.value) and f"finish_reason={finish_reason}" in str(error.value)


def test_a_response_without_choices_is_an_empty_output():
    with patch("app.courses.get_openai_client") as get_client:
        get_client.return_value.chat.completions.create.return_value = MagicMock(choices=[])
        with pytest.raises(EmptyModelOutput):
            courses_module._call_llm("系统", "用户")


def test_truncated_but_non_empty_content_is_returned_with_a_warning(caplog):
    with patch("app.courses.get_openai_client") as get_client:
        get_client.return_value.chat.completions.create.return_value = completion("半截内容", "length")
        with caplog.at_level("WARNING", logger="app.courses"):
            text = courses_module._call_llm("系统", "用户")

    assert text == "半截内容" and "finish_reason=length" in caplog.text


# ---------------------------------------------------------------------------
# 资料建课的步骤：空内容重试一次
# ---------------------------------------------------------------------------

def test_a_material_step_retries_an_empty_answer_once():
    with patch.object(courses_module, "_call_llm", side_effect=[EmptyModelOutput("空"), "第二次有内容"]) as call:
        assert courses_module._call_material_llm("系统", "用户", max_tokens=50) == "第二次有内容"

    assert call.call_count == 2
    assert call.call_args_list[0] == call.call_args_list[1]


def test_a_material_step_fails_after_the_second_empty_answer():
    with patch.object(courses_module, "_call_llm", side_effect=EmptyModelOutput("空")) as call:
        with pytest.raises(EmptyModelOutput):
            courses_module._call_material_llm("系统", "用户")

    assert call.call_count == 2


@pytest.mark.parametrize("returned", ["", "  \n", "```markdown\n```", None])
def test_a_blank_string_returned_by_the_call_is_also_retried_and_never_passed_on(returned):
    with patch.object(courses_module, "_call_llm", side_effect=[returned, returned]) as call:
        with pytest.raises(EmptyModelOutput):
            courses_module._call_material_llm("系统", "用户")
    assert call.call_count == 2

    with patch.object(courses_module, "_call_llm", side_effect=[returned, "好"]):
        assert courses_module._call_material_llm("系统", "用户") == "好"


def test_the_retry_is_bound_by_the_deadline_too():
    with patch.object(courses_module, "_call_llm", side_effect=EmptyModelOutput("空")) as call:
        with pytest.raises(MaterialTimeout):
            courses_module._call_material_llm("系统", "用户", deadline=courses_module.time.monotonic() - 1)
    assert call.call_count == 0

    # 第一次调用之后截止时间到了：不再重试，按超时处理（504）而不是再调一次模型
    clock = iter([0.0, 500.0])
    with patch.object(courses_module, "_call_llm", side_effect=EmptyModelOutput("空")) as call, \
            patch.object(courses_module.time, "monotonic", side_effect=lambda: next(clock)):
        with pytest.raises(MaterialTimeout):
            courses_module._call_material_llm("系统", "用户", deadline=100.0)
    assert call.call_count == 1


def test_chunk_extraction_in_the_thread_pool_retries_each_chunk_on_its_own():
    lock, seen = threading.Lock(), {}

    def flaky(system_prompt, user_message, **_kwargs):
        with lock:
            seen[user_message] = seen.get(user_message, 0) + 1
            attempt = seen[user_message]
        if user_message == "第二块" and attempt == 1:
            raise EmptyModelOutput("空")
        return f"笔记：{user_message}"

    with patch.object(courses_module, "_call_llm", side_effect=flaky):
        results = courses_module._parallel_material_llm("系统", ["第一块", "第二块", "第三块"], 3, 100)

    assert results == ["笔记：第一块", "笔记：第二块", "笔记：第三块"]
    assert seen == {"第一块": 1, "第二块": 2, "第三块": 1}


# ---------------------------------------------------------------------------
# 资料建课：每一步出现空内容，端到端
# ---------------------------------------------------------------------------

SOURCELESS = syllabus_text().replace(" (Source: concepts.md, Core concepts)", "")
BAD_LESSON = "# Lesson\n\nJust one paragraph, no sources, no questions."


def merge_briefly(system, user):
    return "ok" if "course material merger" in system else respond_en(system, user)


def needs_syllabus_repair(system, user):
    if "fact-checker for source-grounded course outlines" in system or "course syllabus design expert" in system:
        return SOURCELESS
    return merge_briefly(system, user)


def needs_lesson_repair(system, user):
    if "fact and teaching-quality reviewer" in system or "write the first lesson (01)" in system:
        return BAD_LESSON
    if "format fixer for source-grounded first lessons" in system:
        return EN_LESSON
    return merge_briefly(system, user)


EN_STEPS = [  # (步骤, 识别它的系统提示词片段, 基础响应)
    ("chunk", "course material analyzer", merge_briefly),
    ("reduce", "course material merger", merge_briefly),
    ("synthesis", "chief editor of course materials", merge_briefly),
    ("syllabus draft", "course syllabus design expert", merge_briefly),
    ("syllabus review", "fact-checker for source-grounded course outlines", merge_briefly),
    ("syllabus repair", "format fixer for source-grounded course outlines", needs_syllabus_repair),
    ("lesson draft", "write the first lesson (01)", merge_briefly),
    ("lesson review", "fact and teaching-quality reviewer", merge_briefly),
    ("lesson repair", "format fixer for source-grounded first lessons", needs_lesson_repair),
]
ORDER = [marker for _, marker, _ in EN_STEPS]


def empty_at(marker, times, base):
    lock, state = threading.Lock(), {"left": times}

    def responder(system, user):
        if marker in system:
            with lock:
                if state["left"] > 0:
                    state["left"] -= 1
                    return ""
        return base(system, user)

    return responder


LESSON_STEPS = {"lesson draft", "lesson review", "lesson repair"}  # 这三步在 POST /first 里


def post_materials(client, responder, language="en", reference="", first=False):
    """建资料课（只生成大纲）；first=True 且建课成功时，接着用同一个模型生成第 01 篇。返回 (建课响应, 首篇响应或 None, model)。"""
    with patch.object(courses_module, "MATERIAL_REDUCE_BATCH_CHARS", 40):
        with fake_model(responder) as model:
            res = client.post(
                "/api/courses/from-materials",
                data={"name": "Compound interest", "learning_depth": "simple", "language": language, "reference": reference},
                files=[
                    ("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown")),
                    ("files", ("cases.md", b"# Cases\n\nA savings account.", "text/markdown")),
                ],
            )
            started = client.post(f"/api/courses/{res.json()['id']}/first") if first and res.status_code == 200 else None
    return res, started, model


def count(model, marker):
    return sum(marker in call["system"] for call in model.calls)


@pytest.mark.parametrize("step, marker, base", EN_STEPS, ids=[step for step, _, _ in EN_STEPS])
def test_one_empty_answer_in_a_material_step_is_retried_and_the_course_is_still_created(client, user, step, marker, base):
    _, _, baseline = post_materials(client, base, first=True)

    res, started, model = post_materials(client, empty_at(marker, 1, base), first=True)

    assert res.status_code == 200, res.text
    assert res.json()["language"] == "en" and res.json()["syllabus_content"].startswith("# Compound interest")
    assert started.status_code == 200, started.text
    assert count(model, marker) == count(baseline, marker) + 1
    for text in model.all_text():
        assert text.strip()  # 没有任何一步拿空笔记继续：发给模型的每条消息都有内容


@pytest.mark.parametrize("step, marker, base", EN_STEPS, ids=[step for step, _, _ in EN_STEPS])
def test_two_empty_answers_in_a_material_step_fail_the_request_and_save_nothing(client, user, step, marker, base):
    res, started, model = post_materials(client, empty_at(marker, 2, base), first=True)

    if step in LESSON_STEPS:
        # 大纲已经建好；首篇这次请求失败，不留课文，大纲还在，可以重试
        assert res.status_code == 200, res.text
        failed = started
        with TestSession() as db:
            assert db.query(Course).count() == 1 and db.query(Lesson).filter(Lesson.number > 0).count() == 0
    else:
        failed = res
        assert started is None
        with TestSession() as db:
            assert db.query(Course).count() == 0
    assert failed.status_code == 502 and "请稍后重试" in failed.json()["detail"]
    assert count(model, marker) == 2  # 重试了一次，只一次
    for later in ORDER[ORDER.index(marker) + 1:]:
        assert count(model, later) == 0, f"{later} still ran after {step} failed"


def test_an_empty_chunk_note_never_reaches_the_knowledge_pack(client, user):
    """分块笔记空了两次：整单失败，而不是让综合那一步拿着空笔记去编一份知识包。"""
    res, _, model = post_materials(client, empty_at("course material analyzer", 2, merge_briefly))

    assert res.status_code == 502
    assert count(model, "chief editor of course materials") == 0
    assert count(model, "course syllabus design expert") == 0


@pytest.mark.parametrize("step, marker", [("chunk", "课程资料分析器"), ("synthesis", "课程资料总编")])
def test_the_chinese_material_steps_are_guarded_the_same_way(client, user, step, marker):
    for times, status in ((1, 200), (2, 502)):
        with fake_model(empty_at(marker, times, respond_zh)) as model:
            res = client.post(
                "/api/courses/from-materials", data={"name": "资料课", "learning_depth": "simple", "language": "zh"},
                files=[("files", ("甲.md", "# 概念\n\n正文".encode(), "text/markdown"))],
            )
        assert res.status_code == status, res.text
        assert count(model, marker) == 2  # 第一个请求：空一次、重试成功；第二个请求：空两次、失败
    with TestSession() as db:
        assert db.query(Course).count() == 1  # 只有第一个请求建了课


def test_empty_answers_fail_the_course_when_it_also_has_pasted_reference_text(client, user):
    res, _, _ = post_materials(client, empty_at("chief editor of course materials", 2, merge_briefly), reference="Pasted notes.")

    assert res.status_code == 502
    with TestSession() as db:
        assert db.query(Course).count() == 0


# ---------------------------------------------------------------------------
# 其余调模型的步骤：空内容直接失败、不保存
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("blank", ["", "  \n\t", "```markdown\n```"])
@pytest.mark.parametrize("marker, calls_made", [("course syllabus design expert", 1), ("write the first lesson (01)", 2)])
def test_a_plain_topic_course_fails_on_an_empty_answer_and_saves_nothing(client, user, marker, calls_made, blank):
    def responder(system, user_message):
        return blank if marker in system else respond_en(system, user_message)

    with fake_model(responder) as model:
        res = client.post("/api/courses", json={"name": "Compound interest", "learning_depth": "simple", "language": "en"})
        if res.status_code == 200:  # 大纲建好了：第 01 篇在 /first 里生成
            res = client.post(f"/api/courses/{res.json()['id']}/first")
            with TestSession() as db:
                assert db.query(Course).count() == 1 and db.query(Lesson).filter(Lesson.number > 0).count() == 0
        else:
            with TestSession() as db:
                assert db.query(Course).count() == 0

    assert res.status_code == 502 and "请稍后重试" in res.json()["detail"]
    assert len(model.calls) == calls_made  # 没有重试


@pytest.mark.parametrize("locale", ["en", "zh"])
def test_recommendations_fail_on_an_empty_answer_and_save_nothing(client, user, locale):
    with fake_model(lambda system, user_message: "") as model:
        res = client.post("/api/recommendations/refresh", json={"locale": locale})

    assert res.status_code == 502 and "请稍后重试" in res.json()["detail"]
    assert len(model.calls) == 1
    with TestSession() as db:
        assert db.query(LearningRecommendation).count() == 0


def test_the_chinese_plain_topic_course_is_guarded_too(client, user):
    with fake_model(lambda system, user_message: "") as model:
        res = client.post("/api/courses", json={"name": "博弈论", "learning_depth": "simple"})

    assert res.status_code == 502 and len(model.calls) == 1
    with TestSession() as db:
        assert db.query(Course).count() == 0


# ---------------------------------------------------------------------------
# 流式步骤：在模型客户端这一层确认「不保存空内容」
# ---------------------------------------------------------------------------

def lessons_and_notes():
    with TestSession() as db:
        return db.query(Lesson).count(), db.query(Annotation).count(), db.query(Syllabus).count()


def only_error(res):
    events = sse_events(res)
    assert not any(event.get("done") for event in events), res.text
    return next(event["error"] for event in events if "error" in event)


def test_streaming_next_lesson_assessment_and_summary_refuse_an_empty_answer(client, user):
    created, _ = create_topic(client)
    cid = created["id"]
    before_rows = lessons_and_notes()

    with fake_model(lambda system, user_message: "") as model:
        res = client.post(f"/api/courses/{cid}/next")
    assert "请稍后重试" in only_error(res)
    assert lessons_and_notes() == before_rows
    assert model.calls[0]["stream"] is True

    with TestSession() as db:  # 评估篇
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    with fake_model(lambda system, user_message: "  \n") as model:
        res = client.post(f"/api/courses/{cid}/next")
    assert "请稍后重试" in only_error(res)
    assert lessons_and_notes() == before_rows

    next_lesson(client, cid)  # 真的生成评估篇
    rows = lessons_and_notes()
    with fake_model(lambda system, user_message: "") as model:  # 总结
        res = client.post(f"/api/courses/{cid}/next")
    assert "请稍后重试" in only_error(res)
    assert lessons_and_notes() == rows
    assert client.get(f"/api/courses/{cid}").json()["status"] == "learning"


def test_streaming_highlight_answers_and_follow_ups_refuse_an_empty_answer(client, user):
    created, _ = create_topic(client)
    cid = created["id"]
    before_rows = lessons_and_notes()
    body = {"position_start": 0, "position_end": 4, "original_text": "Interest", "comment": "What?", "answer_immediately": True}

    with fake_model(lambda system, user_message: "") as model:
        res = client.post(f"/api/courses/{cid}/lessons/1/annotations", json=body)
    assert "请稍后重试" in only_error(res)
    assert lessons_and_notes() == before_rows and model.calls[0]["stream"] is True

    with fake_model(lambda system, user_message: "A real answer.") as model:
        ok = client.post(f"/api/courses/{cid}/lessons/1/annotations", json=body)
    annotation = next(event for event in sse_events(ok) if event.get("done"))["annotation"]
    rows = lessons_and_notes()

    with fake_model(lambda system, user_message: "") as model:
        res = client.post(f"/api/courses/{cid}/lessons/1/annotations/{annotation['id']}/messages", json={"content": "And?"})
    assert "请稍后重试" in only_error(res)
    assert lessons_and_notes() == rows
    stored = client.get(f"/api/courses/{cid}/lessons/1/annotations").json()[0]
    assert stored["answer"] == "A real answer." and len(stored["messages"]) == 2


# ---------------------------------------------------------------------------
# max_tokens 预算
# ---------------------------------------------------------------------------

BUDGET_STEPS = {
    "chunk": ("course material analyzer", courses_module.MAX_TOKENS_CHUNK),
    "reduce": ("course material merger", courses_module.MAX_TOKENS_REDUCE),
    "synthesis": ("chief editor of course materials", courses_module.MAX_TOKENS_SYNTHESIS),
    "syllabus draft": ("course syllabus design expert", courses_module.MAX_TOKENS_SYLLABUS),
    "syllabus review": ("fact-checker for source-grounded course outlines", courses_module.MAX_TOKENS_SYLLABUS),
    "syllabus repair": ("format fixer for source-grounded course outlines", courses_module.MAX_TOKENS_SYLLABUS),
    "lesson draft": ("write the first lesson (01)", courses_module.MAX_TOKENS_LESSON),
    "lesson review": ("fact and teaching-quality reviewer", courses_module.MAX_TOKENS_LESSON),
    "lesson repair": ("format fixer for source-grounded first lessons", courses_module.MAX_TOKENS_LESSON),
}


def budgets_sent(client, base):
    _, _, model = post_materials(client, base, first=True)
    sent = {}
    for step, (marker, _) in BUDGET_STEPS.items():
        # 预算字段名按模型名定（_token_limit_key）：测试模型 test-model 不是 GPT / o 系列，用 max_tokens
        key = courses_module._token_limit_key(courses_module.settings.LLM_MODEL)
        assert key == "max_tokens"
        values = {call["kwargs"].get(key) for call in model.calls if marker in call["system"]}
        if values:
            sent[step] = values
    return sent


def test_every_material_step_sends_its_budget(client):
    sent = {**budgets_sent(client, merge_briefly), **budgets_sent(client, needs_syllabus_repair),
            **budgets_sent(client, needs_lesson_repair)}

    assert set(sent) == set(BUDGET_STEPS)
    for step, (_, expected) in BUDGET_STEPS.items():
        assert sent[step] == {expected}, step


def test_the_budgets_hold_the_longest_output_each_prompt_allows():
    """预算 ≥ 提示词允许的最长输出：中文按 1.5 token / 字、英文按 1.4 token / 词，再留余量；上限不超过 8192（qwen-plus 等拒绝更大的值）。"""
    zh, en = courses_module.PROMPTS["zh"], courses_module.PROMPTS["en"]

    def zh_chars(prompt):
        return int(re.search(r"(\d+) 中文字", prompt).group(1))

    def en_words(prompt):
        return int(re.search(r"(\d+) words", prompt).group(1))

    floors = {
        "chunk": (zh_chars(zh.material_chunk), en_words(en.material_chunk), courses_module.MAX_TOKENS_CHUNK),
        "reduce": (zh_chars(zh.material_reduce), en_words(en.material_reduce), courses_module.MAX_TOKENS_REDUCE),
        "synthesis": (zh_chars(zh.material_synthesis), en_words(en.material_synthesis), courses_module.MAX_TOKENS_SYNTHESIS),
    }
    for step, (chars, words, budget) in floors.items():
        assert budget >= chars * 1.5, step
        assert budget >= words * 1.4, step
    assert re.search(r"1200 中文字", zh.material_chunk) and "800 words" in en.material_chunk

    budgets = [courses_module.MAX_TOKENS_CHUNK, courses_module.MAX_TOKENS_REDUCE, courses_module.MAX_TOKENS_SYNTHESIS,
               courses_module.MAX_TOKENS_SYLLABUS, courses_module.MAX_TOKENS_LESSON]
    assert all(0 < budget <= 8192 for budget in budgets)
    assert courses_module.MAX_TOKENS_SYLLABUS >= 3500 and courses_module.MAX_TOKENS_LESSON >= 6000
