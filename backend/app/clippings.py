"""Web clippings: the browser extension hands over a page the user already has open, and it becomes one more file
in that user's single 「网页剪藏」 course. The article is what 网页原文 would import from the same address whenever the
server can read it (web_import.clip_article), else the page from the browser; the course is an ordinary project course."""

import asyncio
import re
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import web_import
from app.auth import get_current_user
from app.config import settings
from app.courses import _append_project_lessons, _read_project_files, _record_event
from app.database import get_db
from app.models import Course, Lesson
from app.models import User
from app.schemas import Language

router = APIRouter(prefix="/api/clippings", tags=["clippings"])

COURSE_NAME = {"zh": "网页剪藏", "en": "Web Clippings"}
# Same first lines as a 网页原文 lesson (frontend lib/learn/web-import.ts)
SOURCE_LABEL = {"zh": "查看来源网页", "en": "View original article"}


class ClipRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4096)
    # Characters, not bytes: extract_page checks the UTF-8 size against the same 4 MB limit as the web import
    html: str = Field(min_length=1, max_length=web_import.MAX_BYTES)
    language: Language = "zh"  # only used when the clippings course is created


class ClipResponse(BaseModel):
    course_id: int
    lesson_number: int
    existed: bool = False  # this page was clipped before: open that file instead of adding it again


def article_markdown(article: web_import.WebPreview, language: str) -> str:
    title = re.sub(r"([\\`*_{}\[\]<>#!|])", r"\\\1", re.sub(r"[\r\n]+", " ", article.title))
    source = article.url.replace("<", "%3C").replace(">", "%3E")
    return f"# {title}\n\n[{SOURCE_LABEL[language]}](<{source}>)\n\n---\n\n{article.content}\n"


def article_filename(title: str) -> str:
    return (" ".join(re.sub(r'[\\/\x00-\x1f<>:"|?*]', " ", title).split())[:160] or "article") + ".md"


def clipped_before(db: Session, user_uuid: str, url: str) -> tuple[int, int] | None:
    """The newest file from this page in any of the user's own courses (it may have been moved out of 网页剪藏)."""
    return db.query(Lesson.course_id, Lesson.number).join(Course).filter(
        Course.user_uuid == user_uuid, Lesson.source_url == url, Lesson.number > 0).order_by(Lesson.id.desc()).first()


def clippings_course(db: Session, user_uuid: str, language: str) -> Course:
    """The user's 网页剪藏 course, created on the first clip. Two first clips at once: the unique index lets one win."""
    for _ in range(2):
        course = db.query(Course).filter(Course.user_uuid == user_uuid, Course.is_clippings.is_(True)).first()
        if course is not None:
            return course
        course = Course(user_uuid=user_uuid, name=COURSE_NAME[language], mode="source", is_project=True, is_clippings=True,
                        status="learning", learning_depth="standard", language=language)
        db.add(course)
        try:
            db.flush()
            _record_event(db, course.id, "project_created")
            db.commit()
            return course
        except IntegrityError:
            db.rollback()
    raise HTTPException(status_code=409, detail="网页剪藏正在创建，请再点一次")


def _site(url: str) -> str:
    host = urlsplit(url).hostname or ""
    return host[4:] if host.startswith("www.") else host


def _clip(db: Session, user_uuid: str, req: ClipRequest) -> ClipResponse:
    url = web_import.normalize_url(req.url, any_port=True)
    # Clicking the extension on a Bloom lesson would save Bloom's own page into Bloom
    if _site(url) == _site(settings.WEB_URL):
        raise HTTPException(status_code=400, detail="这一页本来就在 Bloom 里，不用再剪")
    found = clipped_before(db, user_uuid, url)
    if found is not None:
        return ClipResponse(course_id=found[0], lesson_number=found[1], existed=True)
    with web_import.extraction_slot(user_uuid):
        article = web_import.clip_article(req.html, url)
    course = clippings_course(db, user_uuid, req.language)
    language = course.language
    upload = (article_filename(article.title), article_markdown(article, language).encode())
    pages, skipped, image_ids = _read_project_files(db, user_uuid, [upload], language)
    if not pages:
        raise HTTPException(status_code=422, detail=f"没能保存这篇网页：{'；'.join(skipped)}")
    numbers = _append_project_lessons(db, user_uuid, course.id, pages, image_ids, "clipping_added", source_url=url)
    return ClipResponse(course_id=course.id, lesson_number=numbers[0])


@router.post("", response_model=ClipResponse)
async def clip(req: ClipRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Unmetered like 网页原文: no model is called."""
    return await asyncio.to_thread(_clip, db, user.uuid, req)
