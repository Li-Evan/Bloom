"""打开不存在的课文返回 404，不写学习记录。"""
import pytest

from app.models import LearningEvent
from tests.conftest import TestSession
from tests.unit.test_lesson_prompt_rules import make_course


@pytest.fixture
def client(authed_client):
    return authed_client


def events(cid, kind="lesson_opened"):
    with TestSession() as db:
        return [(e.event_type, e.lesson_number) for e in db.query(LearningEvent).filter(
            LearningEvent.course_id == cid, LearningEvent.event_type == kind,
        )]


def test_opening_a_lesson_that_does_not_exist_is_a_404_and_writes_no_record(client):
    cid, _ = make_course(client, "zh")

    for number in (99, 0, -1):
        res = client.post(f"/api/courses/{cid}/lessons/{number}/opened")
        assert res.status_code == 404 and res.json()["detail"] == "找不到这篇课文"

    assert events(cid) == []
    shown = [number for day in client.get("/api/calendar").json()["days"] for c in day["courses"] for number in c["lessons"]]
    assert not {99, 0, -1} & set(shown)  # 学习记录里没有「第 99 篇」
    assert client.get("/api/stats").json()["last_lesson"] is None or client.get("/api/stats").json()["last_lesson"]["lesson_number"] != 99


def test_opening_a_lesson_that_exists_still_records_it(client):
    cid, _ = make_course(client, "zh")

    assert client.post(f"/api/courses/{cid}/lessons/1/opened").json() == {"ok": True}

    assert events(cid) == [("lesson_opened", 1)]


def test_opening_a_lesson_of_a_course_that_does_not_exist_is_a_404(client):
    assert client.post("/api/courses/999/lessons/1/opened").status_code == 404


def test_opening_a_lesson_of_somebody_elses_course_is_a_404_and_writes_nothing(client, other_headers):
    cid, _ = make_course(client, "zh")  # 课程是 user 的，用另一个真实用户的身份去打开它的第 1 篇（它存在）

    res = client.post(f"/api/courses/{cid}/lessons/1/opened", headers=other_headers)

    assert res.status_code == 404 and events(cid) == []
    assert client.post(f"/api/courses/{cid}/lessons/1/opened").status_code == 200  # 自己打开照常
