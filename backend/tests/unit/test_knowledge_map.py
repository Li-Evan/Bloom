import json
from types import SimpleNamespace as NS

import pytest
from app import knowledge
from app.config import settings
from app.models import Course, Feedback, KnowledgeChunk, LearningEvent, Lesson
from tests.conftest import TestSession, bearer, create_user

TEXT = '# 纳什均衡\n纳什均衡描述每个人都没有单方面改变策略的动机。最佳回应是在对方策略不变时选择自己的最佳策略。'


def lesson_for(user, *, read=True, text=TEXT, name='博弈论'):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name=name, language='zh')
        db.add(course); db.flush()
        lesson = Lesson(course_id=course.id, number=1, content=text)
        db.add(lesson); db.flush()
        if read:
            db.add(LearningEvent(course_id=course.id, lesson_number=1, event_type='lesson_completed'))
        db.commit()
        return course.id, lesson.id


def extraction():
    return {'concepts': [
        {'key': 'nash-equilibrium', 'label': '纳什均衡', 'summary': '没有人能通过单方面改变策略获益。', 'domain': 'mathematics', 'quote': '纳什均衡描述每个人都没有单方面改变策略的动机'},
        {'key': 'best-response', 'label': '最佳回应', 'summary': '对方策略不变时的最优选择。', 'domain': 'mathematics', 'quote': '最佳回应是在对方策略不变时选择自己的最佳策略'},
    ]}


def model_extraction():
    graph = extraction()
    passages = knowledge.source_passages(TEXT)
    for item in graph['concepts']:
        quote = item.pop('quote')
        item['source_id'] = next(key for key, value in passages.items() if quote in value)
    return graph


def refresh(client, user):
    response = client.get('/api/knowledge-map', headers=bearer(user))
    assert response.status_code == 200
    return response.json()


def sync(client, user, part):
    return client.post('/api/knowledge-map/sync', headers=bearer(user), json=part)


def test_new_learner_has_no_world_tree(client):
    user = create_user('map-new@example.com')
    lesson_for(user, read=False)
    result = refresh(client, user)
    assert result['nodes'] == [] and result['courses'] == []
    assert result['pending_count'] == result['read_lessons'] == 0


def test_only_completed_content_is_extracted_and_only_once(client, monkeypatch):
    user = create_user('map-read@example.com')
    _, lesson_id = lesson_for(user)
    calls = []
    monkeypatch.setattr(knowledge, 'extract_part', lambda course, text, known: calls.append(text) or extraction())
    before = refresh(client, user)
    assert before['read_lessons'] == 1 and before['pending_count'] == 1
    assert before['nodes'] == []
    assert sync(client, user, before['next_chunk']).status_code == 200
    assert sync(client, user, before['next_chunk']).json() == {'updated': False, 'nodes': []}
    after = refresh(client, user)
    assert {n['id'] for n in after['nodes']} == {'nash-equilibrium', 'best-response'}
    assert after['pending_count'] == 0 and len(calls) == 1
    assert after['nodes'][0]['sources'][0]['lesson_number'] == 1
    with TestSession() as db:
        assert db.get(KnowledgeChunk, (lesson_id, 0)) is not None


def test_feedback_counts_as_previous_learning(client, monkeypatch):
    user = create_user('map-feedback@example.com')
    _, lesson_id = lesson_for(user, read=False)
    with TestSession() as db:
        db.add(Feedback(lesson_id=lesson_id, content='我读完了')); db.commit()
    assert refresh(client, user)['read_lessons'] == 1


def test_cross_course_same_concept_shares_one_node(client, monkeypatch):
    user = create_user('map-merge@example.com')
    lesson_for(user, name='博弈论'); lesson_for(user, name='纳什均衡')
    monkeypatch.setattr(knowledge, 'extract_part', lambda *args: extraction())
    while (part := refresh(client, user)['next_chunk']):
        assert sync(client, user, part).status_code == 200
    result = refresh(client, user)
    assert len(result['nodes']) == 2 and 'edges' not in result
    assert len(result['nodes'][0]['sources']) == 2


def test_other_users_cannot_read_or_sync_learning(client, monkeypatch):
    owner, stranger = create_user('map-owner@example.com'), create_user('map-stranger@example.com')
    lesson_for(owner)
    part = refresh(client, owner)['next_chunk']
    monkeypatch.setattr(knowledge, 'extract_part', lambda *args: extraction())
    assert sync(client, stranger, part).status_code == 404
    assert refresh(client, stranger)['nodes'] == []
    assert refresh(client, stranger)['pending_count'] == 0
    assert client.get('/api/knowledge-map').status_code == 401


def test_failure_is_visible_and_remains_retryable(client, monkeypatch):
    user = create_user('map-failure@example.com'); lesson_for(user)
    def fail(*args): raise TimeoutError('provider timeout')
    monkeypatch.setattr(knowledge, 'extract_part', fail)
    part = refresh(client, user)['next_chunk']
    failed = sync(client, user, part)
    assert failed.status_code == 504
    assert failed.json()['detail'] == '知识地图暂时未能更新，已有学习记录已保留，请稍后重试（原因：TimeoutError: provider timeout）'
    assert refresh(client, user)['pending_count'] == 1
    with TestSession() as db:
        assert db.query(KnowledgeChunk).filter(KnowledgeChunk.fingerprint != '').count() == 0


def test_changed_or_deleted_source_cannot_leave_stale_topics(client, monkeypatch):
    user = create_user('map-change@example.com'); course_id, lesson_id = lesson_for(user)
    monkeypatch.setattr(knowledge, 'extract_part', lambda *args: extraction())
    old = refresh(client, user)['next_chunk']; assert sync(client, user, old).status_code == 200
    with TestSession() as db:
        db.get(Lesson, lesson_id).content = '# 新内容\n这篇课文已经重新生成，需要重新提取知识。'; db.commit()
    assert refresh(client, user)['nodes'] == []
    assert refresh(client, user)['pending_count'] == 1
    assert sync(client, user, old).status_code == 409
    with TestSession() as db:
        db.delete(db.get(Course, course_id)); db.commit()
    assert refresh(client, user)['nodes'] == []


def test_large_sources_are_all_chunked_instead_of_truncated(client):
    user = create_user('map-large@example.com')
    content = '一段实际读过的长内容。\n' * 4000
    lesson_for(user, text=content)
    parts = knowledge.text_chunks(content)
    assert len(parts) > 1 and max(map(len, parts)) <= knowledge.CHUNK_SIZE
    assert ''.join(parts).replace('\n', '') == content.replace('\n', '')
    assert refresh(client, user)['pending_count'] == len(parts)


@pytest.mark.parametrize('field,value,reason', [
    ('source_id', 's999', 'unsupported_evidence'),
    ('domain', 'made-up-domain', 'unknown_domain'),
])
def test_unknown_domains_and_unsupported_evidence_ids_are_dropped_and_recorded(field, value, reason):
    result = model_extraction(); result['concepts'][0][field] = value
    parsed = knowledge.parse_extraction(json.dumps(result), TEXT, [])
    assert [c['key'] for c in parsed['concepts']] == ['best-response']
    assert parsed['omitted_concepts'] == [{'index': 0, 'reason': reason}]
    for item in result['concepts']:
        item[field] = value
    with pytest.raises(ValueError): knowledge.parse_extraction(json.dumps(result), TEXT, [])


def test_duplicate_identities_are_dropped_and_recorded():
    result = model_extraction(); result['concepts'][1]['label'] = '纳什均衡'
    parsed = knowledge.parse_extraction(json.dumps(result), TEXT, [])
    assert [c['key'] for c in parsed['concepts']] == ['nash-equilibrium']
    assert parsed['omitted_concepts'] == [{'index': 1, 'reason': 'duplicate_identity'}]


def test_shared_display_name_does_not_merge_distinct_meanings():
    result = {'concepts':[{'key':'java-island','label':'Java','summary':'An island in Indonesia.', 'domain':'geography','source_id':'s0'}], 'connections':[]}
    parsed = knowledge.parse_extraction(json.dumps(result), 'Java is an island in Indonesia.',
                                        [{'id':'java-programming-language','label':'Java','domain':'technology'}])
    assert parsed['concepts'][0]['key'] == 'java-island'


@pytest.mark.parametrize('blank', ['one', 'all'])
def test_whitespace_evidence_ids_cannot_create_unsupported_nodes(client, monkeypatch, blank):
    user = create_user(f'map-blank-{blank}@example.com'); lesson_for(user)
    result = model_extraction()
    for item in result['concepts'][:1 if blank == 'one' else None]:
        item['source_id'] = '      '
    monkeypatch.setattr(knowledge, '_call_llm', lambda *args, **kwargs: json.dumps(result))
    response = sync(client, user, refresh(client, user)['next_chunk'])
    state = refresh(client, user)
    with TestSession() as db:
        rows = db.query(KnowledgeChunk).filter(KnowledgeChunk.fingerprint != '').all()
    if blank == 'one':
        assert response.status_code == 200 and state['pending_count'] == 0
        assert [n['id'] for n in state['nodes']] == ['best-response']
        assert json.loads(rows[0].graph)['omitted_concepts'] == [{'index': 0, 'reason': 'unsupported_evidence'}]
    else:
        assert response.status_code == 502 and rows == []
        assert state['nodes'] == [] and state['failed_count'] == 1


def test_extraction_is_one_call_on_the_fast_model(monkeypatch):
    monkeypatch.setattr(settings, 'LLM_FAST_MODEL', 'fast-model')
    observed = []
    def model(*args, **kwargs):
        observed.append(kwargs['model'])
        return json.dumps(model_extraction())
    monkeypatch.setattr(knowledge, '_call_llm', model)
    parsed = knowledge.extract_part(Course(name='测试', language='zh'), TEXT, [])
    assert len(parsed['concepts']) == 2 and observed == ['fast-model']


def test_map_always_extracts_with_the_fast_model_whatever_the_teaching_model(client, monkeypatch):
    monkeypatch.setattr(settings, 'LLM_MODEL', 'teaching-model')
    monkeypatch.setattr(settings, 'LLM_FAST_MODEL', 'fast-model')
    owner = create_user('map-first-owner@example.com')
    other = create_user('map-second-owner@example.com')
    lesson_for(owner); lesson_for(other)
    observed = []
    def model(*args, **kwargs):
        observed.append(kwargs['model'])
        if len(observed) == 1:
            return 'invalid JSON; retry within the same request'
        return json.dumps(model_extraction())
    monkeypatch.setattr(knowledge, '_call_llm', model)
    assert sync(client, owner, refresh(client, owner)['next_chunk']).status_code == 200
    assert sync(client, other, refresh(client, other)['next_chunk']).status_code == 200
    # the owner's first output was unusable: its repair uses the same extractor
    assert observed == ['fast-model', 'fast-model', 'fast-model']


def test_courses_list_most_recently_studied_first_with_read_counts(client):
    from datetime import datetime
    user = create_user('map-recent@example.com')
    older, _ = lesson_for(user, name='先学的课')
    newer, _ = lesson_for(user, name='后学的课')
    with TestSession() as db:
        db.add(LearningEvent(course_id=older, lesson_number=2, event_type='lesson_completed'))
        db.add(Lesson(course_id=older, number=2, content=TEXT))
        db.add(LearningEvent(course_id=older, lesson_number=1, event_type='lesson_opened', created_at=datetime(2099, 1, 1)))
        db.commit()
    assert refresh(client, user)['courses'] == [
        {'id': older, 'name': '先学的课', 'read_lessons': 2}, {'id': newer, 'name': '后学的课', 'read_lessons': 1}]


def no_usable_concept():
    graph = model_extraction()
    for item in graph['concepts']:
        item['source_id'] = 's999'
    return json.dumps(graph)


@pytest.mark.parametrize('unusable', ['不是 JSON', no_usable_concept()], ids=['not-json', 'no-usable-concept'])
def test_one_unusable_model_output_is_repaired_once(client, monkeypatch, unusable):
    user = create_user('map-repair@example.com'); lesson_for(user)
    responses = iter([unusable, json.dumps(model_extraction())]); calls = []
    def model(*args, **kwargs):
        calls.append({'timeout':kwargs['timeout'],'prompt':args[1]})
        return next(responses)
    monkeypatch.setattr(knowledge, '_call_llm', model)
    assert sync(client, user, refresh(client, user)['next_chunk']).status_code == 200
    assert len(calls) == 2
    assert 0 < calls[1]['timeout'] <= calls[0]['timeout'] <= knowledge.EXTRACTION_SECONDS
    assert 'supplied source_ids' in calls[1]['prompt']
    assert ('Invalid JSON' if unusable == '不是 JSON' else "'reason': 'unsupported_evidence'") in calls[1]['prompt']
    result = refresh(client, user)
    assert result['pending_count'] == 0 and len(result['nodes']) == 2


def test_host_copies_markdown_and_punctuation_instead_of_model_rewriting_quotes():
    text = '**过程级评估**：依据评分标准检查轨迹中的中间步骤，判断它们是否可靠。\n\n公式为 `score(step)`，不应被改写。'
    graph = {'concepts':[{'key':'process-evaluation','label':'过程级评估','summary':'检查中间步骤。','domain':'technology','source_id':'s0'}],'connections':[]}
    parsed = knowledge.parse_extraction(json.dumps(graph), text, [])
    assert parsed['concepts'][0]['quote'] == text.split('\n\n')[0]
    graph['concepts'][0]['quote'] = '模型不能自行生成引用'
    assert knowledge.parse_extraction(json.dumps(graph), text, [])['concepts'][0]['quote'] == text.split('\n\n')[0]


USAGE = {'prompt_tokens': 1000, 'completion_tokens': 500}


def gateway(monkeypatch, *outputs):
    """The real model path: _call_llm runs against a fake provider that reports token usage."""
    import app.courses as courses
    answers = iter(outputs)

    def create(**kwargs):
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return NS(id='r', usage=USAGE, choices=[NS(message=NS(content=answer), finish_reason='stop')])
    monkeypatch.setattr(courses, 'get_openai_client', lambda **kw: NS(chat=NS(completions=NS(create=create)), close=lambda: None))


def test_a_map_update_through_the_gateway_maps_the_chunk_once(client, monkeypatch):
    user = create_user('map-paid@example.com'); lesson_for(user)
    gateway(monkeypatch, json.dumps(model_extraction()))
    part = refresh(client, user)['next_chunk']
    assert sync(client, user, part).json()['updated'] is True
    assert sync(client, user, part).json() == {'updated': False, 'nodes': []}  # already mapped: no second model call
    state = refresh(client, user)
    assert state['pending_count'] == 0 and len(state['nodes']) == 2


def test_a_failed_extraction_is_reported_and_counted_as_failed(client, monkeypatch):
    user = create_user('map-failed@example.com'); lesson_for(user)
    gateway(monkeypatch, RuntimeError('provider down'))
    assert sync(client, user, refresh(client, user)['next_chunk']).status_code == 502
    assert refresh(client, user)['failed_count'] == 1
