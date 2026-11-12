"""Concurrency and cascade checks against an explicitly supplied isolated Postgres."""
import os
import pytest
from sqlalchemy.orm import Session
from app.models import Course, Lesson, TeachingFeedback
from app import teaching
from tests.integration.pg import pg_engine, pg_user, run_concurrently

pytestmark=[pytest.mark.postgres, pytest.mark.skipif(not os.getenv('TEST_DATABASE_URL'), reason='Requires isolated Postgres TEST_DATABASE_URL')]


def test_concurrent_feedback_revisions_have_one_active_version(pg_engine,pg_user):
    with Session(pg_engine) as db:
        course=Course(user_uuid=pg_user,name='feedback-lock-test');db.add(course);db.flush()
        lesson=Lesson(course_id=course.id,number=1,content='sample');db.add(lesson);db.commit();cid,lid=course.id,lesson.id
    try:
        def save(db):
            db.query(Course.id).filter_by(id=cid).with_for_update().one()
            r=teaching.record_feedback(db,cid,lid,2,'以后用电商','', 'course')
            db.commit();return r.id
        ids=run_concurrently(pg_engine,8,save)
        assert len(set(ids))==1
        with Session(pg_engine) as db:
            assert db.query(TeachingFeedback).filter_by(course_id=cid,status='active').count()==1
            row=db.query(TeachingFeedback).filter_by(course_id=cid).one()
            assert row.requested_scope=='course'
    finally:
        with Session(pg_engine) as db:
            db.delete(db.get(Course,cid));db.commit()
            assert db.query(TeachingFeedback).filter_by(course_id=cid).count()==0
            assert db.query(Lesson).filter_by(course_id=cid).count()==0
