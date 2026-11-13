"""Images inside uploaded material, stored as files under IMAGE_STORE_DIR and served only to the course owner."""

import io
import logging
import re
import time
import uuid
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ProjectImage

logger = logging.getLogger(__name__)
IMAGE_SUFFIXES = {"jpg", "jpeg", "png", "gif", "webp"}
IMAGE_TYPES = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "GIF": ("image/gif", "gif"),
    "WEBP": ("image/webp", "webp"),
}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 25_000_000
_KEY = re.compile(r"[a-f0-9]{32}\.(?:jpg|png|gif|webp)")


def validate_image(path: str, raw: bytes) -> tuple[str, str]:
    from PIL import Image, UnidentifiedImageError  # only image uploads need Pillow: keep it out of API startup

    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(400, f"图片超过 10 MB：{path}")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.width * image.height > MAX_PIXELS or image.format not in IMAGE_TYPES:
                    raise ValueError("Unsupported dimensions or format")
                kind = IMAGE_TYPES[image.format]
                image.verify()
                return kind
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        SyntaxError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise HTTPException(400, f"图片无法读取或尺寸过大：{path}") from exc


def _path(key: str) -> Path:
    # object_key is always generated here, never taken from a request; still refuse anything but "<hex>.<ext>"
    if not _KEY.fullmatch(key):
        raise HTTPException(400, "图片名称无效")
    return Path(settings.IMAGE_STORE_DIR) / key


def upload_images(db: Session, user_uuid: str, images: list[tuple[str, bytes]]) -> tuple[dict[str, str], list[str]]:
    if not images:
        return {}, []
    prepared = [(path, raw, *validate_image(path, raw)) for path, raw in images]
    records, urls = [], {}
    for path, raw, content_type, extension in prepared:
        identifier = uuid.uuid4().hex
        record = ProjectImage(
            id=identifier,
            user_uuid=user_uuid,
            object_key=f"{identifier}.{extension}",
            content_type=content_type,
            size=len(raw),
        )
        db.add(record)
        records.append(record)
        urls[path] = f"/api/project-images/{identifier}"
    # Persist the rows before writing files: an interruption leaves records the orphan cleanup can remove.
    db.commit()
    ids = [record.id for record in records]
    try:
        Path(settings.IMAGE_STORE_DIR).mkdir(parents=True, exist_ok=True)
        for record, (_, raw, _, _) in zip(records, prepared, strict=True):
            _path(record.object_key).write_bytes(raw)
    except OSError as exc:
        logger.warning("Saving images failed (%s)", type(exc).__name__)
        cleanup_images(db, ids)
        raise HTTPException(503, "图片没能保存到本地磁盘，请检查 IMAGE_STORE_DIR") from exc
    except Exception:
        cleanup_images(db, ids)
        raise
    return urls, ids


def read_image(db: Session, record: ProjectImage) -> bytes:
    try:
        return _path(record.object_key).read_bytes()
    except FileNotFoundError as exc:
        raise HTTPException(404, "找不到这张图片") from exc


def cleanup_images(db: Session, ids: list[str], *, timeout_seconds: float = 40) -> int:
    removed = 0
    deadline = time.monotonic() + timeout_seconds
    for identifier in ids:
        if time.monotonic() >= deadline:
            break
        record = db.query(ProjectImage).filter_by(id=identifier, course_id=None).with_for_update().first()
        if record is None:
            db.rollback()
            continue
        try:
            _path(record.object_key).unlink(missing_ok=True)
        except OSError:
            db.rollback()
            break  # Disk problem: keep the row so the next cleanup tries again.
        db.delete(record)
        db.commit()
        removed += 1
    return removed


def cleanup_orphans(db: Session) -> int:
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    ids = [
        row.id
        for row in db.query(ProjectImage.id)
        .filter(ProjectImage.course_id.is_(None), ProjectImage.created_at < cutoff)
        .limit(50)
        .all()
    ]
    return cleanup_images(db, ids)
