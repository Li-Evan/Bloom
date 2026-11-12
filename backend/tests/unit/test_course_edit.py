"""改课程名；往项目文件、网页原文、PDF 阅读版建的课里继续添加资料。"""
from unittest.mock import patch

from app import knowledge
from app.models import Course, LearningEvent, Lesson, ProjectImage
from tests.conftest import TestSession, bearer, create_user
from tests.unit.test_knowledge_map import extraction, lesson_for, refresh, sync
from tests.unit.test_pdf_reading import fake_model, images, pdf_bytes  # noqa: F401  images 是 fixture


def project(client, *files, name="读书会"):
    res = client.post("/api/courses/from-project", data={"name": name},
                      files=[("files", (path, text.encode(), "text/plain")) for path, text in files])
    assert res.status_code == 200, res.text
    return res.json()["id"]


def add_files(client, course_id, *files):
    return client.post(f"/api/courses/{course_id}/files",
                       files=[("files", (path, text.encode(), "text/plain")) for path, text in files])


def lessons_of(course_id):
    with TestSession() as db:
        return [(lesson.number, lesson.source_filename, lesson.content)
                for lesson in db.query(Lesson).filter_by(course_id=course_id).order_by(Lesson.number)]


# ---- 改名 ----

def test_rename_tidies_whitespace_and_shows_everywhere(authed_client):
    course_id = project(authed_client, ("a.txt", "第一份。"))
    res = authed_client.patch(f"/api/courses/{course_id}", json={"name": "  博弈论\n  读书笔记 "})
    assert res.status_code == 200, res.text
    assert res.json() == {"id": course_id, "name": "博弈论 读书笔记"}
    assert authed_client.get(f"/api/courses/{course_id}").json()["name"] == "博弈论 读书笔记"
    assert [c["name"] for c in authed_client.get("/api/courses").json()] == ["博弈论 读书笔记"]


def test_rename_rejects_empty_and_too_long_names_and_other_peoples_courses(authed_client, other_headers):
    course_id = project(authed_client, ("a.txt", "第一份。"))
    assert authed_client.patch(f"/api/courses/{course_id}", json={"name": " \n "}).status_code == 400
    too_long = authed_client.patch(f"/api/courses/{course_id}", json={"name": "长" * 201})
    assert too_long.status_code == 400 and "200" in too_long.json()["detail"]
    assert authed_client.patch(f"/api/courses/{course_id}", json={"name": "别人"}, headers=other_headers).status_code == 404
    assert authed_client.get(f"/api/courses/{course_id}").json()["name"] == "读书会"


def test_renaming_keeps_the_knowledge_map_without_extracting_again(client, monkeypatch):
    user = create_user("rename-map@example.com")
    course_id, lesson_id = lesson_for(user)
    calls = []
    monkeypatch.setattr(knowledge, "extract_part", lambda course, text, known: calls.append(text) or extraction())
    assert sync(client, user, refresh(client, user)["next_chunk"]).status_code == 200
    before = refresh(client, user)
    assert before["pending_count"] == 0 and len(before["nodes"]) == 2 and len(calls) == 1

    res = client.patch(f"/api/courses/{course_id}", json={"name": "博弈论入门"}, headers=bearer(user))
    assert res.status_code == 200, res.text
    after = refresh(client, user)
    assert after["pending_count"] == 0 and len(after["nodes"]) == 2 and len(calls) == 1
    assert {s["course_name"] for node in after["nodes"] for s in node["sources"]} == {"博弈论入门"}


def test_renaming_still_redoes_chunks_whose_text_changed(client, monkeypatch):
    user = create_user("rename-changed@example.com")
    course_id, lesson_id = lesson_for(user)
    monkeypatch.setattr(knowledge, "extract_part", lambda course, text, known: extraction())
    assert sync(client, user, refresh(client, user)["next_chunk"]).status_code == 200
    with TestSession() as db:
        db.get(Lesson, lesson_id).content += "\n\n新增一段讲混合策略的内容。"
        db.commit()
    client.patch(f"/api/courses/{course_id}", json={"name": "博弈论入门"}, headers=bearer(user))
    assert refresh(client, user)["pending_count"] == 1


# ---- 往项目课里添加文件 ----

def test_added_files_go_after_the_existing_ones_and_duplicate_names_get_a_number(authed_client):
    course_id = project(authed_client, ("a.txt", "第一份。"), ("b.txt", "第二份。"))
    for number in (1, 2):
        assert authed_client.post(f"/api/courses/{course_id}/lessons/{number}/completed").status_code == 200
    assert authed_client.get(f"/api/courses/{course_id}").json()["status"] == "completed"

    res = add_files(authed_client, course_id, ("c.txt", "第三份。"), ("a.txt", "又一份 a。"))
    assert res.status_code == 200, res.text
    assert res.json() == {"added": [3, 4], "skipped_files": []}
    assert [(n, name) for n, name, _ in lessons_of(course_id)] == [
        (1, "a.txt"), (2, "b.txt"), (3, "a (2).txt"), (4, "c.txt")]
    assert "又一份 a。" in lessons_of(course_id)[2][2]

    # 新文件还没读：课程回到学习中，进度按四个文件算
    course = authed_client.get(f"/api/courses/{course_id}").json()
    assert course["status"] == "learning" and course["lesson_count"] == 4
    assert (course["mastery_covered"], course["mastery_total"]) == (2, 4)
    listed = authed_client.get(f"/api/courses/{course_id}/lessons").json()
    assert [(item["number"], item["is_read"]) for item in listed] == [(1, True), (2, True), (3, False), (4, False)]
    with TestSession() as db:
        assert db.query(LearningEvent).filter_by(course_id=course_id, event_type="project_files_added").count() == 1

    # 再加一次同名的：接着编号
    again = add_files(authed_client, course_id, ("a.txt", "第三个 a。"))
    assert again.json()["added"] == [5] and lessons_of(course_id)[-1][1] == "a (3).txt"


def test_a_web_article_is_added_as_a_markdown_file(authed_client):
    course_id = project(authed_client, ("notes.md", "# 笔记\n\n正文。"))
    article = "# Harness Engineering\n\n[查看来源网页](<https://example.com/post>)\n\n---\n\n正文段落。\n"
    res = authed_client.post(f"/api/courses/{course_id}/files",
                             files=[("files", ("Harness Engineering.md", article.encode(), "text/markdown"))])
    assert res.status_code == 200, res.text
    number, name, content = lessons_of(course_id)[-1]
    assert (number, name) == (2, "Harness Engineering.md") and "正文段落。" in content


def test_skipped_files_are_reported_and_nothing_readable_adds_nothing(authed_client):
    course_id = project(authed_client, ("a.txt", "第一份。"))
    res = authed_client.post(f"/api/courses/{course_id}/files", files=[
        ("files", ("b.txt", "第二份。".encode(), "text/plain")),
        ("files", ("blob.bin", b"\x00\x01\x02", "application/octet-stream"))])
    assert res.status_code == 200, res.text
    assert res.json()["added"] == [2] and len(res.json()["skipped_files"]) == 1
    assert "blob.bin" in res.json()["skipped_files"][0]

    nothing = authed_client.post(f"/api/courses/{course_id}/files",
                                 files=[("files", ("blob.bin", b"\x00\x01", "application/octet-stream"))])
    assert nothing.status_code == 400
    assert len(lessons_of(course_id)) == 2


def test_only_project_courses_take_more_files_and_only_for_people_in_the_course(authed_client, other_headers, user):
    with TestSession() as db:
        topic = Course(user_uuid=user.uuid, name="主题课", mode="topic", status="learning")
        db.add(topic)
        db.commit()
        topic_id = topic.id
    refused = add_files(authed_client, topic_id, ("a.txt", "内容。"))
    assert refused.status_code == 400 and "项目文件" in refused.json()["detail"]

    course_id = project(authed_client, ("a.txt", "第一份。"))
    stranger = authed_client.post(f"/api/courses/{course_id}/files", headers=other_headers,
                                  files=[("files", ("b.txt", "内容。".encode(), "text/plain"))])
    assert stranger.status_code == 404
    assert len(lessons_of(course_id)) == 1


def test_added_images_belong_to_the_course(authed_client, images):  # noqa: F811
    course_id = project(authed_client, ("a.txt", "第一份。"))
    png = images_png()
    res = authed_client.post(f"/api/courses/{course_id}/files", files=[
        ("files", ("doc/notes.md", "# 图\n\n![示意](pic.png)\n".encode(), "text/markdown")),
        ("files", ("doc/pic.png", png, "image/png"))])
    assert res.status_code == 200, res.text
    with TestSession() as db:
        record = db.query(ProjectImage).one()
        assert record.course_id == course_id
    content = lessons_of(course_id)[-1][2]
    assert f"/api/project-images/{record.id}" in content


def images_png():
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(buf, format="PNG")
    return buf.getvalue()


# ---- 往项目课里添加 PDF 阅读版 ----

def test_pdf_reading_can_be_added_to_a_project_course(authed_client, user, images):  # noqa: F811
    first, _ = fake_model(["# Paper\n\nText."])
    with patch("app.courses.get_openai_client", return_value=first):
        created = authed_client.post("/api/courses/from-pdf-reading",
                                     files={"files": ("paper.pdf", pdf_bytes(1), "application/pdf")})
    assert created.status_code == 200, created.text
    course_id = created.json()["id"]

    client, requests = fake_model(["# Second\n\nMore text."])
    raw = pdf_bytes(2)
    with patch("app.courses.get_openai_client", return_value=client):
        res = authed_client.post(f"/api/courses/{course_id}/pdf-reading",
                                 files={"files": ("paper.pdf", raw, "application/pdf")})
    assert res.status_code == 200, res.text
    assert res.json() == {"added": [2], "skipped_files": []}
    assert len(requests) == 2
    number, name, content = lessons_of(course_id)[-1]
    assert (number, name) == (2, "paper (2).pdf.md") and "More text." in content
    original = authed_client.get(f"/api/courses/{course_id}/lessons/2/file")
    assert original.status_code == 200 and original.content == raw


def test_a_failed_pdf_addition_adds_nothing(authed_client, user):
    course_id = project(authed_client, ("a.txt", "第一份。"))

    def create(**_):
        raise RuntimeError("gateway down")

    from types import SimpleNamespace
    broken = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), close=lambda: None)
    with patch("app.courses.get_openai_client", return_value=broken):
        res = authed_client.post(f"/api/courses/{course_id}/pdf-reading",
                                 files={"files": ("doc.pdf", pdf_bytes(1), "application/pdf")})
    assert res.status_code >= 500 and isinstance(res.json()["detail"], str)
    assert len(lessons_of(course_id)) == 1


def test_pdf_reading_addition_checks_the_course_before_calling_the_model(authed_client, user):
    with TestSession() as db:
        topic = Course(user_uuid=user.uuid, name="主题课", mode="topic", status="learning")
        db.add(topic)
        db.commit()
        topic_id = topic.id
    with patch("app.courses.get_openai_client") as client:
        res = authed_client.post(f"/api/courses/{topic_id}/pdf-reading",
                                 files={"files": ("doc.pdf", pdf_bytes(1), "application/pdf")})
    assert res.status_code == 400 and not client.called
    assert lessons_of(topic_id) == []


# ---- 资料类课程之间移动文件 ----

def move(client, course_id, number, headers=None, **body):
    return client.post(f"/api/courses/{course_id}/lessons/{number}/move", json=body, headers=headers or {})


def test_a_file_moves_with_its_notes_and_read_state_and_takes_the_next_number(authed_client):
    source = project(authed_client, ("a.txt", "第一份。"), ("b.txt", "第二份。"), name="资料甲")
    target = project(authed_client, ("b.txt", "乙的 b。"), name="资料乙")
    assert authed_client.post(f"/api/courses/{source}/lessons/2/completed").status_code == 200
    highlight = authed_client.post(f"/api/courses/{source}/lessons/2/highlights", json={
        "position_start": 0, "position_end": 3, "original_text": "第二份"})
    assert highlight.status_code == 200, highlight.text
    with TestSession() as db:
        lesson_id = db.query(Lesson.id).filter_by(course_id=source, number=2).scalar()

    res = move(authed_client, source, 2, target_course_id=target)
    assert res.status_code == 200, res.text
    assert res.json() == {"course_id": target, "course_name": "资料乙", "number": 2}
    # 同一行课文换了课：划线跟着走；重名改成 b (2).txt；已读记录跟着换到新位置
    assert [(n, name) for n, name, _ in lessons_of(source)] == [(1, "a.txt")]
    assert [(n, name) for n, name, _ in lessons_of(target)] == [(1, "b.txt"), (2, "b (2).txt")]
    with TestSession() as db:
        assert db.query(Lesson.course_id).filter_by(id=lesson_id).scalar() == target
    assert len(authed_client.get(f"/api/courses/{target}/lessons/2/highlights").json()) == 1
    listed = authed_client.get(f"/api/courses/{target}/lessons").json()
    assert [(item["number"], item["is_read"]) for item in listed] == [(1, False), (2, True)]
    assert authed_client.get(f"/api/courses/{source}/lessons/2").status_code == 404
    with TestSession() as db:
        assert db.query(LearningEvent).filter_by(course_id=source, lesson_number=2).count() == 0
    # 来源只剩一个没读的文件，目标一读一未读
    assert (authed_client.get(f"/api/courses/{source}").json()["mastery_covered"], 1) == (0, 1)
    assert authed_client.get(f"/api/courses/{target}").json()["mastery_covered"] == 1


def test_moving_the_last_unread_file_out_completes_the_course_and_an_empty_one_is_learning(authed_client):
    source = project(authed_client, ("a.txt", "第一份。"), ("b.txt", "第二份。"))
    assert authed_client.post(f"/api/courses/{source}/lessons/1/completed").status_code == 200
    res = move(authed_client, source, 2, new_course_name="  另一个\n文件夹 ")
    assert res.status_code == 200, res.text
    new = res.json()
    assert new["course_name"] == "另一个 文件夹" and new["number"] == 1
    assert authed_client.get(f"/api/courses/{source}").json()["status"] == "completed"
    created = authed_client.get(f"/api/courses/{new['course_id']}").json()
    assert created["is_project"] and created["status"] == "learning" and created["language"] == "zh"

    emptied = move(authed_client, source, 1, target_course_id=new["course_id"])
    assert emptied.status_code == 200
    course = authed_client.get(f"/api/courses/{source}").json()
    assert course["status"] == "learning" and course["lesson_count"] == 0
    # 新文件夹不填名字就用文件名
    named = move(authed_client, new["course_id"], 1, new_course_name="")
    assert named.json()["course_name"] == "B"


def test_only_folder_courses_owned_by_you_can_move_files(authed_client, user, other_headers):
    source = project(authed_client, ("a.txt", "第一份。"))
    other = project(authed_client, ("b.txt", "第二份。"))
    with TestSession() as db:
        topic = Course(user_uuid=user.uuid, name="主题课", mode="topic", status="learning")
        db.add(topic)
        db.flush()
        db.add(Lesson(course_id=topic.id, number=1, content="# 第一篇"))
        db.commit()
        topic_id = topic.id

    into_topic = move(authed_client, source, 1, target_course_id=topic_id)
    out_of_topic = move(authed_client, topic_id, 1, target_course_id=source)
    assert into_topic.status_code == out_of_topic.status_code == 400
    assert "项目文件" in into_topic.json()["detail"]
    assert move(authed_client, source, 1, target_course_id=source).status_code == 400
    assert move(authed_client, source, 1).status_code == 400
    assert move(authed_client, source, 1, target_course_id=other, new_course_name="x").status_code == 400
    assert move(authed_client, source, 9, target_course_id=other).status_code == 404
    assert move(authed_client, source, 1, other_headers, target_course_id=other).status_code == 404
    assert move(authed_client, source, 1, new_course_name="长" * 201).status_code == 400
    assert [(n, name) for n, name, _ in lessons_of(source)] == [(1, "a.txt")]


def test_images_only_this_file_uses_move_and_shared_ones_are_copied(authed_client, images):  # noqa: F811
    png = images_png()
    res = authed_client.post("/api/courses/from-project", data={"name": "图"}, files=[
        ("files", ("doc/one.md", "# 一\n\n![共用](shared.png)\n\n![自己](own.png)\n".encode(), "text/markdown")),
        ("files", ("doc/two.md", "# 二\n\n![共用](shared.png)\n".encode(), "text/markdown")),
        ("files", ("doc/shared.png", png, "image/png")),
        ("files", ("doc/own.png", png, "image/png"))])
    assert res.status_code == 200, res.text
    source = res.json()["id"]
    target = project(authed_client, ("x.txt", "目标。"))
    with TestSession() as db:
        before = {record.id for record in db.query(ProjectImage).filter_by(course_id=source)}
    assert len(before) == 2

    moved = move(authed_client, source, 1, target_course_id=target)
    assert moved.status_code == 200, moved.text
    content = lessons_of(target)[-1][2]
    remaining = lessons_of(source)[0][2]
    with TestSession() as db:
        in_source = {record.id for record in db.query(ProjectImage).filter_by(course_id=source)}
        in_target = {record.id for record in db.query(ProjectImage).filter_by(course_id=target)}
    # 只有 one.md 用的那张跟着走；共用的那张留给 two.md，one.md 里换成一份复制
    assert len(in_source) == 1 and len(in_target) == 2 and in_source < before
    shared_id = next(iter(in_source))
    assert f"/api/project-images/{shared_id}" in remaining and shared_id not in content
    assert all(f"/api/project-images/{image}" in content for image in in_target)
    for image in in_target:
        assert authed_client.get(f"/api/project-images/{image}").status_code == 200


def test_a_moved_file_keeps_its_knowledge_map_concepts(client, monkeypatch):
    user = create_user("move-map@example.com")
    source, lesson_id = lesson_for(user)
    with TestSession() as db:
        db.get(Course, source).is_project = True
        target = Course(user_uuid=user.uuid, name="另一门", language="zh", is_project=True, mode="source")
        db.add(target)
        db.commit()
        target_id = target.id
    calls = []
    monkeypatch.setattr(knowledge, "extract_part", lambda course, text, known: calls.append(text) or extraction())
    assert sync(client, user, refresh(client, user)["next_chunk"]).status_code == 200
    res = move(client, source, 1, bearer(user), target_course_id=target_id)
    assert res.status_code == 200, res.text
    after = refresh(client, user)
    assert after["pending_count"] == 0 and len(after["nodes"]) == 2 and len(calls) == 1
    assert {s["course_name"] for node in after["nodes"] for s in node["sources"]} == {"另一门"}
