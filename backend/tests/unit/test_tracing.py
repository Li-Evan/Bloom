"""Langfuse tracing helpers stay out of the way when tracing is not configured."""

from app import tracing
from app.config import settings


def test_tracing_is_a_noop_without_credentials(monkeypatch):
    monkeypatch.setattr(settings, "LANGFUSE_TRACING_ENABLED", False)
    monkeypatch.setattr(settings, "LANGFUSE_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "LANGFUSE_SECRET_KEY", "")

    assert tracing.enabled() is False
    assert tracing._get_client() is None

    with tracing.trace("test-trace", user_id="user", session_id="session", input={"q": "hi"}) as root:
        root.update(output={"a": "ok"})
        root.score_trace("quality", 1.0)
        with tracing.generation("test-generation", model="test-model", input=[{"role": "user", "content": "hi"}]) as gen:
            gen.update(output="hello", usage_details={"input": 1, "output": 1})
        with tracing.span("test-step") as step:
            step.update(output="done")


def test_llm_name_uses_a_context_variable():
    assert tracing.current_llm_name("fallback") == "fallback"
    with tracing.llm_name("generate-lesson"):
        assert tracing.current_llm_name("fallback") == "generate-lesson"
    assert tracing.current_llm_name("fallback") == "fallback"


def test_usage_details_turn_inclusive_cached_tokens_into_exclusive_buckets():
    details = tracing._usage_details({
        "prompt_tokens": 100,
        "completion_tokens": 20,
        "prompt_tokens_details": {"cached_tokens": 40},
    })

    assert details == {"input": 60, "output": 20, "input_cached_tokens": 40, "total": 120}


def test_usage_details_accept_an_sdk_usage_object():
    class Usage:
        def model_dump(self):
            return {"prompt_tokens": 7, "completion_tokens": 3}

    assert tracing._usage_details(Usage()) == {"input": 7, "output": 3, "total": 10}


def test_usage_details_skips_missing_or_invalid_counters():
    assert tracing._usage_details(None) is None
    assert tracing._usage_details({}) is None
    assert tracing._usage_details({"prompt_tokens": "many"}) is None


def test_masking_redacts_emails_keys_bearer_tokens_and_phone_numbers():
    text = "mail alice@example.com key sk-lf-abcdef123456 bearer Bearer abc.def-123 phone 13800138000"
    masked = tracing._redact_text(text)

    assert "alice@example.com" not in masked
    assert "sk-lf-abcdef123456" not in masked
    assert "Bearer abc.def-123" not in masked
    assert "13800138000" not in masked
    assert "[redacted-email]" in masked and "[redacted-key]" in masked


def test_chat_messages_become_role_labelled_text():
    messages = [{"role": "system", "content": "You teach."}, {"role": "user", "content": "什么是复利"}]

    assert tracing._payload(messages) == "[system]\nYou teach.\n\n[user]\n什么是复利"
    assert tracing._payload(messages[1:]) == "什么是复利"


def test_responses_api_items_become_text():
    items = [
        {"role": "user", "content": [{"type": "input_text", "text": "Write"}, {"type": "input_text", "text": "a lesson"}]},
        {"type": "reasoning", "summary": [], "encrypted_content": "opaque"},
        {"type": "function_call", "name": "search", "arguments": '{"q": "bonds"}', "call_id": "c1"},
        {"type": "function_call_output", "call_id": "c1", "output": "found"},
    ]

    assert tracing._payload(items) == (
        "[user]\nWrite\n\na lesson\n\n"
        '[function_call search]\n{"q": "bonds"}\n\n'
        "[function_call_output]\nfound"
    )


def test_structured_payloads_become_lines_instead_of_json():
    payload = {"title": "复利", "missing": None, "assumptions": ["零基础"], "questions": [{"text": "目标？"}], "done": False}

    assert tracing._payload(payload) == (
        "title: 复利\nassumptions:\n  - 零基础\nquestions:\n  -\n    text: 目标？\ndone: False"
    )
    assert tracing._payload({"chunks": 1, "source_chars": 68}) == "chunks: 1\nsource_chars: 68"
    assert tracing._payload("纯文本") == "纯文本"
    assert tracing._payload(None) is None


def test_long_system_prompt_does_not_clip_away_the_user_message():
    text = tracing._payload([
        {"role": "system", "content": "x" * (tracing.MAX_STRING_CHARS + 5)},
        {"role": "user", "content": "the question"},
    ])

    assert "… [truncated 5 chars]" in text
    assert text.endswith("[user]\nthe question")


def test_observations_send_plain_text_input_and_output(monkeypatch):
    sent = []

    class FakeRaw:
        def update(self, **kwargs):
            sent.append(kwargs)

    class FakeManager:
        def __enter__(self):
            return FakeRaw()

        def __exit__(self, *_exc):
            return False

    class FakeClient:
        def start_as_current_observation(self, **kwargs):
            sent.append(kwargs)
            return FakeManager()

    monkeypatch.setattr(tracing, "_get_client", lambda: FakeClient())

    with tracing.generation("step", model="m", input=[{"role": "user", "content": "hi"}]) as gen:
        gen.update(output={"n": 1}, metadata={"keep": {"a": 1}})

    assert sent[0]["input"] == "hi"
    assert sent[1] == {"output": "n: 1", "metadata": {"keep": {"a": 1}}}


def test_clip_bounds_long_strings_and_collections():
    assert tracing._clip("x" * (tracing.MAX_STRING_CHARS + 5)).endswith("… [truncated 5 chars]")
    assert len(tracing._clip(list(range(tracing.MAX_COLLECTION_ITEMS + 10)))) == tracing.MAX_COLLECTION_ITEMS
    assert tracing._clip({"n": 1, "ok": True}) == {"n": 1, "ok": True}
