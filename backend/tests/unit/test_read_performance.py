from sqlalchemy import event

from app.models import Course, Lesson, Syllabus
from tests.conftest import TestSession, engine


def test_lesson_directory_does_not_fetch_full_content_or_feedback_rows(authed_client, user):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name='Long course', mode='source')
        db.add(course); db.flush(); cid = course.id
        db.add(Syllabus(course_id=cid, content='# Course\n- [ ] 能够解释例子'))
        for n in range(1, 31):
            db.add(Lesson(course_id=cid, number=n, content=f'# Lesson {n}\n' + 'X' * 10000))
        db.add(Lesson(course_id=cid, number=-1, is_source=True, content='SOURCE' * 50000))
        db.commit()
    statements = []
    def collect(conn, cursor, statement, *args): statements.append(statement)
    event.listen(engine, 'before_cursor_execute', collect)
    try:
        response = authed_client.get(f'/api/courses/{cid}/lessons')
    finally:
        event.remove(engine, 'before_cursor_execute', collect)
    assert response.status_code == 200
    assert len(response.json()) == 31
    assert response.json()[-1]['title'] == 'Lesson 30'
    assert len(statements) <= 4
    assert not any('lessons.content AS lessons_content' in s for s in statements)
    assert not any('feedbacks.content' in s for s in statements)


def test_directory_keeps_titles_after_long_prefaces(authed_client, user):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name='Imported markdown', mode='source')
        db.add(course); db.flush(); cid = course.id
        title = 'A long heading ' * 40
        db.add(Lesson(course_id=cid, number=1, content='preface\n' * 100 + '# ' + title + '\nbody'))
        db.commit()
    assert authed_client.get(f'/api/courses/{cid}/lessons').json()[0]['title'] == title.strip()


def test_read_api_import_does_not_load_model_or_pdf_sdk():
    # 冷启动时每多加载一个库都要多等：模型 SDK、PDF、文档转换、支付、图片、Blob 上传都等真正用到时再加载
    import subprocess, sys
    lazy = ['openai', 'pypdf', 'markdownify', 'bs4', 'requests', 'PIL']
    code = f"import app.main,sys; loaded = [m for m in {lazy!r} if m in sys.modules]; assert not loaded, loaded"
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
