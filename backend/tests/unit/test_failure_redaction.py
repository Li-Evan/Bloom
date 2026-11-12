"""What a user-facing failure reason may carry. All values below are fake."""

import httpx
import psycopg.errors
import pytest
from openai import APIStatusError, BadRequestError
from sqlalchemy.exc import IntegrityError, OperationalError

from app.config import settings
from app.errors import failure_reason, with_reason

DB_URL = "postgresql+psycopg://owner:Pa55w0rdXYZ@ep-quiet-db-123.us-east-2.aws.neon.tech/neondb"
GATEWAY_BODY = {"error": {
    "message": 'do request failed: Post "https://internal-relay.corp.example:8443/v1/responses": dial tcp 10.0.0.1:8443: '
               "i/o timeout (request id: 2026101812000012345)",
    "type": "upstream_error", "param": "secret-param-field"}}


@pytest.fixture(autouse=True)
def configured_secrets(monkeypatch):
    monkeypatch.setattr(settings, "DATABASE_URL", DB_URL)
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-live-abcdefghijklmnop")
    monkeypatch.setenv("STORAGE_SERVICE_TOKEN", "svc_tok_STOREID_secretsecret")


def status_error(status, body, headers=None, cls=APIStatusError):
    response = httpx.Response(status, headers=headers or {}, request=httpx.Request("POST", "https://gateway.test/v1/x"))
    return cls(f"Error code: {status} - {body}", response=response, body=body.get("error", body) if isinstance(body, dict) else body)


@pytest.mark.parametrize("exc,leaks", [
    (OperationalError("SELECT 1", {}, Exception(
        'connection to server at "ep-quiet-db-123.us-east-2.aws.neon.tech" (203.0.113.7), port 5432 failed: '
        'FATAL: password authentication failed for user "owner"')), ["neon.tech", "203.0.113.7", "owner", "password"]),
    (IntegrityError("INSERT INTO users", {}, psycopg.errors.UniqueViolation(
        'duplicate key value violates unique constraint "users_email_key"\nDETAIL:  Key (email)=(alice@example.com) already exists.')),
     ["alice@example.com", "users_email_key"]),
    (psycopg.errors.UniqueViolation("Key (email)=(bob@example.com) already exists."), ["bob@example.com"]),
])
def test_database_errors_give_only_the_class_and_sqlstate(exc, leaks):
    reason = failure_reason(exc)
    assert reason.split(" ")[0] in ("OperationalError", "IntegrityError", "UniqueViolation")
    for leak in leaks:
        assert leak not in reason
    if not isinstance(exc, OperationalError):
        assert "sqlstate 23505" in reason


@pytest.mark.parametrize("text,leaks,marker", [
    ("bad dsn postgresql://owner:Pa55w0rdXYZ@ep-quiet-db-123.us-east-2.aws.neon.tech/neondb",
     ["Pa55w0rdXYZ", "neon.tech", "owner:"], "[DATABASE_URL]"),
    ("auth failed with Pa55w0rdXYZ", ["Pa55w0rdXYZ"], "[REDACTED]"),
    ("storage error token=svc_tok_STOREID_secretsecret", ["svc_tok_STOREID_secretsecret"], "[REDACTED]"),
    ("401 for Authorization: Bearer abc.def-unconfigured-token", ["abc.def-unconfigured-token"], "Bearer [REDACTED]"),
    ("cookie session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl", ["eyJhbGciOiJIUzI1NiJ9"], "[JWT]"),
    ("x-api-key: sk-other-provider-key-1234567890", ["sk-other-provider-key"], "[KEY]"),
    ("keys sk_abcdef123456 and rk_abcdef123456", ["sk_abcdef", "rk_abcdef"], "[KEY]"),
    ("echo sk-live-abcdefghijklmnop", ["sk-live-abcdefghijklmnop"], "[REDACTED]"),
    ("proxy at http://admin:hunter22@proxy.internal:3128 refused", ["hunter22", "admin:"], "[URL]"),
    ("relay admin:hunter22@relay.internal refused", ["hunter22"], "[CREDENTIALS]@"),
    ("dial tcp 10.0.0.1:8443: i/o timeout", ["10.0.0.1"], "[IP]"),
    ("user alice@example.com already exists", ["alice@example.com"], "[EMAIL]"),
    ("host ep-quiet-db-123.us-east-2.aws.neon.tech unreachable", ["ep-quiet-db-123"], "[HOST]"),
])
def test_regex_redaction_covers_each_leak_type(text, leaks, marker):
    reason = failure_reason(RuntimeError(text))
    assert reason.startswith("RuntimeError: ")
    for leak in leaks:
        assert leak not in reason, reason
    assert marker in reason


def test_provider_errors_keep_status_request_id_and_only_the_redacted_message_field():
    exc = status_error(400, GATEWAY_BODY, {"x-request-id": "req_abc123"}, BadRequestError)
    reason = failure_reason(exc)
    assert reason.startswith("model provider HTTP 400: do request failed")
    assert reason.endswith("(request id: req_abc123)")
    for leak in ["10.0.0.1", "internal-relay", "upstream_error", "secret-param-field"]:
        assert leak not in reason
    assert "i/o timeout" in reason


def test_a_provider_error_page_without_a_message_field_shows_only_the_status():
    exc = status_error(502, "<html>upstream 10.0.0.8 nginx</html>", {"x-oneapi-request-id": "2026101900001"})
    assert failure_reason(exc) == "model provider HTTP 502 (request id: 2026101900001)"


def test_the_reason_keeps_its_frame_and_length_bound():
    assert with_reason("提示", RuntimeError("x")) == "提示（原因：RuntimeError: x）"
    assert len(failure_reason(RuntimeError("字" * 5000))) == 400
