"""设置里的「读完立刻归档」：开着时资料课的文件第一次点「标记已读」就归档；关着、AI 主题课都不归档。"""
from app.models import Course
from tests.conftest import TestSession, bearer, create_user, seed_course
from tests.unit.test_archive_files import archive, listed
from tests.unit.test_edit_files import folder


def turn_on(client, user, enabled=True):
    res = client.put("/api/me/archive-on-read", headers=bearer(user), json={"enabled": enabled})
    assert res.status_code == 200, res.text
    assert res.json() == {"enabled": enabled}


def mark_read(client, user, course_id, number):
    res = client.post(f"/api/courses/{course_id}/lessons/{number}/completed", headers=bearer(user))
    assert res.status_code == 200, res.text
    return res.json()


def test_the_setting_is_off_by_default_and_saved_to_the_account(client):
    user = create_user("auto-archive-setting@example.com")
    assert client.get("/api/me", headers=bearer(user)).json()["archive_on_read"] is False
    turn_on(client, user)
    assert client.get("/api/me", headers=bearer(user)).json()["archive_on_read"] is True
    turn_on(client, user, enabled=False)
    assert client.get("/api/me", headers=bearer(user)).json()["archive_on_read"] is False
    assert client.put("/api/me/archive-on-read", json={"enabled": True}).status_code == 401


def test_reading_a_file_archives_it_and_reading_the_last_one_finishes_the_course(client):
    user = create_user("auto-archive-read@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"))
    turn_on(client, user)

    first = mark_read(client, user, course_id, 1)
    assert (first["archived"], first["course_completed"], first["mastery_covered"], first["mastery_total"]) == (True, False, 0, 1)
    assert listed(client, user, course_id) == {1: True, 2: False}

    last = mark_read(client, user, course_id, 2)
    assert (last["archived"], last["course_completed"]) == (True, True)
    with TestSession() as db:
        assert db.get(Course, course_id).status == "completed"  # 都读完、都归档了：算读完，不是「学习中」
    # 撤销（取消归档）之后照样读完
    assert archive(client, user, course_id, 2, archived=False).json()["status"] == "completed"


def test_nothing_is_archived_with_the_setting_off_or_outside_your_own_material_courses(client):
    user = create_user("auto-archive-skip@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"))
    assert mark_read(client, user, course_id, 1)["archived"] is False
    assert listed(client, user, course_id) == {1: False, 2: False}

    turn_on(client, user)
    # 已经读过的不跟着归档，再点一次也不归档
    assert mark_read(client, user, course_id, 1)["archived"] is False
    assert listed(client, user, course_id)[1] is False
    # AI 按主题生成的课没有归档
    topic_id = seed_course(user.uuid)[0]
    assert mark_read(client, user, topic_id, 1)["archived"] is False


def test_a_file_already_archived_by_hand_just_gets_read(client):
    user = create_user("auto-archive-manual@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"))
    archive(client, user, course_id, 2)
    turn_on(client, user)
    res = mark_read(client, user, course_id, 2)
    assert (res["archived"], res["course_completed"]) == (False, False)
    assert listed(client, user, course_id) == {1: False, 2: True}
