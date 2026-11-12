"""慢 SQL / 慢请求日志：阈值、脱敏、以及中间件的那几个分支。"""
import asyncio
import json
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app import observability


def records(caplog):
    """把 JSON 日志解析出来：非 JSON 的记录（别的模块打的）跳过。"""
    out = []
    for record in caplog.records:
        if not record.name.startswith("bloom.observability"):
            continue
        try:
            out.append((record.levelno, json.loads(record.getMessage())))
        except json.JSONDecodeError:
            continue
    return out


def events(caplog, name):
    return [payload for _, payload in records(caplog) if payload["event"] == name]


@pytest.fixture
def clock(monkeypatch):
    """让每次 perf_counter() 往前走固定的毫秒数，慢查询判定就不靠真的等。"""
    now = {"value": 0.0}

    def tick(step_ms):
        now["value"] += step_ms / 1000

        def perf_counter():
            now["value"] += step_ms / 1000
            return now["value"]

        monkeypatch.setattr(observability.time, "perf_counter", perf_counter)
        return perf_counter

    return tick


@pytest.fixture
def engine():
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("create table t (id integer primary key, email text)"))
        conn.execute(text("insert into t (email) values ('user@example.com')"))
    yield engine
    engine.dispose()


def test_slow_query_over_the_threshold_is_logged_once_with_its_statement(caplog, engine, clock):
    caplog.set_level(logging.INFO)
    observability.SLOW_QUERY_MS = 300
    clock(400)
    observability.install_slow_query_logging(engine)

    with engine.connect() as conn:
        conn.execute(text("select email from t"))

    [payload] = events(caplog, "slow_query")
    assert payload["ms"] == 400
    assert "select email from t" in payload["sql"]
    assert isinstance(payload["in_tx"], bool)


def test_fast_queries_stay_quiet(caplog, engine, clock):
    caplog.set_level(logging.INFO)
    observability.SLOW_QUERY_MS = 300
    clock(5)
    observability.install_slow_query_logging(engine)

    with engine.connect() as conn:
        conn.execute(text("select 1"))

    assert events(caplog, "slow_query") == []


def test_slow_query_params_are_redacted_and_clipped(caplog, engine, clock):
    caplog.set_level(logging.INFO)
    observability.SLOW_QUERY_MS = 300
    clock(400)
    observability.install_slow_query_logging(engine)

    with engine.connect() as conn:
        conn.execute(text("select :email"), {"email": "user@example.com"})

    [payload] = events(caplog, "slow_query")
    assert "user@example.com" not in json.dumps(payload, ensure_ascii=False)
    assert "[EMAIL]" in payload["params"]
    assert len(payload["sql"]) <= observability.SQL_MAX


def test_threshold_zero_turns_the_listener_off(engine):
    observability.SLOW_QUERY_MS = 0
    observability.install_slow_query_logging(engine)
    from sqlalchemy import event

    assert not event.contains(engine, "before_cursor_execute", observability._before_cursor_execute)


def test_installing_twice_does_not_double_log(caplog, engine, clock):
    caplog.set_level(logging.INFO)
    observability.SLOW_QUERY_MS = 300
    clock(400)
    observability.install_slow_query_logging(engine)
    observability.install_slow_query_logging(engine)

    with engine.connect() as conn:
        conn.execute(text("select 1"))

    assert len(events(caplog, "slow_query")) == 1


def test_query_logging_has_a_per_minute_budget(caplog, engine, clock):
    """一条失控的 N+1 不能把日志刷满：每分钟只记有限几条慢查询。"""
    caplog.set_level(logging.INFO)
    observability.SLOW_QUERY_MS = 300
    observability.QUERY_LOG_BUDGET = 3
    observability._budget.update(window=-60.0, count=0)
    clock(400)
    observability.install_slow_query_logging(engine)

    with engine.connect() as conn:
        for _ in range(5):
            conn.execute(text("select 1"))

    assert len(events(caplog, "slow_query")) == 3


def build_app(path="/items/{item_id}", handler=None):
    app = FastAPI()
    app.add_middleware(observability.RequestLogMiddleware)
    app.get(path)(handler)
    return app


def test_slow_request_is_logged_with_the_route_template(caplog):
    caplog.set_level(logging.INFO)
    observability.SLOW_REQUEST_MS = 1
    observability.REQUEST_LOG = False

    async def handler(item_id: int):
        await asyncio.sleep(0.01)
        return {"ok": item_id}

    client = TestClient(build_app(handler=handler))
    response = client.get("/items/7")

    assert response.status_code == 200
    assert response.headers["server-timing"].startswith("ttfb;dur=")
    [payload] = events(caplog, "slow_request")
    # 路由模板而不是真实路径：不然日志会按 id 炸成几万条
    assert payload["route"] == "/items/{item_id}"
    assert payload["method"] == "GET" and payload["status"] == 200
    assert "path" not in payload


def test_failed_request_is_logged_as_error_with_the_real_path(caplog):
    caplog.set_level(logging.INFO)
    observability.SLOW_REQUEST_MS = 0
    observability.REQUEST_LOG = False

    async def handler(item_id: int):
        raise RuntimeError("boom")

    client = TestClient(build_app(handler=handler), raise_server_exceptions=False)
    response = client.get("/items/7")

    assert response.status_code == 500
    [payload] = events(caplog, "request_failed")
    assert payload["status"] == 500
    assert payload["path"] == "/items/7"
    assert payload["route"] == "/items/{item_id}"
    # 不记异常原文，只记类型
    assert payload["error"] == "RuntimeError"
    assert "boom" not in json.dumps(payload, ensure_ascii=False)


def test_every_request_can_be_logged_when_requested(caplog):
    caplog.set_level(logging.INFO)
    observability.SLOW_REQUEST_MS = 10_000
    observability.REQUEST_LOG = True

    async def handler(item_id: int):
        return {"ok": item_id}

    TestClient(build_app(handler=handler)).get("/items/1")

    [payload] = events(caplog, "request")
    assert payload["status"] == 200 and payload["route"] == "/items/{item_id}"


def test_request_logging_is_off_by_default(caplog):
    caplog.set_level(logging.INFO)
    observability.SLOW_REQUEST_MS = 10_000
    observability.REQUEST_LOG = False

    async def handler(item_id: int):
        return {"ok": item_id}

    TestClient(build_app(handler=handler)).get("/items/1")

    assert events(caplog, "request") == [] and records(caplog) == []


def test_the_app_engine_has_the_slow_query_hook(monkeypatch):
    """database.py 建完 engine 就挂上：别只写了函数没接上线。"""
    from sqlalchemy import event

    from app import database

    assert event.contains(database.engine, "before_cursor_execute", observability._before_cursor_execute)
