from starlette.routing import Mount
from fastapi.testclient import TestClient

from app.main import app


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_backend_serves_no_ui(client):
    assert not [route for route in app.routes if isinstance(route, Mount)]
    assert client.get("/").status_code == 404


def test_health_never_opens_a_database_session(monkeypatch):
    # 健康检查要便宜：不连数据库
    import app.database as database

    def no_database():
        raise AssertionError("health must not open a database session")

    monkeypatch.setattr(database, "SessionLocal", no_database)
    monkeypatch.setitem(app.dependency_overrides, database.get_db, no_database)
    assert TestClient(app).get("/api/health").status_code == 200
