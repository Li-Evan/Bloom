import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.courses as courses_module
from app.config import settings
from app.main import app as fastapi_app
from tests.unit.helpers import content_rows, materials_llm, small_material_chunks  # noqa: F401

FILES = [("files", (f"part{i}.md", f"# 章节 {i}\n\n{'x' * 440}".encode(), "text/markdown")) for i in range(3)]
# 建课请求里的全部模型调用：3 个分块提炼 + 综合 + 大纲草稿 + 大纲校对。首篇的草稿与审校在确认大纲后的 POST /first 里，
# 不属于资料处理的总时限。
ALL_CALLS = 6


@pytest.fixture
def client(user, auth_headers):
    return TestClient(fastapi_app, headers=auth_headers, raise_server_exceptions=False)


def create(client, fake):
    with patch("app.courses._call_llm", fake):
        return client.post("/api/courses/from-materials", data={"name": "资料课"}, files=FILES)


def recording_llm(delay=0.0):
    calls = []

    def fake(system_prompt, user_message, **kwargs):
        calls.append(kwargs.get("timeout"))
        time.sleep(delay)
        return materials_llm(system_prompt, user_message)

    fake.calls = calls
    return fake


def test_a_pipeline_that_outlives_its_deadline_saves_nothing_and_answers_504(user, client, monkeypatch):
    monkeypatch.setattr(settings, "MATERIAL_TOTAL_TIMEOUT_SECONDS", 0.5)
    before, fake = content_rows(), recording_llm(delay=0.3)

    res = create(client, fake)

    assert res.status_code == 504
    assert res.json() == {"detail": courses_module.MATERIAL_TIMEOUT_DETAIL}
    for phrase in ("资料", "过长", "减少文件数量"):
        assert phrase in courses_module.MATERIAL_TIMEOUT_DETAIL
    assert content_rows() == before
    assert 0 < len(fake.calls) < ALL_CALLS


def test_a_deadline_already_passed_stops_the_worker_threads_before_any_model_call(user, client, monkeypatch):
    monkeypatch.setattr(settings, "MATERIAL_TOTAL_TIMEOUT_SECONDS", -1)
    before, fake = content_rows(), recording_llm()

    res = create(client, fake)

    assert res.status_code == 504 and res.json()["detail"] == courses_module.MATERIAL_TIMEOUT_DETAIL
    assert fake.calls == []
    assert content_rows() == before


def test_every_model_call_of_the_pipeline_is_capped_to_the_time_remaining(client, monkeypatch):
    monkeypatch.setattr(settings, "MATERIAL_TOTAL_TIMEOUT_SECONDS", 60)
    fake = recording_llm()

    res = create(client, fake)

    assert res.status_code == 200
    assert len(fake.calls) == ALL_CALLS
    assert all(timeout is not None and 0 < timeout <= 60 for timeout in fake.calls)


def test_a_call_timeout_is_the_smaller_of_the_remaining_time_and_the_configured_one(monkeypatch):
    monkeypatch.setattr(settings, "LLM_REQUEST_TIMEOUT_SECONDS", 300)

    assert courses_module.get_openai_client(timeout_cap=5).timeout.read == 5
    assert courses_module.get_openai_client(timeout_cap=999).timeout.read == 300
    assert courses_module.get_openai_client().timeout.read == 300
