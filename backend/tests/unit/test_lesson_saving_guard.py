"""后台线程（lesson-tail）还没存完时再点「我读完了」，在调用模型之前就返回 409，不白白再流式一篇；客户端在任何时候断开，课文都由后台线程保存一次。

标记是进程内的。
"""

import pytest

import app.courses as courses_module
from app.models import Lesson
from tests.conftest import TestSession
from tests.unit.test_brief_lessons import course_with_previous, rewrite_responder, zh_lesson
from tests.unit.test_course_language import fake_model
from tests.unit.test_disconnect_saves import heartbeat, lessons, read_until, start, wait_for_tail
from tests.unit.test_lesson_prompt_rules import make_course


@pytest.fixture
def client(authed_client):
    return authed_client


def saved_copies(cid, number):
    with TestSession() as db:
        return db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == number).count()


@pytest.fixture
def raw_generator(monkeypatch):
    """让端点直接返回它的生成器（不包成 StreamingResponse），测试里就能在心跳处 close 它。"""
    monkeypatch.setattr(courses_module, "StreamingResponse", lambda generator, media_type=None: generator)
    monkeypatch.setattr(courses_module, "SSE_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_SECONDS", 0.05)
    monkeypatch.setattr(courses_module, "ANSWERS_CHECK_MIN_ATTEMPT_SECONDS", 0.01)


@pytest.fixture(autouse=True)
def clean_markers():
    courses_module._LESSON_SAVING.clear()
    yield
    wait_for_tail()
    courses_module._LESSON_SAVING.clear()


def test_a_course_whose_previous_lesson_is_still_being_saved_gets_a_409_before_the_model_is_called(client, user):
    cid, _ = make_course(client, "zh")
    courses_module._try_mark_saving(cid)

    with fake_model(lambda system, message: "不应该被调用") as model:
        res = client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 409 and res.json()["detail"] == "上一篇还在保存，稍等几秒再点"
    assert model.calls == []  # 没调模型


def test_the_message_follows_the_course_language(client):
    from tests.unit.test_course_language import create_topic

    created, _ = create_topic(client)
    courses_module._try_mark_saving(created["id"])

    res = client.post(f"/api/courses/{created['id']}/next")

    assert res.status_code == 409 and res.json()["detail"] == "The previous lesson is still being saved. Wait a few seconds and try again."


def test_the_marker_only_blocks_its_own_course_and_goes_away_when_cleared(client):
    first, _ = make_course(client, "zh")
    second, _ = make_course(client, "zh")
    courses_module._try_mark_saving(first)

    assert client.post(f"/api/courses/{first}/next").status_code == 409
    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        assert client.post(f"/api/courses/{second}/next").status_code == 200  # 别的课程不受影响
    courses_module._unmark_saving(first)
    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        assert client.post(f"/api/courses/{first}/next").status_code == 200


def test_a_stale_marker_expires_so_a_dead_thread_cannot_block_a_course_forever(client, monkeypatch):
    cid, _ = make_course(client, "zh")
    courses_module._try_mark_saving(cid)
    courses_module._LESSON_SAVING[cid] -= courses_module.LESSON_SAVING_TTL_SECONDS + 1

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        assert client.post(f"/api/courses/{cid}/next").status_code == 200


def test_the_ttl_is_longer_than_the_whole_back_half(client):
    assert courses_module.LESSON_SAVING_TTL_SECONDS > courses_module.POST_GENERATION_BUDGET_SECONDS


def test_while_the_thread_is_still_working_a_second_click_gets_a_409_and_afterwards_the_course_is_free_again(
    client, user, raw_generator, monkeypatch,
):
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 5)
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.6)) as model:
        db, generator = start(user, cid)
        read_until(generator, heartbeat)  # 线程在等慢的重写
        assert cid in courses_module._LESSON_SAVING
        second = client.post(f"/api/courses/{cid}/next")
        assert second.status_code == 409
        assert sum(call["stream"] for call in model.calls) == 1  # 只有第一次流式生成了正文，第二次没调模型
        generator.close()
        db.close()
        wait_for_tail()

    assert cid not in courses_module._LESSON_SAVING  # 线程存完就清掉
    assert set(lessons(cid)) == {1, 2} and saved_copies(cid, 2) == 1


def test_the_marker_is_cleared_when_the_thread_fails_too(client, user, raw_generator, monkeypatch):
    cid = course_with_previous(client, feedback="读懂了，谢谢")
    monkeypatch.setattr(courses_module, "_record_event", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        db, generator = start(user, cid)
        list(generator)
        db.close()

    assert cid not in courses_module._LESSON_SAVING


def test_the_marker_is_held_from_the_start_and_released_after_the_worker_finishes(client, user, raw_generator):
    """保存标记从请求一开始就占住（生成中再点直接 409），后台线程跑完后释放；客户端中途断开也一样。"""
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        db, generator = start(user, cid)
        read_until(generator, lambda line: line.startswith("data: "))
        assert cid in courses_module._LESSON_SAVING
        generator.close()
        db.close()
        wait_for_tail()

    assert cid not in courses_module._LESSON_SAVING


# ---- 断开不影响保存：整篇在后台线程里生成完、保存一次 ----

def test_a_disconnect_during_the_streaming_still_saves_the_lesson_once(client, user, raw_generator):
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(1500), "")):
        db, generator = start(user, cid)
        read_until(generator, lambda line: line.startswith("data: "))
        generator.close()
        db.close()
        wait_for_tail()

    assert set(lessons(cid)) == {1, 2} and saved_copies(cid, 2) == 1


def test_a_disconnect_after_the_streaming_still_saves_the_lesson_once(client, user, raw_generator, monkeypatch):
    monkeypatch.setattr(courses_module, "LESSON_REWRITE_DEADLINE_SECONDS", 5)
    cid = course_with_previous(client)

    with fake_model(rewrite_responder(zh_lesson(2600), zh_lesson(1500), delay=0.4)):
        db, generator = start(user, cid)
        read_until(generator, heartbeat)
        generator.close()
        db.close()
        wait_for_tail()

    assert set(lessons(cid)) == {1, 2} and saved_copies(cid, 2) == 1
