from datetime import datetime, timedelta

from app.models import Course, LearningEvent, Lesson
from tests.conftest import TestSession, seed_course

BASE = datetime(2026, 3, 1, 8, 0, 0)  # 课程引擎的时间列是不带时区的 UTC


def add_course(owner_uuid, name, lessons, *, is_project=False, status="learning"):
    with TestSession() as db:
        course = Course(user_uuid=owner_uuid, name=name, mode="source" if is_project else "topic", status=status,
                        is_project=is_project)
        db.add(course)
        db.flush()
        for number, content, filename in lessons:
            db.add(Lesson(course_id=course.id, number=number, content=content, source_filename=filename))
        db.commit()
        return course.id


def add_event(course_id, lesson_number, minutes=0, event_type="lesson_opened"):
    with TestSession() as db:
        db.add(LearningEvent(
            course_id=course_id, lesson_number=lesson_number, event_type=event_type,
            created_at=BASE + timedelta(minutes=minutes),
        ))
        db.commit()


def delete_lesson(course_id, number):
    with TestSession() as db:
        db.delete(db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == number).one())
        db.commit()


def last_lesson(client):
    res = client.get("/api/stats")
    assert res.status_code == 200
    return res.json()["last_lesson"]


def test_null_for_a_user_with_no_courses_or_no_opened_lessons(user, authed_client):
    assert last_lesson(authed_client) is None
    add_course(user.uuid, "没打开过", [(1, "# 一", None)])
    assert last_lesson(authed_client) is None


def test_stats_keep_every_existing_field(user, authed_client):
    assert set(authed_client.get("/api/stats").json()) == {
        "total_courses", "active_courses", "completed_courses", "total_lessons_read", "total_annotations",
        "total_feedback", "current_streak", "longest_streak", "last_lesson",
    }


def test_the_most_recently_active_course_wins_and_lands_on_its_newest_lesson(user, authed_client):
    first = add_course(user.uuid, "课程甲", [(1, "# 甲一", None), (2, "# 甲二", None)])
    second = add_course(user.uuid, "课程乙", [(1, "# 乙一\n\n正文", None)])
    add_event(first, 2, minutes=5)
    add_event(second, 1, minutes=10)
    add_event(first, 1, minutes=1)

    body = last_lesson(authed_client)

    assert body["course_id"] == second
    assert (body["course_name"], body["lesson_number"], body["lesson_title"]) == ("课程乙", 1, "乙一")
    assert set(body) == {"course_id", "course_name", "lesson_number", "lesson_title", "opened_at", "course_completed"}
    assert body["course_completed"] is False
    opened = datetime.fromisoformat(body["opened_at"])
    assert opened.utcoffset() == timedelta(0) and opened.replace(tzinfo=None) == BASE + timedelta(minutes=10)

    add_event(first, 2, minutes=20)
    assert last_lesson(authed_client)["course_id"] == first
    assert last_lesson(authed_client)["lesson_number"] == 2


def test_reopening_an_old_lesson_makes_the_course_active_but_does_not_move_the_landing_lesson(user, authed_client):
    course_id = add_course(user.uuid, "课", [(1, "# 一", None), (2, "# 二", None), (3, "# 三", None)])
    other = add_course(user.uuid, "另一门", [(1, "# 另一门第一篇", None)])
    add_event(course_id, 3, minutes=5)
    add_event(other, 1, minutes=10)
    assert last_lesson(authed_client)["course_id"] == other

    add_event(course_id, 1, minutes=20)  # 翻看第 1 篇

    body = last_lesson(authed_client)
    assert (body["course_id"], body["lesson_number"], body["lesson_title"]) == (course_id, 3, "三")
    opened = datetime.fromisoformat(body["opened_at"])
    assert opened.replace(tzinfo=None) == BASE + timedelta(minutes=20)  # 最近一次活动的时间


def test_a_lesson_generated_after_the_last_open_is_where_to_continue(user, authed_client):
    course_id = add_course(user.uuid, "课", [(1, "# 一", None), (2, "# 刚生成的第二篇", None)])
    add_event(course_id, 1, minutes=1)
    add_event(course_id, 2, minutes=2, event_type="lesson_generated")

    assert last_lesson(authed_client)["lesson_number"] == 2


def test_only_opened_events_decide_which_course_is_active(user, authed_client):
    course_id = add_course(user.uuid, "课", [(1, "# 一", None), (2, "# 二", None)])
    quiet = add_course(user.uuid, "只有别的事件", [(1, "# 静", None)])
    add_event(course_id, 1, minutes=1)
    for kind in ("lesson_completed", "annotation_answered", "feedback_submitted", "lesson_generated", "course_created"):
        add_event(quiet, 1, minutes=30, event_type=kind)

    body = last_lesson(authed_client)

    assert (body["course_id"], body["lesson_number"]) == (course_id, 2)


def test_a_finished_course_is_flagged_so_the_landing_is_its_course_page(user, authed_client):
    course_id = add_course(
        user.uuid, "学完的课", [(0, "# 学习总结", None), (1, "# 一", None), (2, "# 评估", None)], status="completed",
    )
    add_event(course_id, 1, minutes=1)

    body = last_lesson(authed_client)

    assert (body["course_id"], body["course_completed"]) == (course_id, True)
    assert body["lesson_number"] == 2  # 总结篇（0）不算前沿


def test_a_project_lands_on_the_first_unread_file_not_the_last_opened_one(user, authed_client):
    project = add_course(user.uuid, "项目", [(1, "# a", "a.md"), (2, "# b", "b.md"), (3, "# c", "c.md")], is_project=True)
    add_event(project, 3, minutes=1)
    add_event(project, 2, minutes=2)

    body = last_lesson(authed_client)

    assert (body["course_id"], body["lesson_number"], body["lesson_title"]) == (project, 1, "a")


def test_a_project_skips_the_files_already_marked_read(user, authed_client):
    project = add_course(user.uuid, "项目", [(1, "# a", "a.md"), (2, "# b", "b.md"), (3, "# c", "c.md")], is_project=True)
    add_event(project, 3, minutes=1)
    add_event(project, 1, minutes=2, event_type="lesson_completed")

    assert last_lesson(authed_client)["lesson_number"] == 2

    add_event(project, 2, minutes=3, event_type="lesson_completed")
    assert last_lesson(authed_client)["lesson_number"] == 3  # 只剩第 3 个没读


def test_a_project_with_every_file_read_lands_on_the_most_recently_opened_one(user, authed_client):
    project = add_course(
        user.uuid, "项目", [(1, "# a", "a.md"), (2, "# b", "b.md"), (3, "# c", "c.md")], is_project=True, status="completed",
    )
    for number in (1, 2, 3):
        add_event(project, number, minutes=number, event_type="lesson_completed")
    add_event(project, 2, minutes=10)
    add_event(project, 1, minutes=11)
    add_event(project, 3, minutes=12)
    add_event(project, 2, minutes=13)

    body = last_lesson(authed_client)

    assert (body["lesson_number"], body["lesson_title"], body["course_completed"]) == (2, "b", True)


def test_the_unread_file_rule_follows_the_same_read_definition_as_the_lesson_list(user, authed_client):
    project = add_course(user.uuid, "项目", [(1, "# a", "a.md"), (2, "# b", "b.md")], is_project=True)
    add_event(project, 2, minutes=1)
    lessons = authed_client.get(f"/api/courses/{project}/lessons").json()
    first_unread = next(lesson["number"] for lesson in lessons if not lesson["is_read"])

    assert last_lesson(authed_client)["lesson_number"] == first_unread == 1
    authed_client.post(f"/api/courses/{project}/lessons/1/completed")
    lessons = authed_client.get(f"/api/courses/{project}/lessons").json()
    assert last_lesson(authed_client)["lesson_number"] == next(lesson["number"] for lesson in lessons if not lesson["is_read"]) == 2


def test_a_project_that_is_not_the_latest_course_never_overrides_which_course_is_active(user, authed_client):
    project = add_course(user.uuid, "项目", [(1, "# a", "a.md"), (2, "# b", "b.md")], is_project=True)
    topic = add_course(user.uuid, "主题课", [(1, "# 一", None), (2, "# 二", None)])
    add_event(project, 2, minutes=1)
    add_event(topic, 1, minutes=2)

    body = last_lesson(authed_client)

    assert (body["course_id"], body["lesson_number"]) == (topic, 2)


def test_an_event_for_a_deleted_lesson_falls_back_to_the_previous_opened_one(user, authed_client):
    course_id = add_course(user.uuid, "课", [(1, "# 一", None), (2, "# 二", None), (3, "# 三", None)])
    add_event(course_id, 1, minutes=1)
    add_event(course_id, 2, minutes=2)
    add_event(course_id, 3, minutes=3)
    assert last_lesson(authed_client)["lesson_number"] == 3

    delete_lesson(course_id, 3)
    assert last_lesson(authed_client)["lesson_number"] == 2
    delete_lesson(course_id, 2)
    delete_lesson(course_id, 1)

    assert last_lesson(authed_client) is None


def test_an_opened_event_whose_lesson_never_existed_is_ignored(user, authed_client):
    course_id = add_course(user.uuid, "课", [(1, "# 一", None)])
    add_event(course_id, 1, minutes=1)
    add_event(course_id, 99, minutes=50)  # /opened 不校验课文是否存在

    assert last_lesson(authed_client)["lesson_number"] == 1


def test_a_deleted_course_stops_being_the_last_lesson(user, authed_client):
    keep = add_course(user.uuid, "留下的课", [(1, "# 留下", None)])
    drop = add_course(user.uuid, "要删的课", [(1, "# 要删", None)])
    add_event(keep, 1, minutes=1)
    add_event(drop, 1, minutes=2)
    assert last_lesson(authed_client)["course_name"] == "要删的课"

    assert authed_client.delete(f"/api/courses/{drop}").status_code == 200
    assert last_lesson(authed_client)["course_name"] == "留下的课"

    assert authed_client.delete(f"/api/courses/{keep}").status_code == 200
    assert last_lesson(authed_client) is None


def test_the_summary_is_not_a_lesson_to_continue(user, authed_client):
    course_id = add_course(user.uuid, "课", [(0, "# 学习总结", None), (1, "# 第一篇", None)])
    add_event(course_id, 1, minutes=1)
    add_event(course_id, 0, minutes=9)

    assert last_lesson(authed_client)["lesson_number"] == 1


def test_a_tie_in_time_goes_to_the_later_event(user, authed_client):
    course_id = add_course(user.uuid, "课", [(1, "# 一", None), (2, "# 二", None)])
    add_event(course_id, 1, minutes=5)
    add_event(course_id, 2, minutes=5)

    assert last_lesson(authed_client)["lesson_number"] == 2


def test_other_users_activity_never_shows_up(user, other_user, other_headers, authed_client):
    mine = add_course(user.uuid, "我的课", [(1, "# 我的", None)])
    theirs = add_course(other_user.uuid, "他的课", [(1, "# 他的", None)])
    add_event(mine, 1, minutes=1)
    add_event(theirs, 1, minutes=50)

    assert last_lesson(authed_client)["course_name"] == "我的课"

    from fastapi.testclient import TestClient

    from app.main import app

    assert last_lesson(TestClient(app, headers=other_headers))["course_name"] == "他的课"


def test_title_comes_from_the_first_heading_then_the_file_name(user, authed_client):
    course_id = add_course(user.uuid, "项目", [
        (1, "# 有标题\n\n" + "正文" * 200_000, "a/readme.md"),
        (2, "没有标题的文件", "src/app.py"),
        (3, "没有标题也没有文件名", None),
        (4, "没有标题的笔记", "notes/todo.md"),
    ], is_project=True)
    for number in (1, 2, 3, 4):  # 全部读完后，项目课落在最近打开的那个文件
        add_event(course_id, number, minutes=number, event_type="lesson_completed")
    expected = {1: "有标题", 2: "src/app.py", 3: "", 4: "notes/todo"}
    for number, title in expected.items():
        add_event(course_id, number, minutes=10 + number)
        assert last_lesson(authed_client)["lesson_title"] == title


def test_a_seeded_course_reports_its_lesson(user, authed_client):
    course_id, _ = seed_course(user.uuid, "种子课程")

    body = last_lesson(authed_client)

    assert (body["course_id"], body["course_name"], body["lesson_number"], body["lesson_title"]) == (
        course_id, "种子课程", 1, "第一章",
    )


def test_stats_still_require_login(client):
    assert client.get("/api/stats").status_code == 401
