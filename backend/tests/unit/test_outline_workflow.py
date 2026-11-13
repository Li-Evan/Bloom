"""Outline confirmation and source format regression coverage."""
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app import courses
from app.models import Course, Lesson, Syllabus
from tests.conftest import TestSession, bearer, create_user, seed_source_course

OUTLINE = '# Course\n\n## 核心掌握项\n- [ ] 能够解释概念\n\n## 学习进度\n| 课文 | 覆盖掌握项 | 生成日期 |\n|---|---|---|'
LESSON = '# First lesson\n\n## 正文内容\nA concrete explanation.\n\n## 思考题\n1. Why?\n<!-- mastery: 能够解释概念 -->'


def create(client):
    with patch.object(courses, '_call_llm', return_value=OUTLINE) as model:
        response = client.post('/api/courses', json={'name': 'Outline course'})
    assert response.status_code == 200, response.text
    assert model.call_count == 1
    assert response.json()['lesson_count'] == 0
    return response.json()['id']


def test_outline_only_edit_then_first_and_retry(authed_client):
    client = authed_client
    cid = create(client)
    assert client.get(f'/api/courses/{cid}/lessons').json() == []
    edited = OUTLINE.replace('Course', 'Edited course')
    assert client.put(f'/api/courses/{cid}/syllabus', json={'content': edited}).status_code == 200
    with patch.object(courses, '_call_llm', return_value=LESSON) as model:
        first = client.post(f'/api/courses/{cid}/first')
        repeat = client.post(f'/api/courses/{cid}/first')
    assert first.status_code == repeat.status_code == 200
    assert first.json()['number'] == 1
    assert first.json()['is_source'] is False
    assert model.call_count == 1
    assert 'Edited course' in model.call_args.args[0]
    assert client.put(f'/api/courses/{cid}/syllabus', json={'content': edited}).status_code == 409
    assert client.post(f'/api/courses/{cid}/syllabus/regenerate', json={'content': 'simpler'}).status_code == 409


def test_regenerate_uses_ideas_and_keeps_no_lessons(authed_client):
    cid = create(authed_client)
    revised = OUTLINE.replace('概念', '基础概念')
    with patch.object(courses, '_call_llm', return_value=revised) as model:
        res = authed_client.post(f'/api/courses/{cid}/syllabus/regenerate', json={'content': 'Explain basics'})
    assert res.status_code == 200
    assert 'Explain basics' in model.call_args.args[1]
    assert authed_client.get(f'/api/courses/{cid}/lessons').json() == []


def test_failed_regeneration_preserves_outline(authed_client):
    cid = create(authed_client)
    with patch.object(courses, '_call_llm', side_effect=RuntimeError('offline')):
        res = authed_client.post(f'/api/courses/{cid}/syllabus/regenerate', json={'content': 'simpler'})
    assert res.status_code >= 400
    assert authed_client.get(f'/api/courses/{cid}/syllabus').json()['content'] == OUTLINE


def test_changed_outline_rejects_stale_first_lesson(authed_client):
    cid = create(authed_client)
    def changed(*args, **kwargs):
        with TestSession() as db:
            db.query(Syllabus).filter_by(course_id=cid).one().content = OUTLINE + '\nnew requirements'
            db.commit()
        return LESSON
    with patch.object(courses, '_call_llm', side_effect=changed):
        res = authed_client.post(f'/api/courses/{cid}/first')
    assert res.status_code == 409
    assert authed_client.get(f'/api/courses/{cid}/lessons').json() == []


def test_source_markdown_is_reference_not_lesson(authed_client):
    created = seed_source_course(authed_client, 'source.md', '# Original\n\n**Bold** and 中文', syllabus=OUTLINE)
    assert created['lesson_count'] == 0
    cid = created['id']
    source = authed_client.get(f'/api/courses/{cid}/lessons/-1').json()
    assert source['content'] == '# Original\n\n**Bold** and 中文'
    assert source['source_filename'] == 'source.md'
    assert source['is_source'] is True
    with patch.object(courses, '_generate_first_content', return_value=LESSON):
        first = authed_client.post(f'/api/courses/{cid}/first')
    assert first.status_code == 200
    assert first.json()['number'] == 1
    assert authed_client.get(f'/api/courses/{cid}').json()['lesson_count'] == 1


def test_pdf_keeps_original_bytes(authed_client):
    raw = b'%PDF-1.7 original document'
    cid = seed_source_course(authed_client, 'paper.pdf', 'Readable source', syllabus=OUTLINE, blob=raw)['id']
    assert authed_client.get(f'/api/courses/{cid}/lessons/-1/file').content == raw
    assert authed_client.get(f'/api/courses/{cid}/lessons/-1').json()['source_filename'] == 'paper.pdf'


@pytest.mark.parametrize('encoding', ['utf-8-sig', 'utf-16', 'gb18030'])
def test_text_encoding(encoding):
    assert courses._decode_text_bytes('标题\n内容'.encode(encoding)) == '标题\n内容'


def test_binary_in_text_is_rejected():
    with pytest.raises(HTTPException):
        courses._decode_text_bytes(b'garbage\x00text')


def test_other_owner_cannot_change_or_start(authed_client):
    cid = create(authed_client)
    other = create_user('outline-other@example.com')
    for path in ['first', 'syllabus/regenerate']:
        res = authed_client.post(f'/api/courses/{cid}/{path}', headers=bearer(other), json={'content': 'change'})
        assert res.status_code == 404


def test_source_following_lesson_uses_previous_lesson_without_original(authed_client):
    from tests.unit.test_courses import _mock_stream
    from unittest.mock import MagicMock
    cid = seed_source_course(authed_client, 'note.md', '# UniqueSource\nOriginalEvidence987', syllabus=OUTLINE)['id']
    with patch.object(courses, '_generate_first_content', return_value=LESSON.replace('<!-- mastery: 能够解释概念 -->', '')):
        assert authed_client.post(f'/api/courses/{cid}/first').status_code == 200
    model = MagicMock()
    model.chat.completions.create.return_value = _mock_stream(['# Next\n\n## 正文内容\nMore context.\n\n## 思考题\n1. Why?'])
    with patch.object(courses, 'get_openai_client', return_value=model):
        response = authed_client.post(f'/api/courses/{cid}/next')
    assert response.status_code == 200
    prompt = model.chat.completions.create.call_args.kwargs['messages'][0]['content']
    assert 'OriginalEvidence987' not in prompt
    assert LESSON.splitlines()[0] in prompt


def test_legacy_source_only_course_moves_reference_on_start(authed_client):
    cid = create(authed_client)
    with TestSession() as db:
        course = db.get(Course, cid)
        course.mode = 'source'
        course.source_content = 'Legacy original'
        db.add(Lesson(course_id=cid, number=1, content='Legacy original', is_source=True))
        db.commit()
    with patch.object(courses, '_generate_first_content', return_value=LESSON):
        response = authed_client.post(f'/api/courses/{cid}/first')
    assert response.status_code == 200
    assert response.json()['is_source'] is False
    assert authed_client.get(f'/api/courses/{cid}/lessons/-1').json()['is_source'] is True
