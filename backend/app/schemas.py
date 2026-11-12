from datetime import datetime, timezone
from typing import Annotated, Literal

import re
import unicodedata

from pydantic import AfterValidator, BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError

from app.course_planning import LearningIntent


def as_utc(value: datetime) -> datetime:
    # 课程引擎的时间列是不带时区的 DateTime，库里存的是 UTC；输出时补上 UTC，客户端才不会按本地时区解析
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


UtcDatetime = Annotated[datetime, AfterValidator(as_utc)]

LearningDepth = Literal["simple", "standard", "deep"]
Language = Literal["zh", "en"]  # 课程语言；同时用作推荐刷新的 locale


# Course
class CreateCourseRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    reference: str = Field("", max_length=50000)  # optional reference material
    learning_depth: LearningDepth = "standard"
    language: Language = "zh"  # 课程语言，建课时确定，之后不变；课程的一切生成内容都用它
    learning_intent: LearningIntent | None = None


class CreateSourceCourseResponse(BaseModel):
    id: int
    name: str
    mode: str
    status: str
    learning_depth: str = "standard"
    language: str = "zh"
    is_project: bool = False
    created_at: UtcDatetime
    lesson_count: int = 0
    syllabus_content: str | None = None
    mastery_progress: float = 0.0
    mastery_covered: int = 0  # 已讲到的要点数（项目课：已读文件数）
    mastery_total: int = 0  # 要点总数（项目课：文件数）
    source_filename: str | None = None
    skipped_files: list[str] = []  # 项目导入时解不开的二进制文件，界面据此提示

    model_config = {"from_attributes": True}


class RenameCourseRequest(BaseModel):
    name: str = Field(..., max_length=1000)  # 空白收拢之后最多 200 字，在接口里检查


class RenamedCourse(BaseModel):
    id: int
    name: str


class MoveLessonRequest(BaseModel):
    target_course_id: int | None = None  # 移到已有的一门资料类课程
    new_course_name: str | None = Field(None, max_length=1000)  # 或者新建一门（空串用文件名）


class EditLessonRequest(BaseModel):
    # 资料类课程的一个文件：改名（只给文件名，不含扩展名和文件夹，扩展名保持原样）和 / 或改正文（Markdown）
    name: str | None = Field(None, max_length=1000)
    content: str | None = Field(None, max_length=1_000_000)


class EditedLesson(BaseModel):
    number: int
    source_filename: str | None


class ArchiveLessonRequest(BaseModel):
    archived: bool


class ArchivedLesson(BaseModel):
    # 归档 / 取消归档之后这门课的状态和已读进度（归档的文件不算在里面）
    number: int
    is_archived: bool
    status: str
    mastery_covered: int
    mastery_total: int
    mastery_progress: float


class MovedLesson(BaseModel):
    course_id: int
    course_name: str
    number: int  # 在新课程里的编号


class AddedLessonsResponse(BaseModel):
    added: list[int]  # 新课文的编号，按文件名排好
    skipped_files: list[str] = []  # 和建课时一样：读不了、被跳过的文件及原因


class CourseResponse(BaseModel):
    id: int
    name: str
    mode: str = "topic"
    status: str
    learning_depth: str = "standard"
    language: str = "zh"
    is_project: bool = False
    created_at: UtcDatetime
    lesson_count: int = 0
    mastery_progress: float = 0.0
    mastery_covered: int = 0
    mastery_total: int = 0
    source_filename: str | None = None
    is_clippings: bool = False

    model_config = {"from_attributes": True}


class CourseDetailResponse(BaseModel):
    id: int
    name: str
    mode: str = "topic"
    status: str
    learning_depth: str = "standard"
    language: str = "zh"
    is_project: bool = False
    created_at: UtcDatetime
    lesson_count: int = 0
    syllabus_content: str | None = None
    mastery_progress: float = 0.0  # 0.0 to 1.0 = mastery_covered / mastery_total
    mastery_covered: int = 0
    mastery_total: int = 0
    source_filename: str | None = None
    is_clippings: bool = False

    model_config = {"from_attributes": True}


# Syllabus
class SyllabusResponse(BaseModel):
    id: int
    course_id: int
    content: str
    created_at: UtcDatetime

    model_config = {"from_attributes": True}


class SyllabusUpdateRequest(BaseModel):
    content: str = Field(..., min_length=1)


# Lesson
class LessonListItem(BaseModel):
    id: int
    number: int
    is_evaluation: bool
    is_source: bool = False
    source_filename: str | None = None
    title: str = ""
    has_feedback: bool = False
    is_read: bool = False
    is_archived: bool = False
    created_at: UtcDatetime

    model_config = {"from_attributes": True}


class LessonResponse(BaseModel):
    teaching_plan: dict | None = None
    id: int
    course_id: int
    number: int
    content: str
    is_evaluation: bool
    is_source: bool = False
    source_filename: str | None = None
    is_read: bool = False
    created_at: UtcDatetime

    model_config = {"from_attributes": True}


# Annotation
class AnnotationMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class CreateAnnotationRequest(BaseModel):
    position_start: int = Field(..., ge=0)
    position_end: int = Field(..., ge=0)
    original_text: str = Field(..., min_length=1, max_length=50000)
    comment: str = Field(..., min_length=1, max_length=50000)
    answer_immediately: bool = False
    anchor_top: int = Field(0, ge=0)
    pdf_position: str | None = None

    request_id: str | None = Field(None, pattern=r"^[A-Za-z0-9._~-]{1,64}$")

    @field_validator("position_end")
    @classmethod
    def end_gte_start(cls, v: int, info) -> int:
        if "position_start" in info.data and v < info.data["position_start"]:
            raise ValueError("position_end must be >= position_start")
        return v


class AddAnnotationMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=50000)
    request_id: str | None = Field(None, pattern=r"^[A-Za-z0-9._~-]{1,64}$")


class SaveInterruptedRequest(BaseModel):
    """保存被用户中途「停止」的一轮划线问答，保留已生成的部分回答。

    annotation_id=None → 首次提问被中断（新建批注）；有值 → 追问被中断（追加到该会话）。
    """
    annotation_id: int | None = None
    position_start: int = Field(0, ge=0)
    position_end: int = Field(0, ge=0)
    original_text: str = Field("", max_length=50000)
    comment: str = Field("", max_length=50000)
    anchor_top: int = Field(0, ge=0)
    pdf_position: str | None = None
    question: str = Field("", max_length=50000)
    partial_answer: str = Field("", max_length=100000)
    request_id: str | None = Field(None, pattern=r"^[A-Za-z0-9._~-]{1,64}$")

    @field_validator("position_end")
    @classmethod
    def end_gte_start(cls, v: int, info) -> int:
        if "position_start" in info.data and v < info.data["position_start"]:
            raise ValueError("position_end must be >= position_start")
        return v


class AnnotationResponse(BaseModel):
    id: int
    lesson_id: int
    position_start: int
    position_end: int
    original_text: str
    comment: str
    answer: str = ""
    messages: list[AnnotationMessage] = []
    anchor_top: int = 0
    pdf_position: str | None = None
    created_at: UtcDatetime

    model_config = {"from_attributes": True}


class MyAnnotation(BaseModel):
    """用户中心「我的笔记」的一条：一个划线问答会话，带上它所在的课程与课文。"""
    id: int
    course_id: int
    course_name: str
    lesson_number: int
    lesson_title: str
    original_text: str
    question: str  # 会话里用户的第一条提问
    answer_preview: str  # 第一条回答去掉 Markdown 标记后的前 200 字
    message_count: int  # 会话里的消息总数（提问和回答各算一条）
    created_at: UtcDatetime
    updated_at: UtcDatetime


class MyAnnotationPage(BaseModel):
    items: list[MyAnnotation]
    page: int
    limit: int
    total: int


# Feedback
class CreateFeedbackRequest(BaseModel):
    scope: Literal["auto", "next", "course"] = "auto"
    content: str = Field("", max_length=50000)
    thought_answers: str = Field("", max_length=50000)

    @field_validator("content", "thought_answers", mode="before")
    @classmethod
    def null_is_empty(cls, v):
        return "" if v is None else v


class FeedbackResponse(BaseModel):
    id: int
    lesson_id: int
    content: str
    thought_answers: str
    created_at: UtcDatetime

    model_config = {"from_attributes": True}


class FeedbackStateResponse(BaseModel):
    scope: Literal["auto", "next", "course"] = "auto"
    exists: bool
    content: str
    thought_answers: str
    id: int | None = None
    created_at: UtcDatetime | None = None


# Learning Stats
class CourseStatsResponse(BaseModel):
    total_lessons: int
    lessons_read: int  # 已读课文数，口径同 GlobalStatsResponse.total_lessons_read
    total_annotations: int
    total_feedback: int
    mastery_checked: int  # 与 mastery_covered 相同，保留旧名
    mastery_covered: int
    mastery_total: int
    mastery_progress: float  # 0.0 to 1.0
    first_activity: UtcDatetime | None = None
    last_activity: UtcDatetime | None = None


class LastLesson(BaseModel):
    course_id: int
    course_name: str
    lesson_number: int  # 这门课的前沿课文（最新一篇）；项目课是第一个没读的文件，全部读完了才是最近打开的那个
    lesson_title: str
    opened_at: UtcDatetime  # 这门课最近一次有学习活动（打开课文）的时间
    course_completed: bool = False  # 课程已完结：继续学习应落到课程页（总结在那里）


class GlobalStatsResponse(BaseModel):
    total_courses: int
    active_courses: int
    completed_courses: int
    total_lessons_read: int  # 已读课文数：点了「我读完了」、有反馈、项目文件标记已读、评估篇已生成总结
    total_annotations: int
    total_feedback: int
    current_streak: int  # consecutive days with activity
    longest_streak: int
    last_lesson: LastLesson | None = None  # 最近有学习活动的那门课的前沿课文


class LearningEventResponse(BaseModel):
    id: int
    course_id: int
    lesson_number: int | None
    event_type: str
    created_at: UtcDatetime

    model_config = {"from_attributes": True}


# Recommendations
class RecommendationResponse(BaseModel):
    id: int
    title: str
    rationale: str
    bridge: str = ""
    source_topics: list[str] = []
    status: str
    generation: int
    language: str = "zh"
    course_id: int | None = None
    created_at: UtcDatetime
    updated_at: UtcDatetime | None = None

    model_config = {"from_attributes": True}


class RecommendationDashboardResponse(BaseModel):
    recommendations: list[RecommendationResponse]
    saved: list[RecommendationResponse]


class RefreshRecommendationsRequest(BaseModel):
    locale: Language | None = None  # 推荐标题与理由用的语言；缺省 zh


class StartRecommendationRequest(BaseModel):
    course_id: int | None = None


# Learning Calendar — 个人中心学习日历
class CalendarCourseActivity(BaseModel):
    course_id: int
    course_name: str
    mode: str
    lessons: list[int]   # 当天接触到的课文编号（去重、升序，不含总结篇 0）
    annotations: int     # 当天该课程的划线问答数
    event_count: int     # 当天该课程的活动事件总数


class CalendarDay(BaseModel):
    date: str            # YYYY-MM-DD（按事件存储时间的日期归组）
    event_count: int
    lessons_read: int    # 当天读到的课文数（按 课程+编号 去重）
    annotations: int
    courses: list[CalendarCourseActivity]


class CalendarResponse(BaseModel):
    days: list[CalendarDay]
    total_active_days: int
    first_active_date: str | None = None
    last_active_date: str | None = None


# 「我的」：个人资料与设置
MAX_NICKNAME = 50
# 看起来是空白、其实是字母或组合符号的填充字符（韩文填充符、高棉固有元音等）：视同空白
_NICKNAME_BLANK_FILLERS = frozenset("\u115f\u1160\u3164\uffa0\u17b4\u17b5")
# 控制类（Tab、换行……）和行 / 段分隔符换成空格，免得「line\none」粘成「lineone」
_NICKNAME_TO_SPACE_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})
# 直接去掉：格式类（Cf：零宽空格、方向控制符等）、代理（Cs）、私用（Co）、未分配（Cn）
_NICKNAME_DROPPED_CATEGORIES = frozenset({"Cf", "Cs", "Co", "Cn"})
# ZWJ / ZWNJ 也是 Cf，但 emoji 序列和一些文字需要它们：夹在两个非空白字符之间时保留，贴着空白或在首尾时去掉
_NICKNAME_JOINERS = "\u200c\u200d"
_NICKNAME_EDGE_JOINERS = re.compile(f"(?:^|(?<=\\s))[{_NICKNAME_JOINERS}]+|[{_NICKNAME_JOINERS}]+(?=\\s|$)")


def clean_nickname(value: str) -> str:
    """昵称的规整：不可见字符去掉或换成空格，合并空白，去首尾空白。前端 lib/me/nickname.ts 是同一套规则。"""
    chars: list[str] = []
    for ch in value:
        category = unicodedata.category(ch)
        if ch in _NICKNAME_BLANK_FILLERS or category in _NICKNAME_TO_SPACE_CATEGORIES:
            chars.append(" ")
        elif ch in _NICKNAME_JOINERS:
            chars.append(ch)
        elif category not in _NICKNAME_DROPPED_CATEGORIES:
            chars.append(ch)
    text = _NICKNAME_EDGE_JOINERS.sub("", "".join(chars))
    return re.sub(r"\s+", " ", text).strip()


class MeResponse(BaseModel):
    uuid: str
    email: str
    nickname: str | None
    avatar_url: str | None
    locale: str | None
    created_at: datetime | None
    archive_on_read: bool = False

    model_config = {"from_attributes": True}


class ArchiveOnRead(BaseModel):
    enabled: bool


class UpdateMeRequest(BaseModel):
    nickname: str

    @field_validator("nickname", mode="after")
    @classmethod
    def clean_and_check(cls, value: str) -> str:
        """先规整（见 clean_nickname），再要求至少含一个字母或数字、最多 50 个字符；
        只剩零宽字符、空白、纯符号和纯 emoji 的统一回「昵称至少要有一个字母或数字」，不用 pydantic 默认的英文提示。"""
        cleaned = clean_nickname(value)
        if not any(unicodedata.category(ch)[0] in "LN" for ch in cleaned):
            raise PydanticCustomError("nickname_needs_letter", "昵称至少要有一个字母或数字")
        if len(cleaned) > MAX_NICKNAME:
            raise PydanticCustomError("nickname_too_long", "昵称最多 {max} 个字符", {"max": MAX_NICKNAME})
        return cleaned
