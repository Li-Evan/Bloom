import json
from datetime import datetime, timedelta, timezone

import pytest

from app import knowledge
from app.models import Course, KnowledgeChunk, LearningEvent, Lesson
from tests.conftest import TestSession, bearer, create_user

TEXT = '# 纳什均衡\n纳什均衡描述每个人都没有单方面改变策略的动机。最佳回应是在对方策略不变时选择自己的最佳策略。'


def course_with(user, *contents, name='博弈论', **lesson_fields):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name=name, language='zh')
        db.add(course); db.flush()
        ids = []
        for number, content in enumerate(contents, 1):
            lesson = Lesson(course_id=course.id, number=number, content=content, **lesson_fields)
            db.add(lesson); db.flush(); ids.append(lesson.id)
            db.add(LearningEvent(course_id=course.id, lesson_number=number, event_type='lesson_completed'))
        db.commit()
        return course.id, ids


def concept(key, label, source_id='s0', **fields):
    return {'key': key, 'label': label, 'summary': f'{label}的说明。', 'domain': 'mathematics', 'source_id': source_id, **fields}


def graph(*concepts):
    return json.dumps({'concepts': list(concepts)}, ensure_ascii=False)


def get_map(client, user):
    response = client.get('/api/knowledge-map', headers=bearer(user))
    assert response.status_code == 200, response.text
    return response.json()


def sync(client, user, part):
    return client.post('/api/knowledge-map/sync', headers=bearer(user), json=part)


def fake_model(monkeypatch, *outputs):
    calls = []
    answers = iter(outputs)
    monkeypatch.setattr(knowledge, '_call_llm', lambda *args, **kwargs: calls.append(args[1]) or next(answers))
    return calls


def test_single_line_json_fence_is_parsed():
    raw = '```json ' + graph(concept('nash-equilibrium', '纳什均衡')) + '```'
    assert [c['key'] for c in knowledge.parse_extraction(raw, TEXT, [])['concepts']] == ['nash-equilibrium']


def test_one_invalid_concept_is_dropped_without_a_second_call(client, monkeypatch):
    user = create_user('kf-drop@example.com'); course_with(user, TEXT)
    calls = fake_model(monkeypatch, graph(concept('best-response', '最佳回应', 's999'), concept('game-equilibrium', '博弈均衡')))
    assert sync(client, user, get_map(client, user)['next_chunk']).status_code == 200
    assert len(calls) == 1
    assert [n['id'] for n in get_map(client, user)['nodes']] == ['game-equilibrium']
    with TestSession() as db:
        stored = json.loads(db.query(KnowledgeChunk).one().graph)
    assert stored['omitted_concepts'] == [{'index': 0, 'reason': 'unsupported_evidence'}]


def test_excess_concepts_and_long_fields_are_truncated_instead_of_failing():
    long_label, long_summary = '长' * 100, '说' * 400
    items = [concept(f'Concept Number {i}', f'概念{i}') for i in range(10)]
    items[0].update(label=long_label, summary=long_summary)
    parsed = knowledge.parse_extraction(graph(*items), TEXT, [])
    assert len(parsed['concepts']) == knowledge.MAX_CONCEPTS
    assert parsed['concepts'][0]['key'] == 'concept-number-0'
    assert parsed['concepts'][0]['label'] == long_label[:70] and parsed['concepts'][0]['summary'] == long_summary[:300]
    assert [o['reason'] for o in parsed['omitted_concepts']] == ['over_limit', 'over_limit']


def test_unusable_output_gets_exactly_one_repair(monkeypatch):
    calls = fake_model(monkeypatch, '不是 JSON', graph(concept('nash-equilibrium', '纳什均衡')))
    parsed = knowledge.extract_part(Course(name='博弈论', language='zh'), TEXT, [])
    assert len(calls) == 2 and 'supplied source_ids' in calls[1]
    assert parsed['concepts'][0]['quote'].startswith('# 纳什均衡')


def test_prompt_and_map_no_longer_carry_unused_connections(client, monkeypatch):
    user = create_user('kf-edges@example.com'); course_with(user, TEXT)
    calls = fake_model(monkeypatch, json.dumps({'concepts': [concept('nash-equilibrium', '纳什均衡')],
                                                'connections': [{'source': 'x', 'target': 'y', 'label': 'z', 'source_id': 's9'}]}))
    assert 'connections' not in knowledge.PROMPT
    assert sync(client, user, get_map(client, user)['next_chunk']).status_code == 200
    result = get_map(client, user)
    assert len(calls) == 1 and 'edges' not in result and len(result['nodes']) == 1


def test_a_failing_chunk_backs_off_and_the_next_chunk_moves_on(client, monkeypatch):
    user = create_user('kf-backoff@example.com'); _, (first, second) = course_with(user, TEXT, '# 第二篇\n最佳回应是在对方策略不变时选择自己的最佳策略。')
    def fail(*args): raise RuntimeError('provider down')
    monkeypatch.setattr(knowledge, 'extract_part', fail)
    failing = get_map(client, user)['next_chunk']
    assert failing['lesson_id'] == first
    response = sync(client, user, failing)
    assert response.status_code == 502 and 'provider down' in response.json()['detail']

    state = get_map(client, user)
    assert state['next_chunk']['lesson_id'] == second
    assert state['failed_count'] == 1 and state['pending_count'] == 2
    retried = sync(client, user, failing)
    assert retried.status_code == 429 and retried.json()['detail'] == knowledge.CHUNK_RETRY_LATER
    assert 0 < int(retried.headers['Retry-After']) <= 5 * 60 + 1

    with TestSession() as db:
        row = db.get(KnowledgeChunk, (first, 0))
        stored = json.loads(row.graph)
        assert row.fingerprint == '' and stored['failure']['attempts'] == 1
        stored['failure']['retry_at'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        row.graph = json.dumps(stored); db.commit()
    assert get_map(client, user)['next_chunk'] == failing
    assert sync(client, user, failing).status_code == 502
    with TestSession() as db:
        failure = json.loads(db.get(KnowledgeChunk, (first, 0)).graph)['failure']
    assert failure['attempts'] == 2
    wait = datetime.fromisoformat(failure['retry_at']) - datetime.now(timezone.utc)
    assert timedelta(minutes=9) < wait <= timedelta(minutes=10)


def test_no_transaction_is_open_while_the_model_runs_and_a_concurrent_sync_gets_409(client, monkeypatch):
    from sqlalchemy import event
    user = create_user('kf-lease@example.com'); course_with(user, TEXT)
    part = get_map(client, user)['next_chunk']
    sessions, seen = [], {}
    record = lambda session, transaction, connection: sessions.append(session)
    event.listen(TestSession, 'after_begin', record)

    def model(*args, **kwargs):
        seen['open'] = [s for s in sessions if s.in_transaction()]
        seen['second'] = sync(client, user, part)
        seen['map'] = get_map(client, user)
        return graph(concept('nash-equilibrium', '纳什均衡'))
    monkeypatch.setattr(knowledge, '_call_llm', model)
    try:
        assert sync(client, user, part).json()['updated'] is True
    finally:
        event.remove(TestSession, 'after_begin', record)
    assert seen['open'] == []
    assert seen['second'].status_code == 409 and seen['second'].json()['detail'] == knowledge.MAP_BUSY
    assert seen['map']['queue'] == [] and seen['map']['pending_count'] == 1
    with TestSession() as db:
        assert 'lease' not in json.loads(db.query(KnowledgeChunk).one().graph)


def test_a_crashed_lease_expires_and_the_chunk_is_mapped_again(client, monkeypatch):
    user = create_user('kf-crash@example.com'); _, (lesson,) = course_with(user, TEXT)
    part = get_map(client, user)['next_chunk']
    with TestSession() as db:
        until = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        db.add(KnowledgeChunk(lesson_id=lesson, part_index=0, fingerprint='', graph=json.dumps({'concepts': [], 'lease': {'ref': 'x', 'until': until}})))
        db.commit()
    assert get_map(client, user)['queue'] == [part]
    fake_model(monkeypatch, graph(concept('nash-equilibrium', '纳什均衡')))
    assert sync(client, user, part).json()['updated'] is True


def test_lesson_changed_during_inference_gives_the_chunk_back(client, monkeypatch):
    user = create_user('kf-changed@example.com'); _, (lesson,) = course_with(user, TEXT)
    part = get_map(client, user)['next_chunk']

    def model(*args, **kwargs):
        with TestSession() as db:
            db.get(Lesson, lesson).content = '# 改过\n课文在整理期间被重新生成了。'; db.commit()
        return graph(concept('nash-equilibrium', '纳什均衡'))
    monkeypatch.setattr(knowledge, '_call_llm', model)
    response = sync(client, user, part)
    assert response.status_code == 409 and response.json()['detail'] == knowledge.LEARNING_CHANGED
    with TestSession() as db:
        row = db.query(KnowledgeChunk).one()
        assert row.fingerprint == '' and 'lease' not in json.loads(row.graph)
    assert get_map(client, user)['queue'][0]['lesson_id'] == lesson


def test_sync_returns_the_topics_it_added_in_the_map_shape(client, monkeypatch):
    user = create_user('kf-nodes@example.com'); course_id, _ = course_with(user, TEXT)
    fake_model(monkeypatch, graph(concept('nash-equilibrium', '纳什均衡'), concept('best-response', '最佳回应')))
    added = sync(client, user, get_map(client, user)['next_chunk']).json()['nodes']
    assert added == get_map(client, user)['nodes']
    assert added[0]['sources'][0] == {'course_id': course_id, 'course_name': '博弈论', 'lesson_number': 1,
                                      'lesson_title': '纳什均衡', 'quote': added[0]['sources'][0]['quote']}


def test_the_map_hands_out_a_bounded_queue_of_pending_chunks(client, monkeypatch):
    monkeypatch.setattr(knowledge, 'QUEUE_LIMIT', 2)
    user = create_user('kf-queue@example.com'); course_with(user, TEXT, TEXT + '二', TEXT + '三')
    state = get_map(client, user)
    assert len(state['queue']) == 2 and state['queue'][0] == state['next_chunk'] and state['pending_count'] == 3


def test_extra_concept_fields_are_ignored_and_a_repair_names_the_rejected_fields(monkeypatch):
    parsed = knowledge.parse_extraction(graph(concept('nash-equilibrium', '纳什均衡', confidence=0.9, quote='模型自己写的')), TEXT, [])
    assert parsed['concepts'][0]['quote'].startswith('# 纳什均衡') and 'confidence' not in parsed['concepts'][0]
    calls = fake_model(monkeypatch, graph({'key': 'nash-equilibrium', 'label': '纳什均衡'}), graph(concept('nash-equilibrium', '纳什均衡')))
    knowledge.extract_part(Course(name='博弈论', language='zh'), TEXT, [])
    assert "'reason': 'invalid_fields', 'fields': ['domain', 'source_id', 'summary']" in calls[1]


def test_an_over_long_english_sentence_is_cut_at_a_word_boundary():
    words = ' '.join(f'word{i}' for i in range(120)) + '.'
    passages = list(knowledge.source_passages(words).values())
    assert len(passages) > 1 and all(len(p) <= knowledge.PASSAGE_CHARS + 1 for p in passages)
    assert passages[0].endswith('…') and passages[0][:-1].split(' ')[-1] in words.split(' ')
    assert passages[1].startswith('…word') and ' '.join(p.strip('…') for p in passages) == words


def test_known_concepts_are_bounded_and_relevant_to_this_chunk():
    user = create_user('kf-known@example.com')
    (current, (lesson,)), (_, (other_lesson,)) = course_with(user, TEXT), course_with(user, "# 其他", name="谈判")
    with TestSession() as db:
        same = [{'key': f'same-{i}', 'label': f'本课概念{i}', 'summary': 's', 'domain': 'mathematics', 'quote': 'q'} for i in range(60)]
        db.add(KnowledgeChunk(lesson_id=lesson, part_index=0, fingerprint='a' * 64, graph=json.dumps({'concepts': same})))
        elsewhere = [{'key': 'best-response', 'label': '最佳回应', 'summary': 's', 'domain': 'mathematics', 'quote': 'q'},
                     {'key': 'batna', 'label': 'BATNA', 'summary': 's', 'domain': 'society', 'quote': 'q'}]
        db.add(KnowledgeChunk(lesson_id=other_lesson, part_index=0, fingerprint='b' * 64, graph=json.dumps({'concepts': elsewhere})))
        db.commit()
        known = knowledge.known_concepts(db, user.uuid, current, TEXT)
    ids = [k['id'] for k in known]
    assert len(known) == knowledge.MAX_KNOWN and ids[0] == 'best-response' and 'batna' not in ids
    assert set(known[0]) == {'id', 'label', 'domain', 'summary'}


def test_sync_never_rebuilds_the_whole_map(client, monkeypatch):
    user = create_user('kf-nomap@example.com'); course_with(user, TEXT)
    part = get_map(client, user)['next_chunk']
    fake_model(monkeypatch, graph(concept('nash-equilibrium', '纳什均衡')))
    monkeypatch.setattr(knowledge, 'map_state', lambda *args: pytest.fail('sync rebuilt the full map'))
    result = sync(client, user, part).json()
    assert result['updated'] is True and [n['id'] for n in result['nodes']] == ['nash-equilibrium']


def test_lesson_titles_are_read_once_per_lesson(client, monkeypatch):
    user = create_user('kf-titles@example.com'); course_with(user, TEXT)
    fake_model(monkeypatch, graph(concept('nash-equilibrium', '纳什均衡'), concept('best-response', '最佳回应')))
    assert sync(client, user, get_map(client, user)['next_chunk']).status_code == 200
    seen = []
    original = knowledge._extract_title
    monkeypatch.setattr(knowledge, '_extract_title', lambda text: seen.append(text) or original(text))
    nodes = get_map(client, user)['nodes']
    assert len(nodes) == 2 and len(seen) == 1
    assert {n['sources'][0]['lesson_title'] for n in nodes} == {'纳什均衡'}


@pytest.mark.parametrize('lesson_name,course_name,expected', [('docs/reports/annual.pdf', None, 'annual.pdf'), (None, 'book.pdf', 'book.pdf')])
def test_untitled_source_lessons_are_named_after_their_file(client, monkeypatch, lesson_name, course_name, expected):
    user = create_user('kf-pdf@example.com')
    plain = '纳什均衡描述每个人都没有单方面改变策略的动机。最佳回应是在对方策略不变时选择自己的最佳策略。'
    course_id, _ = course_with(user, plain, is_source=True, source_filename=lesson_name)
    with TestSession() as db:
        db.get(Course, course_id).source_filename = course_name; db.commit()
    fake_model(monkeypatch, json.dumps({'concepts': [concept('nash-equilibrium', '纳什均衡')]}))
    assert sync(client, user, get_map(client, user)['next_chunk']).status_code == 200
    assert get_map(client, user)['nodes'][0]['sources'][0]['lesson_title'] == expected


def test_a_huge_upload_is_mapped_from_its_opening_chunks_only(client, monkeypatch):
    user = create_user('kf-huge@example.com')
    paragraph = '一段实际读过的长内容，用来测试分块。\n'
    _, (lesson,) = course_with(user, paragraph * 20000)
    state = get_map(client, user)
    assert state['pending_count'] == knowledge.MAX_PARTS
    fake_model(monkeypatch, *[graph(concept(f'part-{i}', f'部分{i}')) for i in range(knowledge.MAX_PARTS)])
    while (part := get_map(client, user)['next_chunk']):
        assert sync(client, user, part).status_code == 200
    with TestSession() as db:
        db.get(Lesson, lesson).content += '\n后面追加的内容不会让已整理的部分失效。'; db.commit()
    assert get_map(client, user)['pending_count'] == 0


def test_long_english_passages_end_at_sentence_boundaries():
    sentence = 'Opportunity cost is the value of the best alternative you give up when you choose. '
    passages = knowledge.source_passages(sentence * 12)
    assert len(passages) == 12
    assert all(p.endswith('choose.') for p in passages.values())
