from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from app.config import settings
from app.database import engine, Base, ensure_sqlite_schema
from app.courses import router as courses_router
from app.recommendations import router as recommendations_router

# Create tables
Base.metadata.create_all(bind=engine)
ensure_sqlite_schema()

app = FastAPI(title="Bloom Learning API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(courses_router)
app.include_router(recommendations_router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Serve frontend static files if they exist (must be last — catch-all mount)
frontend_dist = os.path.join(os.path.dirname(__file__), "../../frontend/dist")
if os.path.exists(frontend_dist):
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
