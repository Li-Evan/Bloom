"""资料类课程里归档文件：课程页列表收进「已归档」，不算已读进度、读完没有、「继续学习」；照常能打开，能取消归档。"""
from app import coordinate
from app.models import Course, Lesson
from tests.conftest import TestSession, bearer, create_user, seed_course
from tests.unit.test_edit_files import folder


def archive(client, user, course_id, number, archived=True):
    return client.put(f"/api/courses/{course_id}/lessons/{number}/archived", headers=bearer(user), json={"archived": archived})


def read(client, user, course_id, number):
    assert client.post(f"/api/courses/{course_id}/lessons/{number}/completed", headers=bearer(user)).status_code == 200


def listed(client, user, course_id):
    return {item["number"]: item["is_archived"]
            for item in client.get(f"/api/courses/{course_id}/lessons", headers=bearer(user)).json()}


def test_an_archived_file_leaves_the_progress_but_stays_readable(client):
    user = create_user("archive-progress@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"), ("c.md", "# C"))
    read(client, user, course_id, 1)

    res = archive(client, user, course_id, 3)
    assert res.status_code == 200, res.text
    assert res.json() == {"number": 3, "is_archived": True, "status": "learning",
                          "mastery_covered": 1, "mastery_total": 2, "mastery_progress": 0.5}
    assert listed(client, user, course_id) == {1: False, 2: False, 3: True}
    detail = client.get(f"/api/courses/{course_id}", headers=bearer(user)).json()
    assert (detail["lesson_count"], detail["mastery_covered"], detail["mastery_total"]) == (2, 1, 2)
    card = client.get("/api/courses", headers=bearer(user)).json()[0]
    assert (card["lesson_count"], card["mastery_total"]) == (2, 2)
    opened = client.get(f"/api/courses/{course_id}/lessons/3", headers=bearer(user))
    assert opened.status_code == 200 and opened.json()["content"] == "# C"

    # 再点一次不变；取消归档回到列表和进度里
    assert archive(client, user, course_id, 3).json()["mastery_total"] == 2
    back = archive(client, user, course_id, 3, archived=False).json()
    assert (back["is_archived"], back["mastery_covered"], back["mastery_total"]) == (False, 1, 3)
    assert listed(client, user, course_id) == {1: False, 2: False, 3: False}


def test_archiving_the_last_unread_file_finishes_the_course_and_unarchiving_reopens_it(client):
    user = create_user("archive-status@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"))
    read(client, user, course_id, 1)
    assert archive(client, user, course_id, 2).json()["status"] == "completed"
    # 归档的文件读了也不影响：取消归档时它已经读过，课程还是读完的
    read(client, user, course_id, 2)
    assert archive(client, user, course_id, 2, archived=False).json()["status"] == "completed"

    archive(client, user, course_id, 1)
    assert archive(client, user, course_id, 2).json()["status"] == "completed"  # 全归档了就看全部文件：都读过，算读完
    with TestSession() as db:
        db.add(Lesson(course_id=course_id, number=3, content="# C", is_source=True, source_filename="c.md"))
        db.commit()
    archive(client, user, course_id, 2, archived=False)
    read(client, user, course_id, 3)
    with TestSession() as db:
        assert db.get(Course, course_id).status == "completed"  # 标记已读时也只看没归档的


def test_archiving_every_file_unread_keeps_the_course_open(client):
    user = create_user("archive-all-unread@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"))
    read(client, user, course_id, 1)
    archive(client, user, course_id, 1)
    assert archive(client, user, course_id, 2).json()["status"] == "learning"  # 第 2 个没读就归档了：还没读完


def test_continue_learning_skips_archived_files(client):
    user = create_user("archive-continue@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"), ("c.md", "# C"))
    assert client.post(f"/api/courses/{course_id}/lessons/1/opened", headers=bearer(user)).status_code == 200
    archive(client, user, course_id, 1)
    last = client.get("/api/stats", headers=bearer(user)).json()["last_lesson"]
    assert (last["course_id"], last["lesson_number"]) == (course_id, 2)
    with TestSession() as db:
        assert coordinate.in_course(db, db.get(Course, course_id))[0]["lesson_number"] == 2


def test_a_moved_file_is_listed_in_its_new_course(client):
    user = create_user("archive-move@example.com")
    source, target = folder(user, ("a.md", "# A"), ("b.md", "# B")), folder(user, ("c.md", "# C"), name="另一门")
    archive(client, user, source, 2)
    moved = client.post(f"/api/courses/{source}/lessons/2/move", headers=bearer(user), json={"target_course_id": target})
    assert moved.status_code == 200, moved.text
    assert listed(client, user, target) == {1: False, 2: False}


def test_only_files_of_your_own_material_courses_can_be_archived(client):
    user, other = create_user("archive-owner@example.com"), create_user("archive-other@example.com")
    course_id = folder(user, ("a.md", "# A"), ("b.md", "# B"))
    assert archive(client, other, course_id, 1).status_code == 404
    assert archive(client, user, course_id, 9).status_code == 404
    assert archive(client, user, seed_course(user.uuid)[0], 1).status_code == 400
    archive(client, user, course_id, 2)
    assert archive(client, user, course_id, 2, archived=False).status_code == 200
    assert listed(client, user, course_id) == {1: False, 2: False}
