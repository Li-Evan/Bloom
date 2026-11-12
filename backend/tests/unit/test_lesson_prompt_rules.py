"""课文提示词发给模型的内容。

B1 没有参考资料的主题课不出现溯源标注（提示词里连「课程参考知识包」小节都没有，并明确禁止）；
B2 简单深度更短更直观；B3 下一篇的开头很短、没作答时答案放文末、不写说明句；B4 划线回答很短；B5 投资 / 医疗 / 法律提示。
中文课和英文课各检查一遍，并检查被解析的结构（思考题抽取、mastery 勾选）没有被新结构破坏。
"""
import pytest

import app.course_language as language_module
import app.courses as courses_module
import app.prompts_en as prompts_en
from app.models import Feedback, Lesson, Syllabus
from tests.conftest import TestSession, seed_source_course
from tests.unit.test_course_language import (
    CJK, fake_model, make_legacy_source_course, next_lesson, respond_en, respond_zh, sse_events, start_first_lesson,
    syllabus_text,
)

ZH_NEXT = (
    "# 第二课\n\n> 前置知识：第一课\n> 难度：入门\n> 预计阅读时间：5 分钟\n\n---\n\n"
    "## 上一篇思考题复盘\n\n思考题是可选的，参考答案放在本篇末尾。\n\n"
    "## 正文内容\n\n新内容。\n\n## 思考题\n\n1. 新问题一？\n2. 新问题二？\n\n"
    "## 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 旧答案一\n\n**第2题：** 旧题二\n> 旧答案二\n\n"
    "<!-- mastery: 能够解释核心概念1; 能够解释核心概念2 -->"
)
EN_NEXT_UNANSWERED = (
    "# Lesson 2\n\n---\n\n## Review of the previous reflection questions\n\n"
    "The reflection questions are optional; the reference answers are at the end of this lesson.\n\n"
    "## Main content\n\nNew material.\n\n## Reflection questions\n\n1. New question one?\n2. New question two?\n\n"
    "## Reference answers to the previous reflection questions\n\n**Question 1:** Old one\n> Old answer one\n\n"
    "**Question 2:** Old two\n> Old answer two\n\n"
    "<!-- mastery: Explain core concept 1 (Source: concepts.md, Core concepts) -->"
)


@pytest.fixture
def client(authed_client):
    return authed_client


def zh_syllabus(items=8):
    lines = "\n".join(f"- [ ] 能够解释核心概念{i}" for i in range(1, items + 1))
    return (
        f"# 线性代数 · 课程大纲\n\n## 核心掌握项\n\n### 主线\n{lines}\n\n## 不在本课题范围内\n\n- 其它\n\n"
        "## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|------|-----------|---------|\n"
    )


ZH_TOPIC_LESSON = (
    "# 特征值与特征向量\n\n> 前置知识：矩阵乘法\n> 难度：入门\n> 预计阅读时间：5 分钟\n\n## 正文内容\n\n先看一个例子。\n\n"
    "## 思考题\n\n1. 为什么方向不变？\n2. 如何求特征值？\n"
)


def responder_for(language):
    if language == "en":
        return respond_en

    def respond(system, user):
        if "课程大纲设计专家" in system:
            return zh_syllabus()
        if "苏格拉底式导师" in system and "生成下一篇" in system:
            return ZH_NEXT
        if "苏格拉底式导师" in system:
            return ZH_TOPIC_LESSON
        return respond_zh(system, user)

    return respond


def make_course(client, language="zh", reference="", depth="simple", name="线性代数", first=True):
    """建课只生成大纲；first=True 时接着 POST /first 生成第 01 篇（calls[0] 大纲、calls[1] 首篇，记在同一个 model 里）。"""
    with fake_model(responder_for(language)) as model:
        res = client.post("/api/courses", json={
            "name": name, "reference": reference, "learning_depth": depth, "language": language,
        })
        assert res.status_code == 200, res.text
        if first:
            start_first_lesson(client, res.json()["id"])
    return res.json()["id"], model


def lesson_prompt(model):
    return model.calls[-1]["system"]


def generate_next(client, cid, language="zh", lesson_text=None):
    responder = responder_for(language) if lesson_text is None else (lambda system, user: lesson_text)
    with fake_model(responder) as model:
        res = client.post(f"/api/courses/{cid}/next")
    assert res.status_code == 200, res.text
    assert not any("error" in e for e in sse_events(res)), res.text
    return model


def set_feedback(cid, thought_answers, content="读懂了", lesson=1):
    with TestSession() as db:
        lesson_row = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == lesson).one()
        db.add(Feedback(lesson_id=lesson_row.id, content=content, thought_answers=thought_answers))
        db.commit()


def all_prompt_texts():
    texts = {}
    for language, prompts in courses_module.PROMPTS.items():
        for field in prompts.__dataclass_fields__:
            texts[f"{language}.prompts.{field}"] = getattr(prompts, field)
    for language in ("zh", "en"):
        table = language_module.text_for(language)
        for field in table.__dataclass_fields__:
            texts[f"{language}.text.{field}"] = getattr(table, field)
    return texts


# ---------------------------------------------------------------------------
# B1：没有参考资料的主题课，提示词里没有溯源规则，也没有「课程参考知识包」小节
# ---------------------------------------------------------------------------

def test_a_chinese_topic_course_without_a_reference_gets_no_grounding_rules(client):
    _, model = make_course(client, "zh")

    system, user = model.calls[1]["system"], model.calls[1]["user"]
    assert "课程参考知识包" not in system and "未提供" not in system.split("## 没有参考资料")[0]
    assert "## 没有参考资料（必须遵守）" in system
    assert "禁止出现这些内部标注和字眼" in system
    for rule in ("资料溯源", "事实与假设分离", "真实案例约束", "## 资料规则"):
        assert rule not in system
    assert "资料指出" not in user and "来源" not in user.replace("资料或来源标注", "")
    assert "不要出现任何资料或来源标注" in user


def test_an_english_topic_course_without_a_reference_gets_no_grounding_rules(client):
    _, model = make_course(client, "en", name="Eigenvalues")

    system, user = model.calls[1]["system"], model.calls[1]["user"]
    assert "Course reference pack" not in system and "Not provided" not in system
    assert "## No reference material (mandatory)" in system
    for rule in ("Source grounding", "Separate fact from assumption", "Real-case constraint", "## Source rules"):
        assert rule not in system
    assert "According to the materials" not in user and "put no source or materials labels" in user


@pytest.mark.parametrize("language,header,marker", [
    ("zh", "## 课程参考知识包\n概念甲是核心。", "## 资料规则（本课程有参考知识包，必须遵守）"),
    ("en", "## Course reference pack\nConcept A is the core.", "## Source rules (this course has a reference pack; mandatory)"),
])
def test_a_course_that_has_a_reference_keeps_the_grounding_rules(client, language, header, marker):
    reference = "概念甲是核心。" if language == "zh" else "Concept A is the core."
    _, model = make_course(client, language, reference=reference)

    system = model.calls[1]["system"]
    assert header in system and marker in system
    assert "没有参考资料" not in system and "No reference material" not in system


def test_the_deep_outline_prompt_only_leans_on_reference_material_when_there_is_some():
    without = courses_module._build_syllabus_prompt("deep", "zh", has_reference=False)
    with_reference = courses_module._build_syllabus_prompt("deep", "zh")

    assert "必须来自参考材料" in with_reference and "必须来自参考材料" not in without
    assert "必须真实可靠" in without
    en_without = courses_module._build_syllabus_prompt("deep", "en", has_reference=False)
    assert "must come from the reference material" not in en_without and "true and reliable" in en_without
    # 浅档的展开策略不分有无资料，只是后面的资料规则不同
    assert courses_module._build_syllabus_prompt("simple", "zh", has_reference=False).split("## 没有参考资料")[0] == \
        courses_module._build_syllabus_prompt("simple", "zh").split("## 资料规则")[0]


def test_a_material_course_still_gets_grounding_rules_in_its_first_lesson(authed_client):
    from tests.unit.test_course_language import create_materials

    _, model = create_materials(authed_client)

    lesson_calls = [c for c in model.calls if c["system"].startswith(prompts_en.FIRST_LESSON_PROMPT.split("{syllabus}")[0])]
    assert len(lesson_calls) == 1
    assert "## Source rules (this course has a reference pack; mandatory)" in lesson_calls[0]["system"]
    assert "## Course reference pack\n# Course Reference Pack" in lesson_calls[0]["system"]
    assert lesson_calls[0]["user"].startswith('Write the first lesson for the topic "Compound interest"')
    assert "According to the materials" in lesson_calls[0]["user"]


def test_no_prompt_asks_for_the_old_unreadable_hypothetical_label():
    for where, text in all_prompt_texts().items():
        if "rules_without_reference" in where or "rules_source_course" in where:
            continue  # 禁止清单里要点名这些字眼
        assert "假设场景（非原文事实）" not in text, where
        assert "Hypothetical scenario (not from the source)" not in text, where
    assert "举个例子（假设的情形）" in language_module.ZH.rules_with_reference
    assert "Here is an example (a made-up situation)" in language_module.EN.rules_with_reference
    assert "举个例子（假设的情形）" in courses_module.GROUNDED_LESSON_REVIEW_PROMPT
    assert "Here is an example (a made-up situation)" in prompts_en.GROUNDED_LESSON_REVIEW_PROMPT


def test_the_next_lesson_of_a_topic_course_has_no_reference_section_and_forbids_labels(client):
    cid, _ = make_course(client, "zh")

    model = generate_next(client, cid)

    system = model.calls[0]["system"]
    assert "## 课程参考知识包" not in system and "资料溯源" not in system and "资料隔离" not in system
    assert "## 没有参考资料（必须遵守）" in system


def test_the_next_lesson_of_a_course_with_a_reference_no_longer_carries_the_pack_but_is_not_told_there_is_none(client):
    # 第二篇起只带上一篇、大纲和反馈，不再带参考知识包；没有知识包也就没有溯源规则。
    # 但这门课确实有参考资料，不能对模型说「这门课没有任何参考资料」（修复轮 1 的约定，见下面「a course with a pack says neither」）。
    cid, _ = make_course(client, "zh", reference="概念甲是核心。")

    model = generate_next(client, cid)

    system = model.calls[0]["system"]
    assert "## 课程参考知识包" not in system and "概念甲是核心。" not in system
    assert "## 资料规则" not in system
    assert "### 第1篇\n# " in system
    assert "没有参考资料" not in system


def test_the_assessment_lesson_forbids_labels_unless_there_is_a_reference(client):
    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()

    plain = generate_next(client, cid, lesson_text="<!-- eval-article -->\n\n# 评估").calls[0]["system"]
    assert plain.startswith("你是一个基于 Bloom 2-Sigma 理论的一对一苏格拉底式导师。\n\n大纲中所有掌握项已经全部覆盖完毕")
    assert "## 没有参考资料（必须遵守）" in plain

    cid2, _ = make_course(client, "zh", reference="概念甲是核心。")
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid2).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    grounded = generate_next(client, cid2, lesson_text="<!-- eval-article -->\n\n# 评估").calls[0]["system"]
    assert "没有参考资料" not in grounded


# ---------------------------------------------------------------------------
# B2：简单深度的篇幅与表达
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("language,marker,must_have", [
    ("zh", "## 简单深度的额外要求（必须遵守）", ["不得超过 10 分钟", "最多只讲 2–3 个核心概念", "先用一个直观的例子", "紧接着用一句大白话"]),
    ("en", "## Extra requirements for Simple depth (mandatory)",
     ["must not exceed 10 minutes", "at most 2-3 core concepts", "intuitive example or scene first", "plain-language sentence"]),
])
def test_the_first_lesson_of_a_simple_course_is_short_intuitive_and_explains_every_symbol(client, language, marker, must_have):
    _, model = make_course(client, language, depth="simple", name="Eigenvalues" if language == "en" else "线性代数")

    system = model.calls[1]["system"]
    assert marker in system
    for phrase in must_have:
        assert phrase in system


@pytest.mark.parametrize("depth", ["standard", "deep"])
@pytest.mark.parametrize("language", ["zh", "en"])
def test_standard_and_deep_first_lessons_are_not_changed_by_the_simple_rules(client, language, depth):
    _, model = make_course(client, language, depth=depth, name="Eigenvalues" if language == "en" else "线性代数")

    system = model.calls[1]["system"]
    assert "简单深度的额外要求" not in system and "Extra requirements for Simple depth" not in system
    assert system.rstrip().endswith("use a made-up example with no real names" if language == "en" else "改用不带真实名称的假设例子")


@pytest.mark.parametrize("depth,present", [("simple", True), ("standard", False), ("deep", False)])
def test_later_lessons_of_a_simple_course_keep_the_same_light_style(client, depth, present):
    cid, _ = make_course(client, "zh", depth=depth)

    system = generate_next(client, cid).calls[0]["system"]

    assert ("## 简单深度的额外要求（必须遵守）" in system) is present


# ---------------------------------------------------------------------------
# B3：下一篇的结构
# ---------------------------------------------------------------------------

def test_an_answered_lesson_gets_a_per_question_review_and_no_answer_section(client):
    cid, _ = make_course(client, "zh")
    set_feedback(cid, "1. 因为方向没变 2. 解特征方程")

    system = generate_next(client, cid).calls[0]["system"]

    assert "[学生作答了。按「上一篇的真实思考题」逐题点评" in system
    assert "思考题是可选的，参考答案放在本篇末尾" not in system
    assert "## 上一篇思考题参考答案" not in system
    assert "思考题回答：1. 因为方向没变 2. 解特征方程" in system


@pytest.mark.parametrize("answers", [None, "", "   \n"])
def test_an_unanswered_lesson_gets_one_sentence_up_front_and_the_answers_at_the_end(client, answers):
    cid, _ = make_course(client, "zh")
    if answers is not None:
        set_feedback(cid, answers)

    system = generate_next(client, cid).calls[0]["system"]

    assert "> 上一篇的思考题是可选的，参考答案放在本篇末尾。" in system and "你还没作答" not in system
    assert "[学生作答了。" not in system
    # 没作答时不开「上一篇思考题复盘」小节，只在标题下面留一行小字
    assert "**不要**写「## 上一篇思考题复盘」这个小节" in system
    assert "\n## 上一篇思考题复盘\n" not in system.split("## 输出格式", 1)[1].split("## 规则", 1)[0]
    answers_at = system.index("## 上一篇思考题参考答案")
    assert system.index("## 思考题\n") < answers_at < system.index("```\n\n## 规则")
    assert "**第1题：** [题目简述" in system


def test_an_unanswered_english_lesson_gets_the_same_structure(client):
    cid, _ = make_course(client, "en", name="Eigenvalues")

    system = next_lesson(client, cid).calls[0]["system"]

    assert "> The previous lesson's reflection questions are optional; the reference answers are at the end of this lesson." in system
    assert '**Do not** write a "Review of the previous reflection questions" section' in system
    assert "\n## Review of the previous reflection questions\n" not in system.split("## Output format", 1)[1].split("## Rules", 1)[0]
    assert "## Reference answers to the previous reflection questions" in system
    assert system.index("## Reflection questions\n") < system.index("## Reference answers to the previous reflection questions")
    assert not CJK.search(system)


def test_an_answered_english_lesson_has_no_answer_section(client):
    cid, _ = make_course(client, "en", name="Eigenvalues")
    set_feedback(cid, "Because the direction stays.")

    system = next_lesson(client, cid).calls[0]["system"]

    assert "## Review of the previous reflection questions\n\n[The student answered. Comment on the previous reflection questions one by one" in system
    assert "## Reference answers to the previous reflection questions" not in system
    assert "reflection questions are optional" not in system


def test_the_highlight_section_only_appears_for_a_question_left_unanswered(client):
    from tests.unit.test_course_language import ask

    cid, _ = make_course(client, "en", name="Eigenvalues")
    without = next_lesson(client, cid).calls[0]["system"]
    assert "## Answers to your highlights" not in without

    # 划线时当场答过的问题，学生已经看过解答：下一篇不再单开一节复述，只当成正文怎么讲的线索
    cid2, _ = make_course(client, "en", name="Eigenvalues")
    ask(client, cid2)
    answered = next_lesson(client, cid2).calls[0]["system"]
    assert "## Answers to your highlights" not in answered
    assert "  Q: What does this mean?\n  A: " in answered
    assert "**[High priority] Do not answer the highlight Q&A again.**" in answered

    cid3, _ = make_course(client, "en", name="Eigenvalues")
    with TestSession() as db:
        from app.models import Annotation

        lesson = db.query(Lesson).filter(Lesson.course_id == cid3, Lesson.number == 1).one()
        db.add(Annotation(lesson_id=lesson.id, position_start=0, position_end=4, original_text="Interest", comment="Why?"))
        db.commit()
    unanswered = next_lesson(client, cid3).calls[0]["system"]
    assert "## Answers to your highlights\n\n[Answer only the questions in the student's highlight records that have no \"A\" yet" in unanswered


def test_the_chinese_highlight_section_answers_only_what_was_left_unanswered(client):
    from app.models import Annotation

    cid, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter(Lesson.course_id == cid, Lesson.number == 1).one()
        db.add(Annotation(
            lesson_id=lesson.id, position_start=0, position_end=2, original_text="特征值", comment="左乘是什么意思", answer="就是……",
        ))
        db.commit()

    answered = generate_next(client, cid).calls[0]["system"]

    assert "## 批注解答\n\n[" not in answered
    assert "- 原文「特征值」\n  问：左乘是什么意思\n  答：就是……" in answered
    assert "**【高优先级】划线问答不要再答一遍。**" in answered

    cid2, _ = make_course(client, "zh")
    with TestSession() as db:
        lesson = db.query(Lesson).filter(Lesson.course_id == cid2, Lesson.number == 1).one()
        db.add(Annotation(lesson_id=lesson.id, position_start=0, position_end=2, original_text="特征值", comment="为什么不变？"))
        db.commit()

    unanswered = generate_next(client, cid2).calls[0]["system"]

    assert "## 批注解答\n\n[只回答批注记录里还没有「答」的提问（学生问了，但当时没有得到解答），逐条作答，每条至多 2–3 句" in unanswered


@pytest.mark.parametrize("prompt_name", ["next_lesson", "eval_lesson", "source_lesson"])
@pytest.mark.parametrize("language", ["zh", "en"])
def test_lesson_prompts_no_longer_contain_template_sentences_the_model_would_copy_into_the_lesson(language, prompt_name):
    prompt = getattr(courses_module.PROMPTS[language], prompt_name)

    for line in prompt.splitlines():
        assert not line.startswith(("> 📝", "> 💬")), line
        assert not line.startswith(("> This section", "> 本模块", "> 本节")), line
    for sentence in (
        "本模块评估你对上一篇思考题的回答，并给出正确答案", "本模块解答学生在上一篇中标记的所有困惑", "本模块综合学生阅读原文时的划线问题",
        "This section assesses your answers to the previous reflection questions and gives the correct answers.",
        "This section answers every confusion the student marked in the previous lesson.",
        "This section combines the questions the student highlighted",
    ):
        assert sentence not in prompt
    # 提示词里明说不许写这类说明句
    assert any(rule in prompt for rule in (
        "**不写说明句**", "不要输出对本节作用的说明", "**No explanatory sentences**", "Do not write sentences that explain what a section is for",
    ))


@pytest.mark.parametrize("language", ["zh", "en"])
def test_the_next_lesson_prompt_asks_for_a_short_opening_with_new_content_early(language):
    prompt = courses_module.PROMPTS[language].next_lesson

    if language == "zh":
        assert "**新内容尽早出现**" in prompt and "合计不超过约 250 字" in prompt
    else:
        assert "**New material comes early**" in prompt and "about 170 words" in prompt


def test_the_hidden_mastery_comment_stays_the_last_thing_in_both_languages():
    zh, en = courses_module.NEXT_LESSON_PROMPT, prompts_en.NEXT_LESSON_PROMPT
    assert "在文档最末尾（思考题之后）追加一个隐藏注释块" in zh and "<!-- mastery: 能够解释核心概念A; 能够应用概念A解决简单问题 -->" in zh
    assert "这个注释放在该小节之后，仍然是全文最后的内容" in zh
    assert "<!-- mastery: Explain the core concept A; Apply concept A to solve a simple problem -->" in en
    assert "put this comment after that section, so it is still the last thing in the document" in en


@pytest.mark.parametrize("lesson,questions", [
    (ZH_NEXT, "1. 新问题一？\n2. 新问题二？"),
    (EN_NEXT_UNANSWERED, "1. New question one?\n2. New question two?"),
])
def test_the_answer_section_at_the_end_is_not_mistaken_for_the_thought_questions(lesson, questions):
    assert courses_module._extract_thought_questions(lesson) == questions
    assert len(language_module.THOUGHT_PRESENT_RE.findall(lesson)) == 1
    for heading in ("## 上一篇思考题参考答案", "## Reference answers to the previous reflection questions"):
        assert not language_module.THOUGHT_SECTION_RE.search(f"{heading}\n\nx\n")
        assert not language_module.THOUGHT_HEADING_ANY_LEVEL_RE.search(heading)


def test_mastery_items_are_still_ticked_when_the_answers_section_comes_before_the_comment(client):
    cid, _ = make_course(client, "zh")

    generate_next(client, cid)

    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    syllabus = client.get(f"/api/courses/{cid}/syllabus").json()["content"]
    assert "- [x] 能够解释核心概念1" in syllabus and "- [x] 能够解释核心概念2" in syllabus
    assert syllabus.count("- [x]") == 2
    course = client.get(f"/api/courses/{cid}").json()
    assert (course["mastery_covered"], course["mastery_total"]) == (2, 8)


def test_the_questions_of_a_lesson_with_an_answers_section_reach_the_following_prompt_cleanly(client):
    cid, _ = make_course(client, "zh")
    generate_next(client, cid)  # 第 2 篇：思考题 + 末尾参考答案 + mastery 注释

    system = generate_next(client, cid).calls[0]["system"]

    questions = system.split("复盘必须严格对应它）\n", 1)[1].split("## 上一篇的篇幅", 1)[0]
    assert questions.strip() == "1. 新问题一？\n2. 新问题二？"
    assert "旧答案一" not in questions and "mastery" not in questions


# ---------------------------------------------------------------------------
# B4：划线回答很短
# ---------------------------------------------------------------------------

def test_the_highlight_answer_prompts_ask_for_a_one_or_two_sentence_answer_first():
    zh, en = courses_module.ANNOTATION_ANSWER_PROMPT, prompts_en.ANNOTATION_ANSWER_PROMPT

    assert "先用 1-2 句大白话直接回答问题" in zh and "约 150 个汉字以内" in zh
    assert "追问，或明确要求详细、展开、举例、推导时，才展开讲" in zh
    assert "2-5 段" not in zh
    assert "First answer the question directly in 1-2 plain-language sentences" in en
    assert "about 120 words by default" in en and "2-5 paragraphs" not in en
    assert "expand only when the student asks a follow-up, or explicitly asks for detail" in en


def test_the_short_answer_rule_is_what_the_model_gets_for_a_question_and_for_a_follow_up(client):
    cid, _ = make_course(client, "zh")
    with fake_model(lambda system, user: "左乘就是先作用。") as model:
        res = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 4, "original_text": "特征值", "comment": "左乘是什么意思？",
        })
    assert res.status_code == 200, res.text
    annotation = next(e for e in sse_events(res) if e.get("done"))["annotation"]
    assert model.calls[0]["system"].startswith(courses_module.ANNOTATION_ANSWER_PROMPT)

    with fake_model(lambda system, user: "好的，展开说。") as follow_up:
        res = client.post(
            f"/api/courses/{cid}/lessons/1/annotations/{annotation['id']}/messages", json={"content": "能详细讲讲吗？"},
        )
    assert res.status_code == 200 and "error" not in res.text
    assert follow_up.calls[0]["system"].startswith(courses_module.ANNOTATION_ANSWER_PROMPT)
    assert follow_up.calls[0]["messages"][-1]["content"] == "能详细讲讲吗？"


# ---------------------------------------------------------------------------
# B5：投资 / 医疗 / 法律提示
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["first_lesson", "next_lesson", "source_lesson"])
def test_the_chinese_lesson_prompts_ask_for_the_learning_only_notice(name):
    prompt = getattr(courses_module.PROMPTS["zh"], name)

    assert "**投资 / 医疗 / 法律提示**" in prompt
    for sentence in ("仅供学习，不构成投资建议。", "仅供学习，不构成医疗建议。", "仅供学习，不构成法律建议。", "仅供学习，不构成投资、医疗或法律建议。"):
        assert sentence in prompt
    assert "在「## 正文内容」的末尾、「## 思考题」之前，单独写一行提示" in prompt
    # 默认不写，先判断课题；产品管理、系统思考这类课一个字都不加
    assert "默认不写。先判断这门课的课题本身属于哪一类" in prompt
    assert "产品管理、系统思考、职场技能、编程、数学、设计、语言、历史、科学等其他课题，一个字都不要加" in prompt
    assert "也不要任何形式的免责声明、「仅供学习」或「学习提示」；拿不准就不加" in prompt
    assert "课文里偶尔举了金融、医疗或法律的例子，不等于课题属于这一类" in prompt


@pytest.mark.parametrize("name", ["first_lesson", "next_lesson", "source_lesson"])
def test_the_english_lesson_prompts_ask_for_the_learning_only_notice(name):
    prompt = getattr(courses_module.PROMPTS["en"], name)

    assert "**Investing / medical / legal notice**" in prompt
    for sentence in (
        "For learning only; this is not investment advice.", "For learning only; this is not medical advice.",
        "For learning only; this is not legal advice.", "For learning only; this is not investment, medical or legal advice.",
    ):
        assert sentence in prompt
    assert "before the reflection questions" in prompt
    assert "do not write one by default. First decide what the subject of this course itself is" in prompt
    assert "Courses on product management, systems thinking, workplace skills, programming, mathematics, design, languages, history, science or any other subject get no such line" in prompt
    assert 'no disclaimer, "for learning only" or "learning note" of any kind; when in doubt, leave it out' in prompt
    assert "An example from finance, medicine or law inside a lesson does not make the subject of the course one of those" in prompt


def test_the_grounded_lesson_review_keeps_an_existing_notice_and_never_adds_one():
    assert "原样保留；初稿里没有，就绝不要新增任何免责声明或提示行" in courses_module.GROUNDED_LESSON_REVIEW_PROMPT
    assert "keep it as it is; if the draft has none, never add any disclaimer or notice line" in prompts_en.GROUNDED_LESSON_REVIEW_PROMPT


# ---------------------------------------------------------------------------
# 兜底：英文提示词没有汉字；两种语言的片段占位符一致
# ---------------------------------------------------------------------------

def test_english_fragments_and_prompts_contain_no_chinese():
    for where, text in all_prompt_texts().items():
        if where.startswith("en."):
            assert not CJK.search(text), where


def test_the_model_input_never_contains_an_unfilled_placeholder(client):
    placeholders = (
        "{depth_rules}", "{source_rules}", "{reference_section}", "{review_section}", "{annotation_section}", "{answers_section}",
    )
    for language in ("zh", "en"):
        name = "Eigenvalues" if language == "en" else "线性代数"
        _, created = make_course(client, language, name=name)
        cid, _ = make_course(client, language, name=name)
        for model in (created, generate_next(client, cid, language) if language == "zh" else next_lesson(client, cid)):
            for call in model.calls:
                for text in (call["system"], call["user"]):
                    assert not any(placeholder in text for placeholder in placeholders)


# ---------------------------------------------------------------------------
# 原文课的说法、大纲规则、英文语言行、评估篇模板、抽题防御
# ---------------------------------------------------------------------------

def make_source_course(client, language, legacy=False):
    """已有的原文课（「我的资料」入口已下线，库里还有）：原文是参考材料（第 -1 篇），默认再 POST /first 生成第 01 篇教学课文。

    legacy=True 造一门旧数据形状的原文课：原文阅读篇占第 1 篇、还没有教学课文。生成下一篇时这类课仍走原文课提示词
    （source_first 兼容路径），用来覆盖那条路径。
    """
    cid = seed_source_course(
        client, "notes.md", "# Notes\n\nInterest earns interest.", name="Notes" if language == "en" else "原文课",
        syllabus=syllabus_text() if language == "en" else zh_syllabus(), learning_depth="simple", language=language,
    )["id"]
    if not legacy:
        with fake_model(responder_for(language)):
            start_first_lesson(client, cid)
    if legacy:
        make_legacy_source_course(cid, language)
    return cid


def tick_everything(cid):
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()


@pytest.mark.parametrize("language,marker,wrong,right", [
    ("zh", "## 课文依据（必须遵守）", "这门课没有任何参考资料", "围绕学生自己上传的原文展开"),
    ("en", "## Where the lesson comes from (mandatory)", "This course has no reference material", "built around source material the student uploaded"),
])
def test_a_source_course_lesson_from_the_third_on_is_not_told_there_is_no_material(client, language, marker, wrong, right):
    cid = make_source_course(client, language)  # 原文是参考材料，第 01 篇已由 /first 生成
    run = (lambda: generate_next(client, cid, language)) if language == "zh" else (lambda: next_lesson(client, cid))
    run()  # 第 2 篇

    system = run().calls[0]["system"]  # 第 3 篇：走下一篇的提示词，没有知识包

    assert marker in system and right in system and wrong not in system
    assert "## 没有参考资料" not in system and "## No reference material" not in system
    assert ("「资料指出」" if language == "zh" else '"Source: ..."') in system  # 仍然明确禁止这些标注


@pytest.mark.parametrize("language", ["zh", "en"])
def test_the_assessment_of_a_source_course_gets_the_same_accurate_wording(client, language):
    cid = make_source_course(client, language)
    (generate_next(client, cid, language) if language == "zh" else next_lesson(client, cid))  # 第 2 篇
    tick_everything(cid)
    lesson = "<!-- eval-article -->\n\n# Final"

    model = generate_next(client, cid, language, lesson_text=lesson) if language == "zh" else next_lesson(client, cid, lambda s, u: lesson)

    system = model.calls[0]["system"]
    assert ("大纲中所有掌握项已经全部覆盖完毕" if language == "zh" else "Every mastery item in the outline has now been covered") in system
    assert ("## 课文依据（必须遵守）" if language == "zh" else "## Where the lesson comes from (mandatory)") in system
    assert "没有任何参考资料" not in system and "has no reference material" not in system


def test_a_topic_course_still_says_there_is_no_reference_material_and_a_course_with_a_pack_says_neither(client):
    cid, _ = make_course(client, "zh")
    assert "这门课没有任何参考资料" in generate_next(client, cid).calls[0]["system"]
    cid2, _ = make_course(client, "zh", reference="概念甲是核心。")
    with_pack = generate_next(client, cid2).calls[0]["system"]
    assert "没有任何参考资料" not in with_pack and "围绕学生自己上传的原文" not in with_pack


def test_the_outline_rules_about_material_follow_whether_there_is_material():
    none = courses_module._build_syllabus_prompt("simple", "zh", has_reference=False)
    pack = courses_module._build_syllabus_prompt("simple", "zh")
    source = courses_module._build_syllabus_prompt("simple", "zh", source_course=True)

    assert "## 没有参考资料（必须遵守）" in none and "## 资料规则" in pack and "## 原文规则" in source
    for phrase in ("「课程参考知识包」", "（来源：文件名，页码/章节）", "基于材料进行", "参考知识包中明确出现"):
        assert phrase not in none and phrase not in source
        assert phrase in pack
    assert "基于原文进行" in source and "掌握项末尾不写来源括注" in source
    assert "7. 输出前自检逻辑一致性" in none  # 与材料无关的那条自检所有课都有

    en_none = courses_module._build_syllabus_prompt("simple", "en", has_reference=False)
    en_pack = courses_module._build_syllabus_prompt("simple", "en")
    en_source = courses_module._build_syllabus_prompt("simple", "en", source_course=True)
    assert "## No reference material (mandatory)" in en_none and "## Source rules (the user message has" in en_pack
    assert "## Source rules (the user uploaded source material" in en_source
    for text in (en_none, en_source):
        assert "Only when the user message contains" not in text and "reference pack is in another language" not in text
        assert not CJK.search(text)
    assert "Even if the topic is in another language" in en_none
    assert "Even if the reference pack is in another language, the outline stays in English" in en_pack
    assert "Even if the source is in another language, the outline stays in English" in en_source


def test_the_outline_sent_for_each_kind_of_course_uses_its_own_rules(client):
    _, topic = make_course(client, "zh")
    _, with_reference = make_course(client, "zh", reference="概念甲是核心。")
    # 原文课已经不能新建了；库里已有的原文课改大纲时仍按原文规则出大纲
    cid = seed_source_course(client, "a.md", "# A\n\nbody", name="x", syllabus=zh_syllabus(), learning_depth="simple")["id"]
    with fake_model(responder_for("zh")) as source:
        assert client.post(f"/api/courses/{cid}/syllabus/regenerate", json={"content": "更简单"}).status_code == 200

    assert "## 没有参考资料" in topic.calls[0]["system"]
    assert "## 资料规则" in with_reference.calls[0]["system"]
    assert "## 原文规则" in source.calls[0]["system"]


def test_the_english_lesson_prompts_only_talk_about_a_reference_pack_language_when_there_is_one(client):
    _, none = make_course(client, "en", name="Eigenvalues")
    _, pack = make_course(client, "en", name="Eigenvalues", reference="Concept A is the core.")

    assert "Even if the reference pack" not in none.calls[1]["system"]
    assert "Even if the topic is given in another language, the lesson stays in English" in none.calls[1]["system"]
    assert "7. Even if the reference pack is in another language, the lesson stays in English" in pack.calls[1]["system"]
    cid, _ = make_course(client, "en", name="Eigenvalues")
    next_none = next_lesson(client, cid).calls[0]["system"]
    assert "reference pack or the earlier lessons" not in next_none and "Even if the earlier lessons contain another language" in next_none


def test_the_assessment_template_has_no_purpose_line_that_the_same_prompt_forbids():
    assert "作用：" not in courses_module.EVAL_LESSON_PROMPT
    assert "Purpose:" not in prompts_en.EVAL_LESSON_PROMPT
    assert "> 本篇为课程评估篇，不含新内容。" in courses_module.EVAL_LESSON_PROMPT
    assert "> This lesson is the course assessment and contains no new material." in prompts_en.EVAL_LESSON_PROMPT


QUESTIONS = "1. 新问题一？\n2. 新问题二？"


@pytest.mark.parametrize("tail", [
    "## 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 旧答案一\n",
    "### 上一篇思考题参考答案\n\n**第1题：** 旧题一\n> 旧答案一\n",
    "#### 参考答案\n\n旧答案一\n",
    "**第1题：** 旧题一\n> 旧答案一\n\n**第2题：** 旧题二\n> 旧答案二\n",
    "参考答案：\n旧答案一\n",
    "**上一篇思考题参考答案**\n\n旧答案一\n",
], ids=["h2", "h3", "h4", "no heading + blockquote answers", "plain label", "bold label"])
def test_old_answers_after_the_questions_never_become_the_next_questions_in_chinese(tail):
    lesson = f"# 第二课\n\n## 正文内容\n\n新内容\n\n## 思考题\n\n{QUESTIONS}\n\n{tail}\n<!-- mastery: 能够解释甲 -->"

    assert courses_module._extract_thought_questions(lesson) == QUESTIONS


@pytest.mark.parametrize("tail", [
    "## Reference answers to the previous reflection questions\n\n**Question 1:** Old one\n> Old answer one\n",
    "### Reference answers to the previous reflection questions\n\n**Question 1:** Old one\n> Old answer one\n",
    "###### Correct answers\n\nOld answer one\n",
    "**Question 1:** Old one\n> Old answer one\n\n**Question 2:** Old two\n> Old answer two\n",
    "Reference answers:\nOld answer one\n",
], ids=["h2", "h3", "h6", "no heading + blockquote answers", "plain label"])
def test_old_answers_after_the_questions_never_become_the_next_questions_in_english(tail):
    lesson = f"# Lesson 2\n\n## Main content\n\nNew material\n\n## Reflection questions\n\n1. New one?\n2. New two?\n\n{tail}\n<!-- mastery: Explain A -->"

    assert courses_module._extract_thought_questions(lesson) == "1. New one?\n2. New two?"


def test_labelled_questions_without_blockquote_answers_are_still_questions():
    zh = "# 课\n\n## 思考题\n\n**第1题：** 为什么？\n**第2题：** 如何？\n"
    en = "# Lesson\n\n## Reflection questions\n\n**Question 1:** Why?\n**Question 2:** How?\n"

    assert courses_module._extract_thought_questions(zh) == "**第1题：** 为什么？\n**第2题：** 如何？"
    assert courses_module._extract_thought_questions(en) == "**Question 1:** Why?\n**Question 2:** How?"
    assert courses_module._extract_thought_questions("# 课\n\n## 思考题\n\n1. 请写出参考答案的第一步？\n2. 为什么？") == \
        "1. 请写出参考答案的第一步？\n2. 为什么？"


def test_the_following_prompt_gets_clean_questions_even_when_the_answers_were_an_h3(client):
    cid, _ = make_course(client, "zh")
    generate_next(client, cid, lesson_text=ZH_NEXT.replace("## 上一篇思考题参考答案", "### 上一篇思考题参考答案"))

    system = generate_next(client, cid).calls[0]["system"]

    questions = system.split("复盘必须严格对应它）\n", 1)[1].split("## 上一篇的篇幅", 1)[0]
    assert questions.strip() == QUESTIONS and "旧答案" not in questions


def test_english_mastery_items_are_ticked_when_the_answers_section_precedes_the_comment(client):
    cid, _ = make_course(client, "en", name="Eigenvalues")

    next_lesson(client, cid, lambda system, user: EN_NEXT_UNANSWERED)

    client.post(f"/api/courses/{cid}/lessons/2/feedback", json={"content": "读完了", "thought_answers": ""})
    syllabus = client.get(f"/api/courses/{cid}/syllabus").json()["content"]
    assert "- [x] Explain core concept 1 (Source: concepts.md, Core concepts)" in syllabus and syllabus.count("- [x]") == 1
    course = client.get(f"/api/courses/{cid}").json()
    assert (course["mastery_covered"], course["mastery_total"]) == (1, 8)
    system = next_lesson(client, cid).calls[0]["system"]
    questions = system.split("must correspond to them strictly)\n", 1)[1].split("## Length of the previous lesson", 1)[0]
    assert questions.strip() == "1. New question one?\n2. New question two?" and "Old answer" not in questions


# ---------------------------------------------------------------------------
# 抽题第三分支收窄——真题后面的 `> 提示：…` 不再被当成答案
# ---------------------------------------------------------------------------

def zh_section(body):
    return f"# 课\n\n## 思考题\n\n{body}\n\n<!-- mastery: 能够解释甲 -->"


def en_section(body):
    return f"# Lesson\n\n## Reflection questions\n\n{body}\n\n<!-- mastery: Explain A -->"


@pytest.mark.parametrize("body", [
    "**第1题：** 为什么？\n> 提示：想想行列式。\n\n**第2题：** 如何？\n> 提示：先画图。",
    "**第1题：** 为什么？\n> 提示：答案是一个数，别忘了单位。\n**第2题：** 如何？",
    "**第1题：** 阅读下面的材料。\n> 材料：f(x) 的解析式为 x²，定义域为 R。\n> 求它的最小值？",
    "**第1题：** 为什么？\n> **思路**：从定义出发。\n**第2题：** 如何？\n> 注：本题不需要计算器。",
    "1. 参考答案的第一步是什么？\n2. 如何？",
    "参考答案的第一步是什么？\n如何验证？",
    "参考答案：请你自己先写一遍，再说明理由？\n如何验证？",
    "**第1题：** 为什么？\n**第2题：** 如何？\n\n参考答案：",
], ids=["hints", "hint with the word answer", "stem quote with 解析式", "bold hint and note", "numbered mention",
        "unnumbered question mention", "label that is a question", "label with nothing after"])
def test_real_questions_are_never_mistaken_for_old_answers_in_chinese(body):
    assert courses_module._extract_thought_questions(zh_section(body)) == body.strip()


@pytest.mark.parametrize("body", [
    "**Question 1:** Why?\n> Hint: the answer is a number.\n\n**Question 2:** How?\n> Note: no calculator needed.",
    "**Question 1:** Read the passage.\n> Passage: the analytic form of f is x squared.\n> What is its minimum?",
    "1. Reference answers to this problem are unknown. Can you guess one?\n2. How?",
    "Reference answers to this are open — what would you write?\nHow would you check?",
    "**Question 1:** Why?\n**Question 2:** How?\n\nReference answers:",
], ids=["hints", "stem quote", "numbered mention", "label inside a question", "label with nothing after"])
def test_real_questions_are_never_mistaken_for_old_answers_in_english(body):
    assert courses_module._extract_thought_questions(en_section(body)) == body.strip()


@pytest.mark.parametrize("answer", [
    "**第1题：** 旧题一\n> 答案：旧答案一",
    "**第1题：** 旧题一\n> **答案**：旧答案一",
    "**第1题：** 旧题一\n> 参考答案：旧答案一",
    "**第1题：** 旧题一\n> 解析：旧解析一",
    "**第1题：** 旧题一\n\n> 这题的正确答案是旧答案一",
    "参考答案：\n旧答案一",
    "**参考答案**\n\n旧答案一",
    "参考答案：旧答案一",
], ids=["quote label", "bold quote label", "reference label", "解析 label", "blank line then quote", "standalone label",
        "bold standalone label", "inline label"])
def test_old_answers_are_still_cut_in_chinese(answer):
    body = f"1. 新问题一？\n2. 新问题二？\n\n{answer}"

    assert courses_module._extract_thought_questions(zh_section(body)) == "1. 新问题一？\n2. 新问题二？"


@pytest.mark.parametrize("answer", [
    "**Question 1:** Old one\n> Answer: old answer one",
    "**Question 1:** Old one\n> **Answer:** old answer one",
    "**Question 1:** Old one\n> Reference answer: old answer one",
    "**Question 1:** Old one\n> The correct answer is old answer one",
    "Reference answers:\nOld answer one",
    "**Reference answers**\n\nOld answer one",
    "Reference answers: old answer one",
], ids=["quote label", "bold quote label", "reference label", "mid-quote marker", "standalone label", "bold standalone label",
        "inline label"])
def test_old_answers_are_still_cut_in_english(answer):
    body = f"1. New one?\n2. New two?\n\n{answer}"

    assert courses_module._extract_thought_questions(en_section(body)) == "1. New one?\n2. New two?"


def test_a_heading_still_wins_when_it_comes_before_a_labelled_hint():
    body = "1. 新问题一？\n\n### 参考答案\n\n**第1题：** 旧题\n> 提示：旧提示"

    assert courses_module._extract_thought_questions(zh_section(body)) == "1. 新问题一？"


# ---- 提示类引用块可以带 emoji 前缀，豁免词补上「注」「想一想」「Think」 ----

@pytest.mark.parametrize("hint", [
    "> 💡 提示：答案在第二段。",
    "> **💡 提示**：答案在第二段。",
    "> 📝 注：答案是一个数。",
    "> 注：答案是一个数。",
    "> 注意：答案是一个数。",
    "> 想一想：答案在哪里？",
    "> 🤔 想想看，答案和什么有关？",
    "> （提示）答案是一个数。",
    "> 【思路】答案是一个数。",
])
def test_chinese_hint_quotes_keep_the_question_even_with_a_prefix_or_the_word_answer(hint):
    body = f"**第1题：** 为什么？\n{hint}\n**第2题：** 如何？\n{hint}"

    assert courses_module._extract_thought_questions(zh_section(body)) == body


@pytest.mark.parametrize("hint", [
    "> 💡 Hint: the answer is a number.",
    "> **Hint**: the answer is a number.",
    "> 🤔 Think about the answer first.",
    "> Think: what is the answer?",
    "> 📝 Note: the answer is a number.",
    "> Tip: the answer is a number.",
])
def test_english_hint_quotes_keep_the_question_even_with_a_prefix_or_the_word_answer(hint):
    body = f"**Question 1:** Why?\n{hint}\n**Question 2:** How?\n{hint}"

    assert courses_module._extract_thought_questions(en_section(body)) == body


def test_an_emoji_prefix_does_not_hide_a_real_answer_quote():
    zh = "1. 新问题？\n\n**第1题：** 旧题\n> 📝 答案：旧答案"
    en = "1. New?\n\n**Question 1:** Old\n> ✅ Answer: old answer"

    assert courses_module._extract_thought_questions(zh_section(zh)) == "1. 新问题？"
    assert courses_module._extract_thought_questions(en_section(en)) == "1. New?"
