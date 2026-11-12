import pytest

from app import teaching


def controls(text, target=3, record_target=3):
    return teaching.explicit_controls([{'id': 1, 'content': text, 'target_lesson': record_target}], target)


def planned(text, action='advance', requirements=('用零售的例子讲解',)):
    plan = teaching.TeachingPlan(action=action, focus='x', requirements=list(requirements))
    return teaching.apply_controls(plan, controls(text), 'zh')


@pytest.mark.parametrize('text', [
    '我已经理解了，不需要练习，继续下一个概念',
    '这篇懂了，别再出练习题了，直接讲新内容吧',
    'I understand it now. No more practice please, move on to the next concept.',
    'No more practice please, move on',
    'Great lesson, I like that you follow best practices. Continue to the next topic.',
])
def test_declining_practice_or_asking_to_move_on_never_forces_consolidation(text):
    assert controls(text)['requested_action'] == 'advance'
    assert planned(text, action='advance').action == 'advance'


@pytest.mark.parametrize('text', ['不需要练习', 'I don’t need practice', "Stop practicing, I'm fine"])
def test_a_negated_practice_request_leaves_the_planner_decision(text):
    assert controls(text)['requested_action'] is None
    assert planned(text, action='advance').action == 'advance'


@pytest.mark.parametrize('text,action', [
    ('我懂了，多做点练习巩固一下', 'consolidate'),
    ('I want more practice', 'consolidate'),
    ("Let's practice more, not move on yet", 'consolidate'),
    ('继续下一个概念', 'advance'),
    ('我还没懂，先别往下讲', 'repair'),
    ("I don't understand, do not move on", 'repair'),
    ('我不理解为什么第二题要这样算，不过整体可以继续推进', 'repair'),
])
def test_affirmative_requests_keep_their_authority(text, action):
    assert controls(text)['requested_action'] == action


def test_a_lesson_target_mismatch_sets_no_action():
    assert controls('多做点练习', target=4, record_target=3)['requested_action'] is None


@pytest.mark.parametrize('text,avoided', [
    ("Please don't use a finance example", 'finance'),
    ('不要再用电商例子了', '电商'),
    ('别用金融例子', '金融'),
    ('别再用金融的例子', '金融'),
    ('不要使用金融例子', '金融'),
    ('Avoid using finance examples', 'finance'),
])
def test_a_refused_example_domain_is_avoided_not_forced(text, avoided):
    result = controls(text)
    assert result['example_context'] is None and result['avoid_examples'] == [avoided]
    requirements = planned(text).requirements
    assert requirements[0] == '用零售的例子讲解'
    assert requirements[-1] == f'本篇例子不要使用用户明确拒绝的「{avoided}」情境。'


@pytest.mark.parametrize('text,used,avoided', [
    ('不要用医疗的例子，用电商例子', '电商', ['医疗']),
    ('Stop using the sports example; use a cooking example', 'cooking', ['sports']),
    ('以后都用电商例子', '电商', []),
    ('Please use the retail example', 'retail', []),
    ('我们不妨用电商例子', '电商', []),
])
def test_affirmative_example_requests_still_set_the_domain(text, used, avoided):
    result = controls(text)
    assert result['example_context'] == used and result['avoid_examples'] == avoided


def test_an_unrelated_negation_earlier_in_the_clause_neither_forces_nor_avoids():
    result = controls('我不太懂第二题用电商例子讲一下')
    assert result['example_context'] is None and result['avoid_examples'] == []


def test_a_later_refusal_cancels_an_earlier_ongoing_domain_and_vice_versa():
    records = [{'content': '以后都用电商例子', 'target_lesson': 2}, {'content': '不要再用电商例子了，以后用医疗例子', 'target_lesson': 3}]
    result = teaching.explicit_controls(records, 3)
    assert result['example_context'] == '医疗' and result['avoid_examples'] == ['电商']
    records.append({'content': '还是用电商例子吧', 'target_lesson': 3})
    result = teaching.explicit_controls(records, 3)
    assert result['example_context'] == '电商' and result['avoid_examples'] == []


def test_english_avoid_requirement_is_written_in_english():
    plan = teaching.TeachingPlan(action='advance', focus='x')
    result = teaching.apply_controls(plan, controls("Please don't use a finance example"), 'en')
    assert result.requirements == ['Do not use finance examples; the learner asked to avoid them.']
