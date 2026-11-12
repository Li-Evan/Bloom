"""课程语言：courses.language、四个建课接口与推荐刷新的参数、每条生成路径发给模型的提示词，以及英文课端到端。

英文课的断言核心有两条：发给模型的每一条消息（系统提示词和用户消息）里没有一个汉字，并且明确要求英文输出；
模型按英文结构输出时，建课、生成下一篇、勾选掌握项、抽取思考题都能成功。解析器本身的单元测试在 test_language_markers.py。
"""
import json
import re
import threading
from contextlib import contextmanager
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import text

import app.course_language as language_module
import app.course_planning as course_planning
import app.courses as courses_module
import app.prompts_en as prompts_en
from app.models import Course, LearningEvent, LearningRecommendation, Lesson, Syllabus
from app.recommendations import RECOMMENDATION_PROMPT
from tests.conftest import TestSession, mock_stream, seed_source_course
from tests.unit.test_language_markers import EN_LESSON, EN_PACK_BODY, INDEX

CJK = re.compile(r"[一-鿿]")
EN_LESSON_STAMPED = EN_LESSON.replace("Estimated reading time: 8 minutes", "Estimated reading time: 1 minute")


@pytest.fixture
def client(authed_client):
    return authed_client


def syllabus_text(depth_items=8):
    items = "\n".join(f"- [ ] Explain core concept {i} (Source: concepts.md, Core concepts)" for i in range(1, depth_items + 1))
    return (
        "# Compound interest · Course Outline\n\n> Learning depth: Simple\n\n## Core mastery items\n\n"
        f"After completing this topic, you will be able to:\n\n### Main line\n{items}\n\n## Out of scope\n\n- Tax\n\n"
        "## Learning progress\n\n| Lesson | Mastery items covered | Date generated |\n|--------|----------------------|----------------|\n"
    )


EN_PACK = (
    f"{language_module.PACK_HEADINGS_EN[0]}\n{EN_PACK_BODY}\n{language_module.PACK_HEADINGS_EN[-1]}\n{INDEX}\n"
)
EN_NEXT = (
    "# Lesson 2: Growth\n\n> Prerequisites: Lesson 1\n> Difficulty: Beginner\n> Estimated reading time: 6 minutes\n\n---\n\n"
    "## Review of the previous reflection questions\n\n### Correct answers\n\n**Question 1:** Why does it bend?\n> Because interest compounds.\n\n"
    "## Main content\n\nGrowth is exponential (Source: concepts.md, Core concepts).\n\n## Reflection questions\n\n"
    "1. What happens to the curve if the rate doubles?\n2. When is simple interest a fair model?\n\n"
    "<!-- mastery: Explain core concept 1 (Source: concepts.md, Core concepts); Explain core concept 2 (Source: concepts.md, Core concepts) -->"
)
EN_PROJECT_ANSWER = "It means the interest is added to the balance before the next period."


def respond_en(system: str, user: str) -> str:
    if "course syllabus design expert" in system or "fact-checker for source-grounded course outlines" in system \
            or "format fixer for source-grounded course outlines" in system:
        return syllabus_text()
    if "course material analyzer" in system:
        return "Interest earns interest (Source: concepts.md, Core concepts)"
    if "course material merger" in system:
        return "Merged notes (Source: concepts.md, Core concepts)"
    if "chief editor of course materials" in system:
        return EN_PACK
    if "fact and teaching-quality reviewer" in system or "format fixer for source-grounded first lessons" in system:
        return EN_LESSON
    if "write the first lesson (01)" in system:
        return EN_LESSON
    if "From the student's feedback and highlights, write the next lesson" in system:
        return EN_NEXT
    if "has just finished reading a PDF/TXT/Markdown source document" in system:
        return EN_NEXT
    if "Every mastery item in the outline has now been covered" in system:
        return "<!-- eval-article -->\n\n# Compound interest · Final Assessment\n\n## Review of the previous reflection questions\n\nDone."
    if "course summary expert" in system:
        return "# Compound interest · Learning Summary\n\n## Knowledge map\n\n- interest"
    if "one-on-one learning tutor" in system:
        return EN_PROJECT_ANSWER
    if "learning-path recommendation module" in system:
        return json.dumps([
            {"title": f"Topic {i}", "rationale": "You have already studied interest.", "bridge": "It builds on what you learned.", "source_topics": ["Compound interest"]}
            for i in range(1, 4)
        ])
    raise AssertionError("unexpected prompt: " + system[:100])


class FakeModel:
    """替换 get_openai_client：记下每次调用的 (系统提示词, 用户消息)，按 responder 给出文字。"""

    def __init__(self, responder=respond_en):
        self.responder = responder
        self.calls: list[dict] = []
        self.lock = threading.Lock()
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def close(self):
        """_call_llm 用完会关掉客户端（释放连接池）；假客户端没有连接，空操作即可。"""

    def create(self, **kwargs):
        messages = kwargs["messages"]
        system, user = messages[0]["content"], messages[-1]["content"]
        with self.lock:
            self.calls.append({
                "system": system, "user": user, "messages": messages, "stream": bool(kwargs.get("stream")), "kwargs": kwargs,
            })
        reply = self.responder(system, user)
        if kwargs.get("stream"):
            reply = reply or ""
            return mock_stream([reply[: len(reply) // 2], reply[len(reply) // 2:]])
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = reply
        response.choices[0].finish_reason = "stop" if reply else "length"  # 推理吃光 max_tokens 时：content 为空、finish_reason=length
        return response

    def all_text(self):
        return [part for call in self.calls for part in (call["system"], *(m["content"] for m in call["messages"][1:]))]


@contextmanager
def fake_model(responder=respond_en):
    model = FakeModel(responder)
    with patch("app.courses.get_openai_client", return_value=model):
        yield model


def assert_english_only(model):
    """发给模型的每一条消息里都没有汉字（输入材料本身是英文）。"""
    assert model.calls
    for part in model.all_text():
        assert not CJK.search(part), CJK.search(part).group(0) + " in: " + part[:200]


def sse_events(res):
    return [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]


def start_first_lesson(client, course_id):
    """建课只生成大纲；确认大纲后由 POST /courses/{id}/first 单独生成第 01 篇（大纲优先流程）。"""
    res = client.post(f"/api/courses/{course_id}/first")
    assert res.status_code == 200, res.text
    assert res.json()["number"] == 1 and res.json()["is_source"] is False
    return res.json()


def create_topic(client, language="en", name="Compound interest", first=True, **extra):
    """建主题课；first=True 时接着生成第 01 篇，两次请求的模型调用记在同一个 model 里（calls[0] 大纲、calls[1] 首篇）。"""
    with fake_model() as model:
        res = client.post("/api/courses", json={"name": name, "learning_depth": "simple", "language": language, **extra})
        assert res.status_code == 200, res.text
        if first:
            start_first_lesson(client, res.json()["id"])
    return res.json(), model


def create_materials(client, language="en", files=None, data=None, first=True):
    files = files or [
        ("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown")),
        ("files", ("cases.md", b"# Cases\n\nA savings account.", "text/markdown")),
    ]
    with fake_model() as model:
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "Compound interest", "learning_depth": "simple", "language": language, **(data or {})},
            files=files,
        )
        assert res.status_code == 200, res.text
        if first:
            start_first_lesson(client, res.json()["id"])
    return res.json(), model


def create_source(client, language="en", first=False):
    """已有的原文课（「我的资料」入口已下线，库里还有）：原文是参考材料（第 -1 篇，不占课文编号）；
    first=True 时接着生成第 01 篇教学课文。"""
    created = seed_source_course(
        client, "notes.md", "# Notes\n\nInterest earns interest over time.", name="Interest notes",
        syllabus=syllabus_text(), learning_depth="simple", language=language,
    )
    with fake_model() as model:
        if first:
            start_first_lesson(client, created["id"])
    return created, model


def make_legacy_source_course(course_id, language="en"):
    """把刚建好的原文课改成旧数据形状：原文阅读篇占第 1 篇（带旧的阅读篇外壳）、还没有教学课文。

    现在建原文课时原文只存成参考材料（第 -1 篇）；旧课程的原文篇仍在第 1 篇，生成下一篇时走原文课提示词（source_first 兼容路径）。
    """
    with TestSession() as db:
        source = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.is_source.is_(True)).one()
        source.number = 1
        source.content = courses_module._source_lesson_content(source.source_filename, source.content, language)
        db.query(LearningEvent).filter_by(course_id=course_id, lesson_number=-1).update({"lesson_number": 1})
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == course_id).one()
        syllabus.content = courses_module._record_lesson_progress(
            syllabus.content, language, 1, [language_module.text_for(language).progress_source], date.today(),
        )
        db.commit()


def next_lesson(client, course_id, responder=respond_en):
    with fake_model(responder) as model:
        res = client.post(f"/api/courses/{course_id}/next")
    assert res.status_code == 200, res.text
    assert not any("error" in event for event in sse_events(res)), res.text
    return model


def ask(client, course_id, lesson=1):
    with fake_model() as model:
        res = client.post(f"/api/courses/{course_id}/lessons/{lesson}/annotations", json={
            "position_start": 0, "position_end": 4, "original_text": "Interest", "comment": "What does this mean?",
            "answer_immediately": True,
        })
    assert res.status_code == 200, res.text
    return res, model


# ---------------------------------------------------------------------------
# 接口与存储
# ---------------------------------------------------------------------------

def test_a_course_without_a_language_is_a_chinese_course(client):
    with fake_model(lambda system, user: syllabus_text() if "课程大纲" in system or "syllabus" in system else EN_LESSON) as model:
        created = client.post("/api/courses", json={"name": "博弈论", "learning_depth": "simple"}).json()
        start_first_lesson(client, created["id"])

    assert created["language"] == "zh"
    assert client.get(f"/api/courses/{created['id']}").json()["language"] == "zh"
    assert [c["language"] for c in client.get("/api/courses").json()] == ["zh"]
    # 课程设计约定（course_planning.CURRICULUM_PROMPT）只在 Codex Agent 模式下接在大纲提示词后面；测试里 Agent 关闭
    assert model.calls[0]["system"] == courses_module._build_syllabus_prompt("simple", "zh", has_reference=False)
    assert model.calls[1]["system"].startswith(courses_module.FIRST_LESSON_PROMPT.split("{syllabus}")[0])
    with TestSession() as db:
        assert db.query(Course).one().language == "zh"


def test_a_topic_course_can_be_created_in_english(client):
    created, model = create_topic(client)

    assert created["language"] == "en" and created["name"] == "Compound interest"
    assert created["syllabus_content"].startswith("# Compound interest · Course Outline")
    assert client.get(f"/api/courses/{created['id']}").json()["language"] == "en"
    listed = client.get("/api/courses").json()
    assert [(c["id"], c["language"]) for c in listed] == [(created["id"], "en")]
    # 「预计阅读时间」由代码按字数重算，不用模型自己报的 8 分钟
    assert client.get(f"/api/courses/{created['id']}/lessons/1").json()["content"] == EN_LESSON_STAMPED.strip()
    with TestSession() as db:
        assert db.query(Course).one().language == "en"


@pytest.mark.parametrize("value", ["fr", "EN", "zh-CN", "", "english", None, 1, ["en"]])
def test_an_unknown_language_is_a_422_before_the_model_is_called(client, user, value):
    with fake_model() as model:
        res = client.post("/api/courses", json={"name": "x", "language": value})

    assert res.status_code == 422
    assert not model.calls
    with TestSession() as db:
        assert db.query(Course).count() == 0


@pytest.mark.parametrize("value", ["fr", "EN", "zh-CN", "english", " en"])
@pytest.mark.parametrize("endpoint", ["from-materials", "from-project"])
def test_the_form_endpoints_reject_an_unknown_language_with_422_and_call_no_model(client, user, endpoint, value):
    files = [("files", ("a.md", b"# A\n\ntext", "text/markdown"))]

    with fake_model() as model:
        res = client.post(f"/api/courses/{endpoint}", data={"name": "x", "language": value}, files=files)

    assert res.status_code == 422, res.text
    assert not model.calls
    with TestSession() as db:
        assert db.query(Course).count() == 0


ZH_SYLLABUS = (
    "# 资料课 · 课程大纲\n\n## 核心掌握项\n\n### 主线\n"
    + "\n".join(f"- [ ] 能够解释核心概念{i}（来源：甲.md，概念）" for i in range(1, 9))
    + "\n\n## 不在本课题范围内\n\n- 外部内容\n\n## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|------|-----------|---------|\n"
)
ZH_LESSON = (
    "# 第一课\n\n## 正文内容\n\n资料指出核心概念彼此关联（来源：甲.md，概念）（来源：甲.md，案例）\n\n## 思考题\n\n"
    "1. 如何解释核心概念？\n2. 如何把它用于案例？\n"
)
ZH_PACK = (
    "\n".join(f"{h}\n内容" for h in language_module.PACK_HEADINGS_ZH[:-1])
    + f"\n{language_module.PACK_HEADINGS_ZH[-1]}\n" + "甲.md：概念与案例章节，关键位置均已保留。" * 6
)


def respond_zh(system, user):
    if "课程大纲设计专家" in system or "事实校对器" in system or "格式修复器" in system:
        return ZH_SYLLABUS
    if "课程资料分析器" in system or "课程资料归并器" in system:
        return "笔记（来源：甲.md，概念）"
    if "课程资料总编" in system:
        return ZH_PACK
    return ZH_LESSON


@pytest.mark.parametrize("endpoint", ["from-materials", "from-project"])
def test_the_form_endpoints_default_to_chinese(client, endpoint):
    files = [("files", ("甲.md", "# 概念\n\n正文".encode(), "text/markdown"))]

    with fake_model(respond_zh) as model:
        res = client.post(f"/api/courses/{endpoint}", data={"name": "资料课", "learning_depth": "simple"}, files=files)

    assert res.status_code == 200, res.text
    assert res.json()["language"] == "zh"
    assert client.get(f"/api/courses/{res.json()['id']}").json()["language"] == "zh"
    if endpoint != "from-project":
        assert model.calls[0]["system"] == courses_module.MATERIAL_CHUNK_PROMPT


def test_every_creation_response_carries_the_language(client):
    topic, _ = create_topic(client)
    materials, _ = create_materials(client)
    with fake_model():
        project = client.post(
            "/api/courses/from-project", data={"language": "en"},
            files=[("files", ("a.py", b"print(1)", "text/plain")), ("files", ("b.py", b"print(2)", "text/plain"))],
        ).json()

    assert [c["language"] for c in (topic, materials, project)] == ["en"] * 3
    assert {c["id"]: c["language"] for c in client.get("/api/courses").json()} == {
        c["id"]: "en" for c in (topic, materials, project)
    }


def test_the_language_does_not_change_when_the_course_moves_on(client):
    created, _ = create_topic(client, first=False)

    # 大纲只能在开始学习前修改（之后 409），所以先改大纲、再开始学习
    edited = {"content": "# x\n\n- [ ] Explain x", "language": "zh"}
    assert client.put(f"/api/courses/{created['id']}/syllabus", json=edited).status_code == 200
    assert client.get(f"/api/courses/{created['id']}").json()["language"] == "en"
    with fake_model():
        start_first_lesson(client, created["id"])
    next_lesson(client, created["id"])

    assert client.get(f"/api/courses/{created['id']}").json()["language"] == "en"


def test_courses_from_before_the_language_column_behave_as_chinese_courses(client, user):
    with TestSession() as db:
        db.execute(text(
            "INSERT INTO courses (user_uuid, name, mode, status, learning_depth, is_project, created_at) "
            "VALUES (:u, '旧课程', 'topic', 'learning', 'standard', 0, CURRENT_TIMESTAMP)"
        ), {"u": user.uuid})
        db.commit()
        course_id = db.query(Course).one().id
        db.add(Syllabus(course_id=course_id, content="# 旧课程 · 课程大纲\n\n- [ ] 能够解释概念A"))
        db.add(Lesson(course_id=course_id, number=1, content="# 第一章\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 起点？"))
        db.commit()

    assert client.get(f"/api/courses/{course_id}").json()["language"] == "zh"
    with fake_model(lambda system, user: "# 第二章\n\n## 思考题\n\n1. 新问？\n\n<!-- mastery: 能够解释概念A -->") as model:
        res = client.post(f"/api/courses/{course_id}/next")

    assert res.status_code == 200
    system = model.calls[0]["system"]
    assert system.startswith("你是一个基于 Bloom 2-Sigma 理论的一对一苏格拉底式导师。\n\n根据学生的反馈和批注，生成下一篇课文。")
    assert "1. 起点？" in system and "课程参考知识包" not in system.split("## 没有参考资料")[0]
    assert "## 没有参考资料（必须遵守）" in system and "## 资料规则" not in system
    assert model.calls[0]["user"] == "生成第2篇课文"
    client.post(f"/api/courses/{course_id}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    assert "- [x] 能够解释概念A" in client.get(f"/api/courses/{course_id}/syllabus").json()["content"]


# ---------------------------------------------------------------------------
# 主题课：大纲与首篇
# ---------------------------------------------------------------------------

def test_an_english_topic_course_asks_for_english_in_every_prompt(client):
    created, model = create_topic(client, reference="Compound interest means interest on interest.", learning_depth="deep")

    syllabus_call, lesson_call = model.calls[0], model.calls[1]
    assert syllabus_call["system"] == courses_module._build_syllabus_prompt("deep", "en")  # Agent 关闭：不接课程设计约定
    assert "Write the entire outline in English" in syllabus_call["system"]
    assert "- Learning depth: Deep" in syllabus_call["system"] and "12-15 mastery items" in syllabus_call["system"]
    assert syllabus_call["user"].startswith("Topic: Compound interest\nLearning depth: Deep")
    assert "## Course reference pack\n\nCompound interest means interest on interest." in syllabus_call["user"]
    assert "Write the whole lesson in English" in lesson_call["system"]
    assert "## Reflection questions" in lesson_call["system"] and "## 思考题" not in lesson_call["system"]
    assert 'at the "Deep" learning depth' in lesson_call["user"] and "Write everything in English." in lesson_call["user"]
    assert created["language"] == "en"
    # 粘贴参考文本的主题课不是资料课：首篇用「有参考文本」的那套说法，不要求「依据资料」开头，也没有资料课的首篇审校
    assert "According to the materials" not in lesson_call["user"]
    assert len(model.calls) == 2
    assert_english_only(model)


def test_an_english_topic_course_without_a_reference_has_no_reference_section_and_forbids_source_labels(client):
    _, model = create_topic(client)

    lesson_system = model.calls[1]["system"]
    assert "Course reference pack" not in lesson_system and "Not provided" not in lesson_system
    assert "## No reference material (mandatory)" in lesson_system
    assert "Never write these internal labels or phrases" in lesson_system
    assert "## Source rules" not in lesson_system and "Source grounding" not in lesson_system
    assert "## Course reference pack" not in model.calls[0]["user"]


def test_the_chinese_prompts_are_what_a_chinese_course_sends(client):
    with fake_model(lambda system, user: syllabus_text() if "课程大纲设计专家" in system else EN_LESSON) as model:
        created = client.post("/api/courses", json={"name": "博弈论", "reference": "参考", "learning_depth": "deep", "language": "zh"})
        start_first_lesson(client, created.json()["id"])

    assert model.calls[0]["system"] == courses_module._build_syllabus_prompt("deep", "zh")  # 带了参考文本；Agent 关闭
    assert model.calls[0]["user"] == "课题：博弈论\n学习深度：深入\n\n## 课程参考知识包\n\n参考"
    assert "按「深入」学习深度" in model.calls[1]["user"]


# ---------------------------------------------------------------------------
# 资料课：流水线每一步
# ---------------------------------------------------------------------------

def test_an_english_material_course_runs_every_stage_in_english(client):
    def responder(system, user):
        return "ok" if "course material merger" in system else respond_en(system, user)

    with patch.object(courses_module, "MATERIAL_REDUCE_BATCH_CHARS", 40):
        with fake_model(responder) as model:
            res = client.post(
                "/api/courses/from-materials",
                data={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
                files=[
                    ("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown")),
                    ("files", ("cases.md", b"# Cases\n\nA savings account.", "text/markdown")),
                ],
            )
            assert res.status_code == 200, res.text
            start_first_lesson(client, res.json()["id"])  # 首篇与首篇审校在确认大纲后单独生成
    created = res.json()

    systems = [call["system"] for call in model.calls]
    assert prompts_en.MATERIAL_CHUNK_PROMPT in systems
    assert prompts_en.MATERIAL_REDUCE_PROMPT in systems
    assert prompts_en.MATERIAL_SYNTHESIS_PROMPT in systems
    assert prompts_en.GROUNDED_SYLLABUS_REVIEW_PROMPT + course_planning.REVIEW_RULE in systems
    assert prompts_en.GROUNDED_LESSON_REVIEW_PROMPT in systems
    assert any(s.startswith(prompts_en.SYLLABUS_PROMPT.split("{learning_depth_section}")[0]) for s in systems)
    assert any(s.startswith(prompts_en.FIRST_LESSON_PROMPT.split("{syllabus}")[0]) for s in systems)
    assert_english_only(model)
    chunk_user = next(c["user"] for c in model.calls if c["system"] == prompts_en.MATERIAL_CHUNK_PROMPT)
    assert chunk_user.startswith("This is source chunk 1/1:")
    assert "[Source: concepts.md; Location: Core concepts]" in chunk_user and "[Source: cases.md; Location: Cases]" in chunk_user
    synthesis_user = next(c["user"] for c in model.calls if c["system"] == prompts_en.MATERIAL_SYNTHESIS_PROMPT)
    assert synthesis_user.startswith("Topic: Compound interest\nMaterial files: concepts.md, cases.md\n\n")
    syllabus_user = next(c["user"] for c in model.calls if "course syllabus design expert" in c["system"])
    assert "## Extra constraints for a source-grounded outline" in syllabus_user
    assert created["language"] == "en" and created["source_filename"] == "2 reference sources"


def test_an_english_material_course_is_created_from_english_structure(client):
    created, _ = create_materials(client)

    lesson = client.get(f"/api/courses/{created['id']}/lessons/1").json()["content"]
    assert lesson.startswith("# Compound interest\n")
    assert "## Main content\n\nAccording to the materials" in lesson and "## Reflection questions" in lesson
    assert courses_module._extract_thought_questions(lesson).count("?") == 2
    assert created["syllabus_content"].count("- [ ]") == 8
    assert created["mastery_progress"] == 0.0 and created["lesson_count"] == 0  # 建课只生成大纲
    course = client.get(f"/api/courses/{created['id']}").json()
    assert course["language"] == "en" and course["lesson_count"] == 1  # 第 01 篇由 /first 生成


def test_a_single_english_file_and_pasted_text_are_labeled_in_english(client):
    created, model = create_materials(
        client, files=[("files", ("only.md", b"No headings here.", "text/markdown"))], data={"reference": "Pasted notes."},
    )

    chunk_user = next(c["user"] for c in model.calls if c["system"] == prompts_en.MATERIAL_CHUNK_PROMPT)
    assert "[Source: only.md; Location: Start of document]" in chunk_user
    assert "[Source: Pasted reference; Location: Full text]" in chunk_user
    assert created["source_filename"] == "2 reference sources"
    assert_english_only(model)


def _material_files(*bodies):
    return [("files", (f"{name}.md", body.encode(), "text/markdown")) for name, body in zip("abcd", bodies)]


def test_two_small_files_are_one_chunk_in_either_language(client, user):
    files = [
        ("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown")),
        ("files", ("cases.md", b"# Cases\n\nA savings account.", "text/markdown")),
    ]

    chunks = {}
    for language, responder in (("en", respond_en), ("zh", respond_zh)):
        with fake_model(responder) as model:
            res = client.post(
                "/api/courses/from-materials", data={"name": "x", "learning_depth": "simple", "language": language}, files=files,
            )
        assert res.status_code == 200, res.text
        chunk_prompt = courses_module.PROMPTS[language].material_chunk
        chunks[language] = sum(call["system"] == chunk_prompt for call in model.calls)

    assert chunks == {"en": 1, "zh": 1}


def test_a_chunk_boundary_can_fall_differently_per_language_because_the_source_markers_differ_in_length(client, user):
    """英文的来源标记比中文的长，卡着分块上限的资料，英文课可能多一个分块；实际提炼的分块数与切分出的一致。"""
    marked = {
        language: len(language_module.text_for(language).source_marker.format(
            source="a.md", locator=language_module.text_for(language).locator_document_start,
        )) + 1 + 100
        for language in ("zh", "en")
    }
    assert marked["en"] > marked["zh"]
    sections = {
        language: [
            courses_module.MaterialSection(name, language_module.text_for(language).locator_document_start, "x" * 100)
            for name in ("a.md", "b.md")
        ]
        for language in ("zh", "en")
    }
    files = _material_files("x" * 100, "x" * 100)

    with patch.object(courses_module, "MATERIAL_CHUNK_TARGET_CHARS", 2 * marked["zh"]):
        assert [len(courses_module._chunk_material_sections(sections[lang], lang)) for lang in ("zh", "en")] == [1, 2]
        for language, responder in (("zh", respond_zh), ("en", respond_en)):
            with fake_model(responder) as model:
                res = client.post(
                    "/api/courses/from-materials", data={"name": "x", "learning_depth": "simple", "language": language}, files=files,
                )
            assert res.status_code == 200, res.text
            chunk_prompt = courses_module.PROMPTS[language].material_chunk
            assert sum(call["system"] == chunk_prompt for call in model.calls) == {"zh": 1, "en": 2}[language]


def test_a_malformed_reviewer_report_falls_back_to_the_valid_english_draft(client):
    def responder(system, user):
        if "fact and teaching-quality reviewer" in system:
            return "Review notes: the lesson is fine.\n\n```text\nnothing\n```"
        if "fact-checker for source-grounded course outlines" in system:
            return "Sorry, here is a table report only.\n\n| a | b |\n"
        return respond_en(system, user)

    with fake_model(responder) as model:
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
            files=[("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown"))],
        )
        assert res.status_code == 200, res.text
        start_first_lesson(client, res.json()["id"])

    assert res.json()["syllabus_content"].startswith("# Compound interest · Course Outline")
    assert client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"].strip() == EN_LESSON_STAMPED.strip()
    assert_english_only(model)


def test_an_english_draft_with_loose_structure_is_normalized_and_the_course_is_still_created(client):
    loose = (
        "# Compound interest\n\n## Content\n\nInterest can earn interest (Source: concepts.md, Core concepts) "
        "and grows with time (Source: cases.md, Cases).\n\n### Reflection Questions\n\n"
        "1. Why does the curve bend upwards.\n2. Explain simple versus compound interest.\n"
    )

    def responder(system, user):
        if "fact and teaching-quality reviewer" in system:
            return "no lesson here"
        if "format fixer for source-grounded first lessons" in system:
            return loose
        if "write the first lesson (01)" in system:
            return loose
        return respond_en(system, user)

    with fake_model(responder) as model:
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
            files=[("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown"))],
        )
        assert res.status_code == 200, res.text
        start_first_lesson(client, res.json()["id"])

    lesson = client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"]
    assert "## Main content\n\nAccording to the materials, what follows is built on" in lesson
    assert "## Reflection questions" in lesson and "###" not in lesson
    questions = courses_module._extract_thought_questions(lesson)
    assert "Why does the curve bend upwards?" in questions and "Explain simple versus compound interest?" in questions
    assert_english_only(model)


def test_questions_the_model_writes_as_plain_lines_survive_into_the_created_course(client):
    plain = EN_LESSON.split("## Reflection questions")[0] + (
        "## Reflection questions\n\nWhy does the growth curve bend upwards?  \n"
        "How would you compare simple and compound interest for ten years?  \n"
    )

    def responder(system, user):
        if "fact and teaching-quality reviewer" in system or "write the first lesson (01)" in system:
            return plain
        return respond_en(system, user)

    with fake_model(responder):
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
            files=[("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown"))],
        )
        assert res.status_code == 200, res.text
        start_first_lesson(client, res.json()["id"])

    lesson = client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"]
    assert courses_module._extract_thought_questions(lesson) == (
        "1. Why does the growth curve bend upwards?\n2. How would you compare simple and compound interest for ten years?"
    )


def test_a_reviewer_that_drops_the_sources_is_repaired_in_english(client):
    sourceless = syllabus_text().replace(" (Source: concepts.md, Core concepts)", "")
    seen = []

    def responder(system, user):
        if "fact-checker for source-grounded course outlines" in system:
            seen.append("review")
            return sourceless
        if "format fixer for source-grounded course outlines" in system:
            seen.append("repair")
            return syllabus_text()
        if "course syllabus design expert" in system:
            return sourceless
        return respond_en(system, user)

    with fake_model(responder) as model:
        res = client.post(
            "/api/courses/from-materials",
            data={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
            files=[("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown"))],
        )

    assert res.status_code == 200, res.text
    assert seen == ["review", "repair"]
    repair_user = next(c["user"] for c in model.calls if "format fixer for source-grounded course outlines" in c["system"])
    assert repair_user.startswith("Target number of mastery items: 8-10\n\n## Reference pack\n")
    assert "## Original draft\n# Compound interest" in repair_user and "## Reviewed version\n# Compound interest" in repair_user
    assert "(Source:" in res.json()["syllabus_content"]


def test_an_english_course_whose_model_never_produces_valid_structure_fails_cleanly(client, user):
    def responder(system, user_message):
        if "fact and teaching-quality reviewer" in system or "format fixer for source-grounded first lessons" in system \
                or "write the first lesson (01)" in system:
            return "# Lesson\n\nJust one paragraph, no sources, no questions."
        return respond_en(system, user_message)

    with fake_model(responder):
        created = client.post(
            "/api/courses/from-materials",
            data={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
            files=[("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown"))],
        )
        assert created.status_code == 200, created.text  # 建课只生成大纲，不受首篇结构影响
        outline = client.get(f"/api/courses/{created.json()['id']}/syllabus").json()["content"]
        res = client.post(f"/api/courses/{created.json()['id']}/first")

    # 首篇始终不合格：不留半成品课文，原大纲保留，可以重试
    assert res.status_code == 502 and isinstance(res.json()["detail"], str)
    with TestSession() as db:
        assert db.query(Lesson).filter(Lesson.course_id == created.json()["id"], Lesson.number > 0).count() == 0
    assert client.get(f"/api/courses/{created.json()['id']}/syllabus").json()["content"] == outline


# ---------------------------------------------------------------------------
# 原文课、项目课
# ---------------------------------------------------------------------------

def test_a_text_file_alone_makes_a_materials_course(client):
    """「我的资料」并进「主题或资料」后，只传一个 TXT 也走资料建课：整份是一个「全文」片段。"""
    created, model = create_materials(
        client, files=[("files", ("notes.txt", b"Interest earns interest over time.", "text/plain"))], first=False,
    )

    assert created["mode"] == "topic" and created["lesson_count"] == 0
    assert created["syllabus_content"].startswith("# Compound interest · Course Outline")
    chunks = [call for call in model.calls if "course material analyzer" in call["system"]]
    assert len(chunks) == 1 and "[Source: notes.txt; Location: Full text]\nInterest earns interest over time." in chunks[0]["user"]


def test_an_english_project_course_gets_an_english_default_name(client):
    with fake_model():
        res = client.post(
            "/api/courses/from-project", data={"language": "en"},
            files=[("files", ("a.py", b"print(1)", "text/plain")), ("files", ("b.py", b"print(2)", "text/plain"))],
        )
        zh = client.post(
            "/api/courses/from-project",
            files=[("files", ("a.py", b"print(1)", "text/plain")), ("files", ("b.py", b"print(2)", "text/plain"))],
        )

    assert res.json()["name"] == "Project" and res.json()["language"] == "en"
    assert zh.json()["name"] == "项目" and zh.json()["language"] == "zh"


# ---------------------------------------------------------------------------
# 下一篇、评估篇、总结
# ---------------------------------------------------------------------------

def test_the_next_english_lesson_is_asked_for_in_english_and_ticks_the_english_outline(client):
    created, _ = create_materials(client)
    cid = created["id"]
    ask_res, _ = ask(client, cid)
    assert "annotation" in ask_res.text
    client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "Very clear.", "thought_answers": "Because it compounds."})

    model = next_lesson(client, cid)

    call = model.calls[0]
    assert call["system"].startswith(prompts_en.NEXT_LESSON_PROMPT.split("{syllabus}")[0])
    assert call["user"] == "Write lesson 2"
    system = call["system"]
    assert "Feedback: Very clear.\nAnswers to the reflection questions: Because it compounds." in system
    assert "- Original text “Interest”\n  Q: What does this mean?\n  A: " + EN_PROJECT_ANSWER in system
    assert "### Lesson 1\n# Compound interest" in system
    questions = system.split("(the original text of the reflection questions actually listed at the end of the previous lesson; the review must correspond to them strictly)\n", 1)[1]
    assert questions.startswith("1. Why does the growth curve bend upwards?\n2. How would you compare simple and compound interest for ten years?\n\n## Length of the previous lesson\nabout")
    # 第二篇起不带整包知识包，只带和这一篇相关的资料片段，规则也是英文的
    assert "## Course reference pack" not in system and "# Course Reference Pack" not in system
    assert "## Material excerpts most relevant to this lesson\n[Source: concepts.md; Location: Core concepts]\n# Core concepts" in system
    assert "## How to use the material excerpts (mandatory)" in system and "The material is not attached to this lesson" not in system
    assert_english_only(model)
    lesson_two = client.get(f"/api/courses/{cid}/lessons/2").json()["content"]
    assert lesson_two.startswith("# Lesson 2: Growth") and lesson_two.rstrip().endswith("-->")
    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    syllabus = client.get(f"/api/courses/{cid}/syllabus").json()["content"]
    assert "- [x] Explain core concept 1 (Source: concepts.md, Core concepts)" in syllabus
    assert "- [x] Explain core concept 2 (Source: concepts.md, Core concepts)" in syllabus
    assert syllabus.count("- [x]") == 2
    assert client.get(f"/api/courses/{cid}").json()["mastery_progress"] == pytest.approx(2 / 8)


def test_the_questions_of_an_english_lesson_reach_the_following_prompt_without_the_mastery_comment(client):
    created, _ = create_topic(client)
    cid = created["id"]
    next_lesson(client, cid)

    model = next_lesson(client, cid)

    system = model.calls[0]["system"]
    questions = system.split("must correspond to them strictly)\n", 1)[1].split("## Length of the previous lesson", 1)[0]
    assert "1. What happens to the curve if the rate doubles?" in questions and "2. When is simple interest a fair model?" in questions
    assert "mastery" not in questions and "<!--" not in questions
    # 只带上一篇（第 2 篇）全文，不再带更早的课文
    assert "### Lesson 2" in system and "### Lesson 1" not in system
    assert_english_only(model)


def test_a_missing_question_section_is_explained_to_the_model_in_english(client, user):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="Course", mode="topic", status="learning", language="en")
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content="# Outline\n\n- [ ] Explain A"))
        db.add(Lesson(course_id=course.id, number=1, content="# Lesson\n\n## Main content\n\nBody only."))
        db.commit()
        cid = course.id

    model = next_lesson(client, cid)

    assert "The previous lesson has no explicit reflection-questions section" in model.calls[0]["system"]
    assert "The student did not submit any feedback." in model.calls[0]["system"]
    assert "No highlight Q&A records." in model.calls[0]["system"]
    assert_english_only(model)


def test_an_english_source_course_writes_its_second_lesson_from_the_english_prompt(client):
    # 旧数据形状的原文课（原文阅读篇占第 1 篇）读完后，下一篇仍走原文课提示词；新建的原文课先由 /first 生成第 01 篇
    created, _ = create_source(client)
    cid = created["id"]
    make_legacy_source_course(cid, "en")
    ask(client, cid)

    model = next_lesson(client, cid)

    call = model.calls[0]
    assert call["system"].startswith(prompts_en.SOURCE_LESSON_PROMPT.split("{syllabus}")[0])
    assert call["user"] == "Write lesson 2 from the source material and the highlight Q&A"
    assert "## Source file\nnotes.md" in call["system"] and "# Notes\n\nInterest earns interest over time." in call["system"]
    assert "- Original text “Interest”" in call["system"]
    assert_english_only(model)
    assert client.get(f"/api/courses/{cid}/lessons/2").json()["is_source"] is False
    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    assert "- [x] Explain core concept 1" in client.get(f"/api/courses/{cid}/syllabus").json()["content"]


def test_an_english_course_gets_an_english_assessment_and_summary(client):
    created, _ = create_topic(client)
    cid = created["id"]
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()

    model = next_lesson(client, cid)
    assessment = model.calls[0]
    assert assessment["system"].startswith(prompts_en.EVAL_LESSON_PROMPT.split("{syllabus}")[0])
    assert assessment["user"] == "Write the assessment lesson"
    assert_english_only(model)
    done = client.get(f"/api/courses/{cid}/lessons").json()
    assert done[-1]["is_evaluation"] is True

    model = next_lesson(client, cid)
    summary = model.calls[0]
    assert summary["system"].startswith(prompts_en.SUMMARY_PROMPT.split("{syllabus}")[0])
    assert summary["user"] == "Write the course summary"
    assert "### Lesson 1\n# Compound interest" in summary["system"] and "### Lesson 2\n<!-- eval-article -->" in summary["system"]
    assert_english_only(model)
    assert client.get(f"/api/courses/{cid}/summary").json()["content"].startswith("# Compound interest · Learning Summary")
    assert client.get(f"/api/courses/{cid}").json()["status"] == "completed"


# ---------------------------------------------------------------------------
# 划线问答
# ---------------------------------------------------------------------------

def test_highlight_answers_and_follow_ups_are_asked_for_in_english(client):
    created, _ = create_topic(client)
    cid = created["id"]

    res, model = ask(client, cid)

    call = model.calls[0]
    assert call["system"].startswith(prompts_en.ANNOTATION_ANSWER_PROMPT)
    assert "Answer in English, even if the material or the question is in another language" in call["system"]
    assert "about 120 words by default" in call["system"]
    assert "\n\n## Current study material\n# Compound interest" in call["system"]
    assert call["system"].endswith("\n\n## Text the student highlighted\nInterest\n")
    assert_english_only(model)
    annotation = next(e for e in sse_events(res) if e.get("done"))["annotation"]
    assert annotation["answer"] == EN_PROJECT_ANSWER

    with fake_model() as follow_up:
        follow = client.post(f"/api/courses/{cid}/lessons/1/annotations/{annotation['id']}/messages", json={"content": "And then?"})
    assert follow.status_code == 200 and "error" not in follow.text
    assert follow_up.calls[0]["system"].startswith(prompts_en.ANNOTATION_ANSWER_PROMPT)
    assert_english_only(follow_up)


def test_highlights_in_a_chinese_course_still_use_the_chinese_prompt(client):
    with fake_model(lambda s, u: syllabus_text() if "课程大纲设计专家" in s else EN_LESSON):
        created = client.post("/api/courses", json={"name": "博弈论", "learning_depth": "simple"}).json()
        start_first_lesson(client, created["id"])

    with fake_model(lambda s, u: "回答。") as model:
        res = client.post(f"/api/courses/{created['id']}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 4, "original_text": "片段", "comment": "什么意思？", "answer_immediately": True,
        })

    assert res.status_code == 200
    system = model.calls[0]["system"]
    assert system.startswith(courses_module.ANNOTATION_ANSWER_PROMPT)
    assert "\n\n## 当前学习材料\n" in system and system.endswith("\n\n## 学生划线内容\n片段\n")


def test_a_highlight_in_an_english_project_course_is_answered_in_english(client):
    with fake_model():
        project = client.post(
            "/api/courses/from-project", data={"language": "en", "name": "Code"},
            files=[("files", ("main.py", b"print('hello')", "text/plain"))],
        ).json()

    res, model = ask(client, project["id"])

    assert model.calls[0]["system"].startswith(prompts_en.ANNOTATION_ANSWER_PROMPT)
    assert "```python\nprint('hello')\n```" in model.calls[0]["system"]
    assert_english_only(model)


# ---------------------------------------------------------------------------
# 推荐
# ---------------------------------------------------------------------------

def recommendations_payload(language="en", tag=""):
    if language == "zh":
        return json.dumps([{"title": f"主题{tag}{i}", "rationale": "你已经学过基础。", "bridge": "它接在你学过的内容之上。", "source_topics": []} for i in range(3)], ensure_ascii=False)
    return json.dumps([
        {"title": f"Topic {tag}{i}", "rationale": "You have already studied interest.", "bridge": "It builds on what you learned.", "source_topics": ["Compound interest"]}
        for i in range(1, 4)
    ])


def test_refresh_defaults_to_chinese_and_marks_the_recommendations_so(client):
    with patch("app.recommendations._call_llm", return_value=recommendations_payload("zh")) as call:
        res = client.post("/api/recommendations/refresh")

    assert res.status_code == 200
    assert call.call_args.args[0] == RECOMMENDATION_PROMPT
    assert [r["language"] for r in res.json()["recommendations"]] == ["zh"] * 3


@pytest.mark.parametrize("how", ["body", "query", "both-body-wins"])
def test_refresh_in_english_uses_the_english_prompt_and_profile(client, how):
    create_topic(client)
    kwargs = {
        "body": dict(json={"locale": "en"}),
        "query": dict(params={"locale": "en"}),
        "both-body-wins": dict(json={"locale": "en"}, params={"locale": "zh"}),
    }[how]

    with patch("app.recommendations._call_llm", return_value=recommendations_payload()) as call:
        res = client.post("/api/recommendations/refresh", **kwargs)

    assert res.status_code == 200, res.text
    system, profile = call.call_args.args
    assert system.startswith(prompts_en.RECOMMENDATION_PROMPT) and '"kind": "foundation"' in system
    assert "write every title, rationale and bridge in English" in system
    assert profile.startswith("## Profile of what has been learned\n\nCourses are listed by when the learner last studied them;")
    assert ("\n\n- Course “Compound interest” | last studied today | 0/8 mastery items learned\n"
            "  Already learned: no finished lessons yet\n"
            "  Still to come in this course (the course will teach these next; never recommend them as a new topic):\n"
            "    - Explain core concept 1\n") in profile
    assert ("\n\n## The learner's wishlist (topics the learner saved to learn)\n\nNone\n\n"
            "## Do not recommend these topics\n\nCompound interest\n\n## Output language\n\nWrite every title") in profile
    assert profile.endswith("even if the courses above are in another language.\n")
    assert not CJK.search(system + profile)
    body = res.json()
    assert [r["language"] for r in body["recommendations"]] == ["en"] * 3
    assert body["recommendations"][0]["title"] == "Topic 1"
    assert [r["language"] for r in client.get("/api/recommendations").json()["recommendations"]] == ["en"] * 3


def test_a_chinese_refresh_states_the_output_language_even_when_the_learner_studied_english_courses(client):
    create_topic(client)

    with patch("app.recommendations._call_llm", return_value=recommendations_payload("zh")) as call:
        res = client.post("/api/recommendations/refresh", json={"locale": "zh"})

    assert res.status_code == 200
    system, profile = call.call_args.args
    assert system == RECOMMENDATION_PROMPT
    assert "- Course “Compound interest”" not in profile and "- 课程《Compound interest》｜最近学习：今天｜已学 0/8 个掌握项" in profile
    assert profile.endswith("\n\n## 输出语言\n\n标题、理由、衔接说明都用中文，即使上面的课程是别的语言。\n")


def test_a_body_with_a_null_or_empty_locale_falls_back_to_the_query_then_chinese(client):
    payloads = [recommendations_payload("en", "a"), recommendations_payload("zh", "b"), recommendations_payload("zh", "c")]
    with patch("app.recommendations._call_llm", side_effect=payloads):
        with_query = client.post("/api/recommendations/refresh", json={"locale": None}, params={"locale": "en"})
        empty_body = client.post("/api/recommendations/refresh", json={})
        no_body = client.post("/api/recommendations/refresh", headers={"Content-Type": "application/json"}, content=b"")

    assert with_query.status_code == 200 and with_query.json()["recommendations"][0]["language"] == "en"
    assert empty_body.status_code == 200 and empty_body.json()["recommendations"][0]["language"] == "zh"
    assert no_body.status_code == 200 and no_body.json()["recommendations"][0]["language"] == "zh"


@pytest.mark.parametrize("kwargs", [
    dict(json={"locale": "fr"}), dict(json={"locale": "EN"}), dict(json={"locale": ""}), dict(json={"locale": 1}),
    dict(params={"locale": "fr"}), dict(params={"locale": "zh-CN"}), dict(params={"locale": ""}),
])
def test_refresh_rejects_an_unknown_locale_before_calling_the_model(client, user, kwargs):
    with patch("app.recommendations._call_llm", return_value=recommendations_payload()) as call:
        res = client.post("/api/recommendations/refresh", **kwargs)

    assert res.status_code == 422
    assert not call.called


def test_each_refresh_replaces_suggestions_in_the_language_asked_for_and_keeps_saved_ones(client):
    with patch("app.recommendations._call_llm", return_value=recommendations_payload("zh")):
        zh = client.post("/api/recommendations/refresh").json()["recommendations"]
    client.post(f"/api/recommendations/{zh[0]['id']}/save")

    with patch("app.recommendations._call_llm", return_value=recommendations_payload("en")):
        en = client.post("/api/recommendations/refresh", json={"locale": "en"}).json()

    assert [r["language"] for r in en["recommendations"]] == ["en"] * 3
    assert [(r["id"], r["language"]) for r in en["saved"]] == [(zh[0]["id"], "zh")]
    with TestSession() as db:
        assert sorted(r.language for r in db.query(LearningRecommendation).filter_by(status="dismissed")) == ["zh", "zh"]


def test_an_english_recommendation_starts_an_english_course_and_the_start_call_keeps_it(client):
    with patch("app.recommendations._call_llm", return_value=recommendations_payload()):
        rec = client.post("/api/recommendations/refresh", json={"locale": "en"}).json()["recommendations"][0]

    created, _ = create_topic(client, language=rec["language"], name=rec["title"], reference=f"{rec['title']}\n{rec['rationale']}")
    started = client.post(f"/api/recommendations/{rec['id']}/start", json={"course_id": created["id"]})

    assert started.status_code == 200
    assert started.json()["language"] == "en" and started.json()["status"] == "started"
    assert created["language"] == rec["language"] == "en"


def test_the_profile_of_a_learner_without_courses_and_with_a_project_reads_in_english(client):
    with patch("app.recommendations._call_llm", return_value=recommendations_payload("en", "x")) as call:
        client.post("/api/recommendations/refresh", json={"locale": "en"})
    assert call.call_args.args[1].startswith(
        "## Profile of what has been learned\n\nThe learner has no course history yet. Recommend introductory topics"
    )

    with fake_model():
        project = client.post(
            "/api/courses/from-project", data={"language": "en", "name": "Code"},
            files=[("files", ("main.py", b"print(1)", "text/plain"))],
        ).json()
    ask(client, project["id"])
    with patch("app.recommendations._call_llm", return_value=recommendations_payload("en", "y")) as call:
        client.post("/api/recommendations/refresh", json={"locale": "en"})

    profile = call.call_args.args[1]
    assert ("- Materials “Code” (files / web pages the learner uploaded to study) | last studied today | read 0 of 1\n"
            "  Not read yet: main.py\n") in profile
    assert "  Highlight questions (where the learner got stuck or curious):\n    - “Interest” → What does this mean?" in profile
    assert not CJK.search(profile)
