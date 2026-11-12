import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.courses import _get_owned_course, _lesson_head, _lesson_title, _load_messages
from app.database import get_db
from app.models import Annotation, Course, Lesson, course_access
from app.models import User
from app.pagination import PageQuery
from app.schemas import MyAnnotation, MyAnnotationPage

router = APIRouter(prefix="/api/me", tags=["notes"])

NOTES_DEFAULT_LIMIT = 20
NOTES_MAX_LIMIT = 100
PREVIEW_CHARS = 200

NotesLimitQuery = Annotated[int, Query(ge=1, le=NOTES_MAX_LIMIT)]

# 只剥真正的 HTML 标签：List<String>、Map<K, V>、a<b 这类泛型和比较不能被当成标签吃掉
_HTML_TAGS = (
    "a|abbr|b|big|blockquote|br|center|cite|code|dd|del|details|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|"
    "ol|p|pre|q|s|section|small|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul"
)
_CODE = re.compile(r"```[^\n]*\n?(.*?)(?:```|\Z)|`([^`\n]+)`", re.DOTALL)
_STASH = re.compile(r"\ue000(\d+)\ue001")
_ASCII_WORD = r"A-Za-z0-9"


def _unwrap_unless_identifier(match: re.Match) -> str:
    """__init__、__name__ 这类标识符不是强调，原样保留。"""
    inner = match.group(1)
    return match.group(0) if re.fullmatch(r"\w+", inner, re.ASCII) else inner


_MARKDOWN_NOISE = [
    (re.compile(rf"<!--.*?-->|</?(?:{_HTML_TAGS})(?:\s[^<>]*)?/?>", re.DOTALL), ""),  # HTML 注释与标签
    (re.compile(r"!?\[([^\]]*)\]\([^)]*\)"), r"\1"),  # 链接与图片只留文字
    (re.compile(r"^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)", re.MULTILINE), ""),  # 标题、引用
    (re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+", re.MULTILINE), ""),  # 列表符号
    # 强调只在「开头紧跟文字、结尾紧贴文字、外侧不是英文字母数字」时才算：2 * 3 * 4、x**2 + y**2 保持原样
    (re.compile(rf"(?<![{_ASCII_WORD}*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![{_ASCII_WORD}*])"), r"\1"),
    (re.compile(rf"(?<![{_ASCII_WORD}*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![{_ASCII_WORD}*])"), r"\1"),
    (re.compile(rf"(?<![{_ASCII_WORD}_])__(?=\S)(.+?)(?<=\S)__(?![{_ASCII_WORD}_])"), _unwrap_unless_identifier),
    (re.compile(r"(?<!~)~~(?=\S)(.+?)(?<=\S)~~(?!~)"), r"\1"),
]


def plain_preview(markdown: str, limit: int = PREVIEW_CHARS) -> str:
    """去掉 Markdown 标记，空白折成单个空格，取前 limit 个字。代码（围栏和行内）去掉反引号、内容原样保留。
    只处理开头一段：摘要只要前 limit 个字，强调类正则在超长单行上是平方级耗时。"""
    markdown = markdown[:limit * 20]
    code: list[str] = []

    def stash(match: re.Match) -> str:
        code.append(match.group(1) if match.group(1) is not None else match.group(2))
        return f"\ue000{len(code) - 1}\ue001"

    text = _CODE.sub(stash, markdown)
    for pattern, replacement in _MARKDOWN_NOISE:
        text = pattern.sub(replacement, text)
    text = _STASH.sub(lambda match: code[int(match.group(1))], text)
    return re.sub(r"\s+", " ", text).strip()[:limit].rstrip()


def _message_text(message, role: str) -> str | None:
    """会话里第一条该角色的消息正文；数据损坏（不是 dict、没有文字）的消息跳过。"""
    if isinstance(message, dict) and message.get("role") == role and isinstance(message.get("content"), str):
        return message["content"]
    return None


def _first_message(messages: list, role: str) -> str:
    return next((text for text in (_message_text(m, role) for m in messages) if text is not None), "")


@router.get("/annotations", response_model=MyAnnotationPage)
def my_annotations(
    page: PageQuery = 1,
    limit: NotesLimitQuery = NOTES_DEFAULT_LIMIT,
    course_id: int | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户所有课程里的划线问答会话，按会话最近一次有新内容的时间倒序。"""
    # 只列自己问的
    conditions = [course_access(user.uuid), or_(
        Annotation.user_uuid == user.uuid, and_(Annotation.user_uuid.is_(None), Course.user_uuid == user.uuid),
    )]
    if course_id is not None:
        _get_owned_course(db, user, course_id)
        conditions.append(Course.id == course_id)
    sessions = (
        db.query(Annotation)
        .join(Lesson, Annotation.lesson_id == Lesson.id)
        .join(Course, Lesson.course_id == Course.id)
        .filter(*conditions)
    )
    last_activity = func.coalesce(Annotation.updated_at, Annotation.created_at)
    rows = (
        sessions.with_entities(Annotation, Course.id, Course.name, Lesson.number, _lesson_head(), Lesson.source_filename)
        .order_by(last_activity.desc(), Annotation.id.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )
    items = []
    for annotation, cid, course_name, number, head, filename in rows:
        messages = _load_messages(annotation)
        items.append(MyAnnotation(
            id=annotation.id,
            course_id=cid,
            course_name=course_name,
            lesson_number=number,
            lesson_title=_lesson_title(head, filename),
            original_text=annotation.original_text,
            question=_first_message(messages, "user") or annotation.comment,
            answer_preview=plain_preview(_first_message(messages, "assistant")),
            message_count=len(messages),
            created_at=annotation.created_at,
            updated_at=annotation.updated_at or annotation.created_at,
        ))
    return {"items": items, "page": page, "limit": limit, "total": sessions.count()}
