"""上传原文课的原文篇头部、课程名留空时的默认名。

大纲优先流程之后，上传的原文原样存成参考材料（第 -1 篇），不再包成第 1 篇阅读篇；
阅读篇头部只剩旧课程的数据形状（_source_lesson_content），这里直接检查那个格式。
"""
import pytest

import app.courses as courses_module
from app.models import Course, Lesson
from tests.conftest import TestSession, seed_source_course
from tests.unit.test_course_language import CJK


@pytest.fixture
def client(authed_client):
    return authed_client


# ---------------------------------------------------------------------------
# B9：上传原文课的原文篇
# ---------------------------------------------------------------------------

def create_source(client, filename, text, *, language="zh"):
    """已有的原文课（「我的资料」入口已下线）：建课时原文去掉首尾空白后原样存成第 -1 篇。"""
    created = seed_source_course(client, filename, text.strip(), learning_depth="simple", language=language)
    return created, client.get(f"/api/courses/{created['id']}/lessons/-1").json()["content"]


def test_a_chinese_source_lesson_states_its_real_length_and_reading_time(client):
    text = "# 标题\n\n" + "系统思考" * 300
    _, source = create_source(client, "thinking-in-systems-notes.md", text)
    assert source == text.strip()  # 原文原样保存（只去掉首尾空白），不加头部

    lesson = courses_module._source_lesson_content("thinking-in-systems-notes.md", text)
    assert lesson.startswith("# 原文 · thinking-in-systems-notes\n\n> 字数：约 1200 字\n> 预计阅读时间：约 4 分钟\n\n## 原文\n\n")
    for old in ("前置知识", "难度", "取决于", "按原文长度而定", "原始材料："):
        assert old not in lesson
    assert "## 你的反馈" in lesson


def test_an_english_source_lesson_counts_words_and_uses_240_words_a_minute(client):
    text = "# Notes\n\n" + ("Interest earns interest. " * 110)  # 2 + 330 个词

    _, source = create_source(client, "interest-notes.md", text, language="en")
    assert source == text.strip()  # 原文原样保存（只去掉首尾空白），不加头部

    lesson = courses_module._source_lesson_content("interest-notes.md", text, "en")
    assert lesson.startswith("# Your material · interest-notes\n\n> Length: about 330 words\n> Estimated reading time: about 2 min\n\n## Original text\n\n")
    assert "Prerequisites" not in lesson and "Difficulty" not in lesson and "depends on" not in lesson
    assert not CJK.search(lesson.split("## Original text")[0])


def test_the_estimate_follows_the_text_not_the_course_language():
    chinese_only = courses_module._reading_stats("系统" * 400)
    english_only = courses_module._reading_stats("systems thinking " * 240)
    mixed = courses_module._reading_stats("系统" * 200 + " systems thinking" * 120)

    assert chinese_only == (800, 2)
    assert english_only == (480, 2)
    assert mixed == (640, 2)  # 400 字 ≈ 1 分钟 + 240 词 ≈ 1 分钟
    assert courses_module._reading_stats("短") == (1, 1)  # 至少 1 分钟
    assert courses_module._reading_stats("a " * 241) == (241, 2)  # 向上取整
    assert courses_module._reading_stats("# Title\n\n* **bold** — `code` | table |")[0] == 4  # 标点和 Markdown 符号不算词


def test_the_source_lesson_is_titled_with_the_file_name_without_its_extension(client):
    created, _ = create_source(client, "chapter_3.final.md", "正文")

    lessons = client.get(f"/api/courses/{created['id']}/lessons").json()

    # 原文是参考材料（第 -1 篇），靠原文件名识别；旧阅读篇的标题仍是「原文 · 去掉扩展名的文件名」
    assert [(item["number"], item["is_source"], item["source_filename"]) for item in lessons] == [(-1, True, "chapter_3.final.md")]
    legacy = courses_module._source_lesson_content("chapter_3.final.md", "正文")
    assert courses_module._extract_title(legacy) == "原文 · chapter_3.final"


def test_old_source_lessons_are_left_alone(client, user):
    old = "# 原始材料：old.md\n\n> 前置知识：无\n> 难度：按原始材料而定\n> 预计阅读时间：按原文长度而定\n\n## 原文\n\n旧"
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="旧", mode="source", status="learning")
        db.add(course)
        db.flush()
        db.add(Lesson(course_id=course.id, number=1, content=old, is_source=True))
        db.commit()
        cid = course.id

    assert client.get(f"/api/courses/{cid}/lessons/1").json()["content"] == old


# ---------------------------------------------------------------------------
# B10：课程名留空时
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("filename,expected", [
    ("thinking-in-systems-notes.md", "Thinking in systems notes"),
    ("my_reading_list.md", "My reading list"),
    ("Mixed-Case_name  here.md", "Mixed Case name here"),
    ("系统思考-笔记.md", "系统思考 笔记"),
    ("notes.v2.md", "Notes.v2"),
    ("plain.md", "Plain"),
    ("AI-notes.md", "AI notes"),
])
def test_a_blank_course_name_becomes_a_readable_name_from_the_file_name(filename, expected):
    assert courses_module._readable_course_name(filename) == expected


def test_a_single_file_project_gets_the_same_readable_name_but_a_folder_name_is_kept(client):
    single = client.post("/api/courses/from-project", files=[("files", ("my-notes.md", b"x", "text/markdown"))]).json()
    folder = client.post("/api/courses/from-project", files=[
        ("files", ("my-code/a.py", b"x", "text/plain")), ("files", ("my-code/b.py", b"y", "text/plain")),
    ]).json()
    loose = client.post("/api/courses/from-project", files=[
        ("files", ("a.py", b"x", "text/plain")), ("files", ("b.py", b"y", "text/plain")),
    ]).json()

    assert single["name"] == "My notes"
    assert folder["name"] == "my-code"
    assert loose["name"] == "项目"


def test_the_name_helpers_cope_with_odd_file_names():
    assert courses_module._readable_course_name("-.md") == "-"
    assert courses_module._readable_course_name("___.md") == "___"
    assert courses_module._readable_course_name("dir/sub/final-draft.txt") == "Final draft"
    assert courses_module._filename_stem("a\\b\\c.md") == "c"
    assert courses_module._filename_stem(".hidden") == ".hidden"
