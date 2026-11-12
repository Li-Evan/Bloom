"""Authenticated, bounded temporary uploads: the browser sends each file in 1 MB parts, then a course route consumes them."""
import hashlib
import io
import json
import math
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import UploadSession, UploadPart, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
CHUNK_BYTES = 1024 * 1024
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_ACTIVE_UPLOADS = 20


class FileManifest(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    size: int = Field(ge=0, le=MAX_FILE_BYTES)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class UploadManifest(BaseModel):
    files: list[FileManifest] = Field(min_length=1, max_length=50)


def cleanup_expired(db: Session) -> int:
    count = 0
    for row in db.query(UploadSession).filter(UploadSession.expires_at < datetime.now(timezone.utc).replace(tzinfo=None)).with_for_update(skip_locked=True).limit(200).all():
        db.query(UploadPart).filter_by(upload_id=row.id).delete(synchronize_session=False)
        db.delete(row)
        count += 1
    db.commit()
    return count


def owned(db: Session, upload_id: str, user_uuid: str) -> UploadSession:
    row = db.query(UploadSession).filter_by(id=upload_id, user_uuid=user_uuid).with_for_update().first()
    if row is None or row.expires_at < datetime.now(timezone.utc).replace(tzinfo=None):
        raise HTTPException(404, "Upload expired or unavailable; please upload again.")
    if any(e.get("consumed") for e in json.loads(row.manifest)):
        raise HTTPException(404, "Upload already consumed; please upload again.")
    return row


@router.post("")
def start_upload(manifest: UploadManifest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    total = sum(f.size for f in manifest.files)
    if total > MAX_TOTAL_BYTES:
        raise HTTPException(413, "Files must total at most 50 MB.")
    # 不同文件夹里的同名文件都要能传：建课时后端给后来的那个编号（见 courses.create_course_from_materials）
    if any("\x00" in f.name for f in manifest.files):
        raise HTTPException(400, "Invalid or duplicate filenames.")
    cleanup_expired(db)
    # Serialize the active-upload check for one owner.
    db.query(User).filter_by(uuid=user.uuid).with_for_update().one()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    active = db.query(UploadSession).filter(UploadSession.user_uuid == user.uuid, UploadSession.expires_at > now).all()
    if len(active) >= MAX_ACTIVE_UPLOADS or sum(row.size for row in active) + total > MAX_ACTIVE_UPLOADS * MAX_TOTAL_BYTES:
        raise HTTPException(429, f"你还有 {len(active)} 个未完成的上传（共 {sum(row.size for row in active) // (1024 * 1024)} MB），请先完成或取消后再上传")
    upload_id = uuid.uuid4().hex
    entries = [f.model_dump() for f in manifest.files]
    row = UploadSession(id=upload_id, user_uuid=user.uuid, size=max(total, 1),
                        manifest=json.dumps(entries),
                        expires_at=now + timedelta(hours=1))
    db.add(row)
    db.commit()
    return {"id": row.id, "chunk_bytes": CHUNK_BYTES, "transport": "chunks"}


@router.put("/{upload_id}/files/{file_index}/parts/{part_index}")
async def put_part(upload_id: str, file_index: int, part_index: int, request: Request,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Read a bounded body before taking the row lock.
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > CHUNK_BYTES:
            raise HTTPException(413, "Upload chunk exceeds 1 MB.")
    row = owned(db, upload_id, user.uuid)
    manifest = json.loads(row.manifest)
    if not 0 <= file_index < len(manifest):
        raise HTTPException(400, "Invalid file index.")
    size = manifest[file_index]["size"]
    count = max(1, math.ceil(size / CHUNK_BYTES))
    expected = min(CHUNK_BYTES, size - part_index * CHUNK_BYTES)
    if not 0 <= part_index < count or len(data) != expected:
        raise HTTPException(400, "Invalid chunk index or length.")
    part = db.query(UploadPart).filter_by(upload_id=upload_id, file_index=file_index, part_index=part_index).first()
    if part:
        if part.data != bytes(data):
            raise HTTPException(409, "Chunk already uploaded with different content.")
    else:
        db.add(UploadPart(upload_id=upload_id, file_index=file_index, part_index=part_index, data=bytes(data)))
    db.commit()
    return {"ok": True}


def remove_upload(db: Session, row: UploadSession):
    db.query(UploadPart).filter_by(upload_id=row.id).delete(synchronize_session=False)
    db.delete(row)
    db.commit()


@router.delete("/{upload_id}")
def cancel_upload(upload_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = owned(db, upload_id, user.uuid)
    remove_upload(db, row)
    return {"ok": True}


def take_upload(db: Session, upload_id: str, user_uuid: str) -> list[UploadFile]:
    """Consume once, checking completeness and SHA-256 before any model call."""
    row = owned(db, upload_id, user_uuid)
    files = []
    for index, entry in enumerate(json.loads(row.manifest)):
        parts = db.query(UploadPart).filter_by(upload_id=upload_id, file_index=index).order_by(UploadPart.part_index).all()
        count = max(1, math.ceil(entry["size"] / CHUNK_BYTES))
        if [p.part_index for p in parts] != list(range(count)):
            raise HTTPException(400, "Upload incomplete; please upload again.")
        raw = b"".join(p.data for p in parts)
        if len(raw) != entry["size"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise HTTPException(400, "Upload checksum mismatch; please upload again.")
        files.append(UploadFile(filename=entry["name"], file=io.BytesIO(raw), size=len(raw)))
    remove_upload(db, row)
    return files
