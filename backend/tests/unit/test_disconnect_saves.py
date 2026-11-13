"""流式文字生成完之后（重写 / 核对的等待期间）客户端断开，课文不能丢。

重写 / 核对、保存都在一个单独的线程里做完（lesson-tail）：客户端断开后 Starlette 不会马上关掉生成器
（真实 HTTP 里实测要等垃圾回收，空闲进程隔了十几秒），不能指望在 GeneratorExit 里补救。所以关掉生成器之后线程照样跑完，
保存恰好一次；流式文字还在生成的时候断开，和以前一样什么都不保存。
"""
import threading
import time

import pytest

import app.courses as courses_module
from app.models import Lesson, Syllabus
from tests.conftest import TestSession
from tests.unit.test_brief_lessons import (
    REWRITE_MARKER, body_chars, course_with_previous, rewrite_responder, stored, zh_lesson,
)
from tests.unit.test_course_language import fake_model


@pytest.fixture
def client(authed_client):
    return authed_client


@pytest.fixture(autouse=True)
def join_background_workers():
    yield
    wait_for_tail()


def wait_for_tail():
    """等后台线程跑完（它们在生成器被关掉之后还在继续）。"""
    for worker in threading.enumerate():
        # 下一篇 / 总结 / 划线问答整个生成都在后台线程里跑（_worker_stream：lesson-next、lesson-summary、annotation-*）
        if worker.name.startswith(("lesson-next", "lesson-summary", "annotation-", "lesson-tail", "answers-check", "lesson-rewrite")):
            worker.join(timeout=10)


@pytest.fixture
def raw_generator(monkeypatch):
    """让端点直接返回它的生成器（不包成 StreamingResponse），测试里就能在心跳处 close 它。"""
    monkeypatch.setattr(courses_module, "StreamingResponse", lambda generator, media_type=None: generator)
    monkeypatch.setattr(courses_module, "SSE_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_ATTEMPT_SECONDS", 0.01)


def start(user, cid):
    db = TestSession()
    return db, courses_module.generate_next_lesson(cid, user=user, db=db)


def read_until(generator, stop):
    for line in generator:
        if stop(line):
            return line
    raise AssertionError("生成器在出现要等的那一行之前就结束了")


def heartbeat(line):
    return line == courses_module.SSE_HEARTBEAT


def lessons(cid):
    with TestSession() as db:
        return {row.number: row.content for row in db.query(Lesson).filter(Lesson.course_id == cid)}


def test_a_disconnect_during_a_slow_rewrite_still_saves_the_lesson_once(client, user, raw_generator, monkeypatch):
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 5)
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.5)):
        db, generator = start(user, cid)
        read_until(generator, heartbeat)  # 流式文字已经给完，现在在等重写
        generator.close()
        db.close()
        assert set(lessons(cid)) == {1}  # 刚断开的时候线程还在等重写
        wait_for_tail()

    saved = lessons(cid)
    assert set(saved) == {1, 2}
    assert body_chars(saved[2]) == 1500  # 线程把重写等回来了，存的是重写后的


def test_a_disconnect_while_the_answers_are_being_checked_still_gets_the_checked_version_saved(client, user, raw_generator):
    cid = course_with_previous(client)

    def respond(system, user_message):
        if "参考答案的核对员" in system:
            time.sleep(0.5)
            return "**第1题：** 旧题一\n> 核对后的答案。\n\n"
        return rewrite_responder(zh_lesson(2600), zh_lesson(1500))(system, user_message)

    with fake_model(respond):
        db, generator = start(user, cid)
        read_until(generator, heartbeat)  # 重写已经完成，现在在等核对
        generator.close()
        db.close()
        wait_for_tail()

    saved = lessons(cid)[2]
    assert body_chars(saved) == 1500 and "核对后的答案。" in saved and "旧答案一" not in saved


def test_the_saved_lesson_also_ticks_the_outline_and_adds_the_progress_row(client, user, raw_generator, monkeypatch):
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 5)
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.5)):
        db, generator = start(user, cid)
        read_until(generator, heartbeat)
        generator.close()
        db.close()
        wait_for_tail()

    with TestSession() as session:
        syllabus = session.query(Syllabus).one().content
    assert "| 第 2 篇 |" in syllabus and "- [x] 能够解释核心概念1" in syllabus


def test_it_does_not_matter_that_the_request_session_is_gone_or_that_the_generator_is_still_referenced(client, user, raw_generator, monkeypatch):
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 5)
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.5)):
        db, generator = start(user, cid)
        read_until(generator, heartbeat)
        db.close()  # 连接断了，请求的会话先关了；生成器没人再去 next() 也没有被关掉（像 Starlette 里等垃圾回收的那种）
        # 等后台线程自己跑完再查库，不能边等边查：测试的内存 SQLite 只有一条共享连接，
        # 这边每查一次收尾的回滚，会把线程还没提交的保存一起回滚掉（机器慢一点就必中）
        wait_for_tail()

    assert 2 in lessons(cid)  # 课文照样存下来了，没有等垃圾回收
    generator.close()


def test_a_disconnect_while_the_text_is_still_streaming_saves_nothing_like_before(client, user, raw_generator):
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        db, generator = start(user, cid)
        read_until(generator, lambda line: line.startswith("data: "))
        generator.close()
        db.close()

    assert set(lessons(cid)) == {1}  # 流式还没结束：没有可保存的东西


def test_closing_after_the_lesson_was_saved_does_not_save_it_twice(client, user, raw_generator):
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        db, generator = start(user, cid)
        read_until(generator, lambda line: '"done": true' in line)
        generator.close()
        db.close()

    assert set(lessons(cid)) == {1, 2}
    with TestSession() as session:
        assert session.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == 2).count() == 1


def test_if_saving_fails_in_the_background_thread_nothing_is_saved(client, user, raw_generator, monkeypatch):
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 5)
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.5)):
        db, generator = start(user, cid)
        read_until(generator, heartbeat)
        monkeypatch.setattr(courses_module, "_record_event", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))
        generator.close()
        db.close()
        wait_for_tail()

    assert set(lessons(cid)) == {1}


def test_when_saving_fails_while_the_client_is_still_connected_it_gets_the_error(client, user, raw_generator, monkeypatch):
    cid = course_with_previous(client, feedback="读懂了，谢谢")
    monkeypatch.setattr(courses_module, "_record_event", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        db, generator = start(user, cid)
        lines = list(generator)
        db.close()

    assert any('"error"' in line for line in lines) and not any('"done"' in line for line in lines)
    assert set(lessons(cid)) == {1}


def test_the_normal_path_is_unchanged_by_all_this(client, user):
    cid = course_with_previous(client, feedback="读懂了，谢谢")

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        res = client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 200 and '"done": true' in res.text
    assert 2 in lessons(cid) and "核对" not in stored(client, cid)
    assert REWRITE_MARKER not in res.text
