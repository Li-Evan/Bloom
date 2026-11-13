"""几个测试文件共用的固定数据和小工具：假模型的输出、按流式接口跑一次请求、数一数各张内容表的行数。"""
import json
from typing import Callable, NamedTuple
from unittest.mock import MagicMock, patch

import pytest

import app.courses as courses_module
from app.models import Annotation, Course, Feedback, LearningEvent, LearningRecommendation, Lesson, Syllabus
from tests.conftest import TestSession, seed_course

SYLLABUS = "# 课程 · 课程大纲\n\n## 核心掌握项\n\n### 模块一\n- [ ] 能够解释概念"
# 种子批注问的是「这是什么？」：同一选区、同一问题会被当成用户停止时存下的那一条（_interrupted_twin）合并，所以这里换一个问题
ANNOTATION = {"position_start": 0, "position_end": 2, "original_text": "正文", "comment": "这段话想说明什么？", "request_id": "helpers-ask-1"}

PACK = """# 课程参考知识包
## 资料目录
part0.md、part1.md、part2.md
## 核心问题与总论点
核心问题（来源：part0.md，章节 0）
## 概念与定义
概念
## 论证与机制
机制
## 例子、证据与应用
例子
## 边界、反例、争议与限制
边界
## 前置知识与建议教学顺序
顺序
## 来源索引
part0.md：章节 0；part1.md：章节 1；part2.md：章节 2。这里保留足够完整的来源定位内容，用于验证知识包不是被模型截断的半成品，并供后续课程回查原文。
"""
GROUNDED_SYLLABUS = (
    "# 资料课 · 课程大纲\n\n## 核心掌握项\n\n### 主线\n"
    + "\n".join(f"- [ ] 能够解释资料概念 {i}（来源：part0.md，章节 0）" for i in range(1, 11))
    + "\n\n## 不在本课题范围内\n\n- 外部内容\n\n## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|------|-----------|---------|\n"
)
GROUNDED_LESSON = """# 第一课

## 正文内容

资料指出核心概念与案例有关（来源：part0.md，章节 0）（来源：part1.md，章节 1）

## 思考题

1. 如何解释核心概念？
2. 如何把它用于案例？

## 你的反馈

> 写下反馈。
"""


def materials_llm(system_prompt, user_message, **_kwargs):
    if system_prompt == courses_module.MATERIAL_CHUNK_PROMPT:
        return "分块笔记（来源：part0.md，章节 0）"
    if system_prompt == courses_module.MATERIAL_SYNTHESIS_PROMPT:
        return PACK
    # 大纲校对的提示词末尾接上课程设计的保留规则（course_planning.REVIEW_RULE），所以按开头认
    if "课程大纲设计专家" in system_prompt or system_prompt.startswith(courses_module.GROUNDED_SYLLABUS_REVIEW_PROMPT):
        return GROUNDED_SYLLABUS
    return GROUNDED_LESSON


def mark_last_lesson_as_evaluation(course_id):
    with TestSession() as db:
        db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == 0).delete()
        db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == 1).update({"is_evaluation": True})
        db.commit()


class Endpoint(NamedTuple):
    """一个流式调模型的接口：target 是要替换的模型调用，outputs 是假模型依次流出的分片。"""
    target: str
    outputs: list
    path: str
    body: dict | None = None
    prepare: Callable = lambda course_id: None


STREAMING = {
    "next_lesson": Endpoint("app.courses._stream_llm", ["# 第二章\n\n", "新内容"], "/api/courses/{c}/next"),
    "summary": Endpoint(
        "app.courses._stream_llm", ["# 学习总结\n\n", "知识图谱"], "/api/courses/{c}/next", prepare=mark_last_lesson_as_evaluation,
    ),
    "annotation": Endpoint(
        "app.courses._stream_llm_messages", ["这段话的", "意思是……"], "/api/courses/{c}/lessons/1/annotations", body=ANNOTATION,
    ),
    "annotation_followup": Endpoint(
        "app.courses._stream_llm_messages", ["追问的", "回答"], "/api/courses/{c}/lessons/1/annotations/{a}/messages",
        body={"content": "追问", "request_id": "helpers-followup-1"},
    ),
}


@pytest.fixture(autouse=True)
def small_material_chunks(monkeypatch):
    """三份 440 字的资料切成三块（资料课时限的测试按三块数模型调用）。"""
    monkeypatch.setattr(courses_module, "MATERIAL_CHUNK_TARGET_CHARS", 500)


def content_rows():
    with TestSession() as db:
        return {
            model.__name__: db.query(model).count()
            for model in (Course, Syllabus, Lesson, Annotation, Feedback, LearningEvent, LearningRecommendation)
        }


def provider(case):
    def stream(*_args, **_kwargs):
        for chunk in case.outputs:
            yield chunk, False
        yield "".join(case.outputs), True
    return MagicMock(side_effect=stream)


def run(case, client, user, llm):
    course_id, annotation_id = seed_course(user.uuid)
    case.prepare(course_id)
    before = content_rows()
    with patch(case.target, llm):
        res = client.post(case.path.format(c=course_id, a=annotation_id), json=case.body)
    return res, before, (course_id, annotation_id)


def stream_error(res):
    events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]
    return next(event["error"] for event in events if "error" in event)
