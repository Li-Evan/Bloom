import json
import re
from unittest.mock import MagicMock, patch

import pytest

import app.courses as courses_module
from app.models import Course, Lesson, Syllabus
from app.recommendations import RECOMMENDATION_PROMPT
from tests.conftest import TestSession, mock_stream

LESSON_PROMPTS = {
    "FIRST_LESSON_PROMPT": courses_module.FIRST_LESSON_PROMPT,
    "SOURCE_LESSON_PROMPT": courses_module.SOURCE_LESSON_PROMPT,
    "NEXT_LESSON_PROMPT": courses_module.NEXT_LESSON_PROMPT,
    "EVAL_LESSON_PROMPT": courses_module.EVAL_LESSON_PROMPT,
    "GROUNDED_LESSON_REVIEW_PROMPT": courses_module.GROUNDED_LESSON_REVIEW_PROMPT,
    "GROUNDED_LESSON_REPAIR_PROMPT": courses_module.GROUNDED_LESSON_REPAIR_PROMPT,
}


# ---- 课文提示词：不再要求输出「你的反馈」占位小节 ----

@pytest.mark.parametrize("name", sorted(LESSON_PROMPTS))
def test_no_lesson_prompt_asks_for_a_feedback_section(name):
    prompt = LESSON_PROMPTS[name]

    assert "## 你的反馈" not in prompt
    assert "在这里写下你的问题" not in prompt
    assert "不得添加「你的反馈」" in prompt or "不要在文末添加「你的反馈」" in prompt


def test_the_mastery_comment_requirement_is_untouched():
    next_prompt = courses_module.NEXT_LESSON_PROMPT
    assert "<!-- mastery: 能够解释核心概念A; 能够应用概念A解决简单问题 -->" in next_prompt
    assert "在文档最末尾（思考题之后）追加一个隐藏注释块" in next_prompt
    assert "必须与大纲中的文字完全一致" in next_prompt
    source_prompt = courses_module.SOURCE_LESSON_PROMPT
    assert "<!-- mastery: 能够...; 能够... -->" in source_prompt
    assert "隐藏 mastery 注释必须列出本篇覆盖的大纲掌握项原文，且与大纲 checkbox 文本完全一致" in source_prompt
    # 注释在输出格式里紧跟思考题，中间没有别的小节
    assert re.search(r"\[2-3 个引导用户深入思考的问题，不给答案；每题只问一个问题，不要把几个问题连在一起问\]\n\n<!-- mastery:", source_prompt)


def test_the_prompts_still_format_with_their_fields():
    courses_module.FIRST_LESSON_PROMPT.format(syllabus="S", reference_section="R", depth_rules="", source_rules="")
    courses_module.SOURCE_LESSON_PROMPT.format(
        syllabus="S", source_filename="f", source_content="c", source_annotations="a", feedback="f", feedback_note="",
        lesson_number=2,
    )
    courses_module.NEXT_LESSON_PROMPT.format(
        syllabus="S", previous_lessons="p", reference_section="r", feedback="f", annotations="a",
        lesson_number=2, last_questions="q", last_length="n", review_section="v", feedback_note="", annotation_section="", answers_section="",
        depth_rules="", source_rules="",
    )
    courses_module.EVAL_LESSON_PROMPT.format(
        syllabus="S", last_lesson="l", feedback="f", annotations="a", last_questions="q", source_rules="",
    )


def test_questions_extraction_leaves_out_the_trailing_mastery_comment():
    lesson = (
        "# 标题\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 第一题？\n2. 第二题？\n\n"
        "<!-- mastery: 能够解释核心概念A; 能够判断是否适用？ -->"
    )

    assert courses_module._extract_thought_questions(lesson) == "1. 第一题？\n2. 第二题？"
    assert courses_module._extract_thought_questions("## 思考题\n\n1. 问？\n\n## 你的反馈\n\n> 旧课文") == "1. 问？"
    assert courses_module._extract_thought_questions("没有思考题") == ""


GROUNDED_WITHOUT_FEEDBACK = """# 第一课

## 正文内容

资料指出核心概念与案例有关（来源：concepts.md，核心概念）（来源：examples.md，案例）

## 思考题

1. 如何解释核心概念？
2. 如何把它用于案例？
"""


def test_grounded_lessons_are_valid_with_or_without_the_old_feedback_section():
    with_feedback = GROUNDED_WITHOUT_FEEDBACK + "\n## 你的反馈\n\n> 写下反馈。\n"

    assert courses_module._grounded_lesson_review_valid(GROUNDED_WITHOUT_FEEDBACK) is True
    assert courses_module._grounded_lesson_review_valid(with_feedback) is True
    assert courses_module._grounded_lesson_candidate_score(GROUNDED_WITHOUT_FEEDBACK) == (
        courses_module._grounded_lesson_candidate_score(with_feedback)[0],
        len(GROUNDED_WITHOUT_FEEDBACK),
    )


def test_a_reviewer_report_around_a_lesson_without_feedback_is_still_salvaged():
    wrapped = f"校对说明：已修正。\n\n```markdown\n{GROUNDED_WITHOUT_FEEDBACK}```"

    assert courses_module._extract_lesson_artifact(wrapped) == GROUNDED_WITHOUT_FEEDBACK.strip()


def test_missing_questions_are_added_at_the_end_when_there_is_no_feedback_section():
    draft = "\n".join(f"- [ ] 能够解释资料核心概念{i}（来源：a.md，概念）" for i in range(1, 4))
    lesson = "# 第一课\n\n## 正文内容\n\n资料指出一些事实。\n"

    ensured = courses_module._ensure_grounded_lesson_questions(lesson, draft)

    assert ensured.index("## 正文内容") < ensured.index("## 思考题")
    questions = courses_module._extract_thought_questions(ensured)
    assert 2 <= sum("？" in line for line in questions.splitlines()) <= 3


def test_the_first_lesson_of_a_material_course_is_accepted_without_a_feedback_section(authed_client):
    sections = {}

    def fake_call(system_prompt, user_message, **_kwargs):  # max_tokens / timeout / max_retries 等调用参数不影响回答
        if system_prompt == courses_module.MATERIAL_CHUNK_PROMPT:
            return "笔记（来源：concepts.md，核心概念）"
        if system_prompt == courses_module.MATERIAL_REDUCE_PROMPT:
            return "归并笔记"
        if system_prompt == courses_module.MATERIAL_SYNTHESIS_PROMPT:
            return (
                "# 课程参考知识包\n## 资料目录\nconcepts.md\n## 核心问题与总论点\n可追溯知识（来源：concepts.md，核心概念）\n"
                "## 概念与定义\n核心概念\n## 论证与机制\n概念机制\n## 例子、证据与应用\n应用案例\n"
                "## 边界、反例、争议与限制\n资料边界\n## 前置知识与建议教学顺序\n先概念后案例\n## 来源索引\n"
                "concepts.md：核心概念章节。关键位置已保留，后续大纲和课文可以据此追溯原始材料内容。"
                "所有核心定义、论证机制、应用案例与资料边界均可通过此索引定位回对应文件和 Markdown 标题。\n"
            )
        # 大纲校对 / 修复的提示词末尾接上课程设计的保留规则（course_planning.REVIEW_RULE）
        if system_prompt.startswith((courses_module.GROUNDED_SYLLABUS_REVIEW_PROMPT, courses_module.GROUNDED_SYLLABUS_REPAIR_PROMPT)) \
                or "课程大纲设计专家" in system_prompt:
            items = "\n".join(
                f"- [ ] 能够解释资料核心概念 {i}（来源：concepts.md，核心概念）" for i in range(1, 11)
            )
            return (
                f"# 通用资料课 · 课程大纲\n\n## 核心掌握项\n\n### 主线\n{items}\n\n## 不在本课题范围内\n\n- 外部内容\n\n"
                "## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|------|-----------|---------|\n"
            )
        if system_prompt in (courses_module.GROUNDED_LESSON_REVIEW_PROMPT, courses_module.GROUNDED_LESSON_REPAIR_PROMPT):
            sections["review"] = system_prompt
            return GROUNDED_WITHOUT_FEEDBACK
        if "苏格拉底式导师" in system_prompt:
            sections["lesson"] = system_prompt
            return GROUNDED_WITHOUT_FEEDBACK
        raise AssertionError("unexpected prompt")

    with patch.object(courses_module, "_call_llm", side_effect=fake_call):
        res = authed_client.post(
            "/api/courses/from-materials",
            data={"name": "通用资料课", "learning_depth": "simple"},
            files=[("files", ("concepts.md", "# 核心概念\n\n定义内容。".encode(), "text/markdown"))],
        )
        assert res.status_code == 200, res.text
        started = authed_client.post(f"/api/courses/{res.json()['id']}/first")  # 第 01 篇在确认大纲后生成
        assert started.status_code == 200, started.text

    assert "## 你的反馈" not in sections["lesson"]
    first = authed_client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"]
    assert first.rstrip().endswith("2. 如何把它用于案例？")


# ---- 下一篇：思考题后面紧跟 mastery 注释，复盘和勾选掌握项都要照常工作 ----

def _mock_stream(chunks):
    return mock_stream(chunks)


def _next(client, course_id, chunks):
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(chunks)
        mock_get_client.return_value = mock_client
        res = client.post(f"/api/courses/{course_id}/next")
    assert res.status_code == 200
    assert '"error"' not in res.text
    return mock_client.chat.completions.create.call_args.kwargs["messages"][0]["content"]


def test_a_lesson_ending_with_questions_and_a_mastery_comment_ticks_the_syllabus_and_keeps_questions_clean(
    user, authed_client,
):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="课", mode="topic", status="learning")
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content="# 大纲\n\n- [ ] 能够解释概念A\n- [ ] 能够应用概念B"))
        db.add(Lesson(course_id=course.id, number=1, content="# 第一章\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 起点？"))
        db.commit()
        course_id = course.id

    _next(authed_client, course_id, [
        "# 第二章\n\n## 正文内容\n\n新内容\n\n## 思考题\n\n1. 概念A是什么？\n2. 如何应用？\n\n",
        "<!-- mastery: 能够解释概念A -->",
    ])

    authed_client.post(f"/api/courses/{course_id}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    syllabus = authed_client.get(f"/api/courses/{course_id}/syllabus").json()["content"]
    assert "- [x] 能够解释概念A" in syllabus and "- [ ] 能够应用概念B" in syllabus
    lesson_two = authed_client.get(f"/api/courses/{course_id}/lessons/2").json()["content"]
    assert lesson_two.rstrip().endswith("<!-- mastery: 能够解释概念A -->")
    assert "## 你的反馈" not in lesson_two

    prompt = _next(authed_client, course_id, ["# 第三章\n\n## 思考题\n\n1. 新问？"])
    questions = prompt.split("## 上一篇的真实思考题", 1)[1].split("## 上一篇的篇幅", 1)[0]
    assert "1. 概念A是什么？" in questions and "2. 如何应用？" in questions
    assert "mastery" not in questions and "<!--" not in questions


# ---- 推荐提示词：对学习者说「你」----

def test_the_recommendation_prompt_asks_for_second_person_reasons():
    assert "第二人称" in RECOMMENDATION_PROMPT
    assert "你已经学过" in RECOMMENDATION_PROMPT
    assert "不要写成「用户已具备……」" in RECOMMENDATION_PROMPT
    assert "若用英文写则用 you" in RECOMMENDATION_PROMPT
    schema = RECOMMENDATION_PROMPT.split("JSON 格式：", 1)[1]
    assert '"rationale": "为什么现在学它，对「你」说' in schema
    assert '"bridge": "它如何连接你已学过的内容' in schema
    assert "用户已" not in schema
    json_block = schema[schema.index("["):schema.rindex("]") + 1]
    assert isinstance(json.loads(json_block), list)


def test_the_prompt_actually_sent_to_the_model_is_the_second_person_one(authed_client):
    payload = json.dumps([
        {"title": f"主题{i}", "rationale": "你已经学过基础。", "bridge": "它接在你学过的内容之上。", "source_topics": []}
        for i in range(3)
    ], ensure_ascii=False)

    with patch("app.recommendations._call_llm", return_value=payload) as call:
        res = authed_client.post("/api/recommendations/refresh")

    assert res.status_code == 200
    system_prompt, profile = call.call_args.args
    assert system_prompt == RECOMMENDATION_PROMPT
    assert "第二人称" in system_prompt
    assert "学习者还没有课程记录" in profile and "用户" not in profile
    assert res.json()["recommendations"][0]["rationale"] == "你已经学过基础。"


# ---- 课文自带的代码块不能把课文截断 ----

CODE_LESSON = (
    "# 变量与类型\n\n## 正文内容\n\n先看一段代码：\n\n```python\nx = 1\n# 注释\nprint(x)\n```\n\n"
    "再往下讲类型。\n\n## 思考题\n\n1. 为什么 x 是整数？\n2. 如何查看类型？\n"
)


def test_a_lesson_with_its_own_code_block_is_kept_whole():
    assert courses_module._extract_lesson_artifact(CODE_LESSON) == CODE_LESSON.strip()
    en = CODE_LESSON.replace("正文内容", "Main content").replace("思考题", "Reflection questions")
    assert courses_module._extract_lesson_artifact(en) == en.strip()


def test_a_report_around_a_lesson_that_has_code_blocks_is_still_cut_at_the_closing_fence():
    wrapped = f"校对说明：已修正。\n\n```markdown\n{CODE_LESSON}```\n\n以上是校对后的课文。"

    assert courses_module._extract_lesson_artifact(wrapped) == CODE_LESSON.strip()


def test_an_outline_with_a_fenced_block_is_not_cut_either():
    syllabus = "# 编程 · 课程大纲\n\n## 核心掌握项\n\n- [ ] 能够解释 `x = 1`\n\n```\n示例\n```\n\n## 学习进度\n"

    assert courses_module._extract_syllabus_artifact(syllabus) == syllabus.strip()
    wrapped = f"报告\n\n```markdown\n{syllabus}```\n"
    assert courses_module._extract_syllabus_artifact(wrapped) == syllabus.strip()


def test_a_topic_course_stores_the_whole_first_lesson_when_it_has_a_code_block(authed_client):
    from tests.unit.test_course_language import fake_model

    def responder(system, user):
        return "# 编程 · 课程大纲\n\n- [ ] 能够解释变量" if "课程大纲设计专家" in system else CODE_LESSON

    with fake_model(responder):
        res = authed_client.post("/api/courses", json={"name": "编程入门", "learning_depth": "simple"})
        assert authed_client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200  # 第 01 篇在确认大纲后生成

    assert res.status_code == 200, res.text
    stored = authed_client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"]
    assert stored == CODE_LESSON.strip()
    assert "再往下讲类型" in stored and "## 思考题" in stored


# ---- 围栏的奇偶：开头的 ```markdown 也算 ----

PLAIN_LESSON = "# 标题\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 为什么？\n2. 如何？"
LESSON_WITH_BLOCK = PLAIN_LESSON.replace("正文\n", "正文\n```python\nx = 1\n```\n", 1)


@pytest.mark.parametrize("lesson", [PLAIN_LESSON, LESSON_WITH_BLOCK], ids=["plain", "own code block"])
@pytest.mark.parametrize("wrapper", [
    "```markdown\n{lesson}\n```",
    "```markdown\n{lesson}\n```\n\n希望对你有帮助",
    "```\n{lesson}\n```\n\n如需调整请告诉我。",
    "好的，下面是课文：\n\n```markdown\n{lesson}\n```\n\n希望对你有帮助",
    "{lesson}",
], ids=["fully wrapped", "leading fence + courtesy", "bare fence + courtesy", "intro + fence + courtesy", "no wrapper"])
def test_the_lesson_comes_out_clean_whatever_surrounds_it(wrapper, lesson):
    out = courses_module._extract_lesson_artifact(wrapper.format(lesson=lesson))

    assert out == lesson
    assert "希望对你有帮助" not in out and "如需调整" not in out and "好的，下面" not in out


def test_an_incomplete_fence_keeps_the_whole_lesson():
    open_only = f"```markdown\n{PLAIN_LESSON}"
    assert courses_module._extract_lesson_artifact(open_only) == PLAIN_LESSON
    unclosed_inner = "```markdown\n# 标题\n\n## 正文内容\n\n```python\nx = 1\n\n## 思考题\n\n1. 为什么？"
    assert courses_module._extract_lesson_artifact(unclosed_inner) == unclosed_inner[len("```markdown\n"):]


def test_the_outline_comes_out_clean_too():
    syllabus = "# 编程 · 课程大纲\n\n## 核心掌握项\n\n- [ ] 能够解释变量\n\n## 学习进度\n\n| 文档 |"

    assert courses_module._extract_syllabus_artifact(f"```markdown\n{syllabus}\n```\n\n希望对你有帮助") == syllabus
    assert courses_module._extract_syllabus_artifact(f"说明\n\n```markdown\n{syllabus}\n```") == syllabus
    assert courses_module._extract_syllabus_artifact(f"```markdown\n{syllabus}") == syllabus


def test_a_topic_course_does_not_store_the_courtesy_line_after_a_closing_fence(authed_client):
    from tests.unit.test_course_language import fake_model

    def responder(system, user):
        if "课程大纲设计专家" in system:
            return "```markdown\n# 编程 · 课程大纲\n\n- [ ] 能够解释变量\n```\n\n希望对你有帮助"
        return f"```markdown\n{LESSON_WITH_BLOCK}\n```\n\n希望对你有帮助"

    with fake_model(responder):
        res = authed_client.post("/api/courses", json={"name": "编程入门", "learning_depth": "simple"})
        assert authed_client.post(f"/api/courses/{res.json()['id']}/first").status_code == 200  # 第 01 篇在确认大纲后生成

    assert res.status_code == 200, res.text
    stored = authed_client.get(f"/api/courses/{res.json()['id']}/lessons/1").json()["content"]
    assert stored == LESSON_WITH_BLOCK
    assert res.json()["syllabus_content"] == "# 编程 · 课程大纲\n\n- [ ] 能够解释变量"


# ---- 所有入库出口共用的「去外层包装」 ----

DOC = "# 标题\n\n## 正文内容\n\n正文\n\n## 思考题\n\n1. 为什么？\n2. 如何？"
DOC_BLOCK = DOC.replace("正文\n", "正文\n```python\nx = 1\n```\n", 1)


@pytest.mark.parametrize("doc", [DOC, DOC_BLOCK], ids=["plain", "own code block"])
@pytest.mark.parametrize("fence", ["```markdown", "```md", "```", "````markdown", "````", "`````markdown"])
@pytest.mark.parametrize("courtesy", ["", "\n\n希望对你有帮助", "\n希望对你有帮助\n\n如需调整请告诉我。"], ids=["no courtesy", "courtesy", "two lines"])
@pytest.mark.parametrize("preface", ["", "好的，下面是课文：\n\n"], ids=["no preface", "preface"])
def test_the_document_comes_out_clean_from_any_outer_wrapper(preface, courtesy, fence, doc):
    closing = "`" * (len(fence) - len(fence.lstrip("`")))
    raw = f"{preface}{fence}\n{doc}\n{closing}{courtesy}"

    assert courses_module._strip_document_wrapper(raw) == doc
    assert courses_module._model_text(raw, document=True) == doc
    assert courses_module._extract_lesson_artifact(raw) == doc


@pytest.mark.parametrize("doc", [DOC, DOC_BLOCK], ids=["plain", "own code block"])
def test_an_unwrapped_document_is_left_alone(doc):
    assert courses_module._strip_document_wrapper(doc) == doc
    assert courses_module._strip_document_wrapper(f"\n\n{doc}\n\n") == doc
    assert courses_module._model_text(doc, document=True) == doc


def test_an_incomplete_wrapper_keeps_the_whole_document():
    assert courses_module._strip_document_wrapper(f"```markdown\n{DOC}") == DOC
    assert courses_module._strip_document_wrapper(f"```markdown\n{DOC_BLOCK}") == DOC_BLOCK
    assert courses_module._strip_document_wrapper(f"好的：\n\n```markdown\n{DOC}") == DOC
    unclosed_inner = "```markdown\n# T\n\n```python\nx = 1\n\n## 思考题\n\n1. a？"
    assert courses_module._strip_document_wrapper(unclosed_inner) == unclosed_inner[len("```markdown\n"):]
    four_unclosed = f"````markdown\n{DOC_BLOCK}"
    assert courses_module._strip_document_wrapper(four_unclosed) == DOC_BLOCK


def test_a_document_that_merely_contains_a_markdown_example_is_not_unwrapped():
    lesson = "# Markdown 入门\n\n写法如下：\n\n```markdown\n# 一级标题\n\n- 列表\n```\n\n以上就是全部。\n\n## 思考题\n\n1. 如何写列表？"

    assert courses_module._strip_document_wrapper(lesson) == lesson
    assert courses_module._extract_lesson_artifact(lesson) == lesson
    # 前面是说明、围栏后面不是文档开头的整段文字也不动
    prose = "可以这样写：\n```markdown\n**加粗**\n```\n就是加粗。"
    assert courses_module._strip_document_wrapper(prose) == prose
    code_first = "```python\nx = 1\n```\n这段代码把 x 设为 1。"
    assert courses_module._strip_document_wrapper(code_first) == code_first


def test_a_fence_with_nothing_inside_is_an_empty_output():
    for raw in ("```", "```markdown\n```", "````markdown\n````\n谢谢", "  \n"):
        with pytest.raises(ValueError):
            courses_module._model_text(raw, document=True)


def test_dialogue_answers_keep_the_old_lighter_treatment():
    answer = "可以这样写：\n```markdown\n# 标题\n```\n就是一级标题。"

    assert courses_module._model_text(answer) == answer
    assert courses_module._model_text("```markdown\n答案\n```") == "答案"


def test_the_extractors_fall_back_to_the_same_unwrapping_when_they_find_no_anchor():
    no_thought = "# 只有标题\n\n没有思考题的短文。"
    no_title = "# 一份没有「课程大纲」字样的文档\n\n- [ ] 能够解释甲"

    assert courses_module._extract_lesson_artifact(f"```markdown\n{no_thought}\n```\n\n希望对你有帮助") == no_thought
    assert courses_module._extract_lesson_artifact(f"````markdown\n{no_thought}\n````\n谢谢") == no_thought
    assert courses_module._extract_syllabus_artifact(f"```markdown\n{no_title}\n```\n\n希望对你有帮助") == no_title
    assert courses_module._extract_syllabus_artifact(f"好的：\n\n````markdown\n{no_title}\n````") == no_title


@pytest.mark.parametrize("fence,closing", [("```markdown", "```"), ("````markdown", "````")])
def test_the_next_lesson_and_the_summary_are_stored_without_the_wrapper(authed_client, fence, closing):
    from app.models import Syllabus
    from tests.conftest import TestSession
    from tests.unit.test_course_language import create_topic, next_lesson

    created, _ = create_topic(authed_client)
    cid = created["id"]
    lesson = "# Lesson 2\n\n## Main content\n\nbody\n```python\nx = 1\n```\n\n## Reflection questions\n\n1. Why?\n2. How?"
    next_lesson(authed_client, cid, lambda s, u: f"{fence}\n{lesson}\n{closing}\n\nHope this helps!")
    assert authed_client.get(f"/api/courses/{cid}/lessons/2").json()["content"] == lesson

    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    evaluation = "<!-- eval-article -->\n\n# Final Assessment\n\nbody"
    next_lesson(authed_client, cid, lambda s, u: f"{fence}\n{evaluation}\n{closing}\n\nHope this helps!")
    stored = authed_client.get(f"/api/courses/{cid}/lessons/3").json()
    assert stored["is_evaluation"] is True and stored["content"] == evaluation

    summary = "# Learning Summary\n\n## Knowledge map\n\n- interest"
    next_lesson(authed_client, cid, lambda s, u: f"Sure, here it is:\n\n{fence}\n{summary}\n{closing}\n\nHope this helps!")
    assert authed_client.get(f"/api/courses/{cid}/summary").json()["content"] == summary


# ---- 前置说明 + 正文里的示例代码块，不能被当成外层包装 ----

MARKDOWN_LESSON = (
    "# Markdown 入门\n\n写法如下：\n\n```markdown\n# 一级标题\n\n- 列表\n```\n\n以上就是全部。\n\n## 思考题\n\n1. 如何写列表？"
)
SCRIPT_LESSON = "# 脚本入门\n\n先看一段脚本：\n\n```\n# 注释\nprint(1)\n```\n\n## 思考题\n\n1. 这段脚本做什么？"


@pytest.mark.parametrize("lesson", [MARKDOWN_LESSON, SCRIPT_LESSON], ids=["markdown example", "bare fence with # comment"])
@pytest.mark.parametrize("preface", ["好的，下面是课文：\n\n", "Sure, here is the lesson:\n\n"])
def test_a_preface_plus_a_lesson_whose_own_first_code_block_starts_with_a_hash_is_not_cut_down_to_that_block(lesson, preface):
    raw = preface + lesson

    assert courses_module._strip_document_wrapper(raw) == raw.strip()
    assert courses_module._model_text(raw, document=True) == raw.strip()
    # 有标题锚点的抽取仍然只取课文本身（说明在标题前面，被丢掉），代码块完整
    assert courses_module._extract_lesson_artifact(raw) == lesson


def test_any_hash_line_before_the_first_fence_means_it_is_a_code_block_of_the_document():
    raw = "好的\n# 小标题\n文字\n```markdown\n# 内标题\n```\n后面还有内容"

    assert courses_module._strip_document_wrapper(raw) == raw
    assert courses_module._strip_document_wrapper("<!-- eval-article -->\n```markdown\n# 内标题\n```\n后面") == \
        "<!-- eval-article -->\n```markdown\n# 内标题\n```\n后面"


def test_a_real_wrapper_after_a_preface_is_still_removed():
    wrapped = "好的，下面是课文：\n\n```markdown\n# 标题\n\n正文\n\n## 思考题\n\n1. 为什么？\n```\n\n希望对你有帮助"

    assert courses_module._strip_document_wrapper(wrapped) == "# 标题\n\n正文\n\n## 思考题\n\n1. 为什么？"
