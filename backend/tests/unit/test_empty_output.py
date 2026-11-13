import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.unit.helpers import STREAMING, content_rows, provider, run, stream_error


@pytest.fixture
def soft_client(user, auth_headers):
    return TestClient(app, headers=auth_headers, raise_server_exceptions=False)


EMPTY_OUTPUTS = {name: case._replace(outputs=[""]) for name, case in STREAMING.items()}
BLANK_OUTPUTS = {name: case._replace(outputs=["  \n", "\t"]) for name, case in STREAMING.items()}


@pytest.mark.parametrize("outputs", [EMPTY_OUTPUTS, BLANK_OUTPUTS], ids=["empty", "blank"])
@pytest.mark.parametrize("name", STREAMING)
def test_an_empty_model_answer_is_reported_and_never_saved(name, outputs, user, soft_client):
    case = outputs[name]

    res, before, _ = run(case, soft_client, user, provider(case))

    assert '"done"' not in res.text and "请稍后重试" in stream_error(res)
    assert content_rows() == before
