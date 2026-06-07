from pydantic import BaseModel, Field, field_validator
from datetime import datetime


# Course
class CreateCourseRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    reference: str = Field("", max_length=50000)  # optional reference material


class CreateSourceCourseResponse(BaseModel):
    id: int
    name: str
    mode: str
    status: str
    created_at: datetime
    lesson_count: int = 0
    syllabus_content: str | None = None
    mastery_progress: float = 0.0
    source_filename: str | None = None

    model_config = {"from_attributes": True}


class CourseResponse(BaseModel):
    id: int
    name: str
    mode: str = "topic"
    status: str
    created_at: datetime
    lesson_count: int = 0
    mastery_progress: float = 0.0
    source_filename: str | None = None

    model_config = {"from_attributes": True}


class CourseDetailResponse(BaseModel):
    id: int
    name: str
    mode: str = "topic"
    status: str
    created_at: datetime
    lesson_count: int = 0
    syllabus_content: str | None = None
    mastery_progress: float = 0.0  # 0.0 to 1.0
    source_filename: str | None = None

    model_config = {"from_attributes": True}


# Syllabus
class SyllabusResponse(BaseModel):
    id: int
    course_id: int
    content: str
    created_at: datetime

    model_config = {"from_attributes": True}


class SyllabusUpdateRequest(BaseModel):
    content: str = Field(..., min_length=1)


# Lesson
class LessonListItem(BaseModel):
    id: int
    number: int
    is_evaluation: bool
    is_source: bool = False
    title: str = ""
    has_feedback: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}


class LessonResponse(BaseModel):
    id: int
    course_id: int
    number: int
    content: str
    is_evaluation: bool
    is_source: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}


# Annotation
class AnnotationMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class CreateAnnotationRequest(BaseModel):
    position_start: int = Field(..., ge=0)
    position_end: int = Field(..., ge=0)
    original_text: str = Field(..., min_length=1, max_length=5000)
    comment: str = Field(..., min_length=1, max_length=5000)
    answer_immediately: bool = False
    anchor_top: int = Field(0, ge=0)

    @field_validator("position_end")
    @classmethod
    def end_gte_start(cls, v: int, info) -> int:
        if "position_start" in info.data and v < info.data["position_start"]:
            raise ValueError("position_end must be >= position_start")
        return v


class AddAnnotationMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=5000)


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
    created_at: datetime

    model_config = {"from_attributes": True}


# Feedback
class CreateFeedbackRequest(BaseModel):
    content: str = Field("", max_length=10000)
    thought_answers: str | None = Field(None, max_length=10000)


class FeedbackResponse(BaseModel):
    id: int
    lesson_id: int
    content: str
    thought_answers: str
    created_at: datetime

    model_config = {"from_attributes": True}


# Learning Stats
class CourseStatsResponse(BaseModel):
    total_lessons: int
    total_annotations: int
    total_feedback: int
    mastery_checked: int
    mastery_total: int
    mastery_progress: float  # 0.0 to 1.0
    first_activity: datetime | None = None
    last_activity: datetime | None = None


class GlobalStatsResponse(BaseModel):
    total_courses: int
    active_courses: int
    completed_courses: int
    total_lessons_read: int
    total_annotations: int
    total_feedback: int
    current_streak: int  # consecutive days with activity
    longest_streak: int


class LearningEventResponse(BaseModel):
    id: int
    course_id: int
    lesson_number: int | None
    event_type: str
    created_at: datetime

    model_config = {"from_attributes": True}


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
