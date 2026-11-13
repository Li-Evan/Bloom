import json
from unittest.mock import patch

import httpx
import pytest
from openai import APITimeoutError

from app import courses
from app.models import Course, Lesson, Syllabus
from tests.conftest import TestSession, bearer


def payload():
    return json.dumps([{'title': f'Topic {i}', 'rationale': 'Reason', 'bridge': 'Bridge', 'source_topics': []} for i in range(3)])


def timeout(cause):
    exc = APITimeoutError(request=httpx.Request('POST', 'https://model.test'))
    exc.__cause__ = cause('upstream unavailable')
    return exc


def test_connect_timeout_is_not_reported_as_large_material():
    result = courses.model_failure(timeout(httpx.ConnectTimeout))
    assert result.status_code == 503
    assert result.detail == '没能连接模型服务，请稍后重试。（原因：model provider did not answer in time (upstream unavailable)）'


def test_read_timeout_does_not_blame_user_material():
    result = courses.model_failure(timeout(httpx.ReadTimeout))
    assert result.status_code == 504
    assert '资料' not in result.detail
    assert result.detail.startswith(courses.MODEL_FAILURE_DETAIL)


@pytest.mark.parametrize('failure', [timeout(httpx.ConnectTimeout), timeout(httpx.ReadTimeout), RuntimeError('down')])
def test_failed_refresh_preserves_cards_and_saved_list(authed_client, user, failure):
    with patch('app.recommendations._call_llm', return_value=payload()):
        created = authed_client.post('/api/recommendations/refresh').json()['recommendations']
    assert authed_client.post(f"/api/recommendations/{created[0]['id']}/save").status_code == 200
    before = authed_client.get('/api/recommendations').json()
    with patch('app.recommendations._call_llm', side_effect=failure):
        failed = authed_client.post('/api/recommendations/refresh')
    assert failed.status_code in (502, 503, 504)
    assert authed_client.get('/api/recommendations').json() == before


@pytest.mark.parametrize('raw', ['not json', '[]', payload()], ids=['not-json', 'empty', 'only-already-suggested'])
def test_invalid_results_do_not_replace_existing_recommendations(authed_client, user, raw):
    with patch('app.recommendations._call_llm', return_value=payload()):
        assert authed_client.post('/api/recommendations/refresh').status_code == 200
    before = authed_client.get('/api/recommendations').json()
    with patch('app.recommendations._call_llm', return_value=raw):
        assert authed_client.post('/api/recommendations/refresh').status_code == 502
    assert authed_client.get('/api/recommendations').json() == before


def test_profile_does_not_send_original_document(authed_client, user):
    secret_source = 'RAW_DOCUMENT_SENTINEL ' * 10000
    with TestSession() as db:
        course = Course(name='Reference course', user_uuid=user.uuid, learning_depth='standard', language='zh')
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content='# Outline\n- [ ] Understand a concept'))
        db.add(Lesson(course_id=course.id, number=-1, content=secret_source, is_source=True))
        db.commit()
    with patch('app.recommendations._call_llm', return_value=payload()) as call:
        result = authed_client.post('/api/recommendations/refresh')
    assert result.status_code == 200, result.text
    assert 'RAW_DOCUMENT_SENTINEL' not in call.call_args.args[1]
    assert len(call.call_args.args[1]) < 3000


def test_other_user_cannot_save_or_start_recommendation(authed_client, other_user):
    with patch('app.recommendations._call_llm', return_value=payload()):
        rec = authed_client.post('/api/recommendations/refresh').json()['recommendations'][0]
    headers = bearer(other_user)
    assert authed_client.post(f"/api/recommendations/{rec['id']}/save", headers=headers).status_code == 404
    assert authed_client.post(f"/api/recommendations/{rec['id']}/start", headers=headers, json={}).status_code == 404
