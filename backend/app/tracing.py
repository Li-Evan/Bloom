"""Langfuse tracing for Bloom's model calls.

Tracing is optional: without both Langfuse keys (or with ``LANGFUSE_TRACING_ENABLED=false``)
every helper in this module is a no-op. That keeps tests and local development free of
network traffic, and means a Langfuse outage can never fail a course or a lesson.

The module follows Langfuse's tracing guidance:

* one trace per user-visible operation (create a course, generate a lesson, answer a
  highlight question, ...), with ``user_id`` and a course-scoped ``session_id``;
* one ``generation`` observation per model call, with the model name, the messages'
  text, output and token usage (Langfuse infers the cost from its own model table);
* input and output are plain text, so Langfuse's tables show the content instead of a
  JSON blob; supporting fields belong in metadata;
* inputs and outputs are clipped before they leave the process, and a masking hook
  redacts e-mail addresses, phone numbers and API keys from every exported string;
* with LANGFUSE_FLUSH_ON_EXIT=true (short-lived processes) spans flush at the end of the outermost trace.
"""

from __future__ import annotations

import contextvars
import logging
import os
import re
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

from app.config import settings

logger = logging.getLogger(__name__)

# Long prompts (uploaded material, a whole lesson) are useful in traces, but a single
# observation should not carry an unbounded payload. Every string is clipped here.
MAX_STRING_CHARS = 20_000
MAX_COLLECTION_ITEMS = 200
MAX_DEPTH = 8

_client = None
_client_lock = threading.Lock()
_client_failed = False

# Only the outermost trace flushes. The value is a context variable so worker threads
# that inherited the request context do not double-flush.
_trace_depth = contextvars.ContextVar("bloom_langfuse_trace_depth", default=0)
# The name of the model call currently being made. Keeping it in a context variable lets
# call sites label a step without changing the signature of helpers that tests replace
# with small fakes.
_llm_label = contextvars.ContextVar("bloom_langfuse_llm_label", default=None)


@contextmanager
def llm_name(name: str) -> Iterator[None]:
    """Label the model calls made in this block (``generate-next-lesson``, ...)."""
    token = _llm_label.set(name)
    try:
        yield
    finally:
        _llm_label.reset(token)


def current_llm_name(default: str) -> str:
    return _llm_label.get() or default


class _NullObservation:
    """No-op stand-in used whenever tracing is disabled."""

    def update(self, *_args: Any, **_kwargs: Any) -> "_NullObservation":
        return self

    def end(self, *_args: Any, **_kwargs: Any) -> "_NullObservation":
        return self

    def score(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def score_trace(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def start_observation(self, *_args: Any, **_kwargs: Any) -> "_NullObservation":
        return self


_NOOP = _NullObservation()


@dataclass
class Observation:
    """Small wrapper so callers never need to know whether Langfuse is enabled."""

    _observation: Any

    def update(self, **kwargs: Any) -> "Observation":
        cleaned = {
            key: _payload(value) if key in ("input", "output") else _clip(value)
            for key, value in kwargs.items() if value is not None
        }
        if cleaned:
            try:
                self._observation.update(**cleaned)
            except Exception:  # tracing must never break the operation being traced
                logger.debug("Langfuse observation update failed", exc_info=True)
        return self

    def end(self, **kwargs: Any) -> None:
        try:
            if kwargs:
                self.update(**kwargs)
            self._observation.end()
        except Exception:
            logger.debug("Langfuse observation end failed", exc_info=True)

    def score_trace(self, name: str, value: float, **kwargs: Any) -> None:
        try:
            self._observation.score_trace(name=name, value=value, **kwargs)
        except Exception:
            logger.debug("Langfuse score failed", exc_info=True)


def enabled() -> bool:
    """True only when tracing was explicitly configured with a usable key pair."""
    return bool(
        settings.LANGFUSE_TRACING_ENABLED
        and settings.LANGFUSE_PUBLIC_KEY
        and settings.LANGFUSE_SECRET_KEY
    )


def _environment() -> str:
    configured = (settings.LANGFUSE_TRACING_ENVIRONMENT or "").strip()
    if configured:
        return configured
    return "development"


def _release() -> str | None:
    for key in ("GIT_COMMIT_SHA", "SOURCE_VERSION"):
        value = (os.getenv(key) or "").strip()
        if value:
            return value[:200]
    return None


def _get_client():
    """Create the Langfuse client lazily, after .env has been loaded.

    Importing Langfuse at module import time is intentionally avoided: the SDK reads
    credentials during construction and starts exporter threads, and tests import this
    module in every process.
    """
    global _client, _client_failed
    if not enabled() or _client_failed:
        return None
    if _client is not None:
        return _client
    with _client_lock:
        if _client is not None:
            return _client
        if _client_failed:
            return None
        try:
            from langfuse import Langfuse

            _client = Langfuse(
                public_key=settings.LANGFUSE_PUBLIC_KEY,
                secret_key=settings.LANGFUSE_SECRET_KEY,
                base_url=settings.LANGFUSE_BASE_URL,
                environment=_environment(),
                release=_release(),
                timeout=settings.LANGFUSE_TIMEOUT_SECONDS,
                tracing_enabled=True,
                sample_rate=settings.LANGFUSE_SAMPLE_RATE,
                flush_at=settings.LANGFUSE_FLUSH_AT,
                flush_interval=settings.LANGFUSE_FLUSH_INTERVAL_SECONDS,
                mask_otel_spans=_mask_otel_spans,
            )
            logger.info(
                "Langfuse tracing enabled environment=%s base_url=%s",
                _environment(), settings.LANGFUSE_BASE_URL,
            )
            return _client
        except Exception:
            _client_failed = True
            logger.exception("Langfuse tracing disabled: client initialization failed")
            return None


def flush() -> None:
    client = _client
    if client is None:
        return
    try:
        client.flush()
    except Exception:
        logger.debug("Langfuse flush failed", exc_info=True)


def shutdown() -> None:
    """Flush and stop exporter threads (called from the FastAPI lifespan)."""
    global _client
    with _client_lock:
        client, _client = _client, None
    if client is not None:
        try:
            client.shutdown()
        except Exception:
            logger.debug("Langfuse shutdown failed", exc_info=True)


def _should_flush_on_exit() -> bool:
    return bool(settings.LANGFUSE_FLUSH_ON_EXIT)


def _begin_observation(client, **kwargs):
    """Enter Langfuse's span context, falling back to no tracing if it misbehaves."""
    try:
        manager = client.start_as_current_observation(**kwargs)
        observation = manager.__enter__()
        return manager, observation
    except Exception:
        logger.exception("Langfuse observation start failed; continuing without it")
        return None, None


def _finish_observation(manager) -> None:
    if manager is None:
        return
    try:
        manager.__exit__(None, None, None)
    except Exception:
        logger.debug("Langfuse observation end failed", exc_info=True)


# ---------------------------------------------------------------------------
# Observations
# ---------------------------------------------------------------------------

@contextmanager
def trace(
    name: str,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    input: Any = None,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    version: str | None = None,
) -> Iterator[Observation]:
    """Start one trace for a self-contained user-visible operation.

    The yielded observation is the trace root: update its output with the final
    artifact so Langfuse can show and evaluate it. All generations created inside
    the block (including in threads that copied this context) become children.
    """
    client = _get_client()
    if client is None:
        yield _NOOP
        return

    from langfuse import propagate_attributes

    propagated = _propagated_metadata(metadata)
    manager, span = _begin_observation(
        client,
        as_type="span",
        name=name,
        input=_payload(input),
        metadata=_clip(metadata),
    )
    if span is None:
        yield _NOOP
        return

    depth_token = _trace_depth.set(_trace_depth.get() + 1)
    propagation = None
    try:
        try:
            propagation = propagate_attributes(
                user_id=str(user_id)[:200] if user_id else None,
                session_id=str(session_id)[:200] if session_id else None,
                metadata=propagated,
                tags=tags,
                version=version,
                trace_name=name,
                environment=_environment(),
            )
            propagation.__enter__()
        except Exception:
            logger.exception("Langfuse attribute propagation failed; continuing without it")
            propagation = None

        try:
            yield Observation(span)
        except BaseException as exc:
            _mark_error(span, exc)
            raise
    finally:
        if propagation is not None:
            try:
                propagation.__exit__(None, None, None)
            except Exception:
                logger.debug("Langfuse attribute propagation exit failed", exc_info=True)
        _trace_depth.reset(depth_token)
        _finish_observation(manager)
        if _trace_depth.get() == 0 and _should_flush_on_exit():
            flush()


@contextmanager
def span(
    name: str,
    *,
    input: Any = None,
    metadata: dict[str, Any] | None = None,
    as_type: str = "span",
) -> Iterator[Observation]:
    """Nest a non-model step (for example the material ingestion pipeline)."""
    client = _get_client()
    if client is None:
        yield _NOOP
        return
    manager, observation = _begin_observation(
        client,
        as_type=as_type,
        name=name,
        input=_payload(input),
        metadata=_clip(metadata),
    )
    if observation is None:
        yield _NOOP
        return
    try:
        yield Observation(observation)
    except BaseException as exc:
        _mark_error(observation, exc)
        raise
    finally:
        _finish_observation(manager)


@contextmanager
def generation(
    name: str,
    *,
    model: str,
    input: Any = None,
    metadata: dict[str, Any] | None = None,
    model_parameters: dict[str, Any] | None = None,
) -> Iterator[Observation]:
    """One model invocation, with the text of the chat messages as input."""
    client = _get_client()
    if client is None:
        yield _NOOP
        return
    manager, observation = _begin_observation(
        client,
        as_type="generation",
        name=name,
        model=model,
        input=_payload(input),
        metadata=_clip(metadata),
        model_parameters=_clean_model_parameters(model_parameters),
    )
    if observation is None:
        yield _NOOP
        return
    try:
        yield Observation(observation)
    except BaseException as exc:
        _mark_error(observation, exc)
        raise
    finally:
        _finish_observation(manager)


# ---------------------------------------------------------------------------
# Model call wrappers
# ---------------------------------------------------------------------------

def traced_call(
    name: str,
    *,
    model: str,
    messages: list[dict],
    stream: bool,
    call,
    metadata: dict[str, Any] | None = None,
    model_parameters: dict[str, Any] | None = None,
):
    """Run a chat completion inside a generation observation.

    ``call`` is a zero-argument callable returning either a response or an iterator of
    chunks. The return value/iterator is passed through unchanged so metering and
    retry behaviour stay exactly as they were.
    """
    if _get_client() is None:
        return call()
    if stream:
        return _traced_stream(
            name, model=model, messages=messages, call=call,
            metadata=metadata, model_parameters=model_parameters,
        )
    with generation(
        name, model=model, input=messages, metadata=metadata, model_parameters=model_parameters,
    ) as observation:
        response = call()
        _record_response(observation, response, model)
        return response


def _traced_stream(
    name: str,
    *,
    model: str,
    messages: list[dict],
    call,
    metadata: dict[str, Any] | None = None,
    model_parameters: dict[str, Any] | None = None,
):
    with generation(
        name, model=model, input=messages, metadata=metadata, model_parameters=model_parameters,
    ) as observation:
        text: list[str] = []
        reasoning: list[str] = []
        usage = None
        finish_reason = None
        response_id = None
        try:
            for chunk in call():
                if getattr(chunk, "usage", None) is not None:
                    usage = chunk.usage
                chunk_id = getattr(chunk, "id", None)
                if isinstance(chunk_id, str):
                    response_id = chunk_id
                choices = getattr(chunk, "choices", None) or []
                if choices:
                    choice = choices[0]
                    finish_reason = getattr(choice, "finish_reason", None) or finish_reason
                    delta = getattr(choice, "delta", None)
                    content = getattr(delta, "content", None) if delta is not None else None
                    if isinstance(content, str) and content:
                        text.append(content)
                    reasoning_text = _delta_reasoning(delta)
                    if reasoning_text:
                        reasoning.append(reasoning_text)
                yield chunk
        finally:
            update: dict[str, Any] = {
                "output": "".join(text) or None,
                "usage_details": _usage_details(usage),
            }
            stream_metadata = {key: value for key, value in {
                "response_id": response_id if isinstance(response_id, str) else None,
                "finish_reason": finish_reason if isinstance(finish_reason, str) else None,
            }.items() if value is not None}
            if reasoning:
                stream_metadata["reasoning"] = "".join(reasoning)
            if stream_metadata:
                update["metadata"] = stream_metadata
            observation.update(**update)


# ---------------------------------------------------------------------------
# Response/usage helpers
# ---------------------------------------------------------------------------

def _delta_reasoning(delta: Any) -> str | None:
    if delta is None:
        return None
    for attribute in ("reasoning_content", "reasoning"):
        value = getattr(delta, attribute, None)
        if isinstance(value, str) and value:
            return value
    return None


def _response_text(response: Any) -> str | None:
    choices = getattr(response, "choices", None) or []
    if not choices:
        return None
    message = getattr(choices[0], "message", None)
    content = getattr(message, "content", None) if message is not None else None
    return content if isinstance(content, str) else None


def _record_response(observation: Observation, response: Any, model: str) -> None:
    update: dict[str, Any] = {"output": _response_text(response)}
    usage = getattr(response, "usage", None)
    update["usage_details"] = _usage_details(usage)
    response_id = getattr(response, "id", None)
    metadata = {key: value for key, value in {
        "response_id": response_id if isinstance(response_id, str) else None,
        "finish_reason": _finish_reason(response),
    }.items() if value is not None}
    reasoning = _response_reasoning(response)
    if reasoning:
        metadata["reasoning"] = reasoning
    if metadata:
        update["metadata"] = metadata
    observation.update(**update)


def _finish_reason(response: Any) -> str | None:
    choices = getattr(response, "choices", None) or []
    if not choices:
        return None
    value = getattr(choices[0], "finish_reason", None)
    return value if isinstance(value, str) else None


def _response_reasoning(response: Any) -> str | None:
    choices = getattr(response, "choices", None) or []
    if not choices:
        return None
    message = getattr(choices[0], "message", None)
    if message is None:
        return None
    for attribute in ("reasoning_content", "reasoning"):
        value = getattr(message, attribute, None)
        if isinstance(value, str) and value:
            return value
    return None


def _usage_dict(usage: Any) -> dict | None:
    if usage is None:
        return None
    if isinstance(usage, dict):
        return usage
    model_dump = getattr(usage, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump()
            if isinstance(dumped, dict):
                return dumped
        except Exception:
            pass
    return None


def _as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and value >= 0 else None


def _usage_details(usage: Any) -> dict[str, int] | None:
    """Map OpenAI's inclusive counters (chat or Responses API) to Langfuse's exclusive buckets."""
    raw = _usage_dict(usage)
    if not raw:
        return None
    prompt = _as_int(raw.get("prompt_tokens"))
    if prompt is None:
        prompt = _as_int(raw.get("input_tokens"))
    completion = _as_int(raw.get("completion_tokens"))
    if completion is None:
        completion = _as_int(raw.get("output_tokens"))
    if prompt is None and completion is None:
        return None
    prompt = prompt or 0
    completion = completion or 0
    prompt_details = raw.get("prompt_tokens_details") or raw.get("input_tokens_details") or {}
    if not isinstance(prompt_details, dict):
        prompt_details = {}
    cached = _as_int(prompt_details.get("cached_tokens")) or _as_int(raw.get("prompt_cache_hit_tokens")) or 0
    created = (
        _as_int(prompt_details.get("cache_creation_tokens"))
        or _as_int(prompt_details.get("cache_write_tokens"))
        or _as_int(raw.get("cache_creation_input_tokens"))
        or 0
    )
    if cached + created > prompt:
        cached = min(cached, prompt)
        created = 0
    details = {
        "input": max(prompt - cached - created, 0),
        "output": completion,
    }
    if cached:
        details["input_cached_tokens"] = cached
    if created:
        details["input_cache_creation_tokens"] = created
    if prompt + completion:
        details["total"] = prompt + completion
    # ``output`` already includes reasoning tokens in the OpenAI protocol, and they are
    # billed at the output rate. Do not add a second overlapping bucket.
    return details


# ---------------------------------------------------------------------------
# Masking and serialisation
# ---------------------------------------------------------------------------

_REDACTIONS = (
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "[redacted-email]"),
    (re.compile(r"\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b"), "[redacted-key]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*"), "Bearer [redacted]"),
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "[redacted-phone]"),
)


def _redact_text(value: str) -> str:
    for pattern, replacement in _REDACTIONS:
        value = pattern.sub(replacement, value)
    return value


def _mask_otel_spans(*, params):
    """Mask exported string attributes, per Langfuse's recommended v5 hook."""
    try:
        from langfuse.types import MaskOtelSpansResult, OtelSpanPatch
    except Exception:
        return None
    patches = {}
    for identifier, span in params.spans.items():
        replacements = {}
        for key, value in span.attributes.items():
            if isinstance(value, str):
                masked = _redact_text(value)
                if masked != value:
                    replacements[key] = masked
        if replacements:
            patches[identifier] = OtelSpanPatch(set_attributes=replacements)
    return MaskOtelSpansResult(span_patches=patches) if patches else None


def _clip(value: Any, depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        return "…"
    if isinstance(value, str):
        if len(value) <= MAX_STRING_CHARS:
            return value
        return value[:MAX_STRING_CHARS] + f"… [truncated {len(value) - MAX_STRING_CHARS:,} chars]"
    if isinstance(value, dict):
        items = list(value.items())[:MAX_COLLECTION_ITEMS]
        return {str(key): _clip(item, depth + 1) for key, item in items}
    if isinstance(value, (list, tuple)):
        return [_clip(item, depth + 1) for item in value[:MAX_COLLECTION_ITEMS]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _clip(str(value), depth + 1)


def _message_text(message: dict) -> str:
    """The text of a chat message, a Responses API input item, or one of their content parts."""
    value = next((message[field] for field in ("content", "text", "output", "arguments") if message.get(field)), "")
    if isinstance(value, list):
        parts = (_message_text(part) if isinstance(part, dict) else str(part) for part in value)
        return "\n\n".join(part for part in parts if part)
    return value if isinstance(value, str) else _outline(value)


def _messages_text(messages: list[dict]) -> str:
    if len(messages) == 1:
        return _message_text(messages[0])
    blocks = []
    for message in messages:
        body = _message_text(message)
        if body:
            label = message.get("role") or " ".join(filter(None, (message.get("type"), message.get("name"))))
            blocks.append(f"[{label}]\n{body}")
    return "\n\n".join(blocks)


def _outline(value: Any, indent: str = "") -> str:
    """Indented ``key: value`` lines for the structured payloads that have no main text."""
    if isinstance(value, dict):
        entries = [(f"{key}:", item) for key, item in value.items() if item is not None]
    elif isinstance(value, list):
        entries = [("-", item) for item in value]
    else:
        return f"{indent}{value}"
    lines = []
    for label, item in entries:
        if isinstance(item, (dict, list)):
            lines.extend((f"{indent}{label}", _outline(item, indent + "  ")))
        else:
            lines.append(f"{indent}{label} {item}")
    return "\n".join(lines)


def _display(value: Any) -> str | None:
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, list) and value and all(isinstance(item, dict) and ("role" in item or "type" in item) for item in value):
        return _messages_text(value)
    return _outline(value)


def _payload(value: Any) -> str | None:
    """Bounded plain text for an observation's input or output.

    Strings are clipped one by one before they are joined, so a long system prompt
    cannot push the user message that follows it out of the trace.
    """
    return _display(_clip(value))


def _propagated_metadata(metadata: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep propagated metadata short: Langfuse limits each encoded value to 200 chars."""
    if not metadata:
        return None
    clean: dict[str, Any] = {}
    for key, value in metadata.items():
        if isinstance(value, (bool, int, float)):
            clean[str(key)[:100]] = value
        elif value is not None:
            text = str(value)
            clean[str(key)[:100]] = text[:180]
    return clean or None


def _clean_model_parameters(parameters: dict[str, Any] | None) -> dict[str, Any] | None:
    if not parameters:
        return None
    allowed = {}
    for key, value in parameters.items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            allowed[str(key)] = value
    return allowed or None


def _mark_error(observation: Any, exc: BaseException) -> None:
    message = _redact_text(f"{type(exc).__name__}: {exc}")[:500]
    try:
        observation.update(level="ERROR", status_message=message)
    except Exception:
        logger.debug("Langfuse error marking failed", exc_info=True)
