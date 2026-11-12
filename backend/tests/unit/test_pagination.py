import pytest

from app.main import app
from app.pagination import MAX_PAGE

EXPECTED_LIST_PATHS = {"/api/me/annotations"}


def paged_list_paths():
    return sorted(
        path
        for path, operations in app.openapi()["paths"].items()
        if "{" not in path and any(p["name"] == "page" for p in operations.get("get", {}).get("parameters", []))
    )


def test_every_list_endpoint_is_covered():
    assert set(paged_list_paths()) == EXPECTED_LIST_PATHS


@pytest.mark.parametrize("path", sorted(EXPECTED_LIST_PATHS))
def test_absurd_page_numbers_are_a_422_not_a_500(client, auth_headers, path):
    res = client.get(path, params={"page": 10**12}, headers=auth_headers)
    assert res.status_code == 422
    assert isinstance(res.json()["detail"], list)


@pytest.mark.parametrize("path", sorted(EXPECTED_LIST_PATHS))
def test_the_last_allowed_page_is_served(client, auth_headers, path):
    assert client.get(path, params={"page": MAX_PAGE}, headers=auth_headers).status_code == 200
    assert client.get(path, params={"page": MAX_PAGE + 1}, headers=auth_headers).status_code == 422
