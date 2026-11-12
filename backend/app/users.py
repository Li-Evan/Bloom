"""「我的」页面的个人资料与设置：昵称、读完归档。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import User
from app.schemas import ArchiveOnRead, MeResponse, UpdateMeRequest

router = APIRouter(prefix="/api", tags=["users"])


def me_response(user: User) -> MeResponse:
    return MeResponse.model_validate(user)


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_current_user)):
    return me_response(user)


@router.patch("/me", response_model=MeResponse)
def update_me(body: UpdateMeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.nickname = body.nickname
    db.commit()
    return me_response(user)


@router.put("/me/archive-on-read", response_model=ArchiveOnRead)
def set_archive_on_read(body: ArchiveOnRead, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """设置里的「读完立刻归档」。只管以后点「标记已读」的文件，已经读过的不动。"""
    user.archive_on_read = body.enabled
    db.commit()
    return ArchiveOnRead(enabled=user.archive_on_read)
