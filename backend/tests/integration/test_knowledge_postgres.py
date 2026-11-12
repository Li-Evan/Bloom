"""Knowledge-map concurrency against an explicitly supplied isolated Postgres."""
import json
import os
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import knowledge
from app.models import Course, KnowledgeChunk, LearningEvent, Lesson
from tests.integration.pg import pg_engine, pg_user, run_all, run_concurrently  # noqa: F401

# ruff: noqa: F811

pytestmark = [pytest.mark.postgres, pytest.mark.skipif(not os.getenv('TEST_DATABASE_URL'), reason='Requires isolated Postgres')]

TEXT = '# 纳什均衡\n纳什均衡描述每个人都没有单方面改变策略的动机。最佳回应是在对方策略不变时选择自己的最佳策略。'


def answer(*args, **kwargs):
    return json.dumps({'concepts': [{'key': 'nash-equilibrium', 'label': '纳什均衡', 'summary': '没人想单方面改变。',
                                     'domain': 'mathematics', 'source_id': 's0'}]}, ensure_ascii=False)


def read_course(engine, user_uuid, lessons=1):
    with Session(engine) as db:
        course = Course(user_uuid=user_uuid, name='博弈论', language='zh')
        db.add(course); db.flush()
        for number in range(1, lessons + 1):
            db.add(Lesson(course_id=course.id, number=number, content=TEXT + '。' * number))
            db.add(LearningEvent(course_id=course.id, lesson_number=number, event_type='lesson_completed'))
        db.commit()
        return course.id


def queue(engine, user_uuid):
    with Session(engine) as db:
        return knowledge.map_state(db, user_uuid)['queue']


def sync(part, user_uuid):
    def work(db):
        try:
            return knowledge.sync_map(knowledge.SyncChunk(**part), SimpleNamespace(uuid=user_uuid), db)
        except HTTPException as exc:
            return exc.status_code, exc.detail
    return work


@pytest.fixture
def owned(pg_engine, pg_user):
    yield pg_user
    with Session(pg_engine) as db:
        db.query(Course).filter(Course.user_uuid == pg_user).delete(); db.commit()


def test_the_same_chunk_synced_twice_at_once_is_mapped_once(pg_engine, owned, monkeypatch):
    read_course(pg_engine, owned)
    part = queue(pg_engine, owned)[0]
    calls = []
    monkeypatch.setattr(knowledge, '_call_llm', lambda *a, **k: calls.append(1) or time.sleep(0.5) or answer())
    results = run_concurrently(pg_engine, 2, sync(part, owned))
    assert [r['updated'] for r in results if isinstance(r, dict)] == [True]
    assert [r for r in results if not isinstance(r, dict)] == [(409, knowledge.MAP_BUSY)]
    assert len(calls) == 1


def test_nothing_is_locked_or_left_in_a_transaction_while_the_model_runs(pg_engine, owned, monkeypatch):
    read_course(pg_engine, owned)
    part = queue(pg_engine, owned)[0]
    seen = {}

    def model(*args, **kwargs):
        with pg_engine.connect() as conn:
            seen['idle_in_transaction'] = conn.execute(text(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'")).scalar()
            seen['locked'] = len(conn.execute(text(
                'SELECT lesson_id FROM knowledge_chunks WHERE lesson_id = :l FOR UPDATE NOWAIT'), {'l': part['lesson_id']}).all())
            seen['users'] = len(conn.execute(text('SELECT id FROM users WHERE uuid = :u FOR UPDATE NOWAIT'), {'u': owned}).all())
            conn.rollback()
        return answer()
    monkeypatch.setattr(knowledge, '_call_llm', model)
    with Session(pg_engine) as db:
        assert sync(part, owned)(db)['updated'] is True
    assert seen == {'idle_in_transaction': 0, 'locked': 1, 'users': 1}


def test_deleting_the_course_cascades_the_cache(pg_engine, owned, monkeypatch):
    monkeypatch.setattr(knowledge, '_call_llm', answer)
    course_id = read_course(pg_engine, owned)
    with Session(pg_engine) as db:
        assert sync(queue(pg_engine, owned)[0], owned)(db)['updated'] is True
    with Session(pg_engine) as db:
        lessons = [row.id for row in db.query(Lesson.id).filter(Lesson.course_id == course_id)]
        assert db.query(KnowledgeChunk).filter(KnowledgeChunk.lesson_id.in_(lessons)).count() == 1
        db.query(Course).filter(Course.id == course_id).delete(); db.commit()
        assert db.query(KnowledgeChunk).filter(KnowledgeChunk.lesson_id.in_(lessons)).count() == 0


def test_a_lease_left_by_a_crashed_request_expires(pg_engine, owned, monkeypatch):
    read_course(pg_engine, owned)
    part = queue(pg_engine, owned)[0]
    release = threading.Event()
    monkeypatch.setattr(knowledge, '_call_llm', lambda *a, **k: release.wait(5) and answer())
    def hold():
        with Session(pg_engine) as db:
            sync(part, owned)(db)
    holder = threading.Thread(target=hold)
    holder.start()
    try:
        deadline = time.monotonic() + 5
        while queue(pg_engine, owned) and time.monotonic() < deadline:
            time.sleep(0.05)
        with Session(pg_engine) as db:
            assert sync(part, owned)(db) == (409, knowledge.MAP_BUSY)
            state = knowledge.map_state(db, owned)
            assert state['queue'] == [] and state['pending_count'] == 1
            row = db.get(KnowledgeChunk, (part['lesson_id'], 0))
            graph = json.loads(row.graph)
            graph['lease']['until'] = '2000-01-01T00:00:00+00:00'
            row.graph = json.dumps(graph); db.commit()
        assert queue(pg_engine, owned) == [part]
    finally:
        release.set()
        holder.join()
