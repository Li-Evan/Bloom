import json
import logging
import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from app import prompts_en
from app import tracing
from app.auth import get_current_user
from app.config import settings
from app.course_language import SCOPE_PRESENT_RE, text_for
from app.courses import (
    _bare_mastery, _call_llm, _get_owned_course, _lesson_head, _lesson_title, _progress_lessons,
    _strip_markdown_fences, on_model_failure, _read_numbers_by_course, _read_syllabus,
)
from app.database import get_db
from app.errors import with_reason
from app.models import (
    Annotation, Course, Feedback, LearningEvent, LearningRecommendation, Lesson, User, course_access,
)
from app.schemas import (
    Language,
    RecommendationDashboardResponse,
    RecommendationResponse,
    RefreshRecommendationsRequest,
    StartRecommendationRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])

RECOMMENDATION_PROMPT = """你是 Bloom 学习系统的学习路径推荐模块。

你需要根据学习者的已学内容画像和待学清单，推荐 3 个接下来值得新开一门课来学的主题。

先读懂画像：
- 课程按最近学习的时间排列，越靠前越是学习者现在的重心
- 「已经学过」是学习者读完的课文讲过的内容；「这门课接下来会讲」是原课程还没讲到、之后会接着讲的内容，学习者在原课程里继续学就会学到
- 「这门课不讲」是原课程大纲明确排除的相关主题，可以作为补地基或往外拓展的候选
- 「划线提问」和「课后反馈」是学习者卡住或好奇的地方
- 「待学清单」是学习者自己收藏、想学的方向

推荐原则：
1. 推荐的是一门新课：不能和任何一门课「这门课接下来会讲」的内容重合，也不能把其中一部分换个说法再推荐
2. 主题必须从「已经学过」的内容自底向上生长出来，说明它接在哪些旧知识之上；要先学完原课程后面的内容才能学的，不要推荐
3. 三个主题之间要有明显差异：
   - 一个补地基（kind 写 foundation）：原课程默认学习者已经会、但课程本身不专门讲的先修知识，优先选学习者在划线提问或课后反馈里卡住的地方
   - 一个做交叉连接（kind 写 connect）：用真实的共同方法、机制或前后衔接，把学习者学过的两块内容连起来，只是用词相同或打个比方不算；它也得带来新知识，不能只是把学过的两块内容合起来复习一遍；几门课之间没有真实联系时，就连接已学内容和同一领域里的相邻主题，不要硬连不相干的课程
   - 一个稍微向外扩展（kind 写 explore）：从学习者现在的重心往外走一步，超出原课程大纲的范围
4. 优先围绕最近在学的课程和待学清单，不必每门课都照顾到
5. 主题名要适合直接创建课程，不要写成句子；不要推荐已经学过、正在学、已收藏、已开始的主题
6. rationale 和 bridge 是直接说给学习者看的话：用第二人称「你」称呼学习者（如「你已经学过……」「它接在你学过的……之上」；若用英文写则用 you），不要写成「用户已具备……」「该用户……」这类第三人称；说「你已经学过」时只能引用「已经学过」里的内容或读过的文件，不能把还没讲到的内容说成学过
7. source_topics 写这个主题接着的已学课程名，和画像里《》中的课程名一字不差
8. 只输出 JSON 数组，不要输出 markdown 或解释

JSON 格式：
[
  {
    "kind": "foundation、connect、explore 三选一",
    "title": "主题名",
    "rationale": "为什么现在学它，对「你」说，控制在 1-2 句",
    "bridge": "它如何连接你已学过的内容，对「你」说，控制在 1 句",
    "source_topics": ["课程名A", "课程名B"]
  }
]
"""

RECOMMENDATION_PROMPTS = {"zh": RECOMMENDATION_PROMPT, "en": prompts_en.RECOMMENDATION_PROMPT}
MAX_PROFILE_COURSES = 30
MAX_DETAILED_COURSES = 8  # 最近学的这几门写全大纲和提问，更早的只列名字
MAX_HIGHLIGHTS = 5  # 每门课最近的几条划线提问
MAX_FEEDBACK = 2
MAX_OUTSIDE = 6
MAX_FILES = 12
MAX_WISHLIST = 15
SNIPPET_CHARS = 80
MAX_DISMISSED_AVOIDED = 30
KINDS = ("foundation", "connect", "explore")
# 划线翻译上线前，有人在提问框里只写「翻译」：说明的是看不懂外文，不是卡在哪个知识点上
TRANSLATE_ONLY = {"翻译", "翻譯", "translate", "translation"}


class RecommendationItem(RecommendationResponse):
    kind: Literal["foundation", "connect", "explore"] | None = None  # rows saved before the field existed have none


class RecommendationDashboard(RecommendationDashboardResponse):
    recommendations: list[RecommendationItem]
    saved: list[RecommendationItem]

_JSON_ARRAY_RE = re.compile(r"\[[\s\S]*\]")


def _normalize_title(title: str) -> str:
    return re.sub(r"\s+", "", title.strip().lower())


def _decode_sources(raw: str | None) -> tuple[list[str], str | None]:
    """source_topics holds {"topics": [...], "kind": ...}; rows saved before the kind existed hold a bare list."""
    if not raw:
        return [], None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return [], None
    kind = None
    if isinstance(data, dict):
        kind = data.get("kind") if data.get("kind") in KINDS else None
        data = data.get("topics")
    if not isinstance(data, list):
        return [], kind
    return [str(item) for item in data if str(item).strip()], kind


def _to_response(item: LearningRecommendation) -> RecommendationItem:
    topics, kind = _decode_sources(item.source_topics)
    return RecommendationItem(
        id=item.id,
        title=item.title,
        rationale=item.rationale,
        bridge=item.bridge or "",
        source_topics=topics,
        kind=kind,
        status=item.status,
        generation=item.generation,
        language=item.language,
        course_id=item.course_id,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _dashboard_response(db: Session, user_uuid: str) -> RecommendationDashboard:
    suggestions = db.query(LearningRecommendation).filter(
        LearningRecommendation.user_uuid == user_uuid,
        LearningRecommendation.status == "suggested",
        LearningRecommendation.node_id.is_(None),  # 单门课坐标卡片上的相邻方向不进这里，收进待学清单后才出现在下面的 saved 里
    ).order_by(
        LearningRecommendation.generation.desc(),
        LearningRecommendation.id.desc(),
    ).limit(3).all()
    suggestions = list(reversed(suggestions))

    saved = db.query(LearningRecommendation).filter(
        LearningRecommendation.user_uuid == user_uuid,
        LearningRecommendation.status == "saved",
    ).order_by(LearningRecommendation.updated_at.desc()).all()

    return RecommendationDashboard(
        recommendations=[_to_response(item) for item in suggestions],
        saved=[_to_response(item) for item in saved],
    )


def _outline_parts(syllabus: str) -> tuple[list[str], list[str], list[str]]:
    """已读课文讲过的掌握项、原课程还没讲到的掌握项、大纲「不在本课题范围内」列出的相关主题。
    整份大纲都给模型：只给前几条时，后面没列出的内容会被当成新主题推荐出去。"""
    learned, upcoming, outside, in_scope_section = {}, {}, [], False
    for line in syllabus.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_scope_section = bool(SCOPE_PRESENT_RE.search(stripped))
        elif stripped.startswith(("- [x]", "- [X]", "- [ ]")):
            (upcoming if stripped.startswith("- [ ]") else learned)[_bare_mastery(stripped[6:].strip())] = None
        elif in_scope_section and stripped.startswith("- ") and stripped[2:].strip():
            outside.append(stripped[2:].strip())
    return list(learned), [item for item in upcoming if item not in learned], outside


def _naive_utc(at: datetime | None) -> datetime | None:
    return at.astimezone(timezone.utc).replace(tzinfo=None) if at is not None and at.tzinfo else at


def _when(text, at: datetime, now: datetime) -> str:
    days = (now.date() - at.date()).days
    return text.rec_today if days <= 0 else text.rec_yesterday if days == 1 else text.rec_days_ago.format(days=days)


def _clip(value: str | None, limit: int = SNIPPET_CHARS) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    return value if len(value) <= limit else value[:limit - 1] + "…"


def _build_learning_profile(db: Session, user_uuid: str, language: str = "zh") -> str:
    """推荐看的学习画像：课程按最近学习排序；最近的几门写清已经学过什么、原课程接下来会讲什么（这些不能推荐成新课），
    以及划线提问和课后反馈（卡住的地方）；资料课写读过和没读的文件标题；更早的课只列名字。"""
    text = text_for(language)
    courses = db.query(Course).filter(course_access(user_uuid)).options(selectinload(Course.syllabus)).all()
    if not courses:
        return text.rec_no_courses
    studied = dict(db.query(LearningEvent.course_id, func.max(LearningEvent.created_at)).filter(
        LearningEvent.course_id.in_([course.id for course in courses])).group_by(LearningEvent.course_id)) if courses else {}
    last = {course.id: _naive_utc(studied.get(course.id) or course.created_at) or datetime.min for course in courses}
    courses = sorted(courses, key=lambda course: (last[course.id], course.id), reverse=True)[:MAX_PROFILE_COURSES]
    detailed, older = courses[:MAX_DETAILED_COURSES], courses[MAX_DETAILED_COURSES:]

    # 只有写细的几门才读课文、提问和反馈：更早的课只列名字，不用把它们的课文全文读出来
    ids = [course.id for course in detailed]
    read = _read_numbers_by_course(db, ids)
    progress = _progress_lessons(db, [course.id for course in detailed if not course.is_project])
    heads = {course_id: [] for course_id in ids}
    for course_id, number, head, filename in db.query(Lesson.course_id, Lesson.number, _lesson_head(), Lesson.source_filename).filter(
            Lesson.course_id.in_(ids), Lesson.number > 0).order_by(Lesson.number):
        heads[course_id].append((number, _lesson_title(head, filename)))
    ranked = db.query(
        Lesson.course_id.label("course_id"), func.substr(Annotation.original_text, 1, 200).label("quote"),
        func.substr(func.trim(Annotation.comment), 1, 200).label("question"),
        func.row_number().over(partition_by=Lesson.course_id, order_by=Annotation.id.desc()).label("rank"),
    ).join(Annotation, Annotation.lesson_id == Lesson.id).filter(
        Lesson.course_id.in_(ids), func.trim(Annotation.comment) != "",
        func.lower(func.trim(Annotation.comment)).notin_(sorted(TRANSLATE_ONLY)),
        or_(Annotation.user_uuid == user_uuid, Annotation.user_uuid.is_(None)),
    ).subquery()
    highlights = {course_id: [] for course_id in ids}
    for course_id, quote, question in db.query(ranked.c.course_id, ranked.c.quote, ranked.c.question).filter(
            ranked.c.rank <= MAX_HIGHLIGHTS).order_by(ranked.c.course_id, ranked.c.rank):
        highlights[course_id].append(text.rec_highlight.format(quote=_clip(quote), question=_clip(question)))
    feedback = {course_id: [] for course_id in ids}
    for course_id, content in db.query(Lesson.course_id, func.substr(Feedback.content, 1, 400)).join(
            Feedback, Feedback.lesson_id == Lesson.id).filter(
            Lesson.course_id.in_(ids), func.trim(Feedback.content) != "").order_by(Feedback.id.desc()):
        if len(feedback[course_id]) < MAX_FEEDBACK:
            feedback[course_id].append(f"    - {_clip(content, 2 * SNIPPET_CHARS)}")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    blocks = [text.rec_order]
    for course in detailed:
        when = _when(text, last[course.id], now)
        if course.is_project:
            files = [(number, title or text.rec_project_file_fallback.format(number=number)) for number, title in heads[course.id]]
            done = [title for number, title in files if number in read[course.id]]
            todo = [title for number, title in files if number not in read[course.id]]
            lines = [text.rec_project.format(name=course.name, when=when, read=len(done), total=len(files))]
            if done:
                lines.append(text.rec_project_read.format(files=text.rec_separator.join(done[:MAX_FILES])))
            if todo:
                lines.append(text.rec_project_unread.format(files=text.rec_separator.join(todo[:MAX_FILES])))
        elif course.syllabus:
            learned, upcoming, outside = _outline_parts(_read_syllabus(course, db, read_numbers=read[course.id], lessons=progress[course.id]))
            lines = [text.rec_course.format(name=course.name, when=when)
                     + text.rec_course_progress.format(covered=len(learned), total=len(learned) + len(upcoming)),
                     text.rec_learned if learned else text.rec_learned_none, *(f"    - {item}" for item in learned)]
            if upcoming:
                lines += [text.rec_upcoming, *(f"    - {item}" for item in upcoming)]
            if outside:
                lines.append(text.rec_outside.format(topics=text.rec_separator.join(_clip(topic, 40) for topic in outside[:MAX_OUTSIDE])))
        else:
            titles = [title or text.rec_lesson_fallback.format(number=number) for number, title in heads[course.id]][:8]
            lines = [text.rec_course.format(name=course.name, when=when),
                     text.rec_lessons.format(titles=text.rec_separator.join(titles) or text.rec_none)]
        if highlights[course.id]:
            lines += [text.rec_highlights, *highlights[course.id]]
        if feedback[course.id]:
            lines += [text.rec_feedback, *feedback[course.id]]
        blocks.append("\n".join(lines))
    if older:
        blocks.append(text.rec_older.format(courses=text.rec_separator.join(
            text.rec_older_course.format(name=course.name, when=_when(text, last[course.id], now)) for course in older)))
    return "\n\n".join(blocks)


def _wishlist(db: Session, user_uuid: str) -> list[str]:
    return [title for (title,) in db.query(LearningRecommendation.title).filter(
        LearningRecommendation.user_uuid == user_uuid, LearningRecommendation.status == "saved",
    ).order_by(LearningRecommendation.updated_at.desc()).limit(MAX_WISHLIST) if title]


def _avoid_titles(db: Session, user_uuid: str) -> list[str]:
    """Courses, current suggestions, every saved or started topic, and only the latest dismissed ones
    (refreshed away, removed from the wishlist, or marked 不感兴趣), latest by when they were dismissed."""
    course_titles = [row[0] for row in db.query(Course.name).filter(course_access(user_uuid))]
    kept = [row[0] for row in db.query(LearningRecommendation.title).filter(
        LearningRecommendation.user_uuid == user_uuid,
        LearningRecommendation.status.in_(("suggested", "saved", "started")),
    ).order_by(LearningRecommendation.created_at.desc())]
    dismissed = [row[0] for row in db.query(LearningRecommendation.title).filter(
        LearningRecommendation.user_uuid == user_uuid, LearningRecommendation.status == "dismissed",
    ).order_by(LearningRecommendation.updated_at.desc(), LearningRecommendation.id.desc()).limit(MAX_DISMISSED_AVOIDED)]
    return list(dict.fromkeys(title for title in [*course_titles, *kept, *dismissed] if title))


def _parse_recommendation_payload(raw: str) -> list[dict]:
    text = _strip_markdown_fences(raw)
    try:
        data = json.loads(text)
    except ValueError:
        match = _JSON_ARRAY_RE.search(text)
        if not match:
            raise ValueError("no JSON array found")
        data = json.loads(match.group(0))

    if not isinstance(data, list):
        raise ValueError("recommendation payload must be a list")
    return [item for item in data if isinstance(item, dict)]


def _generate_recommendations(db: Session, user_uuid: str, language: str = "zh") -> list[LearningRecommendation]:
    avoid = _avoid_titles(db, user_uuid)
    blocked = {_normalize_title(title) for title in avoid}
    text = text_for(language)
    user_message = text.rec_message.format(
        profile=_build_learning_profile(db, user_uuid, language),
        wishlist="\n".join(f"- {title}" for title in _wishlist(db, user_uuid)) or text.rec_none,
        avoid=", ".join(avoid) if avoid else text.rec_none,
    )
    db.rollback()  # only reads so far: free the connection while the model runs
    with tracing.llm_name("recommend-courses"):
        raw = _call_llm(RECOMMENDATION_PROMPTS[language], user_message)

    try:
        payload = _parse_recommendation_payload(raw)
    except ValueError as exc:
        logger.exception("Recommendation payload parse error")
        raise HTTPException(status_code=502, detail=with_reason("没能生成推荐：模型返回的内容读不出来，请稍后重试", exc)) from exc

    seen = set()
    recommendations = []
    for item in payload:
        title = str(item.get("title", "")).strip()
        norm = _normalize_title(title)
        if not title or norm in blocked or norm in seen:
            continue
        seen.add(norm)
        topics = item.get("source_topics", [])
        if not isinstance(topics, list):
            topics = []
        kind = str(item.get("kind", "")).strip().lower()
        recommendations.append(
            LearningRecommendation(
                user_uuid=user_uuid,
                title=title[:200],
                rationale=str(item.get("rationale", "")).strip()[:1000],
                bridge=str(item.get("bridge", "")).strip()[:1000],
                source_topics=json.dumps({"topics": [str(topic) for topic in topics[:6]], "kind": kind if kind in KINDS else None},
                                         ensure_ascii=False),
                status="suggested",
                language=language,
            )
        )
        if len(recommendations) == 3:
            break

    if not recommendations:
        raise HTTPException(status_code=502, detail="没能生成推荐：模型给的主题都和学过或推荐过的重复，请稍后重试")
    return recommendations


def _get_owned_recommendation(db: Session, user: User, recommendation_id: int) -> LearningRecommendation:
    recommendation = db.query(LearningRecommendation).filter(
        LearningRecommendation.id == recommendation_id, LearningRecommendation.user_uuid == user.uuid
    ).first()
    if not recommendation:
        raise HTTPException(status_code=404, detail="找不到这条推荐")
    return recommendation


@router.get("", response_model=RecommendationDashboard)
def get_recommendations(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _dashboard_response(db, user.uuid)


@router.post("/refresh", response_model=RecommendationDashboard)
def refresh_recommendations(
    req: RefreshRecommendationsRequest | None = None,
    locale: Language | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """locale（zh / en，缺省 zh）决定推荐标题与理由的语言；可放在 JSON 请求体里，也可以作为查询参数，两处都给时以请求体为准。"""
    language = (req.locale if req else None) or locale or "zh"
    user_uuid = user.uuid
    with tracing.trace(
        "refresh-recommendations",
        user_id=user_uuid,
        input={"language": language},
        metadata={"feature": "recommendation", "model": settings.LLM_MODEL},
        tags=["recommendation"],
    ) as trace_span:
        with on_model_failure(db):
            new_items = _generate_recommendations(db, user_uuid, language)
            # Concurrent refreshes (two tabs) serialize here: each one replaces the suggestions saved before it.
            db.query(User.id).filter(User.uuid == user_uuid).with_for_update().one()
            generation = (
                db.query(func.max(LearningRecommendation.generation))
                .filter(LearningRecommendation.user_uuid == user_uuid)
                .scalar() or 0
            ) + 1
            for item in new_items:
                item.generation = generation

            db.query(LearningRecommendation).filter(
                LearningRecommendation.user_uuid == user_uuid,
                LearningRecommendation.status == "suggested",
                LearningRecommendation.node_id.is_(None),
            ).update({"status": "dismissed"})
            db.add_all(new_items)
            db.commit()
            trace_span.update(output="\n".join(item.title for item in new_items))
        return _dashboard_response(db, user_uuid)


@router.post("/{recommendation_id}/save", response_model=RecommendationItem)
def save_recommendation(
    recommendation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    recommendation = _get_owned_recommendation(db, user, recommendation_id)
    if recommendation.status == "started":
        raise HTTPException(status_code=400, detail="已经开始学的推荐不能加入待学清单")
    recommendation.status = "saved"
    db.commit()
    db.refresh(recommendation)
    return _to_response(recommendation)


@router.delete("/{recommendation_id}/save")
def remove_saved_recommendation(
    recommendation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    recommendation = _get_owned_recommendation(db, user, recommendation_id)
    recommendation.status = "dismissed"
    db.commit()
    return {"ok": True}


@router.post("/{recommendation_id}/dismiss")
def dismiss_recommendation(
    recommendation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """不感兴趣：这条推荐不再显示，之后刷新推荐时避开这个主题，别的课找相邻方向时也跳过这个知识点。"""
    recommendation = _get_owned_recommendation(db, user, recommendation_id)
    if recommendation.status == "started":
        raise HTTPException(status_code=400, detail="已经开始学的推荐不能标成不感兴趣")
    recommendation.status = "dismissed"
    db.commit()
    return {"ok": True}


@router.delete("/{recommendation_id}/dismiss", response_model=RecommendationItem)
def restore_recommendation(
    recommendation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """撤销「不感兴趣」：放回原来的位置。"""
    recommendation = _get_owned_recommendation(db, user, recommendation_id)
    if recommendation.status == "dismissed":
        recommendation.status = "suggested"
        db.commit()
        db.refresh(recommendation)
    return _to_response(recommendation)


@router.post("/{recommendation_id}/start", response_model=RecommendationItem)
def start_recommendation(
    recommendation_id: int,
    req: StartRecommendationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    recommendation = _get_owned_recommendation(db, user, recommendation_id)
    if req.course_id:
        _get_owned_course(db, user, req.course_id)
    recommendation.status = "started"
    recommendation.course_id = req.course_id
    db.commit()
    db.refresh(recommendation)
    return _to_response(recommendation)
