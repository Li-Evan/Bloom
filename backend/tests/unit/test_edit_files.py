"""资料类课程里的单个文件：改名（扩展名和文件夹不变）、改正文（Markdown）；正文改过后找不到原文的划线不再按旧位置画。"""
from app.models import Annotation, Course, Lesson, PassageHighlight
from tests.conftest import TestSession, bearer, create_user, seed_course


def folder(user, *files, name="读书会"):
    """一门资料类课程，files 是（文件名, 正文）；返回课程 id。"""
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name=name, mode="source", is_project=True, language="zh",
                        source_filename=files[0][0] if len(files) == 1 else None)
        db.add(course)
        db.flush()
        for number, (filename, content) in enumerate(files, start=1):
            db.add(Lesson(course_id=course.id, number=number, content=content, is_source=True, source_filename=filename))
        db.commit()
        return course.id


def edit(client, user, course_id, number, **body):
    return client.patch(f"/api/courses/{course_id}/lessons/{number}", headers=bearer(user), json=body)


def lesson(course_id, number):
    with TestSession() as db:
        row = db.query(Lesson).filter_by(course_id=course_id, number=number).one()
        return row.source_filename, row.content


def test_renaming_keeps_the_extension_and_folder_and_avoids_duplicates(client):
    user = create_user("edit-rename@example.com")
    course_id = folder(user, ("docs/JavaScript 不可用。.md", "# 文章\n\n正文。"), ("docs/读书笔记.md", "# 笔记"),
                       ("paper.pdf.md", "# 论文"))
    res = edit(client, user, course_id, 1, name="  改进深度\n智能体  ")
    assert res.status_code == 200, res.text
    assert res.json() == {"number": 1, "source_filename": "docs/改进深度 智能体.md"}
    assert edit(client, user, course_id, 1, name="读书笔记").json()["source_filename"] == "docs/读书笔记 (2).md"
    # PDF 阅读版靠 .pdf.md 认出来，改名不能丢
    assert edit(client, user, course_id, 3, name="注意力").json()["source_filename"] == "注意力.pdf.md"
    names = [item["source_filename"] for item in client.get(f"/api/courses/{course_id}/lessons", headers=bearer(user)).json()]
    assert names == ["docs/读书笔记 (2).md", "docs/读书笔记.md", "注意力.pdf.md"]


def test_renaming_the_only_file_also_renames_what_the_course_shows(client):
    user = create_user("edit-single@example.com")
    course_id = folder(user, ("JavaScript 不可用。.md", "# 文章\n\n正文。"))
    edit(client, user, course_id, 1, name="改进深度智能体")
    with TestSession() as db:
        assert db.get(Course, course_id).source_filename == "改进深度智能体.md"


def test_bad_names_are_refused(client):
    user = create_user("edit-bad-name@example.com")
    course_id = folder(user, ("a.md", "# A"))
    for name, words in ((" \n ", "不能为空"), ("长" * 201, "200"), ("a/b", "斜杠"), ("a\\b", "斜杠")):
        res = edit(client, user, course_id, 1, name=name)
        assert res.status_code == 400 and words in res.json()["detail"], (name, res.text)
    assert edit(client, user, course_id, 1).status_code == 400
    assert lesson(course_id, 1)[0] == "a.md"


def test_editing_the_text_keeps_highlights_whose_words_are_still_there(client):
    user = create_user("edit-content@example.com")
    course_id = folder(user, ("a.md", "# 标题\n\n纳什均衡描述每个人都没有单方面改变策略的动机。\n\n最佳回应是在对方策略不变时的最优选择。"))
    with TestSession() as db:
        lesson_id = db.query(Lesson.id).filter_by(course_id=course_id, number=1).scalar()
        kept = Annotation(lesson_id=lesson_id, position_start=3, position_end=7, original_text="纳什均衡", comment="是什么？")
        bold = Annotation(lesson_id=lesson_id, position_start=30, position_end=34, original_text="最佳回应", comment="举例？")
        gone = PassageHighlight(lesson_id=lesson_id, position_start=10, position_end=20, original_text="没有单方面改变策略的动机")
        db.add_all([kept, bold, gone])
        db.commit()
        ids = kept.id, bold.id, gone.id

    new = "# 标题\n\n纳什均衡是一种稳定状态。\n\n**最佳回应**是在对方策略不变时的最优选择。"
    res = edit(client, user, course_id, 1, content=new)
    assert res.status_code == 200, res.text
    assert lesson(course_id, 1)[1] == new
    with TestSession() as db:
        assert (db.get(Annotation, ids[0]).position_start, db.get(Annotation, ids[0]).position_end) == (3, 7)
        assert (db.get(Annotation, ids[1]).position_start, db.get(Annotation, ids[1]).position_end) == (30, 34)
        # 原文没了：不再按旧位置画到别的字上，但划线本身还在
        assert (db.get(PassageHighlight, ids[2]).position_start, db.get(PassageHighlight, ids[2]).position_end) == (0, 0)
    detail = client.get(f"/api/courses/{course_id}/lessons/1", headers=bearer(user)).json()
    assert detail["content"] == new


def test_text_can_not_be_emptied_and_an_original_pdf_can_only_be_renamed(client):
    user = create_user("edit-pdf@example.com")
    course_id = folder(user, ("a.md", "# A"), ("paper.pdf", "提取出来的文字"))
    assert edit(client, user, course_id, 1, content=" \n").status_code == 400
    pdf = edit(client, user, course_id, 2, content="改一下")
    assert pdf.status_code == 400 and "只能改名" in pdf.json()["detail"]
    assert edit(client, user, course_id, 2, name="论文").json()["source_filename"] == "论文.pdf"
    assert lesson(course_id, 2) == ("论文.pdf", "提取出来的文字")


def test_only_files_of_your_own_material_courses_can_be_edited(client):
    user, other = create_user("edit-owner@example.com"), create_user("edit-other@example.com")
    course_id = folder(user, ("a.md", "# A"))
    assert edit(client, other, course_id, 1, name="b").status_code == 404
    assert edit(client, user, course_id, 9, name="b").status_code == 404
    topic_id = seed_course(user.uuid)[0]
    assert edit(client, user, topic_id, 1, name="b").status_code == 400
    assert lesson(course_id, 1) == ("a.md", "# A")
