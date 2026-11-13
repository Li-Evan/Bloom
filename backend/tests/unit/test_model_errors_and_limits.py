"""Failures say why, and limits only block what a real provider limit requires."""
import hashlib
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS

import httpx
import pytest
from openai import BadRequestError
from sqlalchemy.exc import OperationalError

from app import courses
from app.config import settings
from app.errors import failure_reason, with_reason
from app.models import UploadSession
from tests.conftest import TestSession, bearer, create_user, seed_course

MAX_TOKENS_REJECTED = {
    "message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    "type": "invalid_request_error", "param": "max_tokens", "code": "unsupported_parameter",
}


def provider_400(body=MAX_TOKENS_REJECTED):
    response = httpx.Response(400, request=httpx.Request("POST", "https://gateway.test/v1/chat/completions"))
    return BadRequestError(f"Error code: 400 - {{'error': {body}}}", response=response, body=body)


def analysis(questions=(), **extra):
    return json.dumps({"title": "区块链", "summary": "看懂区块链播客", "assumptions": ["不讲底层细节"],
                       "questions": list(questions), **extra}, ensure_ascii=False)


QUESTION = {"question": "你最想听懂哪类话题？", "options": ["DeFi", "监管", "比特币"]}


# --- provider parameters -------------------------------------------------------------------------------------------

def output_limit_fields(**options):
    seen = {}
    def create(**kwargs):
        seen.update(kwargs)
        return NS(choices=[])
    courses._chat_completion(NS(chat=NS(completions=NS(create=create))), [], max_tokens=1500, **options)
    return {key: value for key, value in seen.items() if key in ("max_tokens", "max_completion_tokens")}


# OpenAI 的 GPT / o 系列只认 max_completion_tokens；DeepSeek、通义、Ollama 等只认 max_tokens（courses._token_limit_key）
@pytest.mark.parametrize("model,field", [
    ("gpt-4.1-mini", "max_completion_tokens"), ("gpt-4o", "max_completion_tokens"),
    ("gpt-5", "max_completion_tokens"), ("o3-mini", "max_completion_tokens"),
    ("chatgpt-4o-latest", "max_completion_tokens"), ("qwen-plus", "max_tokens"),
    ("deepseek-chat", "max_tokens"),
])
def test_every_model_receives_its_supported_output_limit(monkeypatch, model, field):
    monkeypatch.setattr(settings, "LLM_MODEL", model)
    assert output_limit_fields() == {field: 1500}
    monkeypatch.setattr(settings, "LLM_MODEL", "test-model")
    assert output_limit_fields(model=model) == {field: 1500}  # 按这一次调用的模型，不按 LLM_MODEL


@pytest.mark.parametrize("forced", ["max_tokens", "max_completion_tokens"])
def test_the_configured_parameter_name_overrides_the_guess(monkeypatch, forced):
    monkeypatch.setattr(settings, "LLM_MAX_TOKENS_PARAM", forced)
    for model in ("gpt-4.1-mini", "deepseek-chat"):
        monkeypatch.setattr(settings, "LLM_MODEL", model)
        assert output_limit_fields() == {forced: 1500}


def test_an_unknown_configured_parameter_name_falls_back_to_the_guess(monkeypatch):
    monkeypatch.setattr(settings, "LLM_MAX_TOKENS_PARAM", "max_output_tokens")
    monkeypatch.setattr(settings, "LLM_MODEL", "gpt-4.1-mini")
    assert output_limit_fields() == {"max_completion_tokens": 1500}


# --- course goal clarification -------------------------------------------------------------------------------------

def test_a_rejected_provider_request_is_reported_with_its_reason(authed_client, monkeypatch):
    def model(*args, **kwargs):
        raise provider_400()
    monkeypatch.setattr(courses, "_call_llm", model)
    response = authed_client.post("/api/courses/clarify", json={"goal": "区块链"})
    assert response.status_code == 502
    detail = response.json()["detail"]
    assert detail.startswith("没能分析学习目标，请稍后重试（原因：model provider HTTP 400:")
    assert "max_completion_tokens" in detail
    assert "服务暂时不可用" not in detail


def test_goal_analysis_keeps_usable_output_instead_of_failing(authed_client, monkeypatch):
    calls = []
    def model(*args, **kwargs):
        calls.append(kwargs)
        return analysis([QUESTION] * 3, unexpected="ignored")
    monkeypatch.setattr(courses, "_call_llm", model)
    response = authed_client.post("/api/courses/clarify", json={"goal": "区块链"})
    assert response.status_code == 200, response.text
    assert len(response.json()["questions"]) == 2
    # 输出有上限，截断就按失败处理，不拿半截 JSON 去猜
    assert len(calls) == 1 and calls[0]["max_tokens"] == 6000 and calls[0]["fail_on_length"] is True

    skipped = authed_client.post("/api/courses/clarify", json={"goal": "区块链", "skip_questions": True})
    assert skipped.status_code == 200 and skipped.json()["questions"] == []
    assert len(calls) == 2, "asking again after skip is dropped, not retried"


def test_goal_inputs_are_generous_but_bounded(authed_client, monkeypatch):
    """界面限 2000 字、摘录 3000 字；后端上限留足余量，只拦刷接口的超大请求。文件名多了截掉，不拒绝。"""
    seen = []
    monkeypatch.setattr(courses, "_call_llm", lambda system, message, **k: seen.append(message) or analysis())
    goal = "我想了解区块链" * 1000
    response = authed_client.post("/api/courses/clarify", json={"goal": goal[:4000], "reference_excerpt": "参考" * 3000,
                                                                "material_names": [f"{i}.pdf" for i in range(300)]})
    assert response.status_code == 200, response.text
    assert goal[:4000] in seen[0] and "99.pdf" in seen[0] and "100.pdf" not in seen[0]
    assert authed_client.post("/api/courses/clarify", json={"goal": goal}).status_code == 422
    assert authed_client.post("/api/courses/clarify", json={"goal": "区块链", "reference_excerpt": "参考" * 4000}).status_code == 422
    assert authed_client.post("/api/courses/clarify", json={"goal": "区块\x00链"}).status_code == 400
    assert len(seen) == 1


# --- one error vocabulary ------------------------------------------------------------------------------------------

def test_model_failure_names_the_category_and_the_reason():
    bad = courses.model_failure(provider_400())
    assert bad.status_code == 502
    assert bad.detail.startswith(courses.MODEL_FAILURE_DETAIL + "（原因：model provider HTTP 400: Unsupported parameter")

    db = courses.model_failure(OperationalError("SELECT secret FROM t WHERE x = %s", ("private",), Exception("server closed the connection")))
    assert db.status_code == 500
    # A driver message can name hosts, users and row values: the user sees the class (and sqlstate) only.
    assert db.detail == "没能保存，请稍后重试（原因：OperationalError）"

    invalid = courses.model_failure(ValueError("Generated outline has no mastery items"))
    assert invalid.detail == "模型输出没有通过检查，请稍后重试（原因：ValueError: Generated outline has no mastery items）"

    timeout = courses.model_failure(courses.MaterialTimeout())
    assert timeout.detail == courses.MATERIAL_TIMEOUT_DETAIL


def test_reasons_never_carry_configured_secrets(monkeypatch):
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-super-secret-value")
    reason = failure_reason(RuntimeError("upstream echoed Bearer sk-super-secret-value back"))
    assert "sk-super-secret-value" not in reason and "[REDACTED]" in reason
    assert with_reason("提示", RuntimeError("x")) == "提示（原因：RuntimeError: x）"


def test_stream_errors_carry_the_reason():
    text = courses._stream_error("没能生成下一篇", exc=provider_400())
    payload = json.loads(text.removeprefix("data: "))
    assert payload["error"].startswith("没能生成下一篇，请稍后重试（原因：model provider HTTP 400")
    assert json.loads(courses._stream_error("没能生成课程总结").removeprefix("data: ")) == {"error": "没能生成课程总结，请稍后重试"}


# --- uploads and inputs ------------------------------------------------------------------------------------

def test_finished_and_expired_uploads_never_block_a_new_one(client):
    user = create_user("uploads@example.com")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with TestSession() as db:
        for index in range(30):
            consumed = index % 2 == 0
            db.add(UploadSession(id=f"{index:032x}", user_uuid=user.uuid, size=40 * 1024 * 1024,
                                 manifest=json.dumps([{"name": "a.pdf", "size": 1, "consumed": consumed}]),
                                 expires_at=now + timedelta(minutes=30) if consumed else now - timedelta(minutes=1)))
        db.commit()
    data = b"hello"
    body = {"files": [{"name": "a.md", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}]}
    response = client.post("/api/uploads", headers=bearer(user), json=body)
    assert response.status_code == 200, response.text


def test_long_highlights_are_accepted(client, user, auth_headers):
    cid, _ = seed_course(user.uuid)
    url = f"/api/courses/{cid}/lessons/1/highlights"
    rects = [{"page": 1, "x": 0.1, "y": 0.0001 * i, "w": 0.2, "h": 0.0001} for i in range(300)]
    body = dict(position_start=0, position_end=2, original_text="正" * 8000,
                pdf_position=json.dumps({"page": 1, "rects": rects}))
    assert client.post(url, json=body, headers=auth_headers).status_code == 200


def test_text_containing_a_replacement_character_is_still_readable():
    assert courses._decode_text_bytes("第一段�第二段".encode()) == "第一段�第二段"
