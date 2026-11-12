"""Goal intake on a model timeout, and surrogate repair."""
import json

import httpx
from openai import APITimeoutError

from app import courses
from app.config import settings
from app.text_repair import repair_unicode


def analysis():
    return json.dumps({
        "title": "区块链入门", "summary": "能讲清一笔交易如何被确认", "assumptions": [], "questions": [],
    }, ensure_ascii=False)


def test_surrogate_pairs_become_mathematical_letters_and_lone_surrogates_are_replaced():
    paired = "定理 " + "\ud835\udc00" + " 成立"
    repaired = repair_unicode(paired)
    assert "\U0001D400" in repaired
    assert "\ud835" not in repaired
    repaired.encode("utf-8")
    lone = repair_unicode("公式 \ud835 结束")
    assert "\ufffd" in lone
    assert "\ud835" not in lone
    json.dumps(lone).encode("utf-8")


def test_pdf_math_letters_survive_extraction(monkeypatch):
    class Page:
        def extract_text(self):
            return "定理 " + "\ud835\udc00" + " 与孤立 \ud835 的符号"

    monkeypatch.setattr(courses, "_pdf_pages", lambda raw, name: [Page()])
    sections = courses._extract_pdf_sections(b"%PDF", "math.pdf")
    text = sections[0].text
    text.encode("utf-8")
    json.dumps({"material": text}).encode("utf-8")
    assert "\U0001D400" in text
    assert "\ud835" not in text


def test_clarify_timeout_continues_with_the_goal_and_logs(authed_client, monkeypatch, caplog):
    monkeypatch.setattr(settings, "LLM_MODEL", "deepseek-chat")

    def boom(*_args, **_kwargs):
        try:
            raise httpx.ConnectTimeout("connect")
        except httpx.ConnectTimeout as cause:
            raise APITimeoutError(request=httpx.Request("POST", "https://model.invalid")) from cause

    monkeypatch.setattr(courses, "_call_llm", boom)
    with caplog.at_level("ERROR"):
        response = authed_client.post("/api/courses/clarify", json={"goal": "学会给客服 Agent 做评测"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["questions"] == []
    assert "评测" in body["summary"]
    assert "clarify_model_timeout" in caplog.text
    assert "deepseek-chat" in caplog.text
    assert "ConnectTimeout" in caplog.text
