"""用户中心用到的两处查询在真实 Postgres 上的表现（SQLite 与 Postgres 在 substr、coalesce、分组与时区上各有脾气）。

TEST_DATABASE_URL 指向的库要先迁移到最新（alembic upgrade head）。
"""
import json
import os
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.database import connect_args_for, get_db
from app.main import app
from app.models import Annotation, Course, LearningEvent, Lesson, User
from tests.conftest import bearer, override_get_db

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="需要 TEST_DATABASE_URL 指向真实 Postgres"),
]

BASE = datetime(2026, 3, 1, 8, 0, 0)


@pytest.fixture(scope="module")
def pg_engine():
    engine = create_engine(TEST_DATABASE_URL, connect_args=connect_args_for(TEST_DATABASE_URL), poolclass=NullPool)
    yield engine
    engine.dispose()


@pytest.fixture
def pg_user(pg_engine):
    user_uuid = str(uuid.uuid4())
    with Session(pg_engine) as db:
        row = User(uuid=user_uuid, email=f"{user_uuid}@example.com", nickname="PG 用户")
        db.add(row)
        db.commit()
        db.refresh(row)
        db.expunge(row)
    yield row
    with Session(pg_engine) as db:
        for course in db.query(Course).filter(Course.user_uuid == user_uuid).all():
            db.delete(course)
        db.query(User).filter(User.uuid == user_uuid).delete()
        db.commit()


@pytest.fixture
def pg_client(pg_engine, pg_user):
    sessions = sessionmaker(bind=pg_engine)

    def override():
        db = sessions()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    yield TestClient(app, headers=bearer(pg_user))
    app.dependency_overrides[get_db] = override_get_db


def test_notes_and_last_lesson_on_postgres(pg_engine, pg_user, pg_client):
    with Session(pg_engine) as db:
        course = Course(user_uuid=pg_user.uuid, name="间隔重复", mode="topic", status="learning")
        db.add(course)
        db.flush()
        lesson = Lesson(course_id=course.id, number=1, content="# 记忆曲线\n\n" + "正文" * 50_000)
        db.add(lesson)
        db.flush()
        thread = [
            {"role": "user", "content": "什么是遗忘曲线？"},
            {"role": "assistant", "content": "## 答\n\n**遗忘曲线**描述记忆的衰减。"},
        ]
        older = Annotation(lesson_id=lesson.id, position_start=0, position_end=2, original_text="甲", comment="甲问",
                           answer="", messages=json.dumps(thread, ensure_ascii=False), created_at=BASE, updated_at=BASE)
        bumped = Annotation(lesson_id=lesson.id, position_start=0, position_end=2, original_text="乙", comment="乙问",
                            answer="", messages=json.dumps(thread, ensure_ascii=False), created_at=BASE - timedelta(days=3),
                            updated_at=BASE + timedelta(days=1))
        db.add_all([older, bumped, LearningEvent(course_id=course.id, lesson_number=1, event_type="lesson_opened",
                                                 created_at=BASE)])
        db.commit()
        course_id, older_id, bumped_id = course.id, older.id, bumped.id

    notes = pg_client.get("/api/me/annotations", params={"limit": 1}).json()
    assert (notes["total"], notes["limit"]) == (2, 1)
    item = notes["items"][0]
    assert item["id"] == bumped_id and item["lesson_title"] == "记忆曲线" and item["course_name"] == "间隔重复"
    assert item["question"] == "什么是遗忘曲线？" and item["answer_preview"] == "答 遗忘曲线描述记忆的衰减。"
    assert pg_client.get("/api/me/annotations", params={"limit": 1, "page": 2}).json()["items"][0]["id"] == older_id
    assert pg_client.get("/api/me/annotations", params={"course_id": course_id}).json()["total"] == 2

    stats = pg_client.get("/api/stats").json()
    assert stats["last_lesson"]["lesson_title"] == "记忆曲线"
    assert stats["last_lesson"]["opened_at"].startswith("2026-03-01T08:00:00")

    assert pg_client.delete(f"/api/courses/{course_id}").status_code == 200
    assert pg_client.get("/api/stats").json()["last_lesson"] is None
    assert pg_client.get("/api/me/annotations").json()["total"] == 0
