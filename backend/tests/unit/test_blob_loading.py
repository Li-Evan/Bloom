import pytest
from sqlalchemy import event

from tests.conftest import engine, seed_course


@pytest.fixture
def sql_log():
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", record)
    yield statements
    event.remove(engine, "before_cursor_execute", record)


@pytest.mark.parametrize("path", [
    "/api/courses",
    "/api/courses/{c}",
    "/api/courses/{c}/lessons",
    "/api/courses/{c}/lessons/1",
    "/api/courses/{c}/stats",
    "/api/stats",
    "/api/recommendations",
    "/api/calendar",
])
def test_reading_courses_never_loads_uploaded_files(path, user, authed_client, sql_log):
    course_id, _ = seed_course(user.uuid)
    sql_log.clear()

    res = authed_client.get(path.format(c=course_id))

    assert res.status_code == 200
    assert [sql for sql in sql_log if "source_blob" in sql] == []


def test_the_file_endpoint_still_serves_the_stored_bytes(user, authed_client):
    course_id, _ = seed_course(user.uuid)

    res = authed_client.get(f"/api/courses/{course_id}/lessons/1/file")

    assert (res.status_code, res.content) == (200, b"%PDF")
