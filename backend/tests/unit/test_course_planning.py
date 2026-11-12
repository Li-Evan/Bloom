import json

import pytest

from app import courses
from app.models import Course
from tests.conftest import TestSession


def analysis(questions=()):
    return json.dumps({'title': 'Agent 评测', 'summary': '能设计一套用于实际 Agent 的评测标准',
                       'assumptions': ['先按 Python 示例讲解'], 'questions': list(questions)}, ensure_ascii=False)


QUESTION = {'question': '你希望将 rubric 用在哪里？', 'options': ['给实际 Agent 做评测', '读懂论文']}


def test_goal_check_requires_authentication(client, monkeypatch):
    monkeypatch.setattr(courses, '_call_llm', lambda *a, **k: pytest.fail('must not call model'))
    assert client.post('/api/courses/clarify', json={'goal': 'LLM rubric'}).status_code == 401


def test_extra_suggested_choices_do_not_fail_an_otherwise_valid_question(authed_client, monkeypatch):
    question = {**QUESTION, 'options': ['实际评测', '人工审核', '偏好训练', '系统研究']}
    monkeypatch.setattr(courses, '_call_llm', lambda *a, **k: analysis([question]))
    response = authed_client.post('/api/courses/clarify', json={'goal': 'LLM rubric'})
    assert response.status_code == 200
    assert response.json()['questions'][0]['options'] == question['options'][:3]


def test_goal_clarification_preserves_answer_and_creates_no_course(authed_client, user, monkeypatch):
    seen = []
    def model(system, message, **kwargs):
        payload = json.loads(message)
        seen.append(payload)
        return analysis([] if payload['answers'] else [QUESTION])
    monkeypatch.setattr(courses, '_call_llm', model)
    first = authed_client.post('/api/courses/clarify', json={'goal': 'LLM rubric'}).json()
    assert first['questions'] == [QUESTION]
    answer = {'question': QUESTION['question'], 'answer': '给实际客服 Agent 做评测，我会 Python'}
    second = authed_client.post('/api/courses/clarify', json={'goal': 'LLM rubric', 'answers': [answer]}).json()
    assert second['questions'] == []
    assert seen[-1]['answers'] == [answer]
    with TestSession() as db:
        assert db.query(Course).count() == 0


@pytest.mark.parametrize('payload', [{'skip_questions': True}, {'answers': [{'question': '用途？', 'answer': '实际评测'}]}])
def test_no_second_round_of_questions_after_answer_or_skip(authed_client, monkeypatch, payload):
    replies = iter([analysis([QUESTION]), analysis()])
    monkeypatch.setattr(courses, '_call_llm', lambda *a, **k: next(replies))
    response = authed_client.post('/api/courses/clarify', json={'goal': 'LLM rubric', **payload})
    assert response.status_code == 200 and response.json()['questions'] == []


def test_unparseable_goal_response_fails_with_its_reason(authed_client, user, monkeypatch):
    monkeypatch.setattr(courses, '_call_llm', lambda *a, **k: 'not json')
    response = authed_client.post('/api/courses/clarify', json={'goal': 'LLM rubric'})
    assert response.status_code == 502
    assert response.json()['detail'].startswith('没能分析学习目标，请稍后重试（原因：ValidationError:')
    assert '积分' not in response.text


def test_curriculum_receives_goal_answers(authed_client, monkeypatch):
    captured = []
    outline = '# Agent 评测\n## 核心掌握项\n- [ ] 能设计评测标准\n## 学习进度\n| 课文 | 覆盖掌握项 | 生成日期 |\n|---|---|---|'
    def model(system, message, **kwargs):
        captured.append((system, message, kwargs))
        return outline
    monkeypatch.setattr(courses, '_call_llm', model)
    intent = {'goal': 'LLM rubric', 'summary': '设计客服 Agent 评测', 'assumptions': [],
              'answers': [{'question': '用途？', 'answer': '实际客服 Agent，已有 Python 基础'}]}
    response = authed_client.post('/api/courses', json={'name': 'Agent 评测', 'learning_intent': intent})
    assert response.status_code == 200, response.text
    assert '实际客服 Agent，已有 Python 基础' in captured[0][1]
    assert response.json()['lesson_count'] == 0
