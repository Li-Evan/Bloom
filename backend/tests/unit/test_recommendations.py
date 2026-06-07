import json
from unittest.mock import MagicMock, patch


def _make_mock_response(content):
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = content
    return response


def _create_course(client, name="博弈论"):
    syllabus_resp = _make_mock_response(
        "# 博弈论 · 课程大纲\n\n## 核心掌握项\n\n### 基础\n- [ ] 能够解释策略与收益\n- [ ] 能够判断囚徒困境结构"
    )
    lesson_resp = _make_mock_response("# 第一章\n\n## 正文内容\n\n策略、收益与囚徒困境。\n\n## 思考题\n\n1. 策略是什么？")
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [syllabus_resp, lesson_resp]
        mock_get_client.return_value = mock_client
        res = client.post("/api/courses", json={"name": name})
    assert res.status_code == 200
    return res.json()


def _refresh_payload():
    return json.dumps([
        {
            "title": "机制设计",
            "rationale": "你已经学过博弈结构，机制设计把视角从分析博弈推进到设计规则。",
            "bridge": "它直接接在策略、收益和囚徒困境之上。",
            "source_topics": ["博弈论"],
        },
        {
            "title": "决策理论",
            "rationale": "它能把概率直觉、收益权衡和不确定性决策放到同一套框架里。",
            "bridge": "它连接博弈论的收益函数与概率论直觉。",
            "source_topics": ["博弈论", "概率论直觉"],
        },
        {
            "title": "社会选择理论",
            "rationale": "它适合作为从个体选择走向集体规则的下一步。",
            "bridge": "它把多个参与者的偏好聚合问题显性化。",
            "source_topics": ["博弈论"],
        },
    ], ensure_ascii=False)


def test_refresh_recommendations_generates_three_topics(client):
    _create_course(client)

    with patch("app.recommendations._call_llm", return_value=_refresh_payload()):
        res = client.post("/api/recommendations/refresh")

    assert res.status_code == 200
    body = res.json()
    assert len(body["recommendations"]) == 3
    assert body["recommendations"][0]["title"] == "机制设计"
    assert body["recommendations"][0]["source_topics"] == ["博弈论"]
    assert body["saved"] == []


def test_save_and_remove_recommendation(client):
    _create_course(client)
    with patch("app.recommendations._call_llm", return_value=_refresh_payload()):
        recs = client.post("/api/recommendations/refresh").json()["recommendations"]

    rec_id = recs[0]["id"]
    save_res = client.post(f"/api/recommendations/{rec_id}/save")
    assert save_res.status_code == 200
    assert save_res.json()["status"] == "saved"

    dashboard = client.get("/api/recommendations").json()
    assert dashboard["recommendations"] == recs[1:]
    assert len(dashboard["saved"]) == 1

    remove_res = client.delete(f"/api/recommendations/{rec_id}/save")
    assert remove_res.status_code == 200
    assert client.get("/api/recommendations").json()["saved"] == []


def test_refresh_keeps_saved_list_and_replaces_suggestions(client):
    _create_course(client)
    with patch("app.recommendations._call_llm", return_value=_refresh_payload()):
        first = client.post("/api/recommendations/refresh").json()["recommendations"]
    client.post(f"/api/recommendations/{first[0]['id']}/save")

    second_payload = json.dumps([
        {"title": "演化博弈论", "rationale": "从静态策略推进到动态选择。", "bridge": "连接博弈论与进化论。", "source_topics": ["博弈论"]},
        {"title": "贝叶斯决策", "rationale": "把证据更新接入行动选择。", "bridge": "连接概率直觉与收益权衡。", "source_topics": ["概率论直觉"]},
        {"title": "制度经济学", "rationale": "把规则、激励和组织放到同一框架。", "bridge": "连接经济学思维与博弈论。", "source_topics": ["经济学思维", "博弈论"]},
    ], ensure_ascii=False)
    with patch("app.recommendations._call_llm", return_value=second_payload):
        dashboard = client.post("/api/recommendations/refresh").json()

    assert [item["title"] for item in dashboard["recommendations"]] == ["演化博弈论", "贝叶斯决策", "制度经济学"]
    assert [item["title"] for item in dashboard["saved"]] == ["机制设计"]


def test_start_recommendation_links_course(client):
    _create_course(client)
    with patch("app.recommendations._call_llm", return_value=_refresh_payload()):
        rec = client.post("/api/recommendations/refresh").json()["recommendations"][0]

    course = _create_course(client, name=rec["title"])
    res = client.post(f"/api/recommendations/{rec['id']}/start", json={"course_id": course["id"]})

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "started"
    assert body["course_id"] == course["id"]
