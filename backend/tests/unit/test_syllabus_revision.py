from unittest.mock import patch

import httpx
from openai import APITimeoutError

from app import courses
from app.syllabus_revision import revision_reference, MAX_REFERENCE_CHARS
from tests.unit.test_outline_workflow import OUTLINE, create


def test_long_source_retrieval_searches_late_pages_and_keeps_locations():
    source = ''.join(f'<!-- page: {n} -->\n' + ('Background discussion. ' * 160) for n in range(1, 80))
    source += '<!-- page: 80 -->\nRareBehaviorAnchor: exact agent execution criteria.\n' * 40
    result = revision_reference(source, 'paper.pdf', OUTLINE, 'Focus on RareBehaviorAnchor agent execution')
    assert len(result) <= MAX_REFERENCE_CHARS
    assert 'RareBehaviorAnchor: exact agent execution criteria' in result
    assert 'page 80;' in result
    assert 'Source: paper.pdf' in result


def test_short_source_is_unchanged():
    assert revision_reference('# Title\nExact content', 'x.md', OUTLINE, 'simpler') == '# Title\nExact content'


def test_connection_timeout_recovers_with_one_saved_outline(authed_client):
    cid = create(authed_client)
    timeout = APITimeoutError(request=httpx.Request('POST', 'https://model.test'))
    timeout.__cause__ = httpx.ConnectTimeout('connect')
    with patch.object(courses, '_call_llm', side_effect=[timeout, OUTLINE+'\nchanged']) as call, patch.object(courses.time, 'sleep'):
        res = authed_client.post(f'/api/courses/{cid}/syllabus/regenerate', json={'content': 'focus on agents'})
    assert res.status_code == 200
    assert call.call_count == 2
    assert all(c.kwargs['max_retries'] == 0 and c.kwargs['fail_on_length'] for c in call.call_args_list)
    assert authed_client.get(f'/api/courses/{cid}/syllabus').json()['content'].endswith('changed')
    assert authed_client.get(f'/api/courses/{cid}/lessons').json() == []


def test_repeated_timeouts_preserve_outline(authed_client, user):
    cid = create(authed_client)
    timeout = APITimeoutError(request=httpx.Request('POST', 'https://model.test'))
    with patch.object(courses, '_call_llm', side_effect=timeout) as call, patch.object(courses.time, 'sleep'):
        res = authed_client.post(f'/api/courses/{cid}/syllabus/regenerate', json={'content': 'agents'})
    assert res.status_code == 504
    assert call.call_count == 3
    assert '缩短资料' not in res.json()['detail']
    assert authed_client.get(f'/api/courses/{cid}/syllabus').json()['content'] == OUTLINE
    assert authed_client.get(f'/api/courses/{cid}/lessons').json() == []


def test_connection_timeout_has_room_for_cold_network_but_obeys_call_cap():
    assert courses.get_openai_client().timeout.connect == 20
    assert courses.get_openai_client(timeout_cap=7).timeout.connect == 7


def test_unpaginated_markdown_never_invents_page_numbers():
    source = '# Notes\n\n' + 'Agent evaluation examples.\n' * 2500
    result = revision_reference(source, 'notes.md', OUTLINE, 'agent evaluation')
    assert 'page 1' not in result
    assert 'characters ' in result and 'Source: notes.md' in result
