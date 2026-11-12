import logging

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app as fastapi_app

FALLBACK = {"detail": "服务器出了点问题，请稍后重试"}


@pytest.fixture
def probes():
    @fastapi_app.get("/api/_probe/boom")
    def boom():
        raise RuntimeError("secret internals: db password is hunter2")

    @fastapi_app.get("/api/_probe/conflict")
    def conflict():
        raise HTTPException(status_code=409, detail="冲突了")

    @fastapi_app.get("/api/_probe/typed")
    def typed(n: int):
        return {"n": n}

    routes = [fastapi_app.router.routes.pop() for _ in range(3)]
    for route in routes:
        fastapi_app.router.routes.insert(0, route)
    yield
    for route in routes:
        fastapi_app.router.routes.remove(route)


@pytest.fixture
def soft_client():
    return TestClient(fastapi_app, raise_server_exceptions=False)


def test_unhandled_exception_returns_the_fallback_body_without_leaking_anything(probes, soft_client, caplog):
    with caplog.at_level(logging.ERROR):
        res = soft_client.get("/api/_probe/boom")

    assert res.status_code == 500
    assert res.json() == FALLBACK
    assert "secret" not in res.text and "hunter2" not in res.text and "Traceback" not in res.text
    logged = [r for r in caplog.records if r.exc_info and "hunter2" in str(r.exc_info[1])]
    assert logged and logged[0].levelno == logging.ERROR


def test_fallback_handler_leaves_http_and_validation_errors_alone(probes, soft_client):
    conflict = soft_client.get("/api/_probe/conflict")
    assert (conflict.status_code, conflict.json()) == (409, {"detail": "冲突了"})

    invalid = soft_client.get("/api/_probe/typed", params={"n": "abc"})
    assert invalid.status_code == 422
    assert invalid.json()["detail"][0]["loc"] == ["query", "n"]

    assert soft_client.get("/api/_probe/missing").status_code == 404
    assert soft_client.get("/api/me").json() == {"detail": "缺少访问令牌"}


def test_exceptions_still_reach_a_default_test_client(probes):
    with pytest.raises(RuntimeError, match="secret internals"):
        TestClient(fastapi_app).get("/api/_probe/boom")


def test_fallback_response_is_readable_by_the_browser_origin_like_every_other_error(probes, soft_client):
    allowed = {"Origin": settings.WEB_URL}

    for path in ("/api/_probe/conflict", "/api/_probe/boom"):
        res = soft_client.get(path, headers=allowed)
        assert res.headers["access-control-allow-origin"] == settings.WEB_URL, path
        assert res.headers["access-control-allow-credentials"] == "true", path

    stranger = soft_client.get("/api/_probe/boom", headers={"Origin": "https://evil.example.com"})
    assert stranger.status_code == 500 and "access-control-allow-origin" not in stranger.headers
    assert "access-control-allow-origin" not in soft_client.get("/api/_probe/boom").headers
