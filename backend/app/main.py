import time as _startup_time
_import_started = _startup_time.perf_counter()

import asyncio
import logging
from urllib.parse import urlsplit
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import database, tracing
from app.config import settings
from app.batch import router as batch_router
from app.courses import router as courses_router
from app.highlights import router as highlights_router
from app.knowledge import router as knowledge_router
from app.coordinate import overview_router as coordinate_overview_router, router as coordinate_router
from app.notes import router as notes_router
from app.uploads import cleanup_expired, router as uploads_router
from app.web_import import router as web_import_router
from app.clippings import router as clippings_router
from app.observability import RequestLogMiddleware
from app.project_images import cleanup_orphans
from app.recommendations import router as recommendations_router
from app.teaching_styles import router as teaching_styles_router
from app.translate import router as translate_router
from app.lesson_chat import router as lesson_chat_router
from app.users import router as users_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)

logger.info("API module import completed in %.0f ms", (_startup_time.perf_counter() - _import_started) * 1000)
# Public host/model only: never log the URL path, query, credentials, or API key.
logger.info("Model gateway host=%s model=%s", urlsplit(settings.LLM_BASE_URL).hostname, settings.LLM_MODEL)
logger.info("Langfuse tracing %s", "enabled" if tracing.enabled() else "disabled")

MIN_JWT_SECRET_LENGTH = 32

if len(settings.BACKEND_JWT_SECRET) < MIN_JWT_SECRET_LENGTH:
    raise RuntimeError(
        f"BACKEND_JWT_SECRET 未配置或短于 {MIN_JWT_SECRET_LENGTH} 个字符：运行 make setup 生成一个，前后端要用同一个值"
    )
if not settings.LLM_MODEL:
    raise RuntimeError("LLM_MODEL 未配置：在 .env 里填上要用的模型名（例如 gpt-4.1-mini、deepseek-chat、qwen-plus）")

HOUSEKEEPING_MINUTES = 10


def housekeeping() -> None:
    """删掉过期的临时上传和没挂到任何课程上的图片。"""
    with database.SessionLocal() as db:
        cleanup_expired(db)
        try:
            cleanup_orphans(db)
        except Exception:
            db.rollback()
            logger.exception("图片清理失败，下次重试")


async def _housekeeping_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(housekeeping)
        except Exception:
            logger.exception("定时清理失败，下个周期再试")
        await asyncio.sleep(HOUSEKEEPING_MINUTES * 60)


@asynccontextmanager
async def lifespan(_: FastAPI):
    periodic = asyncio.create_task(_housekeeping_loop())
    try:
        yield
    finally:
        periodic.cancel()
        with suppress(asyncio.CancelledError):
            await periodic
        # Flush buffered Langfuse spans on a graceful shutdown.
        await asyncio.to_thread(tracing.shutdown)


app = FastAPI(title="Bloom Learning API", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.WEB_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(courses_router)
app.include_router(uploads_router)
app.include_router(web_import_router)
app.include_router(clippings_router)
app.include_router(recommendations_router)
app.include_router(notes_router)
app.include_router(users_router)
app.include_router(teaching_styles_router)
app.include_router(knowledge_router)
app.include_router(coordinate_router)
app.include_router(coordinate_overview_router)
app.include_router(highlights_router)
app.include_router(translate_router)
app.include_router(lesson_chat_router)
app.include_router(batch_router)

# 最外层：每个请求的耗时、5xx 和慢请求各一条单行 JSON，响应带 Server-Timing
app.add_middleware(RequestLogMiddleware)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
    # 这个响应由最外层的 ServerErrorMiddleware 发出，不经过 CORSMiddleware，需要自己带上 CORS 头，浏览器才读得到 detail
    cors = {}
    if request.headers.get("origin") == settings.WEB_URL:
        cors = {
            "Access-Control-Allow-Origin": settings.WEB_URL,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin",
        }
    return JSONResponse(status_code=500, content={"detail": "服务器出了点问题，请稍后重试"}, headers=cors)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
