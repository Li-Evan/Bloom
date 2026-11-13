import json

import pytest

from app import teaching
from app.models import Course, Lesson, TeachingFeedback
from tests.conftest import TestSession, create_user


def limit(text, target=2):
    return teaching.explicit_word_limit([{'content': text, 'target_lesson': 2}], target)


@pytest.mark.parametrize('text', [
    '每个例子不超过100字', '思考题回答控制在100字以内', '例子控制在200字以内',
    '以后每篇的例子不超过100字', 'Each answer within 50 words', 'keep every example under 80 words',
])
def test_a_cap_on_part_of_a_lesson_is_not_a_whole_lesson_cap(text):
    assert limit(text) == (False, None)
    assert teaching.explicit_controls([{'content': text, 'target_lesson': 2}], 2)['has_explicit_length_rule'] is False


@pytest.mark.parametrize('text,expected', [
    ('整篇不超过800字', 800), ('keep each lesson under 500 words', 500), ('以后每篇不超过800字', 800),
    ('From now on at most 700 words', 700), ('每个例子不超过100字，整篇不超过800字', 800),
    ('我还没懂，先别往下讲。以后都用电商例子，每篇不超过600字。', 600),
])
def test_whole_lesson_caps_are_still_enforced(text, expected):
    assert limit(text) == (True, expected)


def plan_json(**fields):
    return json.dumps({'action': 'repair', 'focus': '补讲', 'requirements': [], 'max_words': None, 'applied_feedback_ids': [],
                       'persistent_feedback_ids': [], 'unresolved_feedback_ids': [], **fields}, ensure_ascii=False)


@pytest.mark.parametrize('wrap', ['```json {}```', '```json\n{}\n```', '```{}```', '{}'])
def test_fenced_planner_output_is_parsed_even_on_one_line(wrap):
    assert teaching.parse_plan(wrap.replace('{}', plan_json()), []).action == 'repair'


def test_long_plans_and_reviews_no_longer_fail_the_lesson():
    plan = teaching.parse_plan(plan_json(focus='重' * 2000, requirements=[f'要求{i}' for i in range(15)], max_words=30000), [])
    assert len(plan.focus) == 2000 and len(plan.requirements) == 15 and plan.max_words == 30000
    draft = '\n'.join(f'第{i}段：' + '内容' * 3000 for i in range(10))
    review = teaching.TeachingReview.model_validate_json(teaching.strip_fence('```json ' + json.dumps({
        'issues': [f'问题{i}' for i in range(10)],
        'edits': [{'old': f'第{i}段：' + '内容' * 3000, 'new': f'第{i}段：已改'} for i in range(10)],
    }, ensure_ascii=False) + '```'))
    assert teaching.apply_review(draft, review).splitlines() == [f'第{i}段：已改' for i in range(10)]


def test_an_example_preference_keeps_every_other_requirement():
    plan = teaching.parse_plan(plan_json(requirements=[f'要求{i}' for i in range(9)]), [])
    controls = {'requested_action': None, 'example_context': '电商', 'has_explicit_length_rule': False, 'max_words': None}
    assert len(teaching.apply_controls(plan, controls, 'zh').requirements) == 10


def feedback_rows(count, size):
    user = create_user(f'teach-{count}-{size}@example.com')
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name='课', language='zh')
        db.add(course); db.flush()
        lesson = Lesson(course_id=course.id, number=1, content='# 一')
        db.add(lesson); db.flush()
        db.add_all(TeachingFeedback(course_id=course.id, lesson_id=lesson.id, target_lesson=2, content='要' * size,
                                    requested_scope='course', effective_scope='course') for _ in range(count))
        db.commit()
        return course.id


def test_many_active_feedback_records_are_still_planned():
    course_id = feedback_rows(150, 500)
    with TestSession() as db:
        assert len(teaching.snapshot(db, course_id, 2)) == 150


def test_an_extreme_feedback_history_is_planned_with_the_newest_records_that_fit():
    course_id = feedback_rows(150, 3000)
    with TestSession() as db:
        records = teaching.snapshot(db, course_id, 2)
    kept, omitted = teaching.bounded(records)
    assert len(records) == 150 and kept == records[-len(kept):] and omitted == 150 - len(kept) > 0
    assert len(json.dumps(kept, ensure_ascii=False)) <= teaching.PLANNER_FEEDBACK_CHARS


def test_a_single_huge_record_is_still_planned():
    records = [{'id': 1, 'content': '要' * (teaching.PLANNER_FEEDBACK_CHARS + 1)}]
    assert teaching.bounded(records) == (records, 0)


def test_rate_rules_are_subject_neutral():
    for text in (teaching.REVIEW_PROMPT, teaching.QUALITY_RULES['en']):
        assert 'refund' not in text.lower() and 'buyer' not in text.lower()
        assert 'same population' in text
    assert '退款' not in teaching.QUALITY_RULES['zh'] and '同一总体' in teaching.QUALITY_RULES['zh']
