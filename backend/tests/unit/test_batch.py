import json
import threading

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from app.batch import MAX_REQUESTS, router as batch_router
from app.database import get_db
from app.main import app
from tests.conftest import override_get_db, seed_course


@pytest.fixture(autouse=True)
def one_session_at_a_time(monkeypatch):
    # 合并的子请求在线程池里并发跑；测试库是所有线程共用一条连接的内存 SQLite（StaticPool），并发读会互相踩。
    # 线上每个子请求从连接池拿各自的连接，这里让测试库一次只给一个会话
    lock = threading.Lock()

    def serialized_db():
        with lock:
            yield from override_get_db()

    monkeypatch.setitem(app.dependency_overrides, get_db, serialized_db)


def run_batch(client, paths, **kwargs):
    res = client.post("/api/batch", json={"paths": paths}, **kwargs)
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(line) for line in res.text.splitlines() if line]
    assert sorted(line["i"] for line in lines) == list(range(len(paths)))
    return {line["i"]: line for line in lines}


def test_batched_reads_match_the_same_reads_sent_one_by_one(authed_client, user):
    course_id, _ = seed_course(user.uuid)
    paths = [
        "/api/me",
        "/api/stats",
        "/api/courses",
        f"/api/courses/{course_id}",
        f"/api/courses/{course_id}/lessons/1",
        "/api/me/annotations?page=1&limit=3",
    ]
    results = run_batch(authed_client, paths)
    for i, path in enumerate(paths):
        direct = authed_client.get(path)
        assert results[i]["status"] == direct.status_code == 200, path
        assert results[i]["body"] == direct.json(), path


def test_each_read_keeps_its_own_status_and_the_callers_identity(client, user, other_headers):
    course_id, _ = seed_course(user.uuid)
    # 别人的课程照样 404，没登录的接口照样 401：合并只是换了个运输方式，身份仍是调用方自己的
    results = run_batch(client, [f"/api/courses/{course_id}", "/api/me", "/api/courses/999999"], headers=other_headers)
    assert results[0]["status"] == 404
    assert results[1]["status"] == 200 and results[1]["body"]["email"] == "other@example.com"
    assert results[2]["status"] == 404

    anonymous = run_batch(client, ["/api/me", "/api/health"])
    assert anonymous[0]["status"] == 401
    assert anonymous[1]["status"] == 200


def test_rejects_paths_that_must_not_be_batched(authed_client):
    for path in ["/api/batch", "//evil.example/api/me", "/api/../internal", "/health", "/api/a b"]:
        res = authed_client.post("/api/batch", json={"paths": ["/api/me", path]})
        assert res.status_code == 422, path
    assert authed_client.post("/api/batch", json={"paths": []}).status_code == 422
    assert authed_client.post("/api/batch", json={"paths": ["/api/me"] * (MAX_REQUESTS + 1)}).status_code == 422


def test_failures_inside_one_read_do_not_break_the_others():
    probe = FastAPI()
    probe.include_router(batch_router)

    @probe.get("/api/boom")
    def boom():
        raise RuntimeError("boom")

    @probe.get("/api/busy")
    def busy():
        return Response('{"detail":"busy"}', status_code=429, media_type="application/json", headers={"Retry-After": "600"})

    @probe.get("/api/text")
    def text():
        return Response("plain", media_type="text/plain")

    @probe.get("/api/empty", status_code=204)
    def empty():
        return Response(status_code=204)

    @probe.get("/api/ok")
    def ok():
        return {"ok": True}

    results = run_batch(TestClient(probe), ["/api/boom", "/api/busy", "/api/text", "/api/empty", "/api/ok"])
    assert results[0] == {"i": 0, "status": 500, "text": "Internal Server Error"}
    assert results[1] == {"i": 1, "status": 429, "body": {"detail": "busy"}, "headers": {"retry-after": "600"}}
    assert results[2] == {"i": 2, "status": 200, "text": "plain"}
    assert results[3] == {"i": 3, "status": 204, "body": None}
    assert results[4]["body"] == {"ok": True}


def test_unhandled_errors_come_back_as_the_apps_own_500(authed_client, monkeypatch):
    import app.users as users

    def broken(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(users, "me_response", broken)
    results = run_batch(authed_client, ["/api/me", "/api/stats"])
    assert results[0]["status"] == 500
    assert results[0]["body"] == {"detail": "服务器出了点问题，请稍后重试"}
    assert results[1]["status"] == 200
