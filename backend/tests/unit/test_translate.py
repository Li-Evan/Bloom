import pytest

from app import translate
from app.config import settings
from app.courses import _token_limit_key
from app.models import PassageTranslation
from tests.conftest import seed_course
from tests.unit.test_course_language import fake_model, sse_events

CONTEXT = "The Knobs we can Turn\n\nAn agent harness has a lot of knobs: system prompts, tools, hooks/middleware."


def chinese(system, user):
    return ("可调项\n\n在这里的意思：指 agent 框架里可以调整的配置，下文列出的系统提示词、工具和中间件都是。"
            "\n\n词根拆解：knob（圆形把手）+ -s（复数）→ 可调节的把手，引申为可调控的设置项")


def body(**extra):
    return {"original_text": "Knobs", "position_start": 4, "position_end": 9, "anchor_top": 120,
            "context": CONTEXT, "title": "Improving deep agents", "target": "zh", **extra}


@pytest.fixture
def course_id(user):
    return seed_course(user.uuid)[0]


def path(course_id, lesson=1):
    return f"/api/courses/{course_id}/lessons/{lesson}/translations"


@pytest.mark.parametrize("model_name", ["fast-model", "gpt-4.1-mini"])
def test_translation_uses_context_streams_from_the_fast_model_and_is_saved(authed_client, user, course_id, monkeypatch, model_name):
    monkeypatch.setattr(settings, "LLM_MODEL", "teaching-model")
    monkeypatch.setattr(settings, "LLM_FAST_MODEL", model_name)
    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", {"thinking": {"type": "disabled"}})
    with fake_model(chinese) as model:
        res = authed_client.post(path(course_id), json=body())

    assert res.status_code == 200, res.text
    events = sse_events(res)
    assert "".join(e.get("content", "") for e in events) == chinese("", "")
    done = events[-1]
    assert done["done"] is True and done["translation"]["translation"] == chinese("", "")
    assert done["translation"]["original_text"] == "Knobs" and done["translation"]["anchor_top"] == 120
    [call] = model.calls
    assert call["stream"] and call["kwargs"]["model"] == model_name
    assert call["kwargs"]["extra_body"] == {"thinking": {"type": "disabled"}}
    key = _token_limit_key(model_name)
    assert key == ("max_completion_tokens" if model_name.startswith("gpt-") else "max_tokens")
    assert call["kwargs"][key] == translate.MAX_OUTPUT_TOKENS
    # One reply carries the translation and, after a blank line, what the passage means here; it is saved as is.
    assert "Write everything in Simplified Chinese" in call["system"]
    assert 'one short plain sentence starting with "在这里的意思：", at most 40 Chinese characters' in call["system"]
    assert "do not repeat the translation" in call["system"]
    # A word or short term also gets its roots split after one more blank line, in the same reply.
    assert 'leave one more blank line and write one line starting with "词根拆解：", at most 60 Chinese characters' in call["system"]
    assert 'for example "词根拆解：in-（不）+ cred（相信）+ -ible（能…的）→ 不能相信的"' in call["system"]
    assert "never invent a split" in call["system"]
    # The word goes with its surroundings and the title, clearly marked as the passage to translate.
    assert call["user"] == ("Title: Improving deep agents\n\nSurrounding text:\n<<<\n" + CONTEXT
                            + "\n>>>\n\nPassage to translate:\n<<<\nKnobs\n>>>")
    [saved] = authed_client.get(path(course_id)).json()
    assert saved == done["translation"]


def test_without_context_only_the_passage_is_sent(authed_client, course_id):
    with fake_model(lambda system, user: "Each step follows the steepest descent.") as model:
        res = authed_client.post(path(course_id), json=body(original_text="每一步都沿着最陡的方向下降。", context="", title="", target="en"))
    assert res.status_code == 200
    assert "Write everything in English" in model.calls[0]["system"]
    assert 'starting with "In this context:", at most 25 words' in model.calls[0]["system"]
    # A whole sentence is never split into roots
    assert "Word roots" not in model.calls[0]["system"] and "{roots}" not in model.calls[0]["system"]
    assert model.calls[0]["user"] == "每一步都沿着最陡的方向下降。"


@pytest.mark.parametrize("text, term", [
    ("Knobs", True), ("gradient descent", True), ("Singular value decomposition", True), ("state-of-the-art", True),
    ("梯度", True), ("反向传播算法", True),
    ("it memorizes the training set", False), ("梯度下降是一种优化算法", False), ("监督 Claude 恰恰需要", False),
])
def test_only_a_word_or_short_term_gets_its_roots_split(text, term):
    assert translate.is_term(text) is term


def test_a_short_term_in_english_gets_word_roots(authed_client, course_id):
    with fake_model(lambda system, user: "Gradient\n\nIn this context: the direction of steepest increase.") as model:
        res = authed_client.post(path(course_id), json=body(original_text="梯度", target="en"))
    assert res.status_code == 200
    assert 'starting with "Word roots:", at most 40 words' in model.calls[0]["system"]
    assert "Word roots: in- (not) + cre (believe) + -íble (can be) → cannot be believed" in model.calls[0]["system"]


def test_translating_the_same_selection_again_replaces_it_and_delete_removes_it(authed_client, course_id):
    with fake_model(chinese):
        authed_client.post(path(course_id), json=body())
        authed_client.post(path(course_id), json=body())
        authed_client.post(path(course_id), json=body(position_start=20, position_end=25))
    saved = authed_client.get(path(course_id)).json()
    assert [(t["position_start"], t["position_end"]) for t in saved] == [(4, 9), (20, 25)]
    assert authed_client.delete(f"{path(course_id)}/{saved[0]['id']}").status_code == 200
    assert [t["id"] for t in authed_client.get(path(course_id)).json()] == [saved[1]["id"]]
    assert authed_client.delete(f"{path(course_id)}/{saved[0]['id']}").status_code == 404


def test_someone_elses_course_is_not_found(client, other_headers, course_id):
    with fake_model(chinese) as model:
        assert client.post(path(course_id), json=body(), headers=other_headers).status_code == 404
        assert client.get(path(course_id), headers=other_headers).status_code == 404
    assert model.calls == []


def test_model_failure_is_an_error_event_and_nothing_is_saved(authed_client, user, course_id):
    def broken(system, user):
        raise RuntimeError("gateway down")

    with fake_model(broken):
        res = authed_client.post(path(course_id), json=body())
    [event] = sse_events(res)
    assert event["error"].startswith("没能翻译，请稍后重试（原因：")
    assert authed_client.get(path(course_id)).json() == []


def test_translations_go_with_their_lesson():
    # Like passage highlights, rows leave with the lesson through the foreign key.
    [fk] = PassageTranslation.__table__.c.lesson_id.foreign_keys
    assert fk.column.table.name == "lessons" and fk.ondelete == "CASCADE"


@pytest.mark.parametrize("extra", [
    {"original_text": "x" * (translate.MAX_CHARS + 1)},
    {"original_text": "  \n "},
    {"target": "fr"},
    {"context": "x" * (translate.CONTEXT_CHARS + 1)},
    {"position_start": 9, "position_end": 4},
    {"course_id": 1},
])
def test_invalid_requests_are_refused(authed_client, course_id, extra):
    assert authed_client.post(path(course_id), json=body(**extra)).status_code == 422


def test_translation_needs_a_signed_in_learner(client, course_id):
    assert client.post(path(course_id), json=body()).status_code == 401
