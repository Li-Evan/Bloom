from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean, CheckConstraint, UniqueConstraint
from sqlalchemy.orm import relationship

from app.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class Course(Base):
    __tablename__ = "courses"
    __table_args__ = (
        CheckConstraint("status IN ('learning', 'completed')", name="ck_course_status"),
        CheckConstraint("mode IN ('topic', 'source')", name="ck_course_mode"),
    )

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    mode = Column(String, default="topic", nullable=False)
    status = Column(String, default="learning")
    source_filename = Column(String, nullable=True)
    source_content = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    syllabus = relationship("Syllabus", back_populates="course", uselist=False, cascade="all, delete-orphan")
    lessons = relationship("Lesson", back_populates="course", order_by="Lesson.number", cascade="all, delete-orphan")
    learning_events = relationship("LearningEvent", back_populates="course", cascade="all, delete-orphan")


class Syllabus(Base):
    __tablename__ = "syllabi"

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), unique=True, nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow)

    course = relationship("Course", back_populates="syllabus")


class Lesson(Base):
    __tablename__ = "lessons"
    __table_args__ = (
        UniqueConstraint("course_id", "number", name="uq_lesson_course_number"),
    )

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False)
    number = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    is_evaluation = Column(Boolean, default=False)
    is_source = Column(Boolean, default=False)
    created_at = Column(DateTime, default=_utcnow)

    course = relationship("Course", back_populates="lessons")
    annotations = relationship("Annotation", back_populates="lesson", cascade="all, delete-orphan")
    feedback = relationship("Feedback", back_populates="lesson", uselist=False, cascade="all, delete-orphan")


class Annotation(Base):
    __tablename__ = "annotations"
    __table_args__ = (
        CheckConstraint("position_end >= position_start", name="ck_annotation_positions"),
    )

    id = Column(Integer, primary_key=True, index=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False)
    position_start = Column(Integer, nullable=False)
    position_end = Column(Integer, nullable=False)
    original_text = Column(Text, nullable=False)
    comment = Column(Text, nullable=False)
    answer = Column(Text, default="")
    messages = Column(Text, default="")  # JSON: [{"role": "user"|"assistant", "content": str}]
    anchor_top = Column(Integer, default=0)  # vertical offset (px) within the article, for margin dot
    created_at = Column(DateTime, default=_utcnow)

    lesson = relationship("Lesson", back_populates="annotations")


class Feedback(Base):
    __tablename__ = "feedbacks"

    id = Column(Integer, primary_key=True, index=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False)
    content = Column(Text, default="")
    thought_answers = Column(Text, default="")
    created_at = Column(DateTime, default=_utcnow)

    lesson = relationship("Lesson", back_populates="feedback")


class LearningEvent(Base):
    """Track learning activities for analytics."""
    __tablename__ = "learning_events"

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False)
    lesson_number = Column(Integer, nullable=True)
    event_type = Column(String, nullable=False)  # lesson_opened, lesson_completed, annotation_added, feedback_submitted
    created_at = Column(DateTime, default=_utcnow)

    course = relationship("Course", back_populates="learning_events")


class LearningRecommendation(Base):
    __tablename__ = "learning_recommendations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('suggested', 'saved', 'started', 'dismissed')",
            name="ck_learning_recommendation_status",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    rationale = Column(Text, nullable=False)
    bridge = Column(Text, default="")
    source_topics = Column(Text, default="[]")
    status = Column(String, default="suggested", nullable=False)
    generation = Column(Integer, default=1, nullable=False)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
