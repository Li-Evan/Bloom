import logging
import json
import io
import re
from datetime import date, timedelta, timezone, datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session
from openai import OpenAI
from pypdf import PdfReader

from app.config import settings
from app.database import get_db
from app.models import Course, Syllabus, Lesson, Annotation, Feedback, LearningEvent
from app.schemas import (
    CreateCourseRequest, CourseResponse, CourseDetailResponse, CreateSourceCourseResponse,
    SyllabusResponse, SyllabusUpdateRequest,
    LessonListItem, LessonResponse,
    CreateAnnotationRequest, AnnotationResponse, AddAnnotationMessageRequest, SaveInterruptedRequest,
    CreateFeedbackRequest, FeedbackResponse,
    CourseStatsResponse, GlobalStatsResponse,
    CalendarResponse, CalendarDay, CalendarCourseActivity,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["courses"])

LEARNING_DEPTH_PROFILES = {
    "simple": {
        "label": "简单",
        "modules": "2-3 个模块",
        "items": "8-10 条掌握项",
        "focus": "只保留课题主干、最低必要概念和高频应用场景；避免历史脉络、复杂证明、分支争议和高级扩展。",
    },
    "standard": {
        "label": "标准",
        "modules": "3-4 个模块",
        "items": "10-12 条掌握项",
        "focus": "覆盖核心概念、关键推理、典型应用和常见误区；在体系完整和认知负荷之间保持平衡。",
    },
    "deep": {
        "label": "深入",
        "modules": "4-5 个模块",
        "items": "12-15 条掌握项",
        "focus": "从第一性原理展开，加入底层机制、边界条件、反例、跨场景迁移和批判性判断。",
    },
}


def _learning_depth_profile(learning_depth: str) -> dict[str, str]:
    if learning_depth not in LEARNING_DEPTH_PROFILES:
        raise HTTPException(status_code=400, detail="学习深度必须是 simple、standard 或 deep")
    return LEARNING_DEPTH_PROFILES[learning_depth]


def _build_syllabus_prompt(learning_depth: str) -> str:
    profile = _learning_depth_profile(learning_depth)
    depth_section = f"""- 学习深度：{profile['label']}
- 模块数量：{profile['modules']}
- 掌握项数量：{profile['items']}
- 展开策略：{profile['focus']}"""
    return SYLLABUS_PROMPT.format(learning_depth_section=depth_section)


# ---------------------------------------------------------------------------
# AI System Prompts
# ---------------------------------------------------------------------------

SYLLABUS_PROMPT = """你是一个课程大纲设计专家。根据用户给出的课题名称，生成一份结构化的课程大纲。

## 学习深度（必须遵守）
{learning_depth_section}

## 输出格式（严格遵守，不要加额外说明）

```markdown
# [课题名] · 课程大纲

> 这份大纲定义了完成本课题后你将掌握的所有能力。
> 学习深度：[简单 / 标准 / 深入]
> 文档数量因人而异，但掌握内容不打折扣。

## 核心掌握项

完成本课题后，你将能够：

### [模块一名称]
- [ ] [具体能力描述，用"能够……"句式，可验证]
- [ ] [具体能力描述]

### [模块二名称]
- [ ] [具体能力描述]
- [ ] [具体能力描述]

## 不在本课题范围内

- [明确列出哪些相关主题本课不涵盖]

## 学习进度

| 文档 | 覆盖掌握项 | 生成日期 |
|------|-----------|---------|
```

## 规则
1. 所有掌握项必须是**可验证的行为**（能解释、能推导、能应用、能判断），禁止写"了解 X""熟悉 Y"
2. 模块数量必须服从上方学习深度要求，同时按知识的内在逻辑分组
3. 总条目数必须服从上方学习深度要求，且所有条目必须有实质差异
4. "不在本课题范围内"必须填写
5. 只输出 markdown 内容，不要加任何前缀说明或后缀解释
"""

FIRST_LESSON_PROMPT = """你是一个基于 Bloom 2-Sigma 理论的一对一苏格拉底式导师。

根据以下课程大纲，生成第一篇课文（01）。

## 课程大纲
{syllabus}

## 输出格式（严格遵守）

```markdown
# [章节标题]

> 前置知识：[列出阅读本文需要的前置知识]
> 难度：[入门 / 进阶 / 高级]
> 预计阅读时间：[X 分钟]

## 正文内容

[清晰、有深度、有举例的知识阐述]
[关键概念用 **加粗** 标注]
[重要定义或公式用引用块]

## 思考题

[2-3 个引导用户深入思考的问题，不给答案]

## 你的反馈

> 在这里写下你的问题、感悟、不理解的地方，或者你希望下一篇深入探讨的方向。
```

## 规则
1. 内容要有实质性的知识增量，不要太水
2. 关键概念加粗，重要定义用引用块
3. 思考题要有深度，引导用户思考而不是简单记忆
4. 只输出 markdown 内容
5. **类比优先**：每个抽象概念至少配一个生活化类比
6. **先why后what**：先讲为什么需要学这个，再讲内容
7. **认知负荷控制**：第一课只引入2-3个核心概念，不要铺开太多
8. **深度一致**：第一课的展开力度必须服从大纲中的学习深度；简单重主干，标准重完整，深入重底层机制和边界
"""

SOURCE_LESSON_PROMPT = """你是一个基于 Bloom 2-Sigma 理论的一对一苏格拉底式导师。

学生刚读完一份用户上传的 PDF/TXT/Markdown 原始材料。你需要根据整份原文、学生划线提出的问题、以及你对这些问题的即时回答，生成下一篇学习课文。

## 课程大纲
{syllabus}

## 原始材料文件
{source_filename}

## 原始材料全文
{source_content}

## 学生划线问答记录
{source_annotations}

## 当前课文编号：{lesson_number}

## 输出格式（严格遵守）

```markdown
# [章节标题]

> 前置知识：[列出阅读本文需要的前置知识]
> 难度：[入门 / 进阶 / 高级]
> 预计阅读时间：[X 分钟]

---

## 划线问题复盘

> 本模块综合学生阅读原文时的划线问题，提炼真正的理解缺口。

[先归纳学生问题背后的共性困惑，再纠正关键误解。不要机械重复每条问答。]

---

## 正文内容

[清晰、有深度、有举例的知识阐述。必须从原始材料中抽取关键脉络，而不是泛泛讲课题。]

## 思考题

[2-3 个引导用户深入思考的问题，不给答案]

## 你的反馈

> 在这里写下你的问题、感悟、不理解的地方，或者你希望下一篇深入探讨的方向。

<!-- mastery: 能够...; 能够... -->
```

## 规则
1. 必须把原始材料当作主要教材，而不是只用课题名自由发挥
2. 必须吸收划线问答记录，优先补足学生已经暴露的理解缺口
3. 正文每次只推进 1-2 个核心概念，避免信息过载
4. 隐藏 mastery 注释必须列出本篇覆盖的大纲掌握项原文，且与大纲 checkbox 文本完全一致
5. 只输出 markdown 内容
"""

NEXT_LESSON_PROMPT = """你是一个基于 Bloom 2-Sigma 理论的一对一苏格拉底式导师。

根据学生的反馈和批注，生成下一篇课文。

## 课程大纲
{syllabus}

## 已完成的课文
{previous_lessons}

## 上一篇课文的学生反馈
{feedback}

## 上一篇课文中的学生批注（学生在阅读时选中文字标记的困惑或想法）
{annotations}

## 上一篇的真实思考题（以下是上一篇文末真实列出的思考题原文，复盘必须严格对应它）
{last_questions}

## 当前课文编号：{lesson_number}

## 输出格式（严格遵守）

```markdown
# [章节标题]

> 前置知识：[列出阅读本文需要的前置知识]
> 难度：[入门 / 进阶 / 高级]
> 预计阅读时间：[X 分钟]

---

## 上一篇思考题复盘

> 📝 本模块评估你对上一篇思考题的回答，并给出正确答案。

### 你的回答评估

[逐题评估用户回答：✅对/❌错/⚠️部分正确，简要说明理由]
[如果用户没有作答，注明"未作答"，直接给出正确答案]

### 正确答案

[严格按「上一篇的真实思考题」逐题复盘：上一篇有几题就复盘几题，题号、顺序、题面与原题一致，一题都不能漏，也不要新增或改写成泛化主题。即使学生未作答，也要逐题给出正确答案。格式如下：]

**第1题：** [题目简述（保留原题要点，勿改写成泛化主题）]
> [完整的正确答案和必要的解析]

**第2题：** [题目简述]
> [完整的正确答案和必要的解析]

（……依此类推，直到覆盖「上一篇的真实思考题」中的最后一题）

---

## 批注解答

> 💬 本模块解答学生在上一篇中标记的所有困惑。

[若无批注，写"上一篇中没有批注，直接进入新内容。"]

---

## 正文内容

[清晰、有深度、有举例的知识阐述]

## 思考题

[2-3 个引导用户深入思考的问题，不给答案]

## 你的反馈

> 在这里写下你的问题、感悟、不理解的地方，或者你希望下一篇深入探讨的方向。
```

## 规则

**【最高优先级】「上一篇思考题复盘」必须严格逐题对应前面给出的「上一篇的真实思考题」：上一篇有几题就复盘几题，题号、顺序、题面与原题保持一致，不得遗漏、新增或改写成泛化主题；即使学生未作答也要逐题给出正确答案。**

1. 必须严格按照"思考题复盘 → 批注解答 → 正文新内容"的顺序
2. 基于学生反馈和批注调整内容深度和方向
3. 每篇文档应覆盖大纲中至少一条掌握项
4. 只输出 markdown 内容

## 教学质量要求
5. **类比优先**：每个抽象概念至少配一个生活化类比或具体场景，帮助学生建立直觉
6. **难度自适应**：如果学生反馈中表现出理解困难（多处批注、反馈提问多），降低本篇难度并增加基础铺垫；如果学生表现出游刃有余，适当提升挑战性
7. **认知负荷控制**：正文部分每次只引入1-2个新概念，不要信息过载
8. **先why后what**：先讲为什么需要这个概念（动机/问题），再讲概念本身
9. **思考题层次**：至少一题是应用级（把概念用到新场景），至少一题是分析级（比较、判断、推理）
10. **掌握项标记**：在文档最末尾（反馈区之后）追加一个隐藏注释块，列出本篇覆盖了哪些大纲掌握项的原文（必须与大纲中的文字完全一致），格式如下：
    <!-- mastery: 能够解释核心概念A; 能够应用概念A解决简单问题 -->
"""

ANNOTATION_ANSWER_PROMPT = """你是一个一对一学习导师。学生正在阅读材料，并对划线内容提出了一个即时问题。

## 回答要求
1. 直接回答问题，先把这段话的意思讲清楚，再补必要背景
2. 不要泛泛扩展到整门课，除非这是理解该划线内容所必需
3. 如果学生的问题里有误解，温和但明确地指出
4. 用中文回答，控制在 2-5 段
5. 不要输出 markdown 标题
"""

EVAL_LESSON_PROMPT = """你是一个基于 Bloom 2-Sigma 理论的一对一苏格拉底式导师。

大纲中所有掌握项已经全部覆盖完毕。现在生成评估篇，只需要回答最后一篇的思考题和批注困惑，不包含任何新内容。

## 课程大纲
{syllabus}

## 上一篇课文
{last_lesson}

## 上一篇课文的学生反馈
{feedback}

## 上一篇课文中的学生批注
{annotations}

## 上一篇的真实思考题（以下是上一篇文末真实列出的思考题原文，复盘必须严格逐题对应它）
{last_questions}

## 输出格式（严格遵守，第一行必须是 <!-- eval-article -->）

```markdown
<!-- eval-article -->

# [课题名] · 最终评估

> 本篇为课程评估篇，不含新内容。
> 作用：解答最后一篇的思考题与批注困惑，确认你已完全掌握。

---

## 上一篇思考题复盘

> 📝 本模块评估你对上一篇思考题的回答，并给出正确答案。

### 你的回答评估

[逐题评估，标注 ✅ / ❌ / ⚠️，并简要说明理由]

### 正确答案

[严格按「上一篇的真实思考题」逐题复盘：上一篇有几题就复盘几题，题号、顺序、题面与原题一致，不得遗漏、新增或改写成泛化主题；即使学生未作答也要逐题给出正确答案。格式如下：]

**第1题：** [题目简述]
> [完整答案和解析]

（……依此类推，直到覆盖「上一篇的真实思考题」中的最后一题）

---

## 批注解答

> 💬 本模块解答学生在上一篇中标记的所有困惑。

[若无批注，写"上一篇中没有批注。"]

---

## 你的反馈

> 写下你对这门课的最终感想、仍有疑问的地方，或希望延伸的方向。
> 当你读完本篇后，告诉我"我读完了"，系统将自动为你生成完整的总结。
```
"""

SUMMARY_PROMPT = """你是一个课程总结专家。根据课程的完整学习过程，生成一份结构化的学习总结。

## 课程大纲
{syllabus}

## 所有课文内容
{all_lessons}

## 输出格式

```markdown
# [课题名] · 学习总结

## 知识图谱

[核心概念及其关系，用层级列表表达]

## 大纲复盘

[逐条回顾每条掌握项的达成情况]

## 关键洞察

[学习过程中最重要的发现和理解]

## 延伸方向

[值得继续探索的方向]
```

只输出 markdown 内容。
"""


# ---------------------------------------------------------------------------
# LLM Helpers
# ---------------------------------------------------------------------------

def get_openai_client() -> OpenAI:
    return OpenAI(api_key=settings.LLM_API_KEY, base_url=settings.LLM_BASE_URL)


_FENCE_RE = re.compile(r'^```(?:markdown|md)?\s*\n?', re.IGNORECASE)
_FENCE_END_RE = re.compile(r'\n?```\s*$')


def _strip_markdown_fences(text: str) -> str:
    """Strip wrapping ```markdown ... ``` fences that LLMs often add."""
    text = text.strip()
    if _FENCE_RE.match(text):
        text = _FENCE_RE.sub('', text, count=1)
        text = _FENCE_END_RE.sub('', text)
    return text.strip()


def _extract_thought_questions(content: str) -> str:
    """从课文 markdown 中抽取 `## 思考题` 区块的全文（截止到下一个二级标题或文末）。

    思考题通常位于课文末尾，单独抽取后作为独立字段传给模型，避免被正文截断丢失，
    确保下一篇能逐题复盘真实思考题（issue #3）。
    """
    if not content:
        return ""
    m = re.search(r'^##\s*思考题\s*$\n(.*?)(?=^##\s|\Z)', content, re.DOTALL | re.MULTILINE)
    return m.group(1).strip() if m else ""


def _stream_llm(system_prompt: str, user_message: str):
    """Generator that yields SSE chunks from LLM streaming."""
    client = get_openai_client()
    stream = client.chat.completions.create(
        model=settings.LLM_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        stream=True,
    )
    full_response = ""
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            content = chunk.choices[0].delta.content
            full_response += content
            yield content, False
    yield full_response, True  # final yield with complete text


def _call_llm(system_prompt: str, user_message: str) -> str:
    """Non-streaming LLM call, returns full response."""
    client = get_openai_client()
    response = client.chat.completions.create(
        model=settings.LLM_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
    )
    return response.choices[0].message.content


def _call_llm_messages(system_prompt: str, history: list[dict]) -> str:
    """Non-streaming LLM call with a multi-turn conversation history."""
    client = get_openai_client()
    response = client.chat.completions.create(
        model=settings.LLM_MODEL,
        messages=[{"role": "system", "content": system_prompt}, *history],
    )
    return response.choices[0].message.content


def _stream_llm_messages(system_prompt: str, history: list[dict]):
    """Streaming multi-turn LLM call. Yields (chunk, False) then (full_text, True)."""
    client = get_openai_client()
    stream = client.chat.completions.create(
        model=settings.LLM_MODEL,
        messages=[{"role": "system", "content": system_prompt}, *history],
        stream=True,
    )
    full_response = ""
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            content = chunk.choices[0].delta.content
            full_response += content
            yield content, False
    yield full_response, True


def _extract_pdf_text(raw: bytes) -> str:
    reader = PdfReader(io.BytesIO(raw))
    return "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()


async def _extract_upload_text(file: UploadFile) -> tuple[str, str]:
    """Return (filename, extracted text) for a PDF, TXT, or Markdown upload."""
    filename = file.filename or "uploaded-source"
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    raw = await file.read()

    if suffix in ("txt", "md", "markdown"):
        for encoding in ("utf-8", "utf-8-sig", "gb18030"):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise HTTPException(status_code=400, detail="文本文件编码无法识别，请转为 UTF-8 后重试")
    elif suffix == "pdf":
        try:
            text = _extract_pdf_text(raw)
        except Exception:
            raise HTTPException(status_code=400, detail="PDF 解析失败，请确认文件未加密且包含可提取文本")
    else:
        raise HTTPException(status_code=400, detail="仅支持上传 PDF、TXT 或 MD 文件")

    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="文件中没有提取到可阅读文本")
    return filename, text


_CODE_LANGS = {
    "py": "python", "js": "javascript", "jsx": "jsx", "ts": "typescript", "tsx": "tsx",
    "java": "java", "c": "c", "h": "c", "cpp": "cpp", "cc": "cpp", "hpp": "cpp",
    "cs": "csharp", "go": "go", "rs": "rust", "rb": "ruby", "php": "php", "swift": "swift",
    "kt": "kotlin", "scala": "scala", "sh": "bash", "bash": "bash", "zsh": "bash",
    "sql": "sql", "html": "html", "css": "css", "scss": "scss", "vue": "vue",
    "json": "json", "yaml": "yaml", "yml": "yaml", "toml": "toml", "xml": "xml",
    "r": "r", "lua": "lua", "dart": "dart", "ex": "elixir", "clj": "clojure",
}


def _source_lesson_content(filename: str, source_text: str) -> str:
    return f"""# 原始材料：{filename}

> 前置知识：无
> 难度：按原始材料而定
> 预计阅读时间：按原文长度而定

## 原文

{source_text}

## 你的反馈

> 阅读时可以直接选中文字提问。读完后点击“我读完了”，系统会结合全文和划线问答生成下一篇。
"""


def _load_messages(annotation: Annotation) -> list[dict]:
    """Parse stored message thread; fall back to comment/answer for old rows."""
    if annotation.messages:
        try:
            data = json.loads(annotation.messages)
            if isinstance(data, list) and data:
                return data
        except (ValueError, TypeError):
            pass
    history = [{"role": "user", "content": annotation.comment}]
    if annotation.answer:
        history.append({"role": "assistant", "content": annotation.answer})
    return history


def _annotation_to_response(annotation: Annotation) -> AnnotationResponse:
    return AnnotationResponse(
        id=annotation.id,
        lesson_id=annotation.lesson_id,
        position_start=annotation.position_start,
        position_end=annotation.position_end,
        original_text=annotation.original_text,
        comment=annotation.comment,
        answer=annotation.answer or "",
        messages=_load_messages(annotation),
        anchor_top=annotation.anchor_top or 0,
        pdf_position=annotation.pdf_position,
        created_at=annotation.created_at,
    )


def _format_annotations(annotations: list[Annotation]) -> str:
    if not annotations:
        return "无划线问答记录。"
    blocks = []
    for item in annotations:
        history = _load_messages(item)
        turns = "\n".join(
            f"  {'问' if m['role'] == 'user' else '答'}：{m['content']}" for m in history
        )
        blocks.append(f"- 原文「{item.original_text}」\n{turns}")
    return "\n".join(blocks)


def _annotation_system_prompt(course: Course, lesson: Lesson, selected_text: str) -> str:
    """Build the system prompt for a highlight Q&A turn: tutor instructions + full lesson + selection."""
    context = lesson.content
    if course.mode == "source" and lesson.is_source and not course.is_project and course.source_content:
        context = course.source_content
    if not context:
        context = selected_text
    return f"""{ANNOTATION_ANSWER_PROMPT}

## 当前学习材料
{context}

## 学生划线内容
{selected_text}
"""


def _count_mastery_items(syllabus_content: str) -> tuple[int, int]:
    """Count (checked, total) mastery checkbox items in syllabus."""
    checked = 0
    total = 0
    for line in syllabus_content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("- [ ]"):
            total += 1
        elif stripped.startswith("- [x]") or stripped.startswith("- [X]"):
            checked += 1
            total += 1
    return checked, total


def _check_all_mastery_items_done(syllabus_content: str) -> bool:
    """Check if all checkbox items in syllabus are checked."""
    checked, total = _count_mastery_items(syllabus_content)
    return total > 0 and checked == total


def _mastery_progress(syllabus_content: str) -> float:
    """Return mastery progress as 0.0 to 1.0."""
    checked, total = _count_mastery_items(syllabus_content)
    return checked / total if total > 0 else 0.0


def _record_event(db: Session, course_id: int, event_type: str, lesson_number: int | None = None):
    """Record a learning event."""
    db.add(LearningEvent(course_id=course_id, lesson_number=lesson_number, event_type=event_type))
    db.flush()


_MASTERY_COMMENT_RE = re.compile(r'<!--\s*mastery:\s*(.+?)\s*-->', re.IGNORECASE)


def _auto_check_mastery(syllabus_content: str, lesson_content: str) -> str:
    """Parse mastery items from lesson content and check them in syllabus."""
    match = _MASTERY_COMMENT_RE.search(lesson_content)
    if not match:
        return syllabus_content

    items = [item.strip() for item in match.group(1).split(";") if item.strip()]
    if not items:
        return syllabus_content

    updated = syllabus_content
    for item in items:
        # Replace "- [ ] ...item..." with "- [x] ...item..."
        unchecked = f"- [ ] {item}"
        checked = f"- [x] {item}"
        if unchecked in updated:
            updated = updated.replace(unchecked, checked, 1)

    return updated


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@router.post("/courses", response_model=CourseDetailResponse)
def create_course(req: CreateCourseRequest, db: Session = Depends(get_db)):
    """Create course + AI generates syllabus + first lesson (blocking)."""
    depth_profile = _learning_depth_profile(req.learning_depth)
    course = Course(name=req.name, mode="topic", status="learning", learning_depth=req.learning_depth)
    db.add(course)
    db.flush()

    try:
        ref_section = ""
        if req.reference.strip():
            ref_section = f"\n\n## 参考材料（用户提供）\n\n{req.reference.strip()}"

        user_msg = f"课题：{req.name}\n学习深度：{depth_profile['label']}{ref_section}"
        syllabus_content = _strip_markdown_fences(_call_llm(_build_syllabus_prompt(req.learning_depth), user_msg))
        syllabus = Syllabus(course_id=course.id, content=syllabus_content)
        db.add(syllabus)
        db.flush()

        prompt = FIRST_LESSON_PROMPT.format(syllabus=syllabus_content)
        lesson_user_msg = f"请为课题「{req.name}」按「{depth_profile['label']}」学习深度生成第一篇课文{ref_section}"
        lesson_content = _strip_markdown_fences(_call_llm(prompt, lesson_user_msg))
        lesson = Lesson(course_id=course.id, number=1, content=lesson_content)
        db.add(lesson)

        _record_event(db, course.id, "course_created")
        _record_event(db, course.id, "lesson_generated", lesson_number=1)

        db.commit()
        db.refresh(course)

        return CourseDetailResponse(
            id=course.id, name=course.name, mode=course.mode, status=course.status,
            learning_depth=course.learning_depth, is_project=course.is_project,
            created_at=course.created_at, lesson_count=1,
            syllabus_content=syllabus_content,
            mastery_progress=0.0,
            source_filename=course.source_filename,
        )
    except Exception:
        logger.exception("Course creation error")
        db.rollback()
        raise HTTPException(status_code=500, detail="课程创建失败，请稍后重试")


@router.post("/courses/from-source", response_model=CreateSourceCourseResponse)
async def create_course_from_source(
    name: str = Form(""),
    learning_depth: str = Form("standard"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Create a source-mode course from an uploaded PDF/TXT/Markdown file."""
    depth_profile = _learning_depth_profile(learning_depth)
    filename, source_text = await _extract_upload_text(file)
    course_name = name.strip() or filename.rsplit(".", 1)[0]

    course = Course(
        name=course_name,
        mode="source",
        status="learning",
        learning_depth=learning_depth,
        source_filename=filename,
        source_content=source_text,
    )
    db.add(course)
    db.flush()

    try:
        user_msg = f"""课题：{course_name}
学习深度：{depth_profile['label']}

请根据以下用户上传原始材料生成课程大纲。大纲要服务于读懂并掌握这份材料，而不是泛泛讲同名主题。

## 原始材料全文

{source_text}
"""
        syllabus_content = _strip_markdown_fences(_call_llm(_build_syllabus_prompt(learning_depth), user_msg))
        syllabus = Syllabus(course_id=course.id, content=syllabus_content)
        db.add(syllabus)

        source_lesson = Lesson(
            course_id=course.id,
            number=1,
            content=_source_lesson_content(filename, source_text),
            is_source=True,
        )
        db.add(source_lesson)

        _record_event(db, course.id, "source_course_created")
        _record_event(db, course.id, "source_lesson_created", lesson_number=1)

        db.commit()
        db.refresh(course)

        return CreateSourceCourseResponse(
            id=course.id,
            name=course.name,
            mode=course.mode,
            status=course.status,
            learning_depth=course.learning_depth,
            is_project=course.is_project,
            created_at=course.created_at,
            lesson_count=1,
            syllabus_content=syllabus_content,
            mastery_progress=0.0,
            source_filename=course.source_filename,
        )
    except Exception:
        logger.exception("Source course creation error")
        db.rollback()
        raise HTTPException(status_code=500, detail="材料课程创建失败，请稍后重试")


@router.post("/courses/from-project", response_model=CreateSourceCourseResponse)
async def create_course_from_project(
    name: str = Form(""),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    """上传一个文件或整个文件夹作为「项目」：每个文件直接渲染成一篇，可随时划线提问；不生成大纲、不生成下一篇。"""
    if not files:
        raise HTTPException(status_code=400, detail="请至少上传一个文件")

    extracted: list[tuple[str, str, bytes | None]] = []
    for f in files:
        path = f.filename or "file"
        name_only = path.rsplit("/", 1)[-1]
        suffix = name_only.rsplit(".", 1)[-1].lower() if "." in name_only else ""
        raw = await f.read()
        if suffix == "pdf":
            try:
                content = _extract_pdf_text(raw)
            except Exception:
                content = ""
            extracted.append((path, content, raw))  # 原始 PDF 仍由前端 pdf.js 渲染；content 供划线问答上下文使用
            continue
        text = None
        for enc in ("utf-8", "utf-8-sig", "gb18030"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            continue
        if suffix in ("md", "markdown"):
            content = text
        else:
            lang = _CODE_LANGS.get(suffix, "")
            content = f"# {name_only}\n\n```{lang}\n{text}\n```"
        if content.strip():
            extracted.append((path, content, None))
    if not extracted:
        raise HTTPException(status_code=400, detail="没有可读取的文件内容")

    extracted.sort(key=lambda item: item[0])  # 默认按文件路径字典序排列

    project_name = name.strip()
    if not project_name:
        first_path = extracted[0][0]
        if len(extracted) == 1:
            project_name = first_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        elif "/" in first_path:
            project_name = first_path.split("/", 1)[0]
        else:
            project_name = "项目"

    course = Course(
        name=project_name,
        mode="source",
        is_project=True,
        status="learning",
        learning_depth="standard",
        source_filename=extracted[0][0] if len(extracted) == 1 else None,
    )
    db.add(course)
    db.flush()

    for i, (path, content, blob) in enumerate(extracted, start=1):
        db.add(Lesson(
            course_id=course.id,
            number=i,
            content=content,
            is_source=True,
            source_filename=path,
            source_blob=blob,
        ))

    _record_event(db, course.id, "project_created")
    db.commit()
    db.refresh(course)

    return CreateSourceCourseResponse(
        id=course.id, name=course.name, mode=course.mode,
        status=course.status, learning_depth=course.learning_depth,
        is_project=course.is_project, created_at=course.created_at,
        lesson_count=len(extracted), syllabus_content=None,
        mastery_progress=0.0, source_filename=course.source_filename,
    )


@router.get("/courses/{course_id}/lessons/{lesson_num}/file")
def get_lesson_file(course_id: int, lesson_num: int, db: Session = Depends(get_db)):
    """返回某一篇的原始文件二进制（如 PDF），供前端 pdf.js 原生渲染。"""
    lesson = db.query(Lesson).join(Course).filter(
        Course.id == course_id, Lesson.number == lesson_num
    ).first()
    if not lesson or not lesson.source_blob:
        raise HTTPException(status_code=404, detail="该课文没有原始文件")
    name = (lesson.source_filename or "file").rsplit("/", 1)[-1]
    media = "application/pdf" if name.lower().endswith(".pdf") else "application/octet-stream"
    return Response(content=lesson.source_blob, media_type=media)


@router.get("/courses", response_model=list[CourseResponse])
def list_courses(db: Session = Depends(get_db)):
    courses = db.query(Course).order_by(Course.created_at.desc()).all()
    return [
        CourseResponse(
            id=c.id, name=c.name, mode=c.mode, status=c.status,
            learning_depth=c.learning_depth, is_project=c.is_project,
            created_at=c.created_at, lesson_count=len(c.lessons),
            mastery_progress=_mastery_progress(c.syllabus.content) if c.syllabus else 0.0,
            source_filename=c.source_filename,
        )
        for c in courses
    ]


@router.delete("/courses/{course_id}")
def delete_course(course_id: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    db.delete(course)
    db.commit()
    return {"ok": True}


@router.get("/courses/{course_id}", response_model=CourseDetailResponse)
def get_course(course_id: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    progress = _mastery_progress(course.syllabus.content) if course.syllabus else 0.0
    return CourseDetailResponse(
        id=course.id, name=course.name, mode=course.mode, status=course.status,
        learning_depth=course.learning_depth, is_project=course.is_project,
        created_at=course.created_at, lesson_count=len(course.lessons),
        syllabus_content=course.syllabus.content if course.syllabus else None,
        mastery_progress=progress,
        source_filename=course.source_filename,
    )


@router.get("/courses/{course_id}/syllabus", response_model=SyllabusResponse)
def get_syllabus(course_id: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    if not course.syllabus:
        raise HTTPException(status_code=404, detail="大纲尚未生成")
    return course.syllabus


@router.put("/courses/{course_id}/syllabus", response_model=SyllabusResponse)
def update_syllabus(
    course_id: int,
    req: SyllabusUpdateRequest,
    db: Session = Depends(get_db),
):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    if not course.syllabus:
        raise HTTPException(status_code=404, detail="大纲尚未生成")
    course.syllabus.content = req.content
    db.commit()
    db.refresh(course.syllabus)
    return course.syllabus


def _extract_title(content: str) -> str:
    """Extract first H1 title from markdown content."""
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            return stripped[2:].strip()
    return ""


@router.get("/courses/{course_id}/lessons", response_model=list[LessonListItem])
def list_lessons(course_id: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    return [
        LessonListItem(
            id=lesson.id, number=lesson.number, is_evaluation=lesson.is_evaluation,
            is_source=lesson.is_source, source_filename=lesson.source_filename,
            title=_extract_title(lesson.content),
            has_feedback=lesson.feedback is not None,
            created_at=lesson.created_at,
        )
        for lesson in course.lessons
    ]


@router.get("/courses/{course_id}/lessons/{lesson_num}", response_model=LessonResponse)
def get_lesson(course_id: int, lesson_num: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")
    return lesson


@router.post("/courses/{course_id}/lessons/{lesson_num}/annotations")
def create_annotation(
    course_id: int,
    lesson_num: int,
    req: CreateAnnotationRequest,
    db: Session = Depends(get_db),
):
    """Highlight a passage and ask → the answer streams back (SSE); session is saved on completion."""
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")

    system_prompt = _annotation_system_prompt(course, lesson, req.original_text)
    history = [{"role": "user", "content": req.comment}]
    lesson_id = lesson.id
    pos_start, pos_end, anchor_top = req.position_start, req.position_end, req.anchor_top
    original_text, comment = req.original_text, req.comment
    pdf_position = req.pdf_position
    cid, lnum = course_id, lesson_num

    def generate():
        try:
            answer = ""
            for content, is_final in _stream_llm_messages(system_prompt, history):
                if is_final:
                    answer = _strip_markdown_fences(content)
                else:
                    yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"

            full_history = history + [{"role": "assistant", "content": answer}]
            annotation = Annotation(
                lesson_id=lesson_id,
                position_start=pos_start,
                position_end=pos_end,
                original_text=original_text,
                comment=comment,
                answer=answer,
                messages=json.dumps(full_history, ensure_ascii=False),
                anchor_top=anchor_top,
                pdf_position=pdf_position,
            )
            db.add(annotation)
            _record_event(db, cid, "annotation_answered", lesson_number=lnum)
            db.commit()
            db.refresh(annotation)
            payload = _annotation_to_response(annotation).model_dump(mode="json")
            yield f"data: {json.dumps({'done': True, 'annotation': payload}, ensure_ascii=False)}\n\n"
        except Exception:
            logger.exception("Annotation answer streaming error")
            db.rollback()
            yield f"data: {json.dumps({'error': '划线问题回答失败，请稍后重试'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/courses/{course_id}/lessons/{lesson_num}/annotations", response_model=list[AnnotationResponse])
def get_annotations(
    course_id: int,
    lesson_num: int,
    db: Session = Depends(get_db),
):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")
    annotations = db.query(Annotation).filter(Annotation.lesson_id == lesson.id).order_by(Annotation.created_at).all()
    return [_annotation_to_response(a) for a in annotations]


@router.post("/courses/{course_id}/lessons/{lesson_num}/annotations/{annotation_id}/messages")
def add_annotation_message(
    course_id: int,
    lesson_num: int,
    annotation_id: int,
    req: AddAnnotationMessageRequest,
    db: Session = Depends(get_db),
):
    """Follow-up question in an existing highlight session — the answer streams back (SSE)."""
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")
    annotation = db.query(Annotation).filter(
        Annotation.id == annotation_id, Annotation.lesson_id == lesson.id
    ).first()
    if not annotation:
        raise HTTPException(status_code=404, detail="批注不存在")

    system_prompt = _annotation_system_prompt(course, lesson, annotation.original_text)
    history = _load_messages(annotation)
    history.append({"role": "user", "content": req.content})
    aid = annotation.id
    cid, lnum = course_id, lesson_num

    def generate():
        try:
            answer = ""
            for content, is_final in _stream_llm_messages(system_prompt, history):
                if is_final:
                    answer = _strip_markdown_fences(content)
                else:
                    yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"

            full_history = history + [{"role": "assistant", "content": answer}]
            ann = db.query(Annotation).filter(Annotation.id == aid).first()
            ann.messages = json.dumps(full_history, ensure_ascii=False)
            ann.answer = answer  # keep latest answer in legacy column
            _record_event(db, cid, "annotation_answered", lesson_number=lnum)
            db.commit()
            db.refresh(ann)
            payload = _annotation_to_response(ann).model_dump(mode="json")
            yield f"data: {json.dumps({'done': True, 'annotation': payload}, ensure_ascii=False)}\n\n"
        except Exception:
            logger.exception("Annotation follow-up streaming error")
            db.rollback()
            yield f"data: {json.dumps({'error': '追问回答失败，请稍后重试'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/courses/{course_id}/lessons/{lesson_num}/annotations/save", response_model=AnnotationResponse)
def save_interrupted_annotation(
    course_id: int,
    lesson_num: int,
    req: SaveInterruptedRequest,
    db: Session = Depends(get_db),
):
    """用户中途点了「停止」：把已生成的部分回答落库（首次→新建批注，追问→追加到会话）。"""
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")

    text = req.partial_answer.rstrip()
    if not text:
        raise HTTPException(status_code=400, detail="没有可保存的内容")

    if req.annotation_id is None:
        full_history = [
            {"role": "user", "content": req.comment},
            {"role": "assistant", "content": text},
        ]
        annotation = Annotation(
            lesson_id=lesson.id,
            position_start=req.position_start,
            position_end=req.position_end,
            original_text=req.original_text,
            comment=req.comment,
            answer=text,
            messages=json.dumps(full_history, ensure_ascii=False),
            anchor_top=req.anchor_top,
            pdf_position=req.pdf_position,
        )
        db.add(annotation)
    else:
        annotation = db.query(Annotation).filter(
            Annotation.id == req.annotation_id, Annotation.lesson_id == lesson.id
        ).first()
        if not annotation:
            raise HTTPException(status_code=404, detail="批注不存在")
        history = _load_messages(annotation)
        history.append({"role": "user", "content": req.question})
        history.append({"role": "assistant", "content": text})
        annotation.messages = json.dumps(history, ensure_ascii=False)
        annotation.answer = text

    _record_event(db, course_id, "annotation_answered", lesson_number=lesson_num)
    db.commit()
    db.refresh(annotation)
    return _annotation_to_response(annotation)


@router.delete("/courses/{course_id}/lessons/{lesson_num}/annotations/{annotation_id}")
def delete_annotation(
    course_id: int,
    lesson_num: int,
    annotation_id: int,
    db: Session = Depends(get_db),
):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")
    annotation = db.query(Annotation).filter(
        Annotation.id == annotation_id, Annotation.lesson_id == lesson.id
    ).first()
    if not annotation:
        raise HTTPException(status_code=404, detail="批注不存在")
    db.delete(annotation)
    db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/lessons/{lesson_num}/feedback", response_model=FeedbackResponse)
def create_feedback(
    course_id: int,
    lesson_num: int,
    req: CreateFeedbackRequest,
    db: Session = Depends(get_db),
):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")

    # Check if feedback already exists, update if so
    existing = db.query(Feedback).filter(Feedback.lesson_id == lesson.id).first()
    if existing:
        existing.content = req.content
        existing.thought_answers = req.thought_answers
        _record_event(db, course_id, "feedback_updated", lesson_number=lesson_num)
        db.commit()
        db.refresh(existing)
        return existing

    feedback = Feedback(
        lesson_id=lesson.id,
        content=req.content,
        thought_answers=req.thought_answers,
    )
    db.add(feedback)
    _record_event(db, course_id, "feedback_submitted", lesson_number=lesson_num)
    db.commit()
    db.refresh(feedback)
    return feedback


@router.post("/courses/{course_id}/next")
def generate_next_lesson(
    course_id: int,
    db: Session = Depends(get_db),
):
    """'我读完了' → AI generates next lesson (SSE streaming)."""
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    if course.status == "completed":
        raise HTTPException(status_code=400, detail="课程已完结")
    if not course.syllabus:
        raise HTTPException(status_code=400, detail="课程大纲尚未生成")

    lessons = course.lessons
    if not lessons:
        raise HTTPException(status_code=400, detail="尚无课文")

    last_lesson = lessons[-1]

    # Check if last lesson is an evaluation article — if so, generate summary
    if last_lesson.is_evaluation:
        return _generate_summary_response(course, db)

    syllabus_content = course.syllabus.content
    all_mastery_done = _check_all_mastery_items_done(syllabus_content)

    # Collect feedback and annotations from last lesson
    last_feedback = db.query(Feedback).filter(
        Feedback.lesson_id == last_lesson.id
    ).first()
    last_annotations = db.query(Annotation).filter(
        Annotation.lesson_id == last_lesson.id
    ).order_by(Annotation.created_at).all()

    feedback_text = ""
    if last_feedback:
        feedback_text = f"反馈内容：{last_feedback.content}\n思考题回答：{last_feedback.thought_answers}"
    else:
        feedback_text = "学生没有提交反馈。"

    annotations_text = _format_annotations(last_annotations)

    next_number = last_lesson.number + 1

    # Extract the previous lesson's real thought questions as a dedicated field so
    # the review section can map to them exactly, instead of relying on the model
    # to spot them inside the (possibly truncated) full text (issue #3).
    last_questions = _extract_thought_questions(last_lesson.content) or \
        "（上一篇未显式列出思考题区块，请根据上一篇正文内容合理拟出其思考题再逐题复盘）"

    if course.mode == "source" and last_lesson.is_source:
        prompt = SOURCE_LESSON_PROMPT.format(
            syllabus=syllabus_content,
            source_filename=course.source_filename or "uploaded-source",
            source_content=course.source_content or last_lesson.content,
            source_annotations=_format_annotations(last_annotations),
            lesson_number=next_number,
        )
        user_msg = f"根据原始材料和划线问答生成第{next_number}篇课文"
    elif all_mastery_done:
        prompt = EVAL_LESSON_PROMPT.format(
            syllabus=syllabus_content,
            last_lesson=last_lesson.content,
            feedback=feedback_text,
            annotations=annotations_text,
            last_questions=last_questions,
        )
        user_msg = "生成评估篇"
    else:
        recent = lessons[-3:] if len(lessons) > 3 else lessons
        prev_text = "\n\n---\n\n".join(
            f"### 第{lesson.number}篇\n{lesson.content[:20000]}" for lesson in recent
        )
        prompt = NEXT_LESSON_PROMPT.format(
            syllabus=syllabus_content,
            previous_lessons=prev_text,
            feedback=feedback_text,
            annotations=annotations_text,
            lesson_number=next_number,
            last_questions=last_questions,
        )
        user_msg = f"生成第{next_number}篇课文"

    cid = course.id

    def generate():
        try:
            lesson_content = ""
            for content, is_final in _stream_llm(prompt, user_msg):
                if is_final:
                    lesson_content = content
                else:
                    yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"

            lesson_content = _strip_markdown_fences(lesson_content)
            is_eval = lesson_content.strip().startswith("<!-- eval-article -->")

            # Use request db session (alive during streaming)
            new_lesson = Lesson(
                course_id=cid, number=next_number,
                content=lesson_content, is_evaluation=is_eval,
            )
            db.add(new_lesson)
            _record_event(db, cid, "lesson_generated", lesson_number=next_number)

            # Auto-update syllabus mastery items based on lesson content
            if not is_eval:
                course_obj = db.query(Course).filter(Course.id == cid).first()
                if course_obj and course_obj.syllabus:
                    updated = _auto_check_mastery(course_obj.syllabus.content, lesson_content)
                    if updated != course_obj.syllabus.content:
                        course_obj.syllabus.content = updated

            db.commit()

            yield f"data: {json.dumps({'done': True, 'lesson_number': next_number, 'is_evaluation': is_eval}, ensure_ascii=False)}\n\n"

        except Exception:
            logger.exception("Next lesson generation error")
            db.rollback()
            yield f"data: {json.dumps({'error': '服务暂时不可用，请稍后重试'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


def _generate_summary_response(course: Course, db: Session):
    """Generate summary after evaluation article is read."""
    syllabus_content = course.syllabus.content
    all_lessons_text = "\n\n---\n\n".join(
        f"### 第{lesson.number}篇\n{lesson.content}" for lesson in course.lessons
    )

    cid = course.id

    def generate():
        try:
            prompt = SUMMARY_PROMPT.format(
                syllabus=syllabus_content,
                all_lessons=all_lessons_text,
            )
            summary_content = ""
            for content, is_final in _stream_llm(prompt, "生成课程总结"):
                if is_final:
                    summary_content = content
                else:
                    yield f"data: {json.dumps({'phase': 'summary', 'content': content}, ensure_ascii=False)}\n\n"

            summary_content = _strip_markdown_fences(summary_content)
            # Save summary as lesson number=0 and mark course completed
            course_obj = db.query(Course).filter(Course.id == cid).first()
            course_obj.status = "completed"
            summary_lesson = Lesson(
                course_id=cid, number=0, content=summary_content, is_evaluation=False,
            )
            db.add(summary_lesson)
            db.commit()

            yield f"data: {json.dumps({'done': True, 'completed': True}, ensure_ascii=False)}\n\n"

        except Exception:
            logger.exception("Summary generation error")
            db.rollback()
            yield f"data: {json.dumps({'error': '总结生成失败，请重试'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/courses/{course_id}/summary")
def get_summary(course_id: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    # Summary is stored as lesson number 0
    summary = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == 0).first()
    if not summary:
        raise HTTPException(status_code=404, detail="总结尚未生成")
    return {"content": summary.content}


# ---------------------------------------------------------------------------
# Feedback GET — restore saved feedback on page load
# ---------------------------------------------------------------------------

@router.get("/courses/{course_id}/lessons/{lesson_num}/feedback")
def get_feedback(course_id: int, lesson_num: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    lesson = db.query(Lesson).filter(Lesson.course_id == course_id, Lesson.number == lesson_num).first()
    if not lesson:
        raise HTTPException(status_code=404, detail="课文不存在")
    feedback = db.query(Feedback).filter(Feedback.lesson_id == lesson.id).first()
    if not feedback:
        return {"exists": False, "content": "", "thought_answers": ""}
    return {
        "exists": True,
        "id": feedback.id,
        "content": feedback.content,
        "thought_answers": feedback.thought_answers or "",
        "created_at": feedback.created_at.isoformat() if feedback.created_at else None,
    }


# ---------------------------------------------------------------------------
# Lesson opened event — frontend calls this when user opens a lesson
# ---------------------------------------------------------------------------

@router.post("/courses/{course_id}/lessons/{lesson_num}/opened")
def record_lesson_opened(course_id: int, lesson_num: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    _record_event(db, course_id, "lesson_opened", lesson_number=lesson_num)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Learning Stats
# ---------------------------------------------------------------------------

@router.get("/courses/{course_id}/stats", response_model=CourseStatsResponse)
def get_course_stats(course_id: int, db: Session = Depends(get_db)):
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")

    normal_lessons = [lesson for lesson in course.lessons if lesson.number > 0]
    total_annotations = sum(len(lesson.annotations) for lesson in normal_lessons)
    total_feedback = sum(1 for lesson in normal_lessons if lesson.feedback)

    checked, total = (0, 0)
    if course.syllabus:
        checked, total = _count_mastery_items(course.syllabus.content)

    events = db.query(LearningEvent).filter(
        LearningEvent.course_id == course_id
    ).order_by(LearningEvent.created_at).all()

    first_activity = events[0].created_at if events else None
    last_activity = events[-1].created_at if events else None

    return CourseStatsResponse(
        total_lessons=len(normal_lessons),
        total_annotations=total_annotations,
        total_feedback=total_feedback,
        mastery_checked=checked,
        mastery_total=total,
        mastery_progress=checked / total if total > 0 else 0.0,
        first_activity=first_activity,
        last_activity=last_activity,
    )


def _event_local_date(dt: datetime) -> date:
    """把事件时间戳归一到服务器本地日期。

    SQLite 取回的是裸时间（无时区，实为 UTC），先补 UTC 再转本地，
    避免凌晨学习被错算到「昨天」。tz-aware 的输入也能正确处理。
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone().date()


@router.get("/stats", response_model=GlobalStatsResponse)
def get_global_stats(db: Session = Depends(get_db)):
    courses = db.query(Course).all()
    total_courses = len(courses)
    active_courses = sum(1 for c in courses if c.status == "learning")
    completed_courses = sum(1 for c in courses if c.status == "completed")

    total_lessons = db.query(Lesson).filter(Lesson.number > 0).count()
    total_annotations = db.query(Annotation).count()
    total_feedback = db.query(Feedback).count()

    # Calculate streaks from learning events（按本地日期，与学习日历口径一致）
    raw_times = db.query(LearningEvent.created_at).all()
    event_dates = sorted(
        {_event_local_date(r[0]) for r in raw_times if r[0]}, reverse=True
    )

    current_streak = 0
    longest_streak = 0

    if event_dates:
        # Current streak: count consecutive days ending today or yesterday
        today = date.today()
        streak = 0
        for i, d in enumerate(event_dates):
            if isinstance(d, str):
                d = date.fromisoformat(d)
            expected = today - timedelta(days=i)
            if d == expected:
                streak += 1
            elif i == 0 and d == today - timedelta(days=1):
                # Allow streak to start from yesterday
                streak += 1
                today = today - timedelta(days=1)
            else:
                break
        current_streak = streak

        # Longest streak
        if event_dates:
            sorted_dates = sorted(set(date.fromisoformat(str(d)) if isinstance(d, str) else d for d in event_dates))
            best = 1
            run = 1
            for i in range(1, len(sorted_dates)):
                if sorted_dates[i] - sorted_dates[i - 1] == timedelta(days=1):
                    run += 1
                    best = max(best, run)
                else:
                    run = 1
            longest_streak = best

    return GlobalStatsResponse(
        total_courses=total_courses,
        active_courses=active_courses,
        completed_courses=completed_courses,
        total_lessons_read=total_lessons,
        total_annotations=total_annotations,
        total_feedback=total_feedback,
        current_streak=current_streak,
        longest_streak=longest_streak,
    )


@router.get("/calendar", response_model=CalendarResponse)
def get_learning_calendar(db: Session = Depends(get_db)):
    """按天聚合所有学习活动，供个人中心的学习日历展示「哪天学了什么」。

    日期归组用本地日期（与 /stats 的连续天数口径一致），每天给出：
    接触到的课程、对应课文编号、划线条数与事件总数。
    划线按 Annotation 行数（真实划线条数）统计，而非问答事件数——
    避免追问轮次把数字撑大，从而与 /stats 的 total_annotations 一致。
    """
    course_meta = {c.id: (c.name, c.mode) for c in db.query(Course).all()}

    def _cell(course_id: int) -> dict:
        name, mode = course_meta.get(course_id, ("", "topic"))
        return {
            "course_id": course_id,
            "course_name": name,
            "mode": mode,
            "lessons": set(),
            "annotations": 0,
            "event_count": 0,
        }

    days: dict[str, dict] = {}

    # 课文与事件：从 learning_events 取课文编号与事件总数
    for event in db.query(LearningEvent).order_by(LearningEvent.created_at).all():
        if not event.created_at or event.course_id not in course_meta:
            continue
        day_key = _event_local_date(event.created_at).isoformat()
        c = days.setdefault(day_key, {}).setdefault(event.course_id, _cell(event.course_id))
        c["event_count"] += 1
        if event.lesson_number and event.lesson_number > 0:
            c["lessons"].add(event.lesson_number)

    # 划线：从 annotations 表按创建日期统计真实划线条数（追问不重复计）
    ann_rows = (
        db.query(Annotation.created_at, Lesson.course_id)
        .join(Lesson, Annotation.lesson_id == Lesson.id)
        .all()
    )
    for created_at, course_id in ann_rows:
        if not created_at or course_id not in course_meta:
            continue
        day_key = _event_local_date(created_at).isoformat()
        c = days.setdefault(day_key, {}).setdefault(course_id, _cell(course_id))
        c["annotations"] += 1

    result_days = []
    for day_key in sorted(days.keys()):
        course_list, lessons_read, annotations, event_count = [], 0, 0, 0
        for c in days[day_key].values():
            lessons_sorted = sorted(c["lessons"])
            lessons_read += len(lessons_sorted)
            annotations += c["annotations"]
            event_count += c["event_count"]
            course_list.append(CalendarCourseActivity(
                course_id=c["course_id"],
                course_name=c["course_name"],
                mode=c["mode"],
                lessons=lessons_sorted,
                annotations=c["annotations"],
                event_count=c["event_count"],
            ))
        course_list.sort(key=lambda x: x.event_count, reverse=True)
        result_days.append(CalendarDay(
            date=day_key,
            event_count=event_count,
            lessons_read=lessons_read,
            annotations=annotations,
            courses=course_list,
        ))

    return CalendarResponse(
        days=result_days,
        total_active_days=len(result_days),
        first_active_date=result_days[0].date if result_days else None,
        last_active_date=result_days[-1].date if result_days else None,
    )
