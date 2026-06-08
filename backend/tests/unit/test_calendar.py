import json
from datetime import date
from unittest.mock import patch, MagicMock


def _make_mock_response(content):
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = content
    return response


def _mock_stream(chunks):
    result = []
    for text in chunks:
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = text
        result.append(chunk)
    end = MagicMock()
    end.choices = [MagicMock()]
    end.choices[0].delta.content = None
    result.append(end)
    return iter(result)


def _create_course(client, name="博弈论基础"):
    syllabus = _make_mock_response("# 大纲\n\n- [ ] 能够解释基本概念")
    lesson = _make_mock_response("# 第一章\n\n正文\n\n## 思考题\n\n1. 问题一")
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [syllabus, lesson]
        mock_get_client.return_value = mock_client
        res = client.post("/api/courses", json={"name": name})
        assert res.status_code == 200
        return res.json()


def test_calendar_empty(client):
    res = client.get("/api/calendar")
    assert res.status_code == 200
    data = res.json()
    assert data["days"] == []
    assert data["total_active_days"] == 0
    assert data["first_active_date"] is None


def test_calendar_aggregates_today_activity(client):
    course = _create_course(client)
    cid = course["id"]

    # 打开课文 → lesson_opened 事件
    assert client.post(f"/api/courses/{cid}/lessons/1/opened").status_code == 200

    # 划线提问 → annotation_answered 事件
    with patch("app.courses.get_openai_client") as mock_get_client:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = _mock_stream(["这是回答。"])
        mock_get_client.return_value = mock_client
        ann = client.post(f"/api/courses/{cid}/lessons/1/annotations", json={
            "position_start": 0, "position_end": 2, "original_text": "正文", "comment": "什么意思？",
        })
        assert ann.status_code == 200

    res = client.get("/api/calendar")
    assert res.status_code == 200
    data = res.json()
    assert data["total_active_days"] == 1
    day = data["days"][0]
    assert day["date"] == date.today().isoformat()
    assert day["lessons_read"] == 1          # 第 1 篇被去重计一次
    assert day["annotations"] == 1
    assert len(day["courses"]) == 1
    c = day["courses"][0]
    assert c["course_name"] == "博弈论基础"
    assert c["lessons"] == [1]
    assert c["annotations"] == 1
    assert c["event_count"] >= 3             # course_created + lesson_generated + lesson_opened + annotation_answered
