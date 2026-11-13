import asyncio
import contextlib
from unittest.mock import MagicMock, patch

import anyio.to_thread
import httpx
import pytest

import app.courses as courses_module
from app.config import settings
from app.main import app as fastapi_app


def test_defaults_keep_the_stream_timeout_below_the_frontends_idle_timeout():
    assert (settings.LLM_REQUEST_TIMEOUT_SECONDS, settings.LLM_STREAM_READ_TIMEOUT_SECONDS) == (300, 90)
    assert settings.LLM_STREAM_READ_TIMEOUT_SECONDS < 120
    assert settings.LLM_MAX_RETRIES == 1


def test_plain_calls_use_the_request_timeout_and_the_configured_retries(monkeypatch):
    monkeypatch.setattr(settings, "LLM_REQUEST_TIMEOUT_SECONDS", 123)
    monkeypatch.setattr(settings, "LLM_MAX_RETRIES", 2)

    client = courses_module.get_openai_client()

    assert client.timeout.read == 123
    assert client.max_retries == 2


def test_streaming_calls_use_the_stream_read_timeout_and_never_retry(monkeypatch):
    monkeypatch.setattr(settings, "LLM_STREAM_READ_TIMEOUT_SECONDS", 45)
    monkeypatch.setattr(settings, "LLM_MAX_RETRIES", 2)

    client = courses_module.get_openai_client(stream=True)

    assert client.timeout.read == 45
    assert client.max_retries == 0


@pytest.mark.parametrize("call,expected_stream", [
    (lambda: list(courses_module._stream_llm("系统", "用户")), True),
    (lambda: list(courses_module._stream_llm_messages("系统", [{"role": "user", "content": "问"}])), True),
    (lambda: courses_module._call_llm("系统", "用户"), False),
])
def test_each_helper_asks_for_the_matching_client(call, expected_stream):
    with patch("app.courses.get_openai_client") as get_client:
        get_client.return_value.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content="ok"))],
            __iter__=lambda self: iter([]),
        )
        call()

    get_client.assert_called_once_with(stream=True) if expected_stream else get_client.assert_called_once_with(timeout_cap=None)


def test_health_answers_even_when_every_worker_thread_is_busy():
    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        borrowers = [object() for _ in range(int(limiter.total_tokens))]
        for borrower in borrowers:
            await limiter.acquire_on_behalf_of(borrower)
        try:
            transport = httpx.ASGITransport(app=fastapi_app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
                return await asyncio.wait_for(http.get("/api/health"), timeout=2)
        finally:
            for borrower in borrowers:
                limiter.release_on_behalf_of(borrower)

    with contextlib.suppress(asyncio.TimeoutError):
        assert asyncio.run(scenario()).json() == {"status": "ok"}
        return
    pytest.fail("/api/health waited for a worker thread")
