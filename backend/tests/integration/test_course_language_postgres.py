"""课程语言列在真实 Postgres 上的表现：服务端默认值、检查约束，以及英文课经由接口落库。

TEST_DATABASE_URL 指向的库要先迁移到最新（alembic upgrade head）。
"""
import os
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.database import connect_args_for, get_db
from app.main import app
from app.models import Course, LearningRecommendation, User
from tests.conftest import bearer, override_get_db
from tests.unit.test_course_language import fake_model

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="需要 TEST_DATABASE_URL 指向真实 Postgres"),
]


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
        db.query(LearningRecommendation).filter(LearningRecommendation.user_uuid == user_uuid).delete()
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


def test_rows_inserted_without_a_language_are_chinese_and_the_column_only_takes_zh_or_en(pg_engine, pg_user):
    with Session(pg_engine) as db:
        # 迁移期间还在跑的旧版本后端不带这一列插入
        db.execute(text(
            "INSERT INTO courses (user_uuid, name, mode, status, learning_depth, is_project, created_at) "
            "VALUES (:u, '旧版本建的课', 'topic', 'learning', 'standard', false, now())"
        ), {"u": pg_user.uuid})
        db.execute(text(
            "INSERT INTO learning_recommendations (user_uuid, title, rationale, status, generation, created_at, updated_at) "
            "VALUES (:u, '旧版本的推荐', '理由', 'suggested', 1, now(), now())"
        ), {"u": pg_user.uuid})
        db.commit()
        assert db.query(Course).filter_by(user_uuid=pg_user.uuid).one().language == "zh"
        assert db.query(LearningRecommendation).filter_by(user_uuid=pg_user.uuid).one().language == "zh"

    for bad in ("fr", "EN", ""):
        with Session(pg_engine) as db, pytest.raises(IntegrityError):
            db.add(Course(user_uuid=pg_user.uuid, name="x", language=bad))
            db.commit()
        with Session(pg_engine) as db, pytest.raises(IntegrityError):
            db.add(LearningRecommendation(user_uuid=pg_user.uuid, title="x", rationale="y", language=bad))
            db.commit()


def test_an_english_course_and_its_recommendations_round_trip_on_postgres(pg_client, pg_engine, pg_user):
    with fake_model():
        created = pg_client.post(
            "/api/courses", json={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
        )
    assert created.status_code == 200, created.text
    assert created.json()["language"] == "en"
    assert [(c["name"], c["language"]) for c in pg_client.get("/api/courses").json()] == [("Compound interest", "en")]
    with Session(pg_engine) as db:
        assert db.query(Course).filter_by(user_uuid=pg_user.uuid).one().language == "en"

    payload = (
        '[{"title": "Rates", "rationale": "You studied interest.", "bridge": "It builds on it.", "source_topics": []},'
        ' {"title": "Inflation", "rationale": "You studied interest.", "bridge": "It builds on it.", "source_topics": []},'
        ' {"title": "Annuities", "rationale": "You studied interest.", "bridge": "It builds on it.", "source_topics": []}]'
    )
    with patch("app.recommendations._call_llm", return_value=payload):
        res = pg_client.post("/api/recommendations/refresh", json={"locale": "en"})
    assert res.status_code == 200, res.text
    assert [r["language"] for r in res.json()["recommendations"]] == ["en"] * 3
