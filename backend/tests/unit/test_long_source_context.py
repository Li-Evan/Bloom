import json

import pytest

from app import courses, teaching
from app.config import settings
from app.models import Course, Lesson, Syllabus
from tests.conftest import TestSession


@pytest.mark.parametrize('adaptive', [False, True])
@pytest.mark.parametrize('previous_number', [1, 3])
def test_next_uses_only_complete_previous_lesson_and_preserves_source(
    authed_client, user, monkeypatch, adaptive, previous_number,
):
    monkeypatch.setattr(settings, 'ADAPTIVE_TEACHING', adaptive)
    source = 'ORIGINAL_SOURCE_MUST_NOT_ENTER_NEXT\n' + '原文资料。' * 42000
    previous = '# 上一篇\n## 正文内容\n' + '已有课文内容。' * 15000 + '\nPREVIOUS_LESSON_END\n## 思考题\n1. 为什么分母要一致？\n2. 如何确定分母？'
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name='Refunds', mode='source', source_filename='original.md', source_content=source)
        db.add(course)
        db.flush()
        cid = course.id
        db.add(Syllabus(course_id=cid, content='# 退款\n- [ ] 能够解释退款率分母'))
        db.add(Lesson(course_id=cid, number=-1, content=source, is_source=True))
        for number in range(1, previous_number):
            db.add(Lesson(course_id=cid, number=number, content=f'# EARLIER_LESSON_MUST_NOT_ENTER_NEXT_{number}'))
        db.add(Lesson(course_id=cid, number=previous_number, content=previous))
        db.commit()
    if adaptive:
        response = authed_client.post(f'/api/courses/{cid}/lessons/{previous_number}/feedback', json={
            'content': '以后都用电商订单解释退款率分母。', 'scope': 'course', 'thought_answers': '',
        })
        assert response.status_code == 200
    captured = []

    def assert_context(value):
        assert 'ORIGINAL_SOURCE_MUST_NOT_ENTER_NEXT' not in value
        assert 'EARLIER_LESSON_MUST_NOT_ENTER_NEXT' not in value
        assert 'PREVIOUS_LESSON_END' in value

    def call(system, message, **kwargs):
        assert_context(message)
        if system == teaching.PLANNER_PROMPT:
            payload = json.loads(message)
            assert payload['previous_lesson'] == previous
            ids = [r['id'] for r in payload['feedback_records']]
            return json.dumps(dict(action='repair', focus='退款率分母', requirements=['用电商订单解释'], max_words=None,
                                   applied_feedback_ids=ids, persistent_feedback_ids=ids, unresolved_feedback_ids=[]))
        assert system == teaching.REVIEW_PROMPT
        assert json.loads(message)['source_material'] == previous
        captured.append('review')
        return '{"issues": [], "edits": []}'

    def stream(system, message, **kwargs):
        assert_context(system)
        assert previous in system
        if adaptive:
            assert '电商订单' in system
        captured.append('generation')
        yield '# 退款率\n## 正文内容\n分母是同一批订单。\n## 思考题\n1. 为什么分母要一致？\n2. 如何确定分母？', True

    monkeypatch.setattr(courses, '_call_llm', call)
    monkeypatch.setattr(courses, '_stream_llm', stream)
    response = authed_client.post(f'/api/courses/{cid}/next')
    assert '"done": true' in response.text, response.text
    assert captured == (['generation', 'review'] if adaptive else ['generation'])
    with TestSession() as db:
        assert db.get(Course, cid).source_content == source
        assert db.query(Lesson).filter_by(course_id=cid, number=-1).one().content == source
        assert db.query(Lesson).filter_by(course_id=cid, number=previous_number + 1).count() == 1
