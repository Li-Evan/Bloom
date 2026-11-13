"""LLM_EXTRA_BODY：原样带进每一次聊天补全调用（流式与非流式、课程引擎与推荐）。

DeepSeek 这类带隐藏推理的模型，推理 token 也算在 max_tokens 里，必须用 {"thinking":{"type":"disabled"}} 关掉，否则 content 为空。
所以任何一处漏带都是线上故障：这里既静态扫描源码，也真的把每条生成路径跑一遍、检查每一次调用。
"""
import ast
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import app
import app.courses as courses_module
from app.config import llm_extra_body, settings
from app.models import Syllabus
from tests.conftest import TestSession, mock_stream
from tests.unit.test_course_language import ask, create_source, create_topic, fake_model, next_lesson, respond_en, start_first_lesson

APP_DIR = Path(app.__file__).parent
BACKEND_DIR = APP_DIR.parent
EXTRA = {"thinking": {"type": "disabled"}}


@pytest.fixture
def client(authed_client):
    return authed_client


@pytest.fixture
def extra_body(monkeypatch):
    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", EXTRA)


# ---- 配置 ----

def test_the_setting_defaults_to_nothing():
    assert llm_extra_body("") == {} and llm_extra_body("  \n ") == {}


def test_a_json_object_is_parsed_as_is():
    assert llm_extra_body('{"thinking":{"type":"disabled"}}') == EXTRA
    assert llm_extra_body(' {"a": 1, "b": [true, null]} ') == {"a": 1, "b": [True, None]}
    assert llm_extra_body("{}") == {}


@pytest.mark.parametrize("raw", ["{bad", "thinking=off", '{"thinking": {"type": "disabled"}', "'{}'", "{'a': 1}"])
def test_invalid_json_is_refused_with_a_clear_message(raw):
    with pytest.raises(RuntimeError) as error:
        llm_extra_body(raw)

    assert "LLM_EXTRA_BODY" in str(error.value) and '{"thinking":{"type":"disabled"}}' in str(error.value)


@pytest.mark.parametrize("raw, kind", [("[1, 2]", "list"), ('"x"', "str"), ("3", "int"), ("null", "NoneType"), ("true", "bool")])
def test_a_json_value_that_is_not_an_object_is_refused(raw, kind):
    with pytest.raises(RuntimeError) as error:
        llm_extra_body(raw)

    assert "必须是 JSON 对象" in str(error.value) and kind in str(error.value)


def _import_app(extra):
    env = {**os.environ, "BACKEND_JWT_SECRET": "x" * 40, "LLM_EXTRA_BODY": extra}
    return subprocess.run(
        [sys.executable, "-c", "import app.main"], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=120,
    )


def test_the_backend_refuses_to_start_with_an_invalid_value_and_starts_with_a_valid_one():
    bad = _import_app("{not json")
    good = _import_app('{"thinking":{"type":"disabled"}}')

    assert bad.returncode != 0 and "LLM_EXTRA_BODY 不是合法的 JSON" in bad.stderr
    assert good.returncode == 0, good.stderr


# ---- 唯一出口 ----

def test_the_chat_completion_helper_adds_the_body_only_when_it_is_set(monkeypatch):
    client = MagicMock()
    messages = [{"role": "user", "content": "hi"}]

    courses_module._chat_completion(client, messages)
    assert "extra_body" not in client.chat.completions.create.call_args.kwargs

    monkeypatch.setattr(settings, "LLM_EXTRA_BODY", EXTRA)
    courses_module._chat_completion(client, messages, stream=True, max_tokens=123)
    kwargs = client.chat.completions.create.call_args.kwargs
    # 预算的字段名按模型定（courses._token_limit_key）：test-model 不是 GPT / o 系列，发 max_tokens
    assert courses_module._token_limit_key(settings.LLM_MODEL) == "max_tokens"
    assert kwargs == {
        "model": settings.LLM_MODEL, "messages": messages, "stream": True, "max_tokens": 123, "extra_body": EXTRA,
    }


def _enclosing_functions(tree):
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def enclosing(node):
        while node in parents:
            node = parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return node.name
        return "<module>"

    return enclosing


def test_the_only_place_that_calls_the_model_is_the_helper_that_adds_the_body():
    """源码里所有 `….completions.create(…)`（以及别的聊天 / 响应接口）调用，都只能出现在 courses.py 的 _chat_completion 里。"""
    calls, clients, base_urls = [], [], []
    for path in sorted(APP_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        enclosing = _enclosing_functions(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                chain = ast.unparse(node.func)
                if node.func.attr in ("create", "parse", "stream") and any(
                    part in chain for part in ("completions", ".responses", ".chat")
                ):
                    calls.append((path.name, enclosing(node)))
                if node.func.attr == "OpenAI" or chain in ("OpenAI", "openai.OpenAI", "AsyncOpenAI"):
                    clients.append((path.name, enclosing(node)))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("OpenAI", "AsyncOpenAI"):
                clients.append((path.name, enclosing(node)))
            if isinstance(node, ast.Attribute) and node.attr == "LLM_BASE_URL":
                base_urls.append((path.name, enclosing(node)))

    assert calls == [("courses.py", "_chat_completion")]
    assert clients == [("courses.py", "get_openai_client")]
    # 网关选择统一归 config；启动日志只记录默认网关的主机名。
    assert base_urls == [("config.py", "model_gateway"), ("main.py", "<module>")]
    main_uses = [
        ast.unparse(node) for node in ast.walk(ast.parse((APP_DIR / "main.py").read_text()))
        if isinstance(node, ast.Attribute) and node.attr == "hostname"
    ]
    assert main_uses == ["urlsplit(settings.LLM_BASE_URL).hostname"]
    helper = next(
        node for node in ast.walk(ast.parse((APP_DIR / "courses.py").read_text()))
        if isinstance(node, ast.FunctionDef) and node.name == "_chat_completion"
    )
    code = "\n".join(  # 不含文档字符串：只看真正的代码
        ast.unparse(statement) for statement in helper.body
        if not (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant))
    )
    assert "extra_body" in code and "LLM_EXTRA_BODY" in code


def test_every_streaming_and_plain_helper_goes_through_the_helper(extra_body):
    def reply(content="ok", stream=False):
        if stream:
            return mock_stream([content], end=False)
        return MagicMock(choices=[MagicMock(message=MagicMock(content=content), finish_reason="stop")])

    cases = [
        (lambda: list(courses_module._stream_llm("系统", "用户")), True),
        (lambda: list(courses_module._stream_llm_messages("系统", [{"role": "user", "content": "问"}])), True),
        (lambda: courses_module._call_llm("系统", "用户"), False),
        (lambda: courses_module._call_llm("系统", "用户", max_tokens=50, timeout=9), False),
        (lambda: courses_module._call_llm_messages("系统", [{"role": "user", "content": "问"}]), False),
        (lambda: courses_module._call_material_llm("系统", "用户", max_tokens=50, deadline=None), False),
        (lambda: courses_module._call_material_llm("系统", "用户", max_tokens=50, deadline=10**12), False),
        (lambda: courses_module._parallel_material_llm("系统", ["甲", "乙", "丙"], 2, 50), False),
    ]
    for call, stream in cases:
        with patch("app.courses.get_openai_client") as get_client:
            create = get_client.return_value.chat.completions.create
            create.side_effect = lambda **kw: reply(stream=kw.get("stream", False))
            call()
        assert create.call_args_list, call
        for recorded in create.call_args_list:
            assert recorded.kwargs["extra_body"] == EXTRA


# ---- 每条生成路径真的带上了 ----

def assert_every_call_carries_the_body(model, minimum):
    assert len(model.calls) >= minimum
    for call in model.calls:
        assert call["kwargs"].get("extra_body") == EXTRA, call["system"][:60]


def test_every_generation_path_sends_the_body_on_every_model_call(client, extra_body):
    models = []

    created, model = create_topic(client)
    models.append((model, 2))
    cid = created["id"]
    models.append((ask(client, cid)[1], 1))
    models.append((next_lesson(client, cid), 1))

    with patch.object(courses_module, "MATERIAL_REDUCE_BATCH_CHARS", 40):
        def merge_short(system, user):
            return "ok" if "course material merger" in system else respond_en(system, user)

        with fake_model(merge_short) as materials_model:
            res = client.post(
                "/api/courses/from-materials",
                data={"name": "Compound interest", "learning_depth": "simple", "language": "en"},
                files=[
                    ("files", ("concepts.md", b"# Core concepts\n\nInterest earns interest.", "text/markdown")),
                    ("files", ("cases.md", b"# Cases\n\nA savings account.", "text/markdown")),
                ],
            )
            assert res.status_code == 200, res.text
            start_first_lesson(client, res.json()["id"])  # 首篇与首篇审校在确认大纲后生成
    assert any("course material merger" in call["system"] for call in materials_model.calls)
    models.append((materials_model, 7))
    models.append((next_lesson(client, res.json()["id"]), 1))

    created_source, model = create_source(client, first=True)
    models.append((model, 1))
    models.append((next_lesson(client, created_source["id"]), 1))

    # 评估篇与总结
    with TestSession() as db:
        syllabus = db.query(Syllabus).filter(Syllabus.course_id == cid).one()
        syllabus.content = syllabus.content.replace("- [ ]", "- [x]")
        db.commit()
    models.append((next_lesson(client, cid), 1))
    models.append((next_lesson(client, cid), 1))

    # 划线追问
    with fake_model() as follow_model:
        ann = client.post(f"/api/courses/{created_source['id']}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 4, "original_text": "Notes", "comment": "Why?", "answer_immediately": True,
        })
        done = next(json.loads(line[6:]) for line in ann.text.splitlines() if '"done"' in line)
        follow = client.post(
            f"/api/courses/{created_source['id']}/lessons/1/annotations/{done['annotation']['id']}/messages", json={"content": "And?"},
        )
    assert follow.status_code == 200
    models.append((follow_model, 2))

    # 推荐
    with fake_model() as recommendation_model:
        res = client.post("/api/recommendations/refresh", json={"locale": "en"})
    assert res.status_code == 200, res.text
    models.append((recommendation_model, 1))

    for model, minimum in models:
        assert_every_call_carries_the_body(model, minimum)
    kinds = {call["stream"] for model, _ in models for call in model.calls}
    assert kinds == {True, False}  # 流式和非流式都走过


def test_nothing_is_sent_when_the_setting_is_empty(client):
    created, model = create_topic(client)
    models = [model, next_lesson(client, created["id"]), ask(client, created["id"])[1]]

    assert sum(len(m.calls) for m in models) == 5  # 建课 2 + 下一篇 1 + 参考答案核对 1 + 划线回答 1
    assert all("extra_body" not in call["kwargs"] for m in models for call in m.calls)
