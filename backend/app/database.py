import hashlib
import os
import sqlite3

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import settings
from app.observability import install_slow_query_logging


def connect_args_for(url: str) -> dict:
    return {"check_same_thread": False} if url.startswith("sqlite") else {"options": "-c timezone=utc"}


def make_engine(url: str):
    if url.startswith("sqlite:///") and ":memory:" not in url:
        os.makedirs(os.path.dirname(os.path.abspath(url[len("sqlite:///"):])), exist_ok=True)
    return create_engine(url, connect_args=connect_args_for(url), pool_pre_ping=not url.startswith("sqlite"))


@event.listens_for(Engine, "connect")
def _sqlite_functions(dbapi_connection, _record):
    # 本地和测试用的 SQLite 没有 Postgres 的 md5()：补一个同样语义的（UTF-8 字节的十六进制摘要）
    if isinstance(dbapi_connection, sqlite3.Connection):
        dbapi_connection.create_function(
            "md5", 1, lambda text: None if text is None else hashlib.md5(text.encode()).hexdigest(), deterministic=True,
        )
        cursor = dbapi_connection.cursor()
        # 外键照 Postgres 那样生效（课文删了，它的对话、翻译跟着删）；WAL + 忙等待：后台线程写课文时请求照常能读
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


engine = make_engine(settings.DATABASE_URL)
install_slow_query_logging(engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
