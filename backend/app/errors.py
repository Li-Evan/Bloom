"""Say why something failed. A fixed message tells the user what to do; the reason after it says what actually broke.

The reason is shown to the user verbatim, so it carries only the error category, HTTP status, upstream request id and the
upstream's short `message` field, after regex redaction. Full provider bodies and driver messages go to server logs only.
"""
import os
import re
from urllib.parse import urlsplit

REASON_MARK = "（原因："
_SECRET_NAMES = ("KEY", "SECRET", "TOKEN", "PASSWORD", "DATABASE_URL")
_REQUEST_ID_HEADERS = ("x-request-id", "x-oneapi-request-id", "request-id")
_PATTERNS = [
    (re.compile(r"(?i)\b(?:postgres(?:ql)?|mysql|redis|mongodb)(?:\+\w+)?://\S+"), "[DATABASE_URL]"),
    (re.compile(r"(?i)\bhttps?://[^\s\"'<>]+"), "[URL]"),
    (re.compile(r"(?i)\bbearer\s+\S+"), "Bearer [REDACTED]"),
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]*"), "[JWT]"),
    (re.compile(r"\b(?:sk|rk)[-_][\w-]{6,}"), "[KEY]"),
    (re.compile(r"[^\s/@:\"'()]+:[^\s/@\"'()]+@"), "[CREDENTIALS]@"),
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "[EMAIL]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[IP]"),
    (re.compile(r"\b[\w.-]+\.neon\.tech\b"), "[HOST]"),
]


def _configured_secrets() -> set[str]:
    from app.config import settings

    values = {getattr(settings, name, None) for name in dir(settings) if any(part in name for part in _SECRET_NAMES)}
    values |= {value for name, value in os.environ.items() if any(part in name for part in _SECRET_NAMES)}
    for url in (settings.DATABASE_URL, os.environ.get("DATABASE_URL", "")):
        try:
            values.add(urlsplit(url).password)
        except ValueError:
            pass
    return {value for value in values if isinstance(value, str) and len(value) >= 8}


def redact(text: str) -> str:
    for value in sorted(_configured_secrets(), key=len, reverse=True):
        text = text.replace(value, "[REDACTED]")
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def request_id(headers) -> str | None:
    for name in _REQUEST_ID_HEADERS:
        value = headers.get(name) if headers is not None else None
        if value and re.fullmatch(r"[\w.:-]{1,80}", value):
            return value
    return None


def provider_reason(status: int, message: str | None = None, request: str | None = None) -> str:
    reason = f"model provider HTTP {status}"
    if message:
        reason += ": " + " ".join(message.split())[:300]
    if request:
        reason += f" (request id: {request})"
    return reason


def provider_message(body) -> str | None:
    """The upstream's own short `message` field ({"error": {"message": ...}} or {"message": ...}); never the whole body."""
    error = body.get("error", body) if isinstance(body, dict) else None
    message = error.get("message") if isinstance(error, dict) else None
    return message if isinstance(message, str) and message.strip() else None


def _database_error(exc: BaseException) -> str | None:
    from sqlalchemy.exc import SQLAlchemyError

    if not isinstance(exc, SQLAlchemyError) and not type(exc).__module__.startswith("psycopg"):
        return None
    # A driver message names hosts, users and constraint values (e.g. an email in a unique-key DETAIL): class and sqlstate only.
    source = getattr(exc, "orig", None) or exc
    state = getattr(source, "sqlstate", None) or getattr(source, "pgcode", None)
    return f"{type(exc).__name__} (sqlstate {state})" if state else type(exc).__name__


def failure_reason(exc: BaseException) -> str:
    from openai import APIConnectionError, APIStatusError, APITimeoutError

    if isinstance(exc, APIStatusError):
        reason = provider_reason(exc.status_code, provider_message(exc.body), request_id(exc.response.headers))
    elif isinstance(exc, APITimeoutError):
        reason = f"model provider did not answer in time ({exc.__cause__ or exc})"
    elif isinstance(exc, APIConnectionError):
        reason = f"cannot connect to model provider ({exc.__cause__ or exc})"
    elif (database := _database_error(exc)) is not None:
        reason = database
    else:
        text = " ".join(str(exc).split())
        reason = f"{type(exc).__name__}: {text}" if text else type(exc).__name__
    return redact(reason[:4000])[:400]


def with_reason(message: str, exc: BaseException) -> str:
    return f"{message}{REASON_MARK}{failure_reason(exc)}）"


def with_detail(message: str, reason: str) -> str:
    """固定提示 + 已知的具体原因（不是异常），格式和 with_reason 一样，前端照常翻译固定提示、原样附上原因。"""
    return f"{message}{REASON_MARK}{reason}）"
