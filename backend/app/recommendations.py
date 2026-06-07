import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.courses import _call_llm, _extract_title, _mastery_progress, _strip_markdown_fences
from app.database import get_db
from app.models import Course, LearningRecommendation
from app.schemas import (
    RecommendationDashboardResponse,
    RecommendationResponse,
    StartRecommendationRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])

RECOMMENDATION_PROMPT = """你是 Bloom 学习系统的学习路径推荐模块。

你需要根据用户已经学过的所有课程、大纲掌握项、课文标题与待学习清单，推荐 3 个下一步学习主题。

推荐原则：
1. 主题必须从已学内容自底向上生长出来，说明它接在哪些旧知识之上
2. 不要推荐已经学过、正在学、已收藏、已开始的主题
3. 三个主题之间要有明显差异：一个补地基，一个做交叉连接，一个稍微向外扩展
4. 主题名要适合直接创建课程，不要写成句子
5. 只输出 JSON 数组，不要输出 markdown 或解释

JSON 格式：
[
  {
    "title": "主题名",
    "rationale": "为什么现在学它，控制在 1-2 句",
    "bridge": "它如何连接用户已学内容，控制在 1 句",
    "source_topics": ["已学主题A", "已学主题B"]
  }
]
"""

_JSON_ARRAY_RE = re.compile(r"\[[\s\S]*\]")


def _normalize_title(title: str) -> str:
    return re.sub(r"\s+", "", title.strip().lower())


def _decode_topics(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [str(item) for item in data if str(item).strip()]


def _to_response(item: LearningRecommendation) -> RecommendationResponse:
    return RecommendationResponse(
        id=item.id,
        title=item.title,
        rationale=item.rationale,
        bridge=item.bridge or "",
        source_topics=_decode_topics(item.source_topics),
        status=item.status,
        generation=item.generation,
        course_id=item.course_id,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _dashboard_response(db: Session) -> RecommendationDashboardResponse:
    suggestions = db.query(LearningRecommendation).filter(
        LearningRecommendation.status == "suggested"
    ).order_by(
        LearningRecommendation.generation.desc(),
        LearningRecommendation.created_at.desc(),
    ).limit(3).all()
    suggestions = list(reversed(suggestions))

    saved = db.query(LearningRecommendation).filter(
        LearningRecommendation.status == "saved"
    ).order_by(LearningRecommendation.updated_at.desc()).all()

    return RecommendationDashboardResponse(
        recommendations=[_to_response(item) for item in suggestions],
        saved=[_to_response(item) for item in saved],
    )


def _mastery_lines(course: Course) -> list[str]:
    if not course.syllabus:
        return []
    lines = []
    for line in course.syllabus.content.splitlines():
        stripped = line.strip()
        if stripped.startswith("- ["):
            lines.append(stripped)
    return lines[:10]


def _build_learning_profile(db: Session) -> str:
    courses = db.query(Course).order_by(Course.created_at.asc()).all()
    if not courses:
        return "用户还没有课程记录。请推荐适合作为长期学习地基的入门主题。"

    blocks = []
    for course in courses:
        lesson_titles = [
            _extract_title(lesson.content) or f"第{lesson.number}篇"
            for lesson in course.lessons
            if lesson.number > 0
        ][:8]
        mastery = "\n".join(f"    {line}" for line in _mastery_lines(course)) or "    暂无大纲掌握项"
        blocks.append(
            "\n".join([
                f"- 课程：{course.name}",
                f"  状态：{course.status}",
                f"  进度：{round(_mastery_progress(course.syllabus.content) * 100) if course.syllabus else 0}%",
                f"  课文：{', '.join(lesson_titles) if lesson_titles else '暂无课文'}",
                "  掌握项：",
                mastery,
            ])
        )
    return "\n\n".join(blocks)


def _avoid_titles(db: Session) -> list[str]:
    course_titles = [row[0] for row in db.query(Course.name).all()]
    recommendation_titles = [
        row[0]
        for row in db.query(LearningRecommendation.title).filter(
            LearningRecommendation.status.in_(("suggested", "saved", "started", "dismissed"))
        ).order_by(LearningRecommendation.created_at.desc()).limit(30).all()
    ]
    return [title for title in [*course_titles, *recommendation_titles] if title]


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


def _generate_recommendations(db: Session, generation: int) -> list[LearningRecommendation]:
    avoid = _avoid_titles(db)
    blocked = {_normalize_title(title) for title in avoid}
    user_message = f"""## 已学内容画像

{_build_learning_profile(db)}

## 不要推荐这些主题

{", ".join(avoid) if avoid else "无"}
"""
    raw = _call_llm(RECOMMENDATION_PROMPT, user_message)

    try:
        payload = _parse_recommendation_payload(raw)
    except ValueError as exc:
        logger.exception("Recommendation payload parse error")
        raise HTTPException(status_code=500, detail=f"推荐生成失败：模型返回格式无法解析（{exc}）")

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
        recommendations.append(
            LearningRecommendation(
                title=title[:200],
                rationale=str(item.get("rationale", "")).strip()[:1000],
                bridge=str(item.get("bridge", "")).strip()[:1000],
                source_topics=json.dumps([str(topic) for topic in topics[:6]], ensure_ascii=False),
                status="suggested",
                generation=generation,
            )
        )
        if len(recommendations) == 3:
            break

    if len(recommendations) < 3:
        raise HTTPException(status_code=500, detail="推荐生成失败：有效主题不足 3 个，请刷新重试")
    return recommendations


@router.get("", response_model=RecommendationDashboardResponse)
def get_recommendations(db: Session = Depends(get_db)):
    return _dashboard_response(db)


@router.post("/refresh", response_model=RecommendationDashboardResponse)
def refresh_recommendations(db: Session = Depends(get_db)):
    generation = (db.query(func.max(LearningRecommendation.generation)).scalar() or 0) + 1
    new_items = _generate_recommendations(db, generation)

    db.query(LearningRecommendation).filter(
        LearningRecommendation.status == "suggested"
    ).update({"status": "dismissed"})
    db.add_all(new_items)
    db.commit()
    return _dashboard_response(db)


@router.post("/{recommendation_id}/save", response_model=RecommendationResponse)
def save_recommendation(recommendation_id: int, db: Session = Depends(get_db)):
    recommendation = db.query(LearningRecommendation).filter(
        LearningRecommendation.id == recommendation_id
    ).first()
    if not recommendation:
        raise HTTPException(status_code=404, detail="推荐不存在")
    if recommendation.status == "started":
        raise HTTPException(status_code=400, detail="已开始学习的推荐不能加入待学习清单")
    recommendation.status = "saved"
    db.commit()
    db.refresh(recommendation)
    return _to_response(recommendation)


@router.delete("/{recommendation_id}/save")
def remove_saved_recommendation(recommendation_id: int, db: Session = Depends(get_db)):
    recommendation = db.query(LearningRecommendation).filter(
        LearningRecommendation.id == recommendation_id
    ).first()
    if not recommendation:
        raise HTTPException(status_code=404, detail="推荐不存在")
    recommendation.status = "dismissed"
    db.commit()
    return {"ok": True}


@router.post("/{recommendation_id}/start", response_model=RecommendationResponse)
def start_recommendation(
    recommendation_id: int,
    req: StartRecommendationRequest,
    db: Session = Depends(get_db),
):
    recommendation = db.query(LearningRecommendation).filter(
        LearningRecommendation.id == recommendation_id
    ).first()
    if not recommendation:
        raise HTTPException(status_code=404, detail="推荐不存在")
    if req.course_id:
        course = db.query(Course).filter(Course.id == req.course_id).first()
        if not course:
            raise HTTPException(status_code=404, detail="课程不存在")
    recommendation.status = "started"
    recommendation.course_id = req.course_id
    db.commit()
    db.refresh(recommendation)
    return _to_response(recommendation)
