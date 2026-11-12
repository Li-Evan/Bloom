"""课文生成、总结、划线问答的回归测试。

1. 总结的规划或压缩失败不再让整份总结作废：按无计划写 / 保存未压缩的版本并提示超长；中文课的字数上限和压缩指令用中文。
2. 中文 mastery 注释用全角「；」分隔也记得上进度（用照真实输出格式写的样例回归）。
3. 下一篇 / 总结 / 划线问答 / 追问返回流式响应时，请求的数据库会话不在事务里（不占着连接）。
4. 长原文划线问答：空白、Markdown 标记不同也能定位选区；定位不到只带选区，不带书开头。
5. 评估篇按提示词分支判定：模型漏写标记也存成评估篇，下一次点击生成总结。
6. 流式输出被截断（finish_reason=length）按失败处理：不保存、提示截断；流式客户端用完就关。
7. 总结不读上传原文；反馈很多时规划只带最新的、不再 400；下一篇总时限；旧版原文课规划只带相关段落；只取 id 的查询。
"""
import json
from types import SimpleNamespace as NS

import pytest
from sqlalchemy import event

from app import courses, teaching, teaching_styles
from app.config import settings
from app.database import get_db
from app.main import app as fastapi_app
from app.models import Annotation, Course, Lesson, Syllabus, TeachingFeedback
from tests.conftest import TestSession, engine, stream_chunk

SYLLABUS = "# 比例\n## 核心掌握项\n- [ ] 能够区分百分点与相对变化\n- [ ] 能够解释退款指标\n\n## 学习进度\n\n| 课文 | 覆盖掌握项 | 生成日期 |\n|------|-----------|---------|\n"
LESSON_1 = "# 变化\n## 正文内容\n10%到12%是2个百分点。\n## 思考题\n1. 5%到7%相对增加多少？\n<!-- mastery: 能够区分百分点与相对变化 -->"
DRAFT = "# 补讲\n## 正文内容\n电商支付率10%到12%。\n## 思考题\n1. a？\n2. b？\n<!-- mastery: 能够解释退款指标 -->"
SUMMARY = "# 比例 · 学习总结\n## 知识图谱\n" + "内容" * 200


def events(res):
    return [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]


def plan_json(cap=None, action="advance"):
    return json.dumps(dict(action=action, focus="电商", requirements=[], max_words=cap, applied_feedback_ids=[],
                           persistent_feedback_ids=[], unresolved_feedback_ids=[]), ensure_ascii=False)


def seed(user, *, syllabus=SYLLABUS, lessons=((1, LESSON_1, False),), mode="topic", source_content=None):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="比例", language="zh", mode=mode, source_content=source_content)
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content=syllabus))
        for number, content, is_eval in lessons:
            db.add(Lesson(course_id=course.id, number=number, content=content, is_evaluation=is_eval))
        db.commit()
        return course.id


def fake_stream(monkeypatch, body, seen=None):
    def stream(system, user, **kwargs):
        if seen is not None:
            seen.append(system)
        yield body, False
        yield body, True
    monkeypatch.setattr(courses, "_stream_llm", stream)


@pytest.fixture
def adaptive(monkeypatch):
    monkeypatch.setattr(settings, "ADAPTIVE_TEACHING", True)


# ---------------------------------------------------------------------------
# 1. 课程总结
# ---------------------------------------------------------------------------

@pytest.fixture
def finished(user, authed_client, adaptive):
    """最后一篇是评估篇、有一条「以后每篇不超过 50 字」的课程级反馈：再点一次就生成总结，并且会调规划器。"""
    cid = seed(user, lessons=((1, LESSON_1, False), (2, "<!-- eval-article -->\n# 最终评估\n## 思考题\n1. b？", True)))
    res = authed_client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "以后每篇不超过50字", "scope": "course"})
    assert res.status_code == 200
    return cid


def summary_calls(monkeypatch, *, planner, compress):
    calls = []

    def call(system, user, **kwargs):
        calls.append((system, user, kwargs))
        if system == teaching.PLANNER_PROMPT:
            if isinstance(planner, Exception):
                raise planner
            return planner
        if isinstance(compress, Exception):
            raise compress
        return compress

    monkeypatch.setattr(courses, "_call_llm", call)
    return calls


def assert_completed(cid):
    with TestSession() as db:
        assert db.query(Lesson).filter_by(course_id=cid, number=0).count() == 1
        assert db.get(Course, cid).status == "completed"


def test_a_failed_summary_plan_still_writes_the_summary_with_the_learners_cap(authed_client, finished, monkeypatch):
    calls = summary_calls(monkeypatch, planner=TimeoutError("planner 45s timeout"), compress="# 总结\n短。")
    seen = []
    fake_stream(monkeypatch, SUMMARY, seen)

    done = events(authed_client.post(f"/api/courses/{finished}/next"))[-1]

    assert done["done"] and done["completed"] and "length_exceeded" not in done
    assert_completed(finished)
    assert "全文字数上限：50 字" in seen[0]  # 规划失败，学生自己写的上限照样生效
    assert [c[0] for c in calls][-1] == courses.SUMMARY_COMPRESS_PROMPT["zh"].format(cap=50)
    with TestSession() as db:
        assert db.query(Lesson).filter_by(course_id=finished, number=0).one().content == "# 总结\n短。"


def test_a_failed_compression_saves_the_uncompressed_summary_and_says_it_is_too_long(authed_client, finished, monkeypatch):
    summary_calls(monkeypatch, planner=plan_json(cap=50), compress=TimeoutError("compression timeout"))
    fake_stream(monkeypatch, SUMMARY)

    done = events(authed_client.post(f"/api/courses/{finished}/next"))[-1]

    assert done == {"done": True, "completed": True, "length_exceeded": 50}
    assert_completed(finished)
    with TestSession() as db:
        assert db.query(Lesson).filter_by(course_id=finished, number=0).one().content == SUMMARY


def test_a_chinese_summary_states_its_cap_and_compresses_in_chinese_with_only_the_summary(authed_client, finished, monkeypatch):
    calls = summary_calls(monkeypatch, planner=plan_json(cap=50), compress="# 总结\n压缩后。")
    seen = []
    fake_stream(monkeypatch, SUMMARY, seen)

    done = events(authed_client.post(f"/api/courses/{finished}/next"))[-1]

    assert done == {"done": True, "completed": True}
    assert "全文字数上限：50 字" in seen[0] and "Whole summary length limit" not in seen[0]
    system, user, kwargs = calls[-1]
    assert system.startswith("你是课程总结的压缩编辑") and "50 字" in system
    assert user == SUMMARY and "所有课文内容" not in system  # 不再把整份总结提示词重发一遍
    assert kwargs["fail_on_length"] and kwargs["timeout"] == courses.SUMMARY_COMPRESS_TIMEOUT_SECONDS


def test_an_english_summary_cap_stays_english():
    assert "words" in courses.SUMMARY_COMPRESS_PROMPT["en"] and "字" not in courses.SUMMARY_COMPRESS_PROMPT["en"]


# ---------------------------------------------------------------------------
# 2. 全角分号的 mastery 注释
# ---------------------------------------------------------------------------

# 一门资料课的大纲和第 2 篇（照模型真实输出的格式写的样例，数据是虚构的）：mastery 注释用全角分号，正文只留开头
SAMPLE_OUTLINE = """# 比例 · 课程大纲

> 这份大纲定义了完成本课题后你将掌握的所有能力。
> 学习深度：简单
> 课文数量因人而异，但掌握内容不打折扣。

## 核心掌握项

完成本课题后，你将能够：

### 统一口径并计算支付率
- [ ] 能够指出支付率中的分子为支付人数、分母为总人数。（来源：ratio-notes.md，第 1 节）
- [ ] 能够依据支付人数和总人数计算各组支付率。（来源：ratio-notes.md，第 1 节）
- [ ] 能够判断两组比例的定义及分子、分母口径是否一致。（来源：ratio-notes.md，第 1 节）
- [ ] 能够判断组间人数不相等时是否仍可按一致口径比较比例。（来源：ratio-notes.md，第 1 节）

### 描述差异并限定结论
- [ ] 能够用两个百分率相减计算并报告百分点差。（来源：ratio-notes.md，第 1 节）
- [ ] 能够以基准比例为分母计算并报告相对增长。（来源：ratio-notes.md，第 1 节）
- [ ] 能够区分百分点差与相对增长所表达的含义。（来源：ratio-notes.md，第 1 节）
- [ ] 能够依据虚构电商练习数据计算并报告支付率差异，同时说明这些数据不构成真实业务证据。（来源：ratio-notes.md，第 1 节）
- [ ] 能够判断观察到的比例差异是否足以证明方案有效。（来源：ratio-notes.md，第 1 节）

## 不在本课题范围内

- 利润分析、p值及其他验证方法。
- 比例比较的其他限制或材料未讨论的结论。

## 学习进度

| 课文 | 覆盖掌握项 | 生成日期 |
|------|-----------|---------|"""
SAMPLE_LESSON_2 = """# 百分点差与相对增长：怎样描述支付率变化

> 前置知识：会读百分数，知道支付率是支付人数 ÷ 总人数
> 难度：入门
> 预计阅读时间：2 分钟

---

## 正文内容

**百分点差**是两个百分率直接相减：12%－10%＝2个百分点。**相对增长**以基准比例为分母：（12%－10%）÷10%＝20%。（来源：ratio-notes.md，第 1 节）

## 思考题

1. 某网店 A 组支付率为8%，B组为10%，两组相差多少个百分点？
2. 同样的数据，以A组为基准时，B组相对增长多少？

<!-- mastery: 能够用两个百分率相减计算并报告百分点差；能够以基准比例为分母计算并报告相对增长；能够区分百分点差与相对增长所表达的含义；能够依据虚构电商练习数据计算并报告支付率差异，同时说明这些数据不构成真实业务证据；能够判断观察到的比例差异是否足以证明方案有效。 -->
"""

def test_a_lesson_with_full_width_semicolons_records_every_item():
    outline, lesson = SAMPLE_OUTLINE, SAMPLE_LESSON_2
    assert "；" in courses._MASTERY_COMMENT_RE.search(lesson).group(1)

    items = courses._mastery_comment_items(outline, lesson)

    assert len(items) == 5
    assert items[0].startswith("能够用两个百分率相减计算并报告百分点差") and items[-1].startswith("能够判断观察到的比例差异是否足以证明方案有效")
    assert courses._auto_check_mastery(outline, lesson).count("- [x]") == 5


def test_items_that_contain_a_semicolon_themselves_are_not_cut_apart():
    syllabus = "- [ ] 能够区分甲；乙两种口径（来源：a.md，第1节）\n- [ ] 能够解释丙指标的含义\n- [ ] 能够比较 x; y 两种做法"
    lesson = "<!-- mastery: 能够区分甲；乙两种口径；能够解释丙指标的含义; 能够比较 x; y 两种做法 -->"

    assert courses._mastery_comment_items(syllabus, lesson) == [
        "能够区分甲；乙两种口径（来源：a.md，第1节）", "能够解释丙指标的含义", "能够比较 x; y 两种做法",
    ]


def test_a_next_lesson_with_full_width_semicolons_lands_in_the_progress_table(authed_client, user, monkeypatch):
    cid = seed(user)
    fake_stream(monkeypatch, DRAFT.replace("能够解释退款指标", "能够区分百分点与相对变化；能够解释退款指标"))

    assert events(authed_client.post(f"/api/courses/{cid}/next"))[-1]["done"]

    with TestSession() as db:
        syllabus = db.query(Syllabus).filter_by(course_id=cid).one().content
    row = next(line for line in syllabus.splitlines() if line.startswith("| 第 2 篇") or line.startswith("| 2"))
    assert "能够区分百分点与相对变化" in row and "能够解释退款指标" in row


def test_the_chinese_prompts_say_how_to_separate_mastery_items():
    for prompt in (courses.FIRST_LESSON_PROMPT, courses.NEXT_LESSON_PROMPT, courses.SOURCE_LESSON_PROMPT):
        assert "掌握项之间用英文分号 ; 分隔，掌握项内部不要用分号" in prompt
    assert "掌握项内部不要用分号" in courses.SYLLABUS_PROMPT


# ---------------------------------------------------------------------------
# 3. 流式响应开始时，请求的数据库会话不在事务里
# ---------------------------------------------------------------------------

@pytest.fixture
def request_sessions(monkeypatch):
    sessions, states = [], []

    def capture():
        db = TestSession()
        sessions.append(db)
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setitem(fastapi_app.dependency_overrides, get_db, capture)
    real = courses.StreamingResponse

    def response(body, **kwargs):
        states.append([db.in_transaction() for db in sessions])
        return real(body, **kwargs)

    monkeypatch.setattr(courses, "StreamingResponse", response)
    return states


@pytest.mark.parametrize("with_feedback", [True, False])
def test_the_next_lesson_releases_the_request_connection_before_streaming(
    authed_client, user, adaptive, monkeypatch, request_sessions, with_feedback,
):
    cid = seed(user)
    if with_feedback:
        assert authed_client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "多举例"}).status_code == 200
    monkeypatch.setattr(courses, "_call_llm", lambda system, user, **kw: json.dumps({"issues": [], "edits": []})
                        if system == teaching.REVIEW_PROMPT else plan_json())
    fake_stream(monkeypatch, DRAFT)

    assert events(authed_client.post(f"/api/courses/{cid}/next"))[-1]["done"]
    assert len(request_sessions) == 1 and not any(request_sessions[0])


def test_the_summary_releases_the_request_connection_before_streaming(authed_client, finished, monkeypatch, request_sessions):
    summary_calls(monkeypatch, planner=plan_json(), compress="# 总结\n短。")
    fake_stream(monkeypatch, "# 总结\n短。")

    assert events(authed_client.post(f"/api/courses/{finished}/next"))[-1]["completed"]
    assert request_sessions == [[False]]


def test_highlight_questions_release_the_request_connection_before_streaming(authed_client, user, monkeypatch, request_sessions):
    cid = seed(user)

    def answer(system, history):
        yield "回答", False
        yield "回答", True

    monkeypatch.setattr(courses, "_stream_llm_messages", answer)
    first = events(authed_client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
        "position_start": 0, "position_end": 2, "original_text": "百分点", "comment": "这是什么？",
    }))[-1]
    follow = events(authed_client.post(
        f"/api/courses/{cid}/lessons/1/annotations/{first['annotation']['id']}/messages", json={"content": "再说说？"},
    ))[-1]

    assert first["done"] and follow["done"]
    assert request_sessions == [[False], [False, False]]


# ---------------------------------------------------------------------------
# 4. 长原文划线问答的选区定位
# ---------------------------------------------------------------------------

FILLER = "开头的段落写的是别的事情。" * 2500


def test_a_rendered_selection_is_found_in_a_long_markdown_source():
    target = "**复利**的关键在于[利滚利](https://example.com/compound)：\n\n- 每期的利息\n- 计入下一期本金"
    context = FILLER + "\n\n" + target + "\n\n" + "结尾的段落。" * 3000

    window = courses._annotation_context(context, "复利的关键在于利滚利：\n每期的利息\n计入下一期本金")

    assert target in window and len(window) <= courses.ANNOTATION_CONTEXT_CHARS + 10


def test_a_pdf_selection_across_a_line_break_and_a_page_marker_is_found():
    context = FILLER + "\n现金流折现把未来的\n<!-- page: 12 -->\n钱换算成今天的价值。\n" + "后面的内容。" * 3000
    at = courses._locate_selection(context, "现金流折现把未来的钱换算成今天的价值。")
    assert context[at:].startswith("现金流折现")


def test_an_english_selection_ignores_bold_and_wrapped_lines():
    context = "Intro text. " * 3000 + "The **compound\ninterest** formula adds interest to the principal." + " Outro." * 3000
    at = courses._locate_selection(context, "The compound interest formula adds")
    assert context[at:].startswith("The **compound")


def test_a_selection_that_cannot_be_located_brings_only_itself_not_the_start_of_the_book():
    window = courses._annotation_context(FILLER * 2, "原文里根本没有的一句话")
    assert "原文里根本没有的一句话" in window and "开头的段落" not in window and "没有在原文里定位到" in window


def test_the_context_limit_can_come_from_the_caller():
    """默认是 ANNOTATION_CONTEXT_CHARS（50000），调用方传进来的值优先：窗口跟着变，选区照样在。"""
    context = "甲" * 40_000 + "关键句子在这里" + "乙" * 40_000
    default_window = courses._annotation_context(context, "关键句子在这里")
    configured_window = courses._annotation_context(context, "关键句子在这里", "zh", 5_000)
    assert len(default_window) <= courses.ANNOTATION_CONTEXT_CHARS + 10
    assert len(configured_window) <= 5_000 + 10 and "关键句子在这里" in configured_window


def test_a_highlight_question_on_a_long_source_sends_the_passage_and_reads_the_source_once(authed_client, user, monkeypatch):
    source = "原文开头标记。" + FILLER + "\n\n## 第三章\n\n**净现值**等于各期[现金流](https://x.y)的现值之和。\n\n" + "尾部。" * 12000
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="金融", language="zh", mode="source", source_content=source, source_filename="a.md")
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content=SYLLABUS))
        db.add(Lesson(course_id=course.id, number=-1, content=source, is_source=True, source_filename="a.md"))
        db.commit()
        cid = course.id
    prompts = []

    def answer(system, history):
        prompts.append(system)
        yield "回答", False
        yield "回答", True

    monkeypatch.setattr(courses, "_stream_llm_messages", answer)
    statements = []
    listener = lambda conn, cursor, statement, *args: statements.append(statement)  # noqa: E731
    event.listen(engine, "before_cursor_execute", listener)
    try:
        res = authed_client.post(f"/api/courses/{cid}/lessons/-1/annotations", json={
            "position_start": 0, "position_end": 10, "original_text": "净现值等于各期现金流的现值之和。", "comment": "怎么算？",
        })
    finally:
        event.remove(engine, "before_cursor_execute", listener)

    assert events(res)[-1]["done"]
    # 选区在材料里，模型看得到；但几十万字的原文不会整份塞进来（上限是 ANNOTATION_CONTEXT_CHARS）
    assert "**净现值**等于各期[现金流]" in prompts[0]
    assert len(source) > courses.ANNOTATION_CONTEXT_CHARS and "原文开头标记。" not in prompts[0]
    assert not any("lessons.content" in statement for statement in statements)  # 上传原文那一篇只读 course.source_content 一份


def test_a_highlight_question_uses_the_configured_context_limit(authed_client, user, monkeypatch):
    """ANNOTATION_CONTEXT_CHARS 设成 5000 字要真的生效：3 万字的课文只带选区前后这一段，而不是整篇。"""
    lesson = "课文开头标记。" + "开头的段落。" * 3000 + "\n\n关键句子在这里。\n\n" + "后面的段落。" * 3000
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="比例", language="zh")
        db.add(course)
        db.flush()
        cid = course.id
        db.add(Lesson(course_id=cid, number=1, content=lesson))
        db.commit()
    monkeypatch.setattr(courses, "ANNOTATION_CONTEXT_CHARS", 5000)
    prompts = []

    def answer(system, history):
        prompts.append(system)
        yield "回答", True

    monkeypatch.setattr(courses, "_stream_llm_messages", answer)
    res = authed_client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
        "position_start": 0, "position_end": 8, "original_text": "关键句子在这里。", "comment": "什么意思？",
    })
    assert events(res)[-1]["done"]
    material = prompts[0].split("## 当前学习材料\n", 1)[1].split("\n\n## 学生划线内容", 1)[0]
    assert "关键句子在这里" in material and "课文开头标记。" not in material and len(material) < 6000


# ---------------------------------------------------------------------------
# 5. 评估篇按提示词分支判定
# ---------------------------------------------------------------------------

def test_an_evaluation_without_its_marker_is_still_saved_as_the_evaluation_and_then_the_summary_follows(authed_client, user, monkeypatch):
    done_syllabus = SYLLABUS.replace("- [ ] 能够解释退款指标\n", "")
    cid = seed(user, syllabus=done_syllabus)
    fake_stream(monkeypatch, "# 最终评估\n## 思考题\n1. 综合题？")

    done = events(authed_client.post(f"/api/courses/{cid}/next"))[-1]

    assert done["is_evaluation"] is True
    with TestSession() as db:
        saved = db.query(Lesson).filter_by(course_id=cid, number=2).one()
        assert saved.is_evaluation and saved.content.startswith("<!-- eval-article -->\n\n# 最终评估")

    fake_stream(monkeypatch, "# 总结\n学完了。")
    assert events(authed_client.post(f"/api/courses/{cid}/next"))[-1] == {"done": True, "completed": True}
    with TestSession() as db:
        assert db.get(Course, cid).status == "completed"


def test_a_stray_marker_in_a_teaching_lesson_does_not_turn_it_into_an_evaluation(authed_client, user, monkeypatch):
    cid = seed(user)
    fake_stream(monkeypatch, "<!-- eval-article -->\n" + DRAFT)

    assert events(authed_client.post(f"/api/courses/{cid}/next"))[-1]["is_evaluation"] is False
    with TestSession() as db:
        saved = db.query(Lesson).filter_by(course_id=cid, number=2).one()
        assert not saved.is_evaluation and "eval-article" not in saved.content


# ---------------------------------------------------------------------------
# 6. 流式输出被截断
# ---------------------------------------------------------------------------

class TruncatingClient:
    """流式回复写到一半就到了输出上限：最后一个分片 finish_reason=length。"""

    def __init__(self, finish_reason="length"):
        self.finish_reason = finish_reason
        self.closed = False
        self.chat = NS(completions=NS(create=self.create))

    def create(self, **kwargs):
        assert kwargs["stream"]
        return iter([stream_chunk("# 第二篇\n\n## 正文内容\n半截"),
                     NS(choices=[NS(delta=NS(content=None), finish_reason=self.finish_reason)], usage=None)])

    def close(self):
        self.closed = True


def test_a_truncated_next_lesson_is_reported_and_not_saved(authed_client, user, monkeypatch):
    cid = seed(user)
    client = TruncatingClient()
    monkeypatch.setattr(courses, "get_openai_client", lambda **kwargs: client)

    error = events(authed_client.post(f"/api/courses/{cid}/next"))[-1]["error"]

    assert "没能生成下一篇" in error and "截断" in error
    with TestSession() as db:
        assert db.query(Lesson).filter_by(course_id=cid, number=2).count() == 0
    assert client.closed


def test_a_truncated_highlight_answer_is_reported_and_not_saved(authed_client, user, monkeypatch):
    cid = seed(user)
    client = TruncatingClient()
    monkeypatch.setattr(courses, "get_openai_client", lambda **kwargs: client)

    error = events(authed_client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
        "position_start": 0, "position_end": 2, "original_text": "百分点", "comment": "这是什么？",
    }))[-1]["error"]

    assert "没能回答这条提问，请稍后重试" in error and "截断" in error
    with TestSession() as db:
        assert db.query(Annotation).count() == 0
    assert client.closed


def test_a_complete_stream_still_works_and_closes_its_client():
    client = TruncatingClient(finish_reason="stop")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(courses, "get_openai_client", lambda **kwargs: client)
        *_, (text, final) = list(courses._stream_llm("系统", "用户"))
    assert final and text.endswith("半截") and client.closed


def test_the_non_streaming_multi_turn_call_closes_its_client():
    client = TruncatingClient()
    client.chat = NS(completions=NS(create=lambda **kwargs: NS(choices=[NS(message=NS(content="答"), finish_reason="stop")])))
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(courses, "get_openai_client", lambda **kwargs: client)
        assert courses._call_llm_messages("系统", [{"role": "user", "content": "问"}]) == "答"
    assert client.closed


# ---------------------------------------------------------------------------
# P3
# ---------------------------------------------------------------------------

def test_the_summary_never_reads_the_uploaded_original_or_its_questions(authed_client, user, monkeypatch):
    original = "# 原文\n## 思考题\n1. 原文里自带的练习题？\n" + "原文。" * 1000
    cid = seed(user, mode="source", source_content=original, lessons=(
        (-1, original, False), (1, LESSON_1, False), (2, "<!-- eval-article -->\n# 最终评估\n## 思考题\n1. b？", True),
    ))
    with TestSession() as db:
        db.query(Lesson).filter_by(course_id=cid, number=-1).update({"is_source": True})
        db.commit()
    seen = []
    fake_stream(monkeypatch, "# 总结\n短。", seen)

    assert events(authed_client.post(f"/api/courses/{cid}/next"))[-1]["completed"]
    assert "原文里自带的练习题" not in seen[0] and "5%到7%相对增加多少" in seen[0]


def test_many_active_feedback_records_no_longer_block_the_next_lesson(authed_client, user, adaptive, monkeypatch):
    cid = seed(user)
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        db.add_all(TeachingFeedback(course_id=cid, lesson_id=lesson.id, target_lesson=2, content=f"偏好{i}：" + "要" * 3000,
                                    requested_scope="course", effective_scope="course") for i in range(150))
        db.commit()
    planner_inputs, seen = [], []

    def call(system, user, **kwargs):
        if system == teaching.PLANNER_PROMPT:
            planner_inputs.append(json.loads(user))
            return plan_json()
        return json.dumps({"issues": [], "edits": []})

    monkeypatch.setattr(courses, "_call_llm", call)
    fake_stream(monkeypatch, DRAFT, seen)

    res = authed_client.post(f"/api/courses/{cid}/next")

    assert res.status_code == 200 and events(res)[-1]["done"]
    records = planner_inputs[0]["feedback_records"]
    assert planner_inputs[0]["omitted_older_feedback_records"] == 150 - len(records) > 0
    assert len(json.dumps(records, ensure_ascii=False)) <= teaching.PLANNER_FEEDBACK_CHARS
    assert records[-1]["content"].startswith("偏好149：")  # 留下的是最新的
    assert f"另有 {150 - len(records)} 条较早的有效反馈因篇幅没有列出" in seen[0]


def test_a_highlight_answer_keeps_the_newest_course_preferences_instead_of_failing(user):
    cid = seed(user)
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        db.add_all(TeachingFeedback(course_id=cid, lesson_id=lesson.id, target_lesson=2, content=f"以后都{i}" + "要" * 3000,
                                    requested_scope="course", effective_scope="course") for i in range(150))
        db.commit()
        prompt = teaching_styles.annotation_prompt(db, user.uuid, cid)
    assert "older preferences were left out for length" in prompt and "以后都149" in prompt and "以后都0要" not in prompt


def test_snapshot_and_highlights_never_load_lesson_text(authed_client, user):
    cid = seed(user, lessons=((-1, "原文" * 1000, False), (1, LESSON_1, False)))
    authed_client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "以后都用电商例子", "scope": "course"})
    statements = []
    listener = lambda conn, cursor, statement, *args: statements.append(statement)  # noqa: E731
    event.listen(engine, "before_cursor_execute", listener)
    try:
        with TestSession() as db:
            assert teaching.snapshot(db, cid, 2)[0]["source_lesson"] == 1
        saved = authed_client.post(f"/api/courses/{cid}/lessons/-1/highlights",
                                   json={"position_start": 0, "position_end": 2, "original_text": "原文"}).json()
        assert len(authed_client.get(f"/api/courses/{cid}/lessons/-1/highlights").json()) == 1
        assert authed_client.delete(f"/api/courses/{cid}/lessons/-1/highlights/{saved['id']}").json() == {"ok": True}
        assert authed_client.get(f"/api/courses/{cid}/lessons/-1/annotations").json() == []
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert statements and not any("lessons.content" in statement for statement in statements)


def test_when_the_whole_pipeline_runs_out_of_time_the_draft_is_saved_without_the_optional_review(
    authed_client, user, adaptive, monkeypatch,
):
    cid = seed(user)
    assert authed_client.post(f"/api/courses/{cid}/lessons/1/feedback", json={"content": "多举例"}).status_code == 200
    monkeypatch.setattr(courses, "NEXT_LESSON_DEADLINE_SECONDS", courses.LESSON_SAVE_RESERVE_SECONDS)
    systems = []
    monkeypatch.setattr(courses, "_call_llm", lambda system, user, **kw: systems.append(system) or plan_json())
    fake_stream(monkeypatch, DRAFT)

    assert events(authed_client.post(f"/api/courses/{cid}/next"))[-1]["done"]

    assert teaching.REVIEW_PROMPT not in systems  # 复核被跳过，没有白发一次调用
    with TestSession() as db:
        saved = db.query(Lesson).filter_by(course_id=cid, number=2).one()
        assert json.loads(saved.teaching_plan)["quality_review"]["reviewed"] is False and "电商支付率" in saved.content


def test_the_saving_marker_outlives_the_whole_pipeline_deadline():
    assert courses.LESSON_SAVING_TTL_SECONDS > courses.NEXT_LESSON_DEADLINE_SECONDS


def test_a_legacy_source_course_plans_with_the_relevant_passage_not_the_whole_book(authed_client, user, adaptive, monkeypatch):
    source = "\n\n".join(f"第{i}段讲的是无关的背景材料。" * 40 for i in range(60)) + "\n\n边际成本是多生产一件产品增加的成本。\n\n" + "尾声。" * 2000
    cid = seed(user, mode="source", source_content=source, lessons=((1, source, False),))
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=cid, number=1).one()
        lesson.is_source = True
        db.add(Annotation(lesson_id=lesson.id, position_start=0, position_end=4, original_text="边际成本", comment="边际成本怎么理解？"))
        db.commit()
    planner_inputs, seen = [], []

    def call(system, user, **kwargs):
        if system == teaching.PLANNER_PROMPT:
            planner_inputs.append(json.loads(user))
            return plan_json()
        if system == teaching.REVIEW_PROMPT:
            planner_inputs.append(json.loads(user))
            return json.dumps({"issues": [], "edits": []})
        raise AssertionError(system[:40])

    monkeypatch.setattr(courses, "_call_llm", call)
    fake_stream(monkeypatch, DRAFT.replace("电商支付率10%到12%。", "边际成本是多生产一件产品增加的成本。"), seen)

    assert events(authed_client.post(f"/api/courses/{cid}/next"))[-1]["done"]

    planned, reviewed = planner_inputs[0]["previous_lesson"], planner_inputs[1]["source_material"]
    for excerpt in (planned, reviewed):
        assert "边际成本是多生产一件产品增加的成本" in excerpt
        assert len(excerpt) <= courses.LEGACY_SOURCE_EXCERPT_CHARS + 200 < len(source)
    assert source[-200:] in seen[0]  # 写课文的提示词仍然带整份原文


def test_the_chinese_prompts_carry_the_same_guardrails_as_the_english_ones():
    for prompt in (courses.SYLLABUS_PROMPT, courses.FIRST_LESSON_PROMPT, courses.NEXT_LESSON_PROMPT, courses.SOURCE_LESSON_PROMPT,
                   courses.GROUNDED_SYLLABUS_REVIEW_PROMPT, courses.GROUNDED_SYLLABUS_REPAIR_PROMPT, courses.SUMMARY_PROMPT):
        assert prompt.count("**通用底线**") == 1 and "不得编造学生的问题" in prompt and "讲过某个内容不等于学生已经掌握" in prompt
    assert courses.PROMPTS["zh"].summary is courses.SUMMARY_PROMPT
