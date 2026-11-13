"""Owner-scoped passage bookmarks; no model calls."""
import json
import math
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator
from sqlalchemy.orm import Session
from app.auth import get_current_user
from app.database import get_db
from app.models import Course, Lesson, PassageHighlight, User, course_access

router = APIRouter(prefix="/api/courses", tags=["highlights"])

class HighlightInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position_start: int = Field(ge=0)
    position_end: int = Field(ge=0)
    original_text: str = Field(min_length=1, max_length=50000)
    anchor_top: int = Field(default=0, ge=0)
    pdf_position: str | None = Field(default=None, max_length=400000)

    @model_validator(mode="after")
    def positions(self):
        if self.position_end < self.position_start or not self.original_text.strip():
            raise ValueError("Invalid selected passage")
        return self

    @field_validator("pdf_position")
    @classmethod
    def pdf_geometry(cls, value):
        if value is None:
            return value
        data = json.loads(value)
        if not isinstance(data, dict) or not isinstance(data.get("page"), int) or data["page"] < 1:
            raise ValueError("Invalid PDF page")
        rects = data.get("rects")
        if not isinstance(rects, list) or not 1 <= len(rects) <= 4000:
            raise ValueError("Invalid PDF rectangles")
        for rect in rects:
            if not isinstance(rect, dict) or type(rect.get("page")) is not int or rect["page"] < 1 or any(not isinstance(rect.get(k), (int, float)) or not math.isfinite(rect[k]) or not 0 <= rect[k] <= 1 for k in ("x", "y", "w", "h")):
                raise ValueError("Invalid PDF rectangle")
        return json.dumps(data, sort_keys=True)

class HighlightOutput(HighlightInput):
    model_config = ConfigDict(from_attributes=True)
    id: int
    lesson_id: int

def owned_lesson_id(db, user, course_id, lesson_num) -> int:
    """Only the id: an uploaded original lesson can hold a million characters."""
    row = db.query(Lesson.id).join(Course).filter(Course.id == course_id, course_access(user.uuid), Lesson.number == lesson_num).first()
    if row is None:
        raise HTTPException(404, "找不到这篇课文")
    return row.id

@router.get("/{course_id}/lessons/{lesson_num}/highlights", response_model=list[HighlightOutput])
def list_highlights(course_id: int, lesson_num: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lesson_id = owned_lesson_id(db, user, course_id, lesson_num)
    items = db.query(PassageHighlight).filter_by(lesson_id=lesson_id).order_by(PassageHighlight.id).all()
    return [HighlightOutput.model_validate(item) for item in items]

@router.post("/{course_id}/lessons/{lesson_num}/highlights", response_model=HighlightOutput)
def save_highlight(course_id: int, lesson_num: int, req: HighlightInput, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lesson_id = owned_lesson_id(db, user, course_id, lesson_num)
    # Serialize repeat saves of the same selection without creating duplicates.
    db.query(Course.id).filter_by(id=course_id).with_for_update().first()
    fields = req.model_dump()
    found = db.query(PassageHighlight).filter_by(lesson_id=lesson_id, user_uuid=user.uuid, position_start=req.position_start, position_end=req.position_end, original_text=req.original_text, pdf_position=req.pdf_position).first()
    if found:
        return found
    item = PassageHighlight(lesson_id=lesson_id, user_uuid=user.uuid, **fields)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.delete("/{course_id}/lessons/{lesson_num}/highlights/{highlight_id}")
def remove_highlight(course_id: int, lesson_num: int, highlight_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lesson_id = owned_lesson_id(db, user, course_id, lesson_num)
    item = db.query(PassageHighlight).filter_by(id=highlight_id, lesson_id=lesson_id).first()
    if item is None:
        raise HTTPException(404, "找不到这条标记")
    db.delete(item)
    db.commit()
    return {"ok": True}
