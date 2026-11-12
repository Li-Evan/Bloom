from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt

from app.config import settings
from app.models import User
from tests.conftest import TestSession

USER_FIELDS = {"uuid", "email", "nickname", "avatar_url", "locale", "created_at", "archive_on_read"}


def test_me_returns_user_fields_without_login_secrets(client, user, auth_headers):
    res = client.get("/api/me", headers=auth_headers)
    assert res.status_code == 200
    body = res.json()
    assert set(body) == USER_FIELDS
    assert body["uuid"] == user.uuid
    assert body["email"] == user.email
    assert body["nickname"] == "Test User"
    assert body["archive_on_read"] is False


# ---- PATCH /api/me：改昵称 ----

def patch_nickname(client, headers, nickname):
    return client.patch("/api/me", json={"nickname": nickname}, headers=headers)


def stored(user_uuid):
    with TestSession() as db:
        return db.query(User).filter(User.uuid == user_uuid).one()


def test_patch_me_changes_the_nickname_and_returns_the_me_payload(client, user, auth_headers):
    res = patch_nickname(client, auth_headers, "小明")

    assert res.status_code == 200
    body = res.json()
    assert set(body) == USER_FIELDS
    assert (body["nickname"], body["uuid"], body["email"]) == ("小明", user.uuid, user.email)
    assert client.get("/api/me", headers=auth_headers).json()["nickname"] == "小明"
    assert stored(user.uuid).nickname == "小明"


def test_patch_me_strips_surrounding_whitespace_only(client, user, auth_headers):
    assert patch_nickname(client, auth_headers, "  Ada  Lovelace \n").json()["nickname"] == "Ada Lovelace"  # 中间的连续空白合并成一个


def test_patch_me_length_bounds_are_1_to_50_characters_after_stripping(client, user, auth_headers):
    for ok in ("a", "我" * 50, "x" * 50, f"  {'y' * 50}  "):
        assert patch_nickname(client, auth_headers, ok).status_code == 200, ok
    for bad in ("", " ", "\t\n  ", "a" * 51, "我" * 51):
        res = patch_nickname(client, auth_headers, bad)
        assert res.status_code == 422, bad
        assert isinstance(res.json()["detail"], list)
    assert stored(user.uuid).nickname == "y" * 50  # 失败的请求不改动已存的昵称


ZERO_WIDTH = "\u200b\u200c\u200d\u2060\ufeff"
BIDI = "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f"

def test_patch_me_drops_invisible_characters_from_the_nickname(client, user, auth_headers):
    assert patch_nickname(client, auth_headers, f"Ada{ZERO_WIDTH} Lovelace").json()["nickname"] == "Ada Lovelace"
    assert patch_nickname(client, auth_headers, f"{BIDI}小明{BIDI}").json()["nickname"] == "小明"
    assert patch_nickname(client, auth_headers, "A\x00d\x07a\x1b").json()["nickname"] == "A d a"  # 控制字符换成空格，不粘连
    assert patch_nickname(client, auth_headers, "line\u2028one\u2029").json()["nickname"] == "line one"
    assert patch_nickname(client, auth_headers, "\ue000A\ud7ffB").json()["nickname"] == "AB"  # 私用区、未分配的码位去掉
    assert stored(user.uuid).nickname == "AB"

def test_patch_me_rejects_a_nickname_made_only_of_invisible_or_symbol_characters(client, user, auth_headers):
    assert patch_nickname(client, auth_headers, "ok").status_code == 200
    for bad in (ZERO_WIDTH, BIDI, f"{ZERO_WIDTH} {BIDI}", "\u200b", "\u202e", "   ", "!!!", "—", "😀", "😀😀", "·.·", "[ ]", "\u3000"):
        res = patch_nickname(client, auth_headers, bad)
        assert res.status_code == 422, repr(bad)
        assert isinstance(res.json()["detail"], list)
    assert stored(user.uuid).nickname == "ok"  # 失败的请求不改动已存的昵称

def test_patch_me_accepts_a_nickname_with_one_letter_or_digit_among_symbols(client, user, auth_headers):
    for ok in ("😀a", "7", "⭐ 小明 ⭐", "\u200b\u200bx", "٣", "ab\u0301", "Ω"):
        assert patch_nickname(client, auth_headers, ok).status_code == 200, repr(ok)

def test_patch_me_length_is_counted_after_the_invisible_characters_are_dropped(client, user, auth_headers):
    assert patch_nickname(client, auth_headers, "x" * 50 + ZERO_WIDTH * 10).status_code == 200
    assert patch_nickname(client, auth_headers, "x" * 51 + ZERO_WIDTH).status_code == 422

def test_patch_me_rejects_missing_or_non_string_nickname(client, user, auth_headers):
    for body in ({}, {"nickname": None}, {"nickname": 5}, {"nickname": ["a"]}):
        assert client.patch("/api/me", json=body, headers=auth_headers).status_code == 422
    assert client.patch("/api/me", headers=auth_headers).status_code == 422
    assert stored(user.uuid).nickname == "Test User"


def test_patch_me_only_changes_the_nickname_of_the_caller(client, user, other_user, auth_headers):
    res = client.patch(
        "/api/me",
        json={"nickname": "新名字", "email": "evil@example.com", "uuid": other_user.uuid, "avatar_url": "x", "archive_on_read": True},
        headers=auth_headers,
    )

    assert res.status_code == 200
    changed = stored(user.uuid)
    assert (changed.nickname, changed.email, changed.avatar_url, changed.archive_on_read) == (
        "新名字", "user@example.com", "https://img.example.com/u.png", False,
    )
    assert stored(other_user.uuid).nickname == "Other User"


def test_patch_me_requires_login(client):
    assert client.patch("/api/me", json={"nickname": "x"}).status_code == 401
    assert client.patch("/api/me", json={"nickname": "x"}, headers={"Authorization": "Bearer nope"}).status_code == 401


def token_with_name(sub, name):
    now = datetime.now(timezone.utc)
    claims = {"iss": "bloom-frontend", "sub": sub, "scope": "user", "name": name, "iat": now, "exp": now + timedelta(minutes=15)}
    return {"Authorization": f"Bearer {jwt.encode(claims, settings.BACKEND_JWT_SECRET, algorithm='HS256')}"}


def test_the_token_name_is_only_the_starting_nickname_and_never_overwrites_the_chosen_one(client):
    created = client.get("/api/me", headers=token_with_name("named-uuid", "令牌里的名字")).json()
    assert created["nickname"] == "令牌里的名字"
    assert patch_nickname(client, token_with_name("named-uuid", "令牌里的名字"), "自己改的").status_code == 200

    later = client.get("/api/me", headers=token_with_name("named-uuid", "另一个名字")).json()

    assert later["nickname"] == "自己改的" and stored("named-uuid").nickname == "自己改的"


# ---- 填充字符、控制字符不粘连、ZWJ / ZWNJ、统一的本地化提示 ----

@pytest.mark.parametrize("filler", ["\u3164", "\u115f", "\u1160", "\uffa0", "\u17b4", "\u17b5"])
def test_patch_me_treats_invisible_filler_letters_as_whitespace(client, user, auth_headers, filler):
    assert patch_nickname(client, auth_headers, f"Ada{filler}Lovelace").json()["nickname"] == "Ada Lovelace"
    assert patch_nickname(client, auth_headers, f"{filler}{filler}小明{filler}").json()["nickname"] == "小明"
    res = patch_nickname(client, auth_headers, filler * 5)
    assert res.status_code == 422
    assert patch_nickname(client, auth_headers, f"{filler} {filler}").status_code == 422
    assert stored(user.uuid).nickname == "小明"  # 失败的请求不改动已存的昵称


def test_patch_me_turns_tabs_and_newlines_into_a_space_instead_of_gluing_the_words(client, user, auth_headers):
    assert patch_nickname(client, auth_headers, "Ada\tLovelace").json()["nickname"] == "Ada Lovelace"
    assert patch_nickname(client, auth_headers, "Ada\nLovelace").json()["nickname"] == "Ada Lovelace"
    assert patch_nickname(client, auth_headers, "Ada\r\n\r\nLovelace").json()["nickname"] == "Ada Lovelace"
    assert patch_nickname(client, auth_headers, "\tAda\u00a0\u3000Lovelace\n").json()["nickname"] == "Ada Lovelace"


def test_patch_me_keeps_zwj_and_zwnj_where_they_belong_and_drops_them_at_the_edges(client, user, auth_headers):
    family = "👨\u200d👩\u200d👧"
    assert patch_nickname(client, auth_headers, f"{family} Li").json()["nickname"] == f"{family} Li"
    assert patch_nickname(client, auth_headers, "می\u200cخواهم").json()["nickname"] == "می\u200cخواهم"  # 波斯语需要 ZWNJ
    assert patch_nickname(client, auth_headers, "\u200dAda\u200c").json()["nickname"] == "Ada"
    assert patch_nickname(client, auth_headers, "Ada \u200d Lovelace").json()["nickname"] == "Ada Lovelace"
    assert patch_nickname(client, auth_headers, "Ada\u200d \u200cLovelace").json()["nickname"] == "Ada Lovelace"
    assert patch_nickname(client, auth_headers, "Ada\u200b\u200dLovelace").json()["nickname"] == "Ada\u200dLovelace"  # 夹在中间的保留


def test_patch_me_gives_the_same_localized_message_for_every_nothing_left_case(client, user, auth_headers):
    messages = set()
    for bad in ("\u200b", "\u200b\u200d", "\u3164", " ", "", "😀", "!!!", "\u200d"):
        res = patch_nickname(client, auth_headers, bad)
        assert res.status_code == 422, repr(bad)
        detail = res.json()["detail"]
        assert isinstance(detail, list) and detail[0]["loc"][-1] == "nickname"
        messages.add(detail[0]["msg"])
    assert messages == {"昵称至少要有一个字母或数字"}  # 不是 pydantic 默认的英文，前端靠「字母或数字」认出这一条


def test_patch_me_too_long_is_localized_too(client, user, auth_headers):
    res = patch_nickname(client, auth_headers, "x" * 51)

    assert res.status_code == 422
    assert res.json()["detail"][0]["msg"] == "昵称最多 50 个字符" and "字母或数字" not in res.json()["detail"][0]["msg"]


def test_clean_nickname_is_idempotent():
    from app.schemas import clean_nickname

    for value in ("Ada\u200b Lovelace", "👨\u200d👩 x", "\u200dab\u200c", "a\tb", "  x  y  "):
        assert clean_nickname(clean_nickname(value)) == clean_nickname(value)
