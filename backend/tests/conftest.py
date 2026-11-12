import os

os.environ.setdefault("BACKEND_JWT_SECRET", "test-jwt-secret-only-for-unit-tests-0123456789")
# 测试绝不连真实模型网关：开发者本机 .env 里的网关地址和钥匙一律换成本机不可达的地址。补丁只在 with 块里生效，
# 生成下一篇的后台线程（lesson-tail / answers-check）可能在补丁撤掉之后才拿客户端。
os.environ["LLM_BASE_URL"] = "http://127.0.0.1:9/v1"
os.environ["LLM_API_KEY"] = "sk-unit-tests-offline"
os.environ["LLM_MODEL"] = "test-model"
os.environ["LLM_FAST_MODEL"] = ""
os.environ["PDF_READING_MODEL"] = ""
# 测试绝不把 trace 发到开发者本机 .env 里配置的 Langfuse 项目；要测 tracing 的用例自己打开并替换客户端。
os.environ["LANGFUSE_TRACING_ENABLED"] = "false"

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from jose import jwt
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.database as app_database
from app.config import settings
from app.main import app as fastapi_app
from app.database import Base, get_db
from app.models import Annotation, Course, Feedback, LearningEvent, Lesson, Syllabus, User

engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def override_get_db():
    db = TestSession()
    try:
        yield db
    finally:
        db.close()


fastapi_app.dependency_overrides[get_db] = override_get_db
app_database.SessionLocal = TestSession


@pytest.fixture(autouse=True)
def no_llm_extra_body(monkeypatch):
    """开发者本机的 .env 里可能设了 LLM_EXTRA_BODY（比如给 DeepSeek 关推理）：测试默认当它没设，需要的测试自己设。"""
    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", {})


@pytest.fixture(autouse=True)
def no_llm_reasoning_extra_body(monkeypatch):
    """同上：开发者本机的 .env 里可能设了 LLM_REASONING_EXTRA_BODY（参考答案核对单独打开推理），测试默认当它没设。"""
    monkeypatch.setattr(settings, "LLM_REASONING_EXTRA_BODY", {})


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client():
    return TestClient(fastapi_app)


def stream_chunk(content):
    """假的流式分片，形状同 openai 的 ChatCompletionChunk：只有 choices[0].delta.content（和 usage）。

    别用 MagicMock 造分片：MagicMock 访问任何属性都返回真值对象，会被 _stream_llm 当成 Agent 心跳（agent_heartbeat）丢掉正文。
    """
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content), finish_reason=None)], usage=None)


def mock_stream(chunks, end=True):
    """一次流式回复：每段文字一个分片，end=True 时最后再补一个 content=None 的收尾分片。"""
    return iter([stream_chunk(text) for text in chunks] + ([stream_chunk(None)] if end else []))


def make_token(sub, scope="user", email=None, exp_delta=timedelta(minutes=15), *, secret=None, iss="bloom-frontend"):
    now = datetime.now(timezone.utc)
    claims = {"iss": iss, "sub": sub, "scope": scope, "iat": now, "exp": now + exp_delta}
    if email:
        claims["email"] = email
    return jwt.encode(claims, secret or settings.BACKEND_JWT_SECRET, algorithm="HS256")


def create_user(email, **fields):
    with TestSession() as db:
        row = User(uuid=str(uuid.uuid4()), email=email, **fields)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def bearer(row):
    return {"Authorization": f"Bearer {make_token(row.uuid, email=row.email)}"}


def seed_course(owner_uuid, name="种子课程"):
    with TestSession() as db:
        course = Course(user_uuid=owner_uuid, name=name, mode="topic", status="learning")
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content="# 种子大纲\n\n- [ ] 能够解释概念"))
        lesson = Lesson(
            course_id=course.id, number=1, content="# 第一章\n\n正文\n\n## 思考题\n\n1. 问题？", source_blob=b"%PDF",
        )
        db.add(lesson)
        db.add(Lesson(course_id=course.id, number=0, content="# 总结"))
        db.flush()
        annotation = Annotation(
            lesson_id=lesson.id, position_start=0, position_end=2, original_text="正文", comment="这是什么？", answer="答案",
        )
        db.add(annotation)
        db.add(Feedback(lesson_id=lesson.id, content="已有反馈", thought_answers=""))
        db.add_all([
            LearningEvent(course_id=course.id, lesson_number=1, event_type="lesson_opened"),
            LearningEvent(course_id=course.id, lesson_number=1, event_type="annotation_answered"),
        ])
        db.commit()
        return course.id, annotation.id


def seed_source_course(client, filename, text, *, name="", syllabus="# 大纲\n\n- [ ] 能够解释概念",
                       learning_depth="standard", language="zh", blob=None, headers=None):
    """已下线的「我的资料」建出的原文课：照当年建课写进库里的样子存原文、大纲和第 -1 篇原文，返回课程详情。
    课程归 headers（默认 client 自带的请求头）里令牌的用户。"""
    from app.courses import _readable_course_name, _record_event

    headers = headers or {}
    token = (headers.get("Authorization") or client.headers["Authorization"]).split(" ", 1)[1]
    owner = jwt.get_unverified_claims(token)["sub"]
    with TestSession() as db:
        course = Course(
            user_uuid=owner, name=name.strip() or _readable_course_name(filename), mode="source", status="learning",
            learning_depth=learning_depth, language=language, source_filename=filename, source_content=text,
        )
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content=syllabus))
        db.add(Lesson(course_id=course.id, number=-1, content=text, is_source=True, source_filename=filename, source_blob=blob))
        _record_event(db, course.id, "source_course_created")
        _record_event(db, course.id, "source_lesson_created", lesson_number=-1)
        db.commit()
        course_id = course.id
    res = client.get(f"/api/courses/{course_id}", headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


@pytest.fixture
def user():
    return create_user("user@example.com", nickname="Test User", avatar_url="https://img.example.com/u.png", locale="en")


@pytest.fixture
def auth_headers(user):
    return bearer(user)


@pytest.fixture
def other_user():
    return create_user("other@example.com", nickname="Other User")


@pytest.fixture
def other_headers(other_user):
    return bearer(other_user)


@pytest.fixture
def authed_client(user, auth_headers):
    return TestClient(fastapi_app, headers=auth_headers)


@pytest.fixture(autouse=True)
def legacy_llm_call_contract(monkeypatch):
    """Old fixtures return Markdown on every call; adaptive integration tests opt in to JSON planning."""
    monkeypatch.setattr(settings, "ADAPTIVE_TEACHING", False)
