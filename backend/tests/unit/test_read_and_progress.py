"""「已读课文」的口径、课程进度的字段。"""
import pytest

from app.models import Feedback, Lesson, Syllabus
from tests.conftest import TestSession
from tests.unit.test_course_language import create_topic, next_lesson


@pytest.fixture
def client(authed_client):
    return authed_client


def stats(client):
    return client.get("/api/stats").json()


def course_stats(client, cid):
    return client.get(f"/api/courses/{cid}/stats").json()


def add_feedback(cid, lesson_number, content="读完了", answers=""):
    with TestSession() as db:
        lesson = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == lesson_number).one()
        db.add(Feedback(lesson_id=lesson.id, content=content, thought_answers=answers))
        db.commit()


def make_project(client, count=2, name="阅读项目"):
    files = [("files", (f"f{i}.txt", f"第 {i} 个文件".encode(), "text/plain")) for i in range(1, count + 1)]
    res = client.post("/api/courses/from-project", data={"name": name}, files=files)
    assert res.status_code == 200, res.text
    return res.json()["id"]


# ---------------------------------------------------------------------------
# B6：已读课文
# ---------------------------------------------------------------------------

def test_a_freshly_created_course_has_read_nothing(client):
    created, _ = create_topic(client)
    cid = created["id"]

    assert stats(client)["total_lessons_read"] == 0
    assert course_stats(client, cid)["lessons_read"] == 0
    assert course_stats(client, cid)["total_lessons"] == 1
    assert [lesson["is_read"] for lesson in client.get(f"/api/courses/{cid}/lessons").json()] == [False]


def test_generating_the_next_lesson_means_the_previous_one_was_read_but_the_new_one_is_not(client):
    created, _ = create_topic(client)
    cid = created["id"]

    next_lesson(client, cid)

    assert stats(client)["total_lessons_read"] == 1
    assert course_stats(client, cid)["lessons_read"] == 1
    assert course_stats(client, cid)["total_lessons"] == 2
    assert [lesson["is_read"] for lesson in client.get(f"/api/courses/{cid}/lessons").json()] == [True, False]
    assert client.get(f"/api/courses/{cid}/lessons/1").json()["is_read"] is True
    assert client.get(f"/api/courses/{cid}/lessons/2").json()["is_read"] is False


def test_a_lesson_with_feedback_counts_as_read_even_before_the_next_one_is_generated(client):
    created, _ = create_topic(client)
    cid = created["id"]

    res = client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "写得清楚", "thought_answers": ""})
    assert res.status_code == 200

    assert stats(client)["total_lessons_read"] == 1
    assert course_stats(client, cid)["lessons_read"] == 1
    assert client.get(f"/api/courses/{cid}/lessons").json()[0]["is_read"] is True


def test_a_lesson_is_counted_once_however_it_became_read(client):
    created, _ = create_topic(client)
    cid = created["id"]
    client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "写得清楚", "thought_answers": "答"})

    next_lesson(client, cid)  # 第 1 篇既有反馈、又因下一篇生成而读完

    assert stats(client)["total_lessons_read"] == 1
    assert course_stats(client, cid)["lessons_read"] == 1


def test_project_files_count_when_marked_read(client):
    cid = make_project(client, 3)
    assert stats(client)["total_lessons_read"] == 0

    assert client.post(f"/api/courses/{cid}/lessons/1/completed").status_code == 200
    assert client.post(f"/api/courses/{cid}/lessons/1/completed").status_code == 200  # 重复标记不重复计数
    assert client.post(f"/api/courses/{cid}/lessons/3/completed").status_code == 200

    assert stats(client)["total_lessons_read"] == 2
    assert course_stats(client, cid)["lessons_read"] == 2


def test_the_assessment_lesson_is_read_once_the_summary_is_generated_and_the_summary_never_counts(client):
    created, _ = create_topic(client)
    cid = created["id"]
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    next_lesson(client, cid)  # 评估篇（第 2 篇）
    assert stats(client)["total_lessons_read"] == 1  # 只有第 1 篇读完了

    next_lesson(client, cid)  # 总结

    assert client.get(f"/api/courses/{cid}").json()["status"] == "completed"
    assert stats(client)["total_lessons_read"] == 2
    assert course_stats(client, cid)["lessons_read"] == 2
    assert course_stats(client, cid)["total_lessons"] == 2  # 总结篇（number=0）不算课文


def test_global_and_course_counts_agree_across_courses(client):
    first, _ = create_topic(client, name="第一门")
    second, _ = create_topic(client, name="第二门")
    project = make_project(client, 2)
    next_lesson(client, first["id"])
    client.post(f"/api/courses/{second['id']}/lessons/1/feedback", json={"content": "x", "thought_answers": ""})
    client.post(f"/api/courses/{project}/lessons/2/completed")

    per_course = [course_stats(client, cid)["lessons_read"] for cid in (first["id"], second["id"], project)]

    assert per_course == [1, 1, 1]
    assert stats(client)["total_lessons_read"] == sum(per_course)


def test_the_calendar_still_counts_opened_lessons(client):
    created, _ = create_topic(client)
    cid = created["id"]
    client.post(f"/api/courses/{cid}/lessons/1/opened")

    day = client.get("/api/calendar").json()["days"][0]

    assert day["lessons_read"] == 1  # 日历里的「当天读到」按打开记录，没有读完也算
    assert stats(client)["total_lessons_read"] == 0


def test_deleted_lessons_and_other_users_never_count(client, other_user, other_headers):
    from fastapi.testclient import TestClient

    from app.main import app

    created, _ = create_topic(client)
    next_lesson(client, created["id"])
    other = TestClient(app, headers=other_headers)

    assert stats(other)["total_lessons_read"] == 0
    assert client.delete(f"/api/courses/{created['id']}").status_code == 200
    assert stats(client)["total_lessons_read"] == 0


# ---------------------------------------------------------------------------
# B8：课程进度 = 已勾选的掌握项 / 全部掌握项
# ---------------------------------------------------------------------------

def test_every_course_response_carries_the_covered_and_total_counts(client):
    created, _ = create_topic(client)
    cid = created["id"]

    assert (created["mastery_covered"], created["mastery_total"], created["mastery_progress"]) == (0, 8, 0.0)
    for body in (client.get(f"/api/courses/{cid}").json(), client.get("/api/courses").json()[0]):
        assert (body["mastery_covered"], body["mastery_total"], body["mastery_progress"]) == (0, 8, 0.0)
    detail = course_stats(client, cid)
    assert (detail["mastery_covered"], detail["mastery_checked"], detail["mastery_total"]) == (0, 0, 8)


def test_the_progress_moves_only_when_a_lesson_ticks_outline_items_and_it_moves_in_steps_of_what_was_ticked(client):
    created, _ = create_topic(client)
    cid = created["id"]

    next_lesson(client, cid)  # EN_NEXT 的 mastery 注释勾了 2 项

    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    detail = client.get(f"/api/courses/{cid}").json()
    assert (detail["mastery_covered"], detail["mastery_total"]) == (2, 8)
    assert detail["mastery_progress"] == pytest.approx(2 / 8)
    listed = client.get("/api/courses").json()[0]
    assert (listed["mastery_covered"], listed["mastery_total"], listed["mastery_progress"]) == (2, 8, pytest.approx(0.25))
    detail_stats = course_stats(client, cid)
    assert (detail_stats["mastery_covered"], detail_stats["mastery_checked"]) == (2, 2)
    assert detail_stats["mastery_progress"] == pytest.approx(0.25)


def test_a_lesson_whose_comment_matches_nothing_in_the_outline_does_not_move_the_progress(client):
    created, _ = create_topic(client)
    cid = created["id"]

    def responder(system, user):
        return "# Lesson 2\n\n## Main content\n\nx\n\n## Reflection questions\n\n1. Why?\n2. How?\n\n<!-- mastery: Something else -->"

    next_lesson(client, cid, responder)

    assert client.get(f"/api/courses/{cid}").json()["mastery_covered"] == 0


def test_project_progress_is_files_read_over_files(client):
    cid = make_project(client, 4)

    body = client.post(f"/api/courses/{cid}/lessons/2/completed").json()

    assert (body["mastery_covered"], body["mastery_total"], body["mastery_progress"]) == (1, 4, 0.25)
    detail = client.get(f"/api/courses/{cid}").json()
    assert (detail["mastery_covered"], detail["mastery_total"], detail["mastery_progress"]) == (1, 4, 0.25)
    assert client.get("/api/courses").json()[0]["mastery_total"] == 4
    assert (course_stats(client, cid)["mastery_covered"], course_stats(client, cid)["mastery_total"]) == (1, 4)


def test_creation_responses_of_the_other_modes_carry_the_total_too(client):
    project = client.post(
        "/api/courses/from-project",
        files=[("files", ("a.txt", b"x", "text/plain")), ("files", ("b.txt", b"y", "text/plain"))],
    ).json()

    assert (project["mastery_covered"], project["mastery_total"]) == (0, 2)
