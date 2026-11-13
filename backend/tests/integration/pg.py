"""Shared fixtures for the Postgres-only tests (set TEST_DATABASE_URL and run `pytest -m postgres`)."""
import os
import threading
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.database import connect_args_for
from app.models import User

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")


@pytest.fixture(scope="module")
def pg_engine():
    engine = create_engine(TEST_DATABASE_URL, connect_args=connect_args_for(TEST_DATABASE_URL), poolclass=NullPool)
    yield engine
    engine.dispose()


@pytest.fixture
def pg_user(pg_engine):
    user_uuid = str(uuid.uuid4())
    with Session(pg_engine) as db:
        db.add(User(uuid=user_uuid, email=f"{user_uuid}@example.com"))
        db.commit()
    yield user_uuid
    with Session(pg_engine) as db:
        db.query(User).filter(User.uuid == user_uuid).delete()
        db.commit()


def run_all(engine, works):
    barrier = threading.Barrier(len(works))
    results = []

    def worker(work):
        barrier.wait()
        with Session(engine) as db:
            try:
                results.append(work(db))
            except Exception as exc:
                results.append(exc)

    threads = [threading.Thread(target=worker, args=(work,)) for work in works]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def run_concurrently(engine, count, work):
    return run_all(engine, [work] * count)
