import json

import pytest

from app import courses, teaching
from app.config import settings
from app.models import Course, Lesson, Syllabus, TeachingFeedback
from tests.conftest import TestSession


@pytest.fixture(autouse=True)
def adaptive(monkeypatch, legacy_llm_call_contract):
    monkeypatch.setattr(settings, 'ADAPTIVE_TEACHING', True)


@pytest.fixture
def seeded(user):
    with TestSession() as db:
        c = Course(user_uuid=user.uuid, name='Rates', language='zh')
        db.add(c); db.flush()
        db.add(Syllabus(course_id=c.id, content='# Rates\n## 核心掌握项\n- [ ] 能够区分百分点与相对变化\n- [ ] 能够解释退款指标'))
        db.add(Lesson(course_id=c.id, number=1, content='# 变化\n## 正文内容\n10%到12%是2个百分点，相对变化20%。\n## 思考题\n1. 5%到7%相对增加多少？\n<!-- mastery: 能够区分百分点与相对变化 -->'))
        db.commit(); return c.id


def save(client, cid, lesson=1, content='', scope='auto', answers=''):
    r = client.post(f'/api/courses/{cid}/lessons/{lesson}/feedback', json={'content': content, 'scope': scope, 'thought_answers': answers})
    assert r.status_code == 200, r.text
    with TestSession() as db:
        row = db.query(TeachingFeedback).filter_by(course_id=cid, status='active').order_by(TeachingFeedback.id.desc()).first()
        return row.id if row else None


def plan(ids, *, persistent=(), unresolved=(), action='repair', cap=None):
    return json.dumps(dict(action=action, focus='用电商解释百分点', requirements=['用电商例子；不要推进新概念'], max_words=cap,
                           applied_feedback_ids=list(ids), persistent_feedback_ids=list(persistent), unresolved_feedback_ids=list(unresolved)), ensure_ascii=False)


def mock_next(monkeypatch, output, content=None):
    captured = []
    monkeypatch.setattr(courses, '_call_llm', lambda system, user, **kw: (captured.append((system, user)) or (json.dumps({'issues': [], 'edits': []}) if system == teaching.REVIEW_PROMPT else output)))
    body = content or '# 补讲\n## 正文内容\n电商支付率10%到12%，差2个百分点，相对增加20%。\n## 思考题\n1. 5%到7%相对增加多少？\n2. 为什么用5%作基线？\n<!-- mastery: 能够区分百分点与相对变化 -->'
    def stream(system, user):
        captured.append((system, user)); yield body, False; yield body, True
    monkeypatch.setattr(courses, '_stream_llm', stream)
    return captured


def test_three_turns_persistent_temporary_exception_and_restore(authed_client, seeded, monkeypatch):
    cid = seeded
    first = save(authed_client, cid, content='以后都用电商例子，每篇不超过800字。这个概念还没懂。')
    mock_next(monkeypatch, plan([first], persistent=[first]))
    assert '"done": true' in authed_client.post(f'/api/courses/{cid}/next').text
    with TestSession() as db:
        assert db.get(TeachingFeedback, first).effective_scope == 'course'
        frozen = json.loads(db.query(Lesson).filter_by(course_id=cid, number=2).one().teaching_plan)
        assert frozen['plan']['action'] == 'repair' and frozen['plan']['max_words'] == 800
    temp = save(authed_client, cid, lesson=2, content='这篇不限字数，但仍用电商例子。', scope='next')
    mock_next(monkeypatch, plan([first, temp], action='consolidate'))
    assert '"done": true' in authed_client.post(f'/api/courses/{cid}/next').text
    with TestSession() as db:
        assert json.loads(db.query(Lesson).filter_by(course_id=cid, number=3).one().teaching_plan)['plan']['max_words'] is None
    captured = mock_next(monkeypatch, plan([first], action='advance'))
    assert '"done": true' in authed_client.post(f'/api/courses/{cid}/next').text
    request = json.loads(captured[0][1])
    assert [r['id'] for r in request['feedback_records']] == [first]
    with TestSession() as db:
        assert json.loads(db.query(Lesson).filter_by(course_id=cid, number=4).one().teaching_plan)['plan']['max_words'] == 800


def test_cancel_does_not_resurrect_from_last_feedback(authed_client, seeded, monkeypatch):
    rid = save(authed_client, seeded, content='以后每篇不超过100字', scope='course')
    assert authed_client.delete(f'/api/courses/{seeded}/teaching-feedback/{rid}').status_code == 200
    captured = mock_next(monkeypatch, 'not used')
    res = authed_client.post(f'/api/courses/{seeded}/next')
    assert '"done": true' in res.text
    assert len(captured) == 1  # no planning call, because cancelled records are not inputs
    assert '以后每篇不超过100字' not in captured[0][0]


def test_revision_and_cancel_win_over_old_generation_snapshot(authed_client, seeded):
    rid = save(authed_client, seeded, content='以后都用电商', scope='course')
    with TestSession() as db:
        old = teaching.snapshot(db, seeded, 2)
    new = save(authed_client, seeded, content='以后用游戏案例', scope='course')
    assert new != rid
    with TestSession() as db:
        teaching.commit_plan(db, seeded, teaching.TeachingPlan.model_validate_json(plan([rid], persistent=[rid])), old, 2)
        db.commit()
        assert db.get(TeachingFeedback, rid).status == 'superseded'
        assert db.get(TeachingFeedback, new).last_applied_lesson is None
    assert authed_client.get(f'/api/courses/{seeded}/lessons/1/feedback').json()['scope'] == 'course'


def test_clear_feedback_deactivates_persistent_record(authed_client, seeded):
    rid = save(authed_client, seeded, content='以后用电商', scope='course')
    save(authed_client, seeded)
    with TestSession() as db:
        assert db.get(TeachingFeedback, rid).status == 'superseded'
        assert teaching.snapshot(db, seeded, 2) == []


def test_ownership_applies_to_read_cancel_and_resolve(authed_client, client, other_headers, seeded):
    rid = save(authed_client, seeded, content='不懂')
    for method, path in [('get',''),('delete',f'/{rid}'),('post',f'/{rid}/resolve')]:
        assert getattr(client,method)(f'/api/courses/{seeded}/teaching-feedback{path}', headers=other_headers).status_code == 404


def test_unresolved_is_not_automatically_resolved_by_teacher(authed_client, seeded, monkeypatch):
    rid = save(authed_client, seeded, content='还是不理解，先不要推进')
    mock_next(monkeypatch, plan([rid], unresolved=[rid]))
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text
    items = authed_client.get(f'/api/courses/{seeded}/teaching-feedback').json()['items']
    assert items[0]['scope'] == 'unresolved'
    assert authed_client.post(f'/api/courses/{seeded}/teaching-feedback/{rid}/resolve').status_code == 200
    assert authed_client.get(f'/api/courses/{seeded}/teaching-feedback').json()['items'] == []


def test_invalid_plan_falls_back_to_generating_without_a_plan(authed_client, seeded, monkeypatch, user):
    # 规划器给出无效计划（引用了不存在的反馈）：不再 502，按无计划生成并照常保存；也不冻结任何计划
    rid = save(authed_client, seeded, content='这篇短一点', scope='next')
    mock_next(monkeypatch, plan([rid, 999999], persistent=[rid]))
    res = authed_client.post(f'/api/courses/{seeded}/next')
    assert res.status_code == 200 and '"done": true' in res.text and '"error"' not in res.text
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=seeded, number=2).one()
        assert lesson.teaching_plan is None


def test_summary_receives_actual_final_answers_and_unverified_rule(authed_client, seeded, monkeypatch):
    with TestSession() as db:
        db.add(Lesson(course_id=seeded, number=2, is_evaluation=True, content='<!-- eval-article -->\n# 综合\n1. 5%到7%相对变化多少？'))
        db.commit()
    rid = save(authed_client, seeded, lesson=2, answers='我的答案是2%，我不确定。')
    captured = mock_next(monkeypatch, plan([rid], action='consolidate'), '# 总结\n已经学习百分点。作答把2个百分点误认为相对2%，需要复习；其他能力未验证。')
    assert '"completed": true' in authed_client.post(f'/api/courses/{seeded}/next').text
    assert '我的答案是2%' in captured[-1][0]
    assert '没有作答就是未验证' in captured[-1][0]


@pytest.mark.parametrize('text,target,expected', [
    ('以后每篇不超过800字',2,(True,800)), ('From now on at most 700 words',2,(True,700)),
    ('这篇不限字数',2,(True,None)), ('这篇不限字数',3,(False,None)),
    ('每题不超过50字',2,(False,None)), ('每篇300字',2,(True,300)),
])
def test_numeric_constraints(text,target,expected):
    assert teaching.explicit_word_limit([{'content':text,'target_lesson':2}],target) == expected


def test_feedback_written_during_generation_is_deferred_not_lost(authed_client, seeded, monkeypatch):
    first = save(authed_client, seeded, content='以后用电商', scope='course')
    mock_next(monkeypatch, plan([first], persistent=[first]))
    original_stream = courses._stream_llm
    late = []
    def during(system, user):
        late.append(save(authed_client, seeded, content='下篇用游戏例子', scope='next'))
        yield from original_stream(system, user)
    monkeypatch.setattr(courses, '_stream_llm', during)
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text
    with TestSession() as db:
        row = db.get(TeachingFeedback, late[0])
        assert row.target_lesson == 3
        assert [r['id'] for r in teaching.snapshot(db,seeded,3)] == late


def test_resolve_difficulty_keeps_same_records_ongoing_style(authed_client,seeded,monkeypatch):
    rid=save(authed_client,seeded,content='以后都用电商，但这个概念还没懂')
    mock_next(monkeypatch,plan([rid],persistent=[rid],unresolved=[rid]))
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text
    row=authed_client.get(f'/api/courses/{seeded}/teaching-feedback').json()['items'][0]
    assert row['scope']=='course' and row['unresolved']
    assert authed_client.post(f'/api/courses/{seeded}/teaching-feedback/{rid}/resolve').status_code==200
    with TestSession() as db:
        row=db.get(TeachingFeedback,rid)
        assert row.status=='active' and row.effective_scope=='course' and row.difficulty_resolved
        assert not row.is_unresolved
        assert teaching.snapshot(db,seeded,3)[0]['difficulty_resolved']


def test_summary_does_not_reintroduce_cancelled_preferences(authed_client,seeded,monkeypatch):
    rid=save(authed_client,seeded,content='以后每篇最多10字',scope='course',answers='用户真实答案42')
    authed_client.delete(f'/api/courses/{seeded}/teaching-feedback/{rid}')
    with TestSession() as db:
        db.add(Lesson(course_id=seeded,number=2,is_evaluation=True,content='<!-- eval-article -->\n# Final'))
        db.commit()
    captured=mock_next(monkeypatch,'unused','# 总结\n尚未验证。')
    assert '"completed": true' in authed_client.post(f'/api/courses/{seeded}/next').text
    assert '以后每篇最多10字' not in captured[-1][0]
    assert '用户真实答案42' in captured[-1][0]


def test_summary_over_strict_limit_is_still_saved(authed_client,seeded,monkeypatch,user):
    # 超出学生明确的字数上限：压缩一次后仍超，也照样保存总结、完结课程，不丢弃
    with TestSession() as db:
        db.add(Lesson(course_id=seeded,number=2,is_evaluation=True,content='<!-- eval-article -->\n# Final'))
        db.commit()
    rid=save(authed_client,seeded,lesson=2,content='总结最多10字',scope='next')
    mock_next(monkeypatch,plan([rid],cap=10),'# 总结\n'+'超限内容'*100)
    result=authed_client.post(f'/api/courses/{seeded}/next')
    assert '"completed": true' in result.text and '"error"' not in result.text
    with TestSession() as db:
        assert db.get(Course,seeded).status=='completed'
        assert db.query(Lesson).filter_by(course_id=seeded,number=0).count()==1


def test_consumed_one_turn_instruction_never_resurrects(authed_client,seeded,monkeypatch):
    rid=save(authed_client,seeded,content='这篇用图书馆例子',scope='next')
    mock_next(monkeypatch,plan([rid]))
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text
    for number in (3,4,5):
        mock_next(monkeypatch,'unused')
        assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text
        with TestSession() as db:
            assert db.get(TeachingFeedback,rid).target_lesson==2
            assert teaching.snapshot(db,seeded,number+1)==[]


def test_explicit_ongoing_writing_survives_planner_omission_and_resolution(authed_client,seeded,monkeypatch):
    rid=save(authed_client,seeded,content='我还没懂，先别往下讲。以后都用电商例子，每篇不超过600字。')
    mock_next(monkeypatch,plan([rid],unresolved=[rid]))
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text
    assert authed_client.post(f'/api/courses/{seeded}/teaching-feedback/{rid}/resolve').status_code==200
    with TestSession() as db:
        record=db.get(TeachingFeedback,rid)
        assert record.status=='active' and record.effective_scope=='course'
        assert teaching.explicit_word_limit(teaching.snapshot(db,seeded,3),3)==(True,600)


def test_adaptive_draft_is_not_exposed_before_review(authed_client,seeded,monkeypatch):
    rid=save(authed_client,seeded,content='请先别往下讲，用电商例子',scope='next')
    bad='# 课文\n## 正文内容\n电商有24名买家，其中60名退款。\n## 思考题\n1. 应该检查什么？\n2. 比例是什么？'
    mock_next(monkeypatch,plan([rid]),bad)
    def call(system,user,**kw):
        if system==teaching.REVIEW_PROMPT:
            return json.dumps({'issues':['子集不能大于总体'],'edits':[{'old':'24名买家，其中60名退款','new':'24名买家，其中3名退款'}]},ensure_ascii=False)
        return plan([rid])
    monkeypatch.setattr(courses,'_call_llm',call)
    response=authed_client.post(f'/api/courses/{seeded}/next')
    assert '"done": true' in response.text
    assert '60名退款' not in response.text and '3名退款' in response.text
    with TestSession() as db:
        lesson=db.query(Lesson).filter_by(course_id=seeded,number=2).one()
        assert '60名退款' not in lesson.content
        assert json.loads(lesson.teaching_plan)['quality_review']['issues_corrected']


def test_review_cannot_patch_unknown_or_ambiguous_passages():
    for draft,old in [('hello','absent'),('hello hello','hello')]:
        with pytest.raises(ValueError):
            teaching.apply_review(draft,teaching.TeachingReview(issues=['incorrect'],edits=[teaching.ReviewEdit(old=old,new='fixed')]))


def test_explicit_next_scope_is_authoritative_over_model_inference():
    records=[{'id':1,'requested_scope':'next'}]
    p=teaching.parse_plan(plan([1],persistent=[1],unresolved=[1]),records)
    assert p.persistent_feedback_ids==p.unresolved_feedback_ids==[]


def test_expired_temporary_example_cannot_override_ongoing_example():
    records=[{'content':'以后都用电商例子，每篇不超过600字','target_lesson':2},
             {'content':'这篇用图书馆例子，不限字数','target_lesson':3}]
    controls=teaching.explicit_controls(records,4)
    assert controls['example_context']=='电商'
    assert controls['max_words']==600


def test_summary_does_not_label_whole_course_from_one_answer():
    text='# 总结\n这题相对变化应为40%。\n**建议：本课未掌握，需复习。**'
    result=teaching.cautious_summary(text,'zh')
    assert '本课未掌握' not in result and '40%' in result and '其他目标仍需' in result


def test_explicit_difficulty_is_not_lost_when_planner_omits_unresolved_ids():
    record={'id':1,'requested_scope':'course','content':'我还没理解百分点，以后用电商例子。','difficulty_resolved':False}
    raw=json.dumps({'action':'repair','focus':'补讲','requirements':[], 'applied_feedback_ids':[1], 'persistent_feedback_ids':[1], 'unresolved_feedback_ids':[]})
    assert teaching.parse_plan(raw,[record]).unresolved_feedback_ids==[1]
    assert teaching.parse_plan(raw,[{**record,'requested_scope':'next'}]).unresolved_feedback_ids==[]
    assert teaching.parse_plan(raw,[{**record,'difficulty_resolved':True}]).unresolved_feedback_ids==[]


def _thread_annotation(cid, *, answered=True):
    from app.models import Annotation
    thread = [{'role': 'user', 'content': '没太懂'}, {'role': 'assistant', 'content': '百分点是两个比例直接相减。', 'request_id': 'r1'},
              {'role': 'user', 'content': '那相对变化呢'}]
    if answered:
        thread.append({'role': 'assistant', 'content': '相对变化是差值除以原来的比例。', 'request_id': 'r2'})
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        db.add(Annotation(lesson_id=lesson.id, position_start=0, position_end=4, original_text='10%到12%是2个百分点',
                          comment='没太懂', messages=json.dumps(thread, ensure_ascii=False)))
        db.commit()
    return [{'role': m['role'], 'content': m['content']} for m in thread]


def test_the_planner_and_the_review_see_the_highlighted_passage_and_the_whole_thread(authed_client, seeded, monkeypatch):
    thread = _thread_annotation(seeded)
    rid = save(authed_client, seeded, content='多用电商例子')
    captured = mock_next(monkeypatch, plan([rid], action='consolidate'))
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text

    expected = [{'passage': '10%到12%是2个百分点', 'thread': thread}]
    planner = json.loads(next(user for system, user in captured if system == teaching.PLANNER_PROMPT))
    review = json.loads(next(user for system, user in captured if system == teaching.REVIEW_PROMPT))
    assert planner['learner_highlights'] == expected and 'learner_highlight_questions' not in planner
    assert review['learner_highlights'] == expected and review['learner_feedback'] == '多用电商例子'
    assert 'reads alone and cannot reply' in teaching.PLANNER_PROMPT
    assert 'never delete only the attribution' in teaching.REVIEW_PROMPT


@pytest.fixture
def material_course(user):
    sections = [
        courses.MaterialSection('rates.pdf', '第 1 页', '百分点是两个比例直接相减。'),
        courses.MaterialSection('rates.pdf', '第 2 页', '退款率等于退款订单数除以支付订单数。'),
        courses.MaterialSection('misc.md', '附录', '与本课无关的附录内容。'),
    ]
    with TestSession() as db:
        c = Course(user_uuid=user.uuid, name='Rates', language='zh', source_filename='2 项参考资料',
                   source_content=courses._serialize_material_archive('# 课程参考知识包\n整包摘要', sections))
        db.add(c); db.flush()
        db.add(Syllabus(course_id=c.id, content='# Rates\n## 核心掌握项\n- [ ] 能够区分百分点与相对变化（来源：rates.pdf，第 1 页）\n'
                                                '- [ ] 能够解释退款指标（来源：rates.pdf，第 2 页）'))
        db.add(Lesson(course_id=c.id, number=1, content='# 变化\n## 正文内容\n10%到12%是2个百分点。\n## 思考题\n1. 5%到7%相对增加多少？\n<!-- mastery: 能够区分百分点与相对变化 -->'))
        db.commit(); return c.id


def test_a_material_course_lesson_and_its_review_get_the_excerpts_for_the_next_items(authed_client, material_course, monkeypatch):
    rid = save(authed_client, material_course, content='多用电商例子')
    captured = mock_next(monkeypatch, plan([rid], action='advance'))
    assert '"done": true' in authed_client.post(f'/api/courses/{material_course}/next').text

    lesson_prompt = next(system for system, _ in captured if '## 与本篇最相关的资料片段' in system)
    excerpts = lesson_prompt.split('## 与本篇最相关的资料片段\n', 1)[1].split('\n\n## ', 1)[0]
    # 第 1 项已讲过；下一项的来源括注指向第 2 页，那一页排最前；和本篇不沾边的附录不带，整包知识包也不带
    assert excerpts.startswith('[来源：rates.pdf；位置：第 2 页]\n退款率等于退款订单数除以支付订单数。')
    assert '第 1 页' not in excerpts and '附录' not in excerpts and '整包摘要' not in lesson_prompt
    assert '## 资料片段的用法（必须遵守）' in lesson_prompt
    review = json.loads(next(user for system, user in captured if system == teaching.REVIEW_PROMPT))
    assert '[来源：rates.pdf；位置：第 2 页]' in review['source_material']


def test_an_answered_highlight_is_not_recapped_in_the_saved_lesson(authed_client, seeded, monkeypatch):
    _thread_annotation(seeded)
    body = ('# 补讲\n\n---\n\n> 上一篇的思考题是可选的，参考答案放在本篇末尾。\n\n## 批注解答\n\n- 相对变化是什么？是差值除以原来的比例。\n\n'
            '## 正文内容\n上一篇你问过相对变化，10%到12%相对增加20%。\n## 思考题\n1. 5%到7%相对增加多少？\n<!-- mastery: 能够区分百分点与相对变化 -->')
    captured = mock_next(monkeypatch, plan([], action='consolidate'), content=body)
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text

    system = next(system for system, user in captured if user == '生成第2篇课文')
    assert '## 批注解答\n\n[' not in system and '**【高优先级】划线问答不要再答一遍。**' in system
    saved = authed_client.get(f'/api/courses/{seeded}/lessons/2').json()['content']
    assert '## 批注解答' not in saved and '差值除以原来的比例' not in saved and '上一篇你问过相对变化' in saved


def test_an_unanswered_highlight_question_still_gets_its_section(authed_client, seeded, monkeypatch):
    _thread_annotation(seeded, answered=False)
    body = ('# 补讲\n\n---\n\n## 批注解答\n\n- 相对变化是差值除以原来的比例。\n\n'
            '## 正文内容\n10%到12%相对增加20%。\n## 思考题\n1. 5%到7%相对增加多少？\n<!-- mastery: 能够区分百分点与相对变化 -->')
    captured = mock_next(monkeypatch, plan([], action='consolidate'), content=body)
    assert '"done": true' in authed_client.post(f'/api/courses/{seeded}/next').text

    system = next(system for system, user in captured if user == '生成第2篇课文')
    assert '## 批注解答\n\n[只回答批注记录里还没有「答」的提问' in system
    assert '## 批注解答' in authed_client.get(f'/api/courses/{seeded}/lessons/2').json()['content']
