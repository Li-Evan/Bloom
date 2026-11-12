"""知识地图读取不再每次把课文正文读出来：分块指纹缓存在 lessons.knowledge_digest，用数据库算的 md5 判断是否作废。"""
import json

from sqlalchemy import event

from app import knowledge
from app.models import Course, Lesson
from tests.conftest import TestSession, create_user, engine
from tests.unit.test_knowledge_map import TEXT, extraction, lesson_for, refresh, sync


def head_reads(client, user):
    """读一次地图，返回其中把正文开头（HEAD_CHARS 那么长）读出来的语句数。"""
    statements = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        if 'substr(lessons.content' in statement and knowledge.HEAD_CHARS in (parameters or ()):
            if 'md5(' not in statement:
                statements.append(statement)

    event.listen(engine, 'before_cursor_execute', capture)
    try:
        state = refresh(client, user)
    finally:
        event.remove(engine, 'before_cursor_execute', capture)
    return state, len(statements)


def digest_of(lesson_id):
    with TestSession() as db:
        raw = db.query(Lesson.knowledge_digest).filter(Lesson.id == lesson_id).scalar()
        return json.loads(raw) if raw else None


def test_the_second_read_uses_cached_fingerprints_without_reading_the_text(client):
    user = create_user('digest-cache@example.com')
    _, lesson_id = lesson_for(user)
    first, reads = head_reads(client, user)
    assert reads == 1 and digest_of(lesson_id)['parts'] == [first['next_chunk']['fingerprint']]
    second, reads = head_reads(client, user)
    assert reads == 0
    assert second['queue'] == first['queue'] and second['pending_count'] == 1


def test_changed_text_or_course_name_invalidates_the_cache(client, monkeypatch):
    user = create_user('digest-change@example.com')
    course_id, lesson_id = lesson_for(user)
    monkeypatch.setattr(knowledge, 'extract_part', lambda course, text, known: extraction())
    before = refresh(client, user)
    assert sync(client, user, before['next_chunk']).status_code == 200
    assert refresh(client, user)['pending_count'] == 0

    with TestSession() as db:
        db.get(Lesson, lesson_id).content = TEXT + '\n\n新增一段讲混合策略的内容。'
        db.commit()
    changed, reads = head_reads(client, user)
    assert reads == 1 and changed['pending_count'] == 1
    assert changed['next_chunk']['fingerprint'] != before['next_chunk']['fingerprint']

    with TestSession() as db:
        db.get(Course, course_id).name = '博弈论入门'
        db.commit()
    renamed, reads = head_reads(client, user)
    assert reads == 1 and renamed['next_chunk']['fingerprint'] != changed['next_chunk']['fingerprint']
    assert digest_of(lesson_id)['parts'] == [renamed['next_chunk']['fingerprint']]


def test_cached_fingerprints_match_what_sync_computes(client, monkeypatch):
    """缓存给出的指纹必须和 sync 从正文现算的一致，否则同步会一直报「课文已变化」。"""
    user = create_user('digest-sync@example.com')
    long_text = '# 长课文\n' + '\n'.join(f'第 {i} 段：' + '纳什均衡与最佳回应。' * 60 for i in range(60))
    lesson_for(user, text=long_text)
    refresh(client, user)
    cached, reads = head_reads(client, user)
    assert reads == 0 and len(cached['queue']) > 1
    monkeypatch.setattr(knowledge, 'extract_part', lambda course, text, known: {'concepts': [], 'omitted_concepts': []})
    for chunk in cached['queue']:
        assert sync(client, user, chunk).status_code == 200, chunk
    assert refresh(client, user)['pending_count'] == 0


def test_a_failed_cache_write_still_returns_the_map(client, monkeypatch, caplog):
    user = create_user('digest-failure@example.com')
    _, lesson_id = lesson_for(user)
    original = knowledge.save_digests

    def failing(db, digests):
        def broken():
            raise RuntimeError('database is read-only')
        db.commit = broken
        original(db, digests)

    monkeypatch.setattr(knowledge, 'save_digests', failing)
    with caplog.at_level('WARNING'):
        state = refresh(client, user)
    assert state['pending_count'] == 1
    assert digest_of(lesson_id) is None
    assert 'could not cache chunk fingerprints' in caplog.text
