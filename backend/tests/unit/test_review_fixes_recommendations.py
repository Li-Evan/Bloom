import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import event

from app import recommendations
from app.models import Annotation, Course, Feedback, LearningEvent, LearningRecommendation, Lesson, Syllabus
from tests.conftest import TestSession, engine


def payload(*titles):
    return json.dumps([{'title': t, 'rationale': '你已经学过基础。', 'bridge': '它接在你学过的内容之上。', 'source_topics': []} for t in titles],
                      ensure_ascii=False)


def add_course(db, user, name, *, created, project=False, lessons=(), syllabus=None):
    course = Course(user_uuid=user.uuid, name=name, language='zh', is_project=project, created_at=created)
    db.add(course); db.flush()
    if syllabus:
        db.add(Syllabus(course_id=course.id, content=syllabus))
    for number, fields in enumerate(lessons, 1):
        db.add(Lesson(course_id=course.id, number=number, **fields))
    db.flush()
    return course


@pytest.fixture
def sql_log():
    statements = []
    record = lambda conn, cursor, statement, *rest: statements.append(statement.lower())
    event.listen(engine, 'before_cursor_execute', record)
    yield statements
    event.remove(engine, 'before_cursor_execute', record)


def test_one_new_topic_is_kept_when_the_others_repeat_what_was_learned(authed_client, user):
    with TestSession() as db:
        add_course(db, user, '博弈论', created=datetime.now(timezone.utc)); db.commit()
    with patch('app.recommendations._call_llm', return_value=payload('博弈论', '机制设计', '博弈 论')):
        response = authed_client.post('/api/recommendations/refresh')
    assert response.status_code == 200, response.text
    assert [r['title'] for r in response.json()['recommendations']] == ['机制设计']


def test_no_new_topic_at_all_fails_and_keeps_old_cards(authed_client, user):
    with patch('app.recommendations._call_llm', return_value=payload('甲', '乙', '丙')):
        old = authed_client.post('/api/recommendations/refresh').json()
    with patch('app.recommendations._call_llm', return_value=payload('甲', '乙')):
        response = authed_client.post('/api/recommendations/refresh')
    assert response.status_code == 502 and '都和学过或推荐过的重复' in response.json()['detail']
    assert authed_client.get('/api/recommendations').json() == old


def test_generation_is_numbered_under_the_user_lock_after_the_model_answers(authed_client, user, sql_log):
    def concurrent_refresh_finishes_first(*args, **kwargs):
        with TestSession() as db:
            db.add(LearningRecommendation(user_uuid=user.uuid, title='另一个窗口', rationale='r', status='suggested', generation=7))
            db.commit()
        sql_log.append('-- model answered')
        return payload('甲', '乙', '丙')

    with patch('app.recommendations._call_llm', side_effect=concurrent_refresh_finishes_first):
        body = authed_client.post('/api/recommendations/refresh').json()
    assert {r['generation'] for r in body['recommendations']} == {8}
    assert [r['title'] for r in body['recommendations']] == ['甲', '乙', '丙']
    with TestSession() as db:
        assert db.query(LearningRecommendation).filter_by(status='suggested').count() == 3
    after_model = sql_log[sql_log.index('-- model answered'):]
    first_users_read = next(i for i, sql in enumerate(after_model) if 'from users' in sql)
    assert first_users_read < next(i for i, sql in enumerate(after_model) if 'max(learning_recommendations.generation)' in sql)


def test_profile_keeps_the_most_recently_studied_courses_first_and_names_only_the_older_ones(user):
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with TestSession() as db:
        courses = [add_course(db, user, f'课程{i:02d}', created=start + timedelta(days=i))
                   for i in range(recommendations.MAX_PROFILE_COURSES + 5)]
        # 最早建的课后来又学了：按最近学习排，它在最前面
        db.add(LearningEvent(course_id=courses[0].id, lesson_number=1, event_type='lesson_opened', created_at=start + timedelta(days=90)))
        db.commit()
        profile = recommendations._build_learning_profile(db, user.uuid)
    last = recommendations.MAX_PROFILE_COURSES + 4
    assert '课程01' not in profile and '课程05' not in profile
    assert profile.index('《课程00》') < profile.index(f'《课程{last}》') < profile.index('《课程06》')
    detailed = [0, *range(last, last - recommendations.MAX_DETAILED_COURSES + 1, -1)]
    assert all(f'- 课程《课程{i:02d}》｜最近学习：' in profile for i in detailed)
    first_older = last - recommendations.MAX_DETAILED_COURSES + 1
    assert f'- 课程《课程{first_older:02d}》' not in profile and f'《课程{first_older:02d}》（' in profile
    assert profile.splitlines()[-1].startswith('- 更早学过的课程（只列名字）：')


def test_profile_never_reads_whole_source_documents_and_batches_questions(user, sql_log):
    huge = '# 原文标题\n' + 'RAW_SOURCE_BODY ' * 50000
    with TestSession() as db:
        source = add_course(db, user, '原文课', created=datetime(2026, 1, 1, tzinfo=timezone.utc), syllabus='# 大纲\n- [ ] 能够解释甲',
                            lessons=[{'content': huge, 'is_source': True},
                                     {'content': '# 第二篇\n正文\n<!-- mastery: 能够解释甲 -->'}])
        db.add(LearningEvent(course_id=source.id, lesson_number=2, event_type='lesson_completed'))
        for p in range(3):
            project = add_course(db, user, f'项目{p}', project=True, created=datetime(2026, 2, 1 + p, tzinfo=timezone.utc),
                                 lessons=[{'content': 'x', 'is_source': True, 'source_filename': f'docs/{p}-{n}.md'} for n in range(3)])
            for lesson in db.query(Lesson).filter_by(course_id=project.id):
                db.add_all(Annotation(lesson_id=lesson.id, position_start=0, position_end=1, original_text='x', comment=f'问题{p}-{lesson.number}-{a}')
                           for a in range(5))
        db.commit()
        sql_log.clear()
        profile = recommendations._build_learning_profile(db, user.uuid)
    assert 'RAW_SOURCE_BODY' not in profile
    assert '- 课程《原文课》｜最近学习：' in profile and '｜已学 1/1 个掌握项\n  已经学过：\n    - 能够解释甲' in profile
    assert profile.count('→ 问题0-') == recommendations.MAX_HIGHLIGHTS and '  还没读：docs/2-0；docs/2-1；docs/2-2' in profile
    assert len([sql for sql in sql_log if sql.lstrip().startswith('select')]) <= 8


def test_profile_gives_the_whole_outline_split_into_learned_and_still_to_come(user):
    # 线上的推荐只看到每门课前 10 条掌握项：后面的内容（还有没讲到的）被当成新主题推荐出去
    items = [f'能够解释概念{i:02d}' for i in range(1, 15)]
    syllabus = ('# 大纲\n\n## 核心掌握项\n\n### 模块一\n' + '\n'.join(f'- [ ] {item}（来源：教材第{i}节）' for i, item in enumerate(items, 1))
                + '\n\n## 不在本课题范围内\n\n- 微积分基础\n- 宇宙学\n\n## 学习进度\n\n| 课文 | 覆盖掌握项 | 生成日期 |\n|---|---|---|\n')
    with TestSession() as db:
        course = add_course(db, user, '长课', created=datetime.now(timezone.utc), syllabus=syllabus,
                            lessons=[{'content': f'# 第一篇\n正文\n<!-- mastery: {items[0]}; {items[1]} -->'},
                                     {'content': f'# 第二篇\n正文\n<!-- mastery: {items[2]} -->'}])
        db.add(LearningEvent(course_id=course.id, lesson_number=1, event_type='lesson_completed'))
        db.commit()
        profile = recommendations._build_learning_profile(db, user.uuid)
    learned, upcoming = profile.split('  这门课接下来会讲（原课程会接着讲，不能推荐成新主题）：\n')
    assert '｜已学 2/14 个掌握项\n  已经学过：\n    - 能够解释概念01\n    - 能够解释概念02\n' in learned
    # 第二篇没读：它讲的也还没学
    assert upcoming.splitlines() == [f'    - {item}' for item in items[2:]] + ['  这门课不讲（大纲明确排除的相关主题）：微积分基础；宇宙学']
    assert '来源' not in profile


def test_profile_quotes_the_passage_of_each_question_and_keeps_feedback_and_the_wishlist(authed_client, user):
    with TestSession() as db:
        course = add_course(db, user, '概率论入门', created=datetime.now(timezone.utc), syllabus='# 大纲\n- [ ] 能够计算条件概率',
                            lessons=[{'content': '# 第一篇\n正文\n<!-- mastery: 能够计算条件概率 -->'}])
        lesson = db.query(Lesson).filter_by(course_id=course.id).one()
        db.add_all([
            Annotation(lesson_id=lesson.id, position_start=0, position_end=1, original_text='P(A|B) = P(A∩B) / P(B)', comment='为什么要除以 P(B)？'),
            Annotation(lesson_id=lesson.id, position_start=0, position_end=1, original_text='Memory is scoped per project', comment=' 翻译 '),
            Annotation(lesson_id=lesson.id, position_start=0, position_end=1, original_text='只是标记', comment=''),
            Feedback(lesson_id=lesson.id, content='条件概率那里没懂', thought_answers=''),
            LearningRecommendation(user_uuid=user.uuid, title='集合运算基础', rationale='r', status='saved'),
            LearningRecommendation(user_uuid=user.uuid, title='换掉的推荐', rationale='r', status='dismissed'),
        ])
        db.commit()
    with patch('app.recommendations._call_llm', return_value=payload('甲', '乙', '丙')) as call:
        assert authed_client.post('/api/recommendations/refresh').status_code == 200
    profile = call.call_args.args[1]
    assert ('  划线提问（学习者卡住或好奇的地方）：\n    - 「P(A|B) = P(A∩B) / P(B)」→ 为什么要除以 P(B)？\n'
            '  课后反馈：\n    - 条件概率那里没懂\n') in profile
    assert '翻译' not in profile and '只是标记' not in profile
    assert '## 待学清单（学习者自己收藏、想学的主题）\n\n- 集合运算基础\n\n## 不要推荐这些主题\n\n' in profile
    assert profile.index('换掉的推荐') > profile.index('## 不要推荐这些主题')


def ranked(*items):
    return json.dumps([{'title': t, 'rationale': '你已经学过基础。', 'bridge': '它接在你学过的内容之上。', 'source_topics': ['甲'], **extra}
                       for t, extra in items], ensure_ascii=False)


def test_each_card_carries_the_lane_the_model_gave_it_even_when_fewer_than_three_survive(authed_client, user):
    with TestSession() as db:
        add_course(db, user, '博弈论', created=datetime.now(timezone.utc)); db.commit()
    raw = ranked(('博弈论', {'kind': 'foundation'}), ('机制设计', {'kind': 'connect'}), ('行为经济学', {'kind': 'Explore '}))
    with patch('app.recommendations._call_llm', return_value=raw):
        cards = authed_client.post('/api/recommendations/refresh').json()['recommendations']
    assert [(c['title'], c['kind'], c['source_topics']) for c in cards] == [('机制设计', 'connect', ['甲']), ('行为经济学', 'explore', ['甲'])]
    assert authed_client.get('/api/recommendations').json()['recommendations'] == cards
    saved = authed_client.post(f"/api/recommendations/{cards[0]['id']}/save").json()
    assert saved['kind'] == 'connect'


def test_a_missing_or_unknown_lane_is_left_empty_instead_of_guessed(authed_client, user):
    with patch('app.recommendations._call_llm', return_value=ranked(('甲', {}), ('乙', {'kind': 'bridge'}))):
        cards = authed_client.post('/api/recommendations/refresh').json()['recommendations']
    assert [c['kind'] for c in cards] == [None, None]
    with TestSession() as db:
        db.add(LearningRecommendation(user_uuid=user.uuid, title='旧推荐', rationale='r', source_topics='["博弈论"]', status='saved'))
        db.commit()
    old = authed_client.get('/api/recommendations').json()['saved'][0]
    assert old['source_topics'] == ['博弈论'] and old['kind'] is None


def test_every_saved_and_started_topic_stays_avoided_and_only_dismissed_ones_are_capped(user):
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with TestSession() as db:
        for i in range(40):
            db.add(LearningRecommendation(user_uuid=user.uuid, title=f'收藏{i}', rationale='r', status='saved', created_at=start))
            db.add(LearningRecommendation(user_uuid=user.uuid, title=f'开始{i}', rationale='r', status='started', created_at=start))
            db.add(LearningRecommendation(user_uuid=user.uuid, title=f'作废{i:02d}', rationale='r', status='dismissed',
                                          created_at=start + timedelta(days=i + 1)))
        db.commit()
        avoid = recommendations._avoid_titles(db, user.uuid)
    assert {f'收藏{i}' for i in range(40)} <= set(avoid) and {f'开始{i}' for i in range(40)} <= set(avoid)
    assert [t for t in avoid if t.startswith('作废')] == [f'作废{i:02d}' for i in range(39, 9, -1)]


def test_an_old_topic_marked_not_interested_just_now_stays_avoided_past_newer_refreshes(user):
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with TestSession() as db:
        db.add(LearningRecommendation(user_uuid=user.uuid, title='不感兴趣的旧推荐', rationale='r', status='dismissed',
                                      created_at=start - timedelta(days=30), updated_at=start + timedelta(days=100)))
        for i in range(40):
            at = start + timedelta(days=i + 1)
            db.add(LearningRecommendation(user_uuid=user.uuid, title=f'换掉{i:02d}', rationale='r', status='dismissed',
                                          created_at=at, updated_at=at))
        db.commit()
        avoid = recommendations._avoid_titles(db, user.uuid)
    assert '不感兴趣的旧推荐' in avoid and '换掉39' in avoid and '换掉10' not in avoid


def test_no_transaction_is_open_while_the_recommendation_model_runs(authed_client):
    sessions, open_during_call = [], []
    record = lambda session, transaction, connection: sessions.append(session)
    event.listen(TestSession, 'after_begin', record)

    def model(*args, **kwargs):
        open_during_call.extend(s for s in sessions if s.in_transaction())
        return payload('甲', '乙', '丙')
    try:
        with patch('app.recommendations._call_llm', side_effect=model):
            assert authed_client.post('/api/recommendations/refresh').status_code == 200
    finally:
        event.remove(TestSession, 'after_begin', record)
    assert sessions and open_during_call == []
