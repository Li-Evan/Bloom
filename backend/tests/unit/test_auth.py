from datetime import timedelta

import pytest

from app.models import User
from tests.conftest import TestSession, make_token


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_valid_user_token_accepted(client, user, auth_headers):
    res = client.get("/api/me", headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["uuid"] == user.uuid


def test_expired_token_rejected(client, user):
    res = client.get("/api/me", headers=bearer(make_token(user.uuid, exp_delta=timedelta(minutes=-5))))
    assert res.status_code == 401
    assert isinstance(res.json()["detail"], str)


def test_clock_skew_within_30_seconds_accepted(client, user):
    assert client.get("/api/me", headers=bearer(make_token(user.uuid, exp_delta=timedelta(seconds=-10)))).status_code == 200
    assert client.get("/api/me", headers=bearer(make_token(user.uuid, exp_delta=timedelta(seconds=-60)))).status_code == 401


def test_wrong_signature_rejected(client, user):
    token = make_token(user.uuid, secret="another-secret-that-is-long-enough-0123456789")
    assert client.get("/api/me", headers=bearer(token)).status_code == 401


def test_wrong_issuer_rejected(client, user):
    assert client.get("/api/me", headers=bearer(make_token(user.uuid, iss="someone-else"))).status_code == 401


def test_garbage_token_rejected(client):
    assert client.get("/api/me", headers=bearer("not-a-jwt")).status_code == 401


def test_service_token_rejected_on_user_endpoint(client, user):
    token = make_token(user.uuid, scope="service", email=user.email)
    assert client.get("/api/me", headers=bearer(token)).status_code == 401


def test_missing_token_rejected(client):
    me = client.get("/api/me")
    assert me.status_code == 401
    assert isinstance(me.json()["detail"], str)


def test_token_of_an_unknown_user_creates_that_user_once(client):
    token = make_token("new-local-uuid", email="new@example.com")

    first = client.get("/api/me", headers=bearer(token))
    second = client.get("/api/me", headers=bearer(token))

    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["uuid"] == second.json()["uuid"] == "new-local-uuid"
    assert first.json()["email"] == "new@example.com"
    with TestSession() as db:
        assert db.query(User).filter(User.uuid == "new-local-uuid").count() == 1


def test_a_token_without_an_email_gets_a_local_placeholder_address(client):
    res = client.get("/api/me", headers=bearer(make_token("no-email-uuid")))

    assert res.status_code == 200 and res.json()["email"] == "no-email-uuid@bloom.local"


@pytest.mark.parametrize("header", ["", "Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Token abc", "abc"])
def test_malformed_authorization_header_is_401(client, header):
    res = client.get("/api/me", headers={"Authorization": header})
    assert res.status_code == 401
    assert isinstance(res.json()["detail"], str)
