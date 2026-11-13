"""生产日志：慢 SQL、慢请求、失败请求，以及给浏览器看的 Server-Timing。

日志写到 stdout，很多日志平台把**每一行当成一条独立日志**，多行会被拆开、还会丢掉相互的顺序。
所以这里所有输出都是单行 JSON，字段固定（event / ms / route / status …），按 `level` 或搜 `"event":"slow_query"`
就能过滤。

日志里不放原始 SQL 参数和个人信息：语句和参数都先过 `app.errors.redact`（邮箱、URL、JWT、Key、IP 都会替换掉），
再截断。阈值和开关都走环境变量，默认值按生产调好：

- `SLOW_QUERY_MS`：单条 SQL 超过多少毫秒记一条 WARNING，默认 300；`0` 关闭。
- `SLOW_REQUEST_MS`：单个请求超过多少毫秒记一条 WARNING，默认 1500；`0` 只记 5xx。
- `REQUEST_LOG=1`：每个请求都记一条 INFO（排障时临时打开，平时别开，量大）。

慢查询记录挂在 engine 上（`database.py` 建完 engine 就调 `install_slow_query_logging`），
请求记录是 ASGI 中间件（`main.py` 里 `app.add_middleware(RequestLogMiddleware)`）。
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

from starlette.datastructures import MutableHeaders

from app.errors import redact

logger = logging.getLogger("bloom.observability")

SQL_MAX = 600  # 单条语句记录的字符数：够看出是哪张表、哪个条件
PARAM_MAX = 200  # 参数只留开头：多数语句的参数里没有关键信息，长了也没人要读
QUERY_LOG_BUDGET = 60  # 每分钟最多记这么多条慢查询：一条失控的 N+1 不能把日志刷满
_budget = {"window": -60.0, "count": 0}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


SLOW_QUERY_MS = _int_env("SLOW_QUERY_MS", 300)
SLOW_REQUEST_MS = _int_env("SLOW_REQUEST_MS", 1500)
REQUEST_LOG = os.getenv("REQUEST_LOG", "").strip().lower() in {"1", "true", "yes", "on"}


def clip(text: str, limit: int) -> str:
    """压成一行的同时截断：换行会把一条日志拆成多条。"""
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def log_event(level: int, event: str, **fields) -> None:
    """一条日志一行 JSON。空字段直接丢掉，免得日志里全是 null。"""
    payload = {"event": event, "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds")}
    payload.update({key: value for key, value in fields.items() if value not in (None, "", [], {})})
    logger.log(level, json.dumps(payload, ensure_ascii=False, default=str))


# ---------------------------------------------------------------- 慢 SQL

def _take_query_log_budget() -> bool:
    """简单的每分钟配额：超过就不记（不写汇总行，免得汇总本身又把配额吃掉）。"""
    now = time.monotonic()
    if now - _budget["window"] >= 60:
        _budget["window"], _budget["count"] = now, 0
    if _budget["count"] >= QUERY_LOG_BUDGET:
        return False
    _budget["count"] += 1
    return True


def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    context._bloom_query_started = time.perf_counter()


def _after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    started = getattr(context, "_bloom_query_started", None)
    if started is None:
        return
    elapsed_ms = (time.perf_counter() - started) * 1000
    if elapsed_ms < SLOW_QUERY_MS or not _take_query_log_budget():
        return
    try:
        in_transaction = conn.in_transaction()
    except Exception:  # 连接已经处于奇怪状态时别让日志本身炸掉
        in_transaction = None
    log_event(
        logging.WARNING, "slow_query",
        ms=round(elapsed_ms),
        sql=clip(redact(statement), SQL_MAX),
        params=clip(redact(repr(parameters)), PARAM_MAX) if parameters else None,
        rows=rows if (rows := getattr(cursor, "rowcount", -1)) is not None and rows >= 0 else None,
        many=bool(executemany),
        in_tx=in_transaction,
    )


def install_slow_query_logging(engine) -> None:
    """给这个 engine 挂上慢 SQL 日志。阈值是 0（或负数）时什么都不做。"""
    if SLOW_QUERY_MS <= 0:
        return
    from sqlalchemy import event

    if event.contains(engine, "before_cursor_execute", _before_cursor_execute):
        return
    event.listen(engine, "before_cursor_execute", _before_cursor_execute)
    event.listen(engine, "after_cursor_execute", _after_cursor_execute)


# ---------------------------------------------------------------- 请求

class RequestLogMiddleware:
    """纯 ASGI 中间件：包一层就能量耗时，流式响应（SSE）照样边写边发。

    - 每个响应都带 `Server-Timing: ttfb;dur=…`（到写出响应头的时间），DevTools 里直接看后端花了多久；
    - 5xx 记 ERROR，慢请求记 WARNING，`REQUEST_LOG=1` 时每个请求再记一条 INFO；
    - 字段用路由模板（`/api/courses/{id}`）而不是真实路径，避免日志按 id 炸成几万条。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        status = 0
        failure: BaseException | None = None

        async def send_with_timing(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = MutableHeaders(scope=message)
                headers.append("server-timing", f'ttfb;dur={(time.perf_counter() - started) * 1000:.1f};desc="time to first byte"')
            await send(message)

        try:
            await self.app(scope, receive, send_with_timing)
        except Exception as exc:
            # 没被处理的异常最终由 Starlette 最外层的 ServerErrorMiddleware 变成 500，
            # 那个 500 到不了这里，所以在异常经过时记一笔，再把异常放出去。
            failure = exc
            raise
        finally:
            self._record(scope, status, (time.perf_counter() - started) * 1000, failure)

    def _record(self, scope, status: int, elapsed_ms: float, failure: BaseException | None = None) -> None:
        if failure is not None:
            self._log_failure(scope, status or 500, elapsed_ms, type(failure).__name__)
            return
        # 响应头都没发出去（客户端断开、连接被掐）：不记，免得把 SSE 的正常断线刷成慢请求
        if not status and elapsed_ms < SLOW_REQUEST_MS:
            return
        route = scope.get("route")
        fields = dict(
            method=scope.get("method"),
            route=getattr(route, "path", None) or scope.get("path"),
            status=status or None,
            ms=round(elapsed_ms),
        )
        if status >= 500:
            self._log_failure(scope, status, elapsed_ms)
            return
        if SLOW_REQUEST_MS and elapsed_ms >= SLOW_REQUEST_MS:
            fields["in_bytes"] = self._header(scope, b"content-length")
            log_event(logging.WARNING, "slow_request", **fields)
            return
        if REQUEST_LOG:
            log_event(logging.INFO, "request", **fields)

    def _log_failure(self, scope, status: int, elapsed_ms: float, error: str | None = None) -> None:
        """5xx 带上真实路径：路由模板看不出是哪一个具体资源出了问题。不记异常原文，只记类型。"""
        route = scope.get("route")
        log_event(
            logging.ERROR, "request_failed",
            method=scope.get("method"),
            route=getattr(route, "path", None) or scope.get("path"),
            path=scope.get("path"),
            status=status,
            ms=round(elapsed_ms),
            error=error,
            in_bytes=self._header(scope, b"content-length"),
        )

    @staticmethod
    def _header(scope, name: bytes):
        for key, value in scope.get("headers") or ():
            if key == name:
                return value.decode("latin-1")
        return None
