from datetime import datetime, timedelta

import pytest

from app.models import LearningRecommendation
from tests.conftest import TestSession, seed_course

CASES = [
    ("/api/courses", ("created_at",)),
    ("/api/courses/{c}", ("created_at",)),
    ("/api/courses/{c}/syllabus", ("created_at",)),
    ("/api/courses/{c}/lessons", ("created_at",)),
    ("/api/courses/{c}/lessons/1", ("created_at",)),
    ("/api/courses/{c}/lessons/1/annotations", ("created_at",)),
    ("/api/courses/{c}/lessons/1/feedback", ("created_at",)),
    ("/api/courses/{c}/stats", ("first_activity", "last_activity")),
    ("/api/recommendations", ("created_at", "updated_at")),
]


def is_utc(value: str) -> bool:
    parsed = datetime.fromisoformat(value)
    return value.endswith("Z") and parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)


def values_of(node, keys):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in keys:
                yield value
            else:
                yield from values_of(value, keys)
    elif isinstance(node, list):
        for item in node:
            yield from values_of(item, keys)


@pytest.fixture
def seeded(authed_client, user):
    course_id, _ = seed_course(user.uuid)
    with TestSession() as db:
        db.add(LearningRecommendation(user_uuid=user.uuid, title="t", rationale="r"))
        db.commit()
    return authed_client, course_id


@pytest.mark.parametrize("path, keys", CASES, ids=[path for path, _ in CASES])
def test_course_engine_timestamps_are_marked_utc(seeded, path, keys):
    client, course_id = seeded
    res = client.get(path.format(c=course_id))
    assert res.status_code == 200
    found = list(values_of(res.json(), keys))
    assert len(found) >= len(keys) and all(is_utc(value) for value in found), found


def test_saving_feedback_returns_a_utc_timestamp(seeded):
    client, course_id = seeded
    res = client.post(f"/api/courses/{course_id}/lessons/1/feedback", json={"content": "新反馈", "thought_answers": ""})
    assert is_utc(res.json()["created_at"])
