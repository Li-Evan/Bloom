from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import settings

engine = create_engine(settings.DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def ensure_sqlite_schema():
    if not settings.DATABASE_URL.startswith("sqlite"):
        return

    additions = {
        "courses": {
            "mode": "mode VARCHAR NOT NULL DEFAULT 'topic'",
            "learning_depth": "learning_depth VARCHAR NOT NULL DEFAULT 'standard'",
            "is_project": "is_project BOOLEAN NOT NULL DEFAULT 0",
            "source_filename": "source_filename VARCHAR",
            "source_content": "source_content TEXT",
        },
        "lessons": {
            "is_source": "is_source BOOLEAN DEFAULT 0",
            "source_filename": "source_filename VARCHAR",
            "source_blob": "source_blob BLOB",
        },
        "annotations": {
            "answer": "answer TEXT DEFAULT ''",
            "messages": "messages TEXT DEFAULT ''",
            "anchor_top": "anchor_top INTEGER DEFAULT 0",
        },
    }

    with engine.begin() as conn:
        for table, columns in additions.items():
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for name, definition in columns.items():
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {definition}")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
