import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2]


def run_python(code, **env):
    env = {**os.environ, "BACKEND_JWT_SECRET": "x" * 32, **env}
    return subprocess.run([sys.executable, "-c", code], cwd=BACKEND_DIR, env=env, capture_output=True, text=True)


@pytest.mark.parametrize("secret", ["", "x" * 31])
def test_app_refuses_to_start_with_a_missing_or_short_jwt_secret(secret):
    result = run_python("import app.main", BACKEND_JWT_SECRET=secret)

    assert result.returncode != 0
    assert "BACKEND_JWT_SECRET" in result.stderr and "32" in result.stderr


def test_app_starts_with_a_32_character_jwt_secret():
    assert run_python("import app.main", BACKEND_JWT_SECRET="x" * 32).returncode == 0


def test_info_logs_reach_stderr_with_time_level_and_logger_name():
    code = (
        "import logging, app.main\n"
        "logging.getLogger('app.courses').info('ignored event')\n"
        "logging.getLogger('app.courses').error('broken event')\n"
    )

    result = run_python(code)

    lines = result.stderr.splitlines()
    assert any(re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} INFO app\.courses ignored event", line)
               for line in lines), result.stderr
    assert any(re.fullmatch(r"\d{4}-\d\d-\d\d .* ERROR app\.courses broken event", line)
               for line in lines), result.stderr


def test_app_refuses_to_start_without_a_model():
    result = run_python("import app.main", LLM_MODEL="")

    assert result.returncode != 0
    assert "LLM_MODEL" in result.stderr
