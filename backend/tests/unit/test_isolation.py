import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.courses import router as courses_router
from app.main import app as fastapi_app
from app.recommendations import router as recommendations_router
from app.models import Annotation, Course, Feedback, LearningEvent, LearningRecommendation, Lesson, Syllabus
from tests.conftest import TestSession, seed_course

ANNOTATION = {"position_start": 0, "position_end": 2, "original_text": "正文", "comment": "这是什么？"}
COURSE_ROUTES = [
    ("get", "/api/courses/{c}", {}),
    ("delete", "/api/courses/{c}", {}),
    ("get", "/api/courses/{c}/syllabus", {}),
    ("put", "/api/courses/{c}/syllabus", {"json": {"content": "# 被改写"}}),
    ("get", "/api/courses/{c}/lessons", {}),
    ("get", "/api/courses/{c}/lessons/1", {}),
    ("get", "/api/courses/{c}/lessons/1/file", {}),
    ("get", "/api/courses/{c}/lessons/1/annotations", {}),
    ("post", "/api/courses/{c}/lessons/1/annotations", {"json": ANNOTATION}),
    ("post", "/api/courses/{c}/lessons/1/annotations/save", {"json": {**ANNOTATION, "partial_answer": "半截回答"}}),
    ("post", "/api/courses/{c}/lessons/1/annotations/{a}/messages", {"json": {"content": "追问"}}),
    ("delete", "/api/courses/{c}/lessons/1/annotations/{a}", {}),
    ("get", "/api/courses/{c}/lessons/1/feedback", {}),
    ("post", "/api/courses/{c}/lessons/1/feedback", {"json": {"content": "被改写", "thought_answers": ""}}),
    ("post", "/api/courses/{c}/lessons/1/opened", {}),
    ("post", "/api/courses/{c}/lessons/1/completed", {}),
    ("post", "/api/courses/{c}/next", {}),
    ("get", "/api/courses/{c}/summary", {}),
    ("get", "/api/courses/{c}/stats", {}),
]


def route_id(route):
    return f"{route[0]} {route[1]}"


def snapshot():
    with TestSession() as db:
        return {
            "courses": [(c.id, c.user_uuid, c.name, c.status) for c in db.query(Course).order_by(Course.id)],
            "syllabi": [(s.course_id, s.content) for s in db.query(Syllabus).order_by(Syllabus.id)],
            "lessons": [(x.id, x.course_id, x.number, x.content) for x in db.query(Lesson).order_by(Lesson.id)],
            "annotations": [(a.id, a.answer, a.messages) for a in db.query(Annotation).order_by(Annotation.id)],
            "feedbacks": [(f.id, f.content) for f in db.query(Feedback).order_by(Feedback.id)],
            "events": db.query(LearningEvent).count(),
            "recommendations": [
                (r.id, r.user_uuid, r.title, r.status, r.course_id)
                for r in db.query(LearningRecommendation).order_by(LearningRecommendation.id)
            ],
        }


def seed_recommendation(owner_uuid, title, status="suggested", generation=1):
    with TestSession() as db:
        row = LearningRecommendation(
            user_uuid=owner_uuid, title=title, rationale="理由", bridge="桥接", status=status, generation=generation,
        )
        db.add(row)
        db.commit()
        return row.id


@pytest.fixture
def llm():
    with patch("app.courses.get_openai_client") as client, patch("app.courses._call_llm") as call:
        yield client, call
    assert not client.called and not call.called


@pytest.fixture
def b_client(other_user, other_headers):
    return TestClient(fastapi_app, headers=other_headers)


def test_every_course_engine_route_rejects_anonymous_requests(client):
    # 新版 FastAPI 的 app.routes 只列出 include 进来的路由器，不展开：直接看这两个模块的路由器
    routes = [
        (method, route.path)
        for route in [*courses_router.routes, *recommendations_router.routes]
        if getattr(route, "endpoint", None) and route.endpoint.__module__ in ("app.courses", "app.recommendations")
        for method in sorted(route.methods)
    ]
    assert len(routes) >= 30
    for method, path in routes:
        res = client.request(method, path.replace("{course_id}", "1").replace("{lesson_num}", "1")
                             .replace("{annotation_id}", "1").replace("{recommendation_id}", "1"))
        assert res.status_code == 401, f"{method} {path} -> {res.status_code}"
        assert res.json()["detail"] == "缺少访问令牌"


def test_course_engine_rejects_invalid_token(client):
    res = client.get("/api/courses", headers={"Authorization": "Bearer not-a-jwt"})
    assert res.status_code == 401


def test_owner_can_reach_every_non_destructive_route(authed_client, user):
    course_id, annotation_id = seed_course(user.uuid)
    for path in ("", "/syllabus", "/lessons", "/lessons/1", "/lessons/1/file", "/lessons/1/annotations",
                 "/lessons/1/feedback", "/summary", "/stats"):
        res = authed_client.get(f"/api/courses/{course_id}{path}")
        assert res.status_code == 200, path


@pytest.mark.parametrize("route", COURSE_ROUTES, ids=route_id)
def test_other_users_cannot_touch_a_course_or_anything_under_it(route, user, b_client, other_user, llm):
    course_id, annotation_id = seed_course(user.uuid)
    method, template, kwargs = route
    before = snapshot()

    res = getattr(b_client, method)(template.format(c=course_id, a=annotation_id), **kwargs)
    missing = getattr(b_client, method)(template.format(c=999999, a=annotation_id), **kwargs)

    assert res.status_code == 404
    assert (res.status_code, res.json()) == (missing.status_code, missing.json())
    assert snapshot() == before


def test_an_annotation_cannot_be_reached_through_another_users_course(user, b_client, other_user):
    _, foreign_annotation = seed_course(user.uuid)
    own_course, _ = seed_course(other_user.uuid)
    before = snapshot()

    deleted = b_client.delete(f"/api/courses/{own_course}/lessons/1/annotations/{foreign_annotation}")
    asked = b_client.post(
        f"/api/courses/{own_course}/lessons/1/annotations/{foreign_annotation}/messages", json={"content": "追问"},
    )

    assert (deleted.status_code, asked.status_code) == (404, 404)
    assert snapshot() == before


def test_new_course_and_project_belong_to_their_creator(authed_client, user, b_client, other_user):
    res = authed_client.post(
        "/api/courses/from-project", data={"name": "我的项目"},
        files=[("files", ("a.md", b"# A\n\nbody", "text/markdown"))],
    )
    assert res.status_code == 200
    with TestSession() as db:
        assert db.query(Course).one().user_uuid == user.uuid
    assert b_client.get(f"/api/courses/{res.json()['id']}").status_code == 404
    assert b_client.get("/api/courses").json() == []


def test_lists_stats_and_calendar_only_contain_the_users_own_data(authed_client, user, b_client, other_user):
    seed_course(user.uuid, "A 的第一门")
    seed_course(user.uuid, "A 的第二门")
    seed_course(other_user.uuid, "B 的课")
    seed_recommendation(user.uuid, "A 的推荐")
    seed_recommendation(user.uuid, "A 收藏", status="saved")

    assert sorted(c["name"] for c in authed_client.get("/api/courses").json()) == ["A 的第一门", "A 的第二门"]
    assert [c["name"] for c in b_client.get("/api/courses").json()] == ["B 的课"]

    a_stats, b_stats = authed_client.get("/api/stats").json(), b_client.get("/api/stats").json()
    assert (a_stats["total_courses"], a_stats["total_lessons_read"], a_stats["total_annotations"],
            a_stats["total_feedback"]) == (2, 2, 2, 2)
    assert (b_stats["total_courses"], b_stats["active_courses"], b_stats["total_lessons_read"],
            b_stats["total_annotations"], b_stats["total_feedback"]) == (1, 1, 1, 1, 1)

    a_days, b_days = authed_client.get("/api/calendar").json()["days"], b_client.get("/api/calendar").json()["days"]
    assert sorted(c["course_name"] for c in a_days[0]["courses"]) == ["A 的第一门", "A 的第二门"]
    assert (a_days[0]["annotations"], a_days[0]["event_count"]) == (2, 4)
    assert [c["course_name"] for c in b_days[0]["courses"]] == ["B 的课"]
    assert (b_days[0]["annotations"], b_days[0]["event_count"]) == (1, 2)

    assert len(authed_client.get("/api/recommendations").json()["recommendations"]) == 1
    assert b_client.get("/api/recommendations").json() == {"recommendations": [], "saved": []}


def test_a_users_streak_does_not_come_from_other_users_activity(authed_client, user, b_client):
    seed_course(user.uuid)

    assert authed_client.get("/api/stats").json()["current_streak"] == 1
    stats = b_client.get("/api/stats").json()
    assert (stats["total_courses"], stats["current_streak"], stats["longest_streak"]) == (0, 0, 0)
    assert b_client.get("/api/calendar").json()["days"] == []


@pytest.mark.parametrize("method,template", [
    ("post", "/api/recommendations/{r}/save"),
    ("delete", "/api/recommendations/{r}/save"),
    ("post", "/api/recommendations/{r}/start"),
])
def test_other_users_cannot_touch_a_recommendation(method, template, user, b_client):
    rec = seed_recommendation(user.uuid, "A 的推荐")
    before = snapshot()
    kwargs = {"json": {"course_id": None}} if template.endswith("start") else {}

    res = getattr(b_client, method)(template.format(r=rec), **kwargs)
    missing = getattr(b_client, method)(template.format(r=999999), **kwargs)

    assert res.status_code == 404
    assert (res.status_code, res.json()) == (missing.status_code, missing.json())
    assert snapshot() == before


def test_recommendation_cannot_be_started_with_someone_elses_course(user, b_client, other_user):
    foreign_course, _ = seed_course(user.uuid)
    own_rec = seed_recommendation(other_user.uuid, "B 的推荐")
    before = snapshot()

    res = b_client.post(f"/api/recommendations/{own_rec}/start", json={"course_id": foreign_course})

    assert res.status_code == 404
    assert snapshot() == before


def test_refresh_uses_only_the_callers_data_and_leaves_other_users_suggestions_alone(
    authed_client, user, b_client, other_user,
):
    seed_course(user.uuid, "A 的秘密课程")
    for title in ("机制设计", "决策理论", "社会选择理论"):
        seed_recommendation(user.uuid, title, generation=5)
    payload = json.dumps([
        {"title": title, "rationale": "理由", "bridge": "桥接", "source_topics": []}
        for title in ("机制设计", "决策理论", "社会选择理论")
    ], ensure_ascii=False)

    with patch("app.recommendations._call_llm", return_value=payload) as call:
        res = b_client.post("/api/recommendations/refresh")

    assert res.status_code == 200
    assert [r["title"] for r in res.json()["recommendations"]] == ["机制设计", "决策理论", "社会选择理论"]
    assert {r["generation"] for r in res.json()["recommendations"]} == {1}
    prompt_input = call.call_args.args[1]
    assert "A 的秘密课程" not in prompt_input and "学习者还没有课程记录" in prompt_input
    a_dashboard = authed_client.get("/api/recommendations").json()
    assert [r["title"] for r in a_dashboard["recommendations"]] == ["机制设计", "决策理论", "社会选择理论"]
    assert {r["generation"] for r in a_dashboard["recommendations"]} == {5}
