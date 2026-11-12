import json
import re
from datetime import datetime, timedelta

import pytest

from app import coordinate
from app import knowledge_graph as kg
from app.models import (
    Course, CourseAnchor, CourseAnchorRun, Feedback, KnEdge, KnLabel, KnMatch, KnNode, KnRelease, LearnerNodeState,
    LearningEvent, LearningRecommendation, Lesson, Syllabus,
)
from tests.conftest import TestSession, bearer, create_user, engine

SOCIETY = "Society and social sciences"
POLITICS = [SOCIETY, "Politics and economics"]
SECTIONS = [
    ([SOCIETY], 1, None),
    (POLITICS, 1, 0),
    (POLITICS + ["Business and economics"], 2, 1),
    (POLITICS + ["Business and economics", "Business"], 3, 2),
    (POLITICS + ["Business and economics", "Business", "Employment"], 4, 3),
    (POLITICS + ["Law"], 2, 1),
    (POLITICS + ["Law", "Basics"], 3, 5),
    (POLITICS + ["Law", "Basics", "Dispute resolution"], 4, 6),
    (["Everyday life"], 1, None),
    (["Everyday life", "Cooking, food and drink"], 2, 8),
    (["Everyday life", "Cooking, food and drink", "Drinks"], 3, 9),
    (["Everyday life", "Cooking, food and drink", "Drinks", "Hot drinks"], 4, 10),
    (["Mathematics"], 1, None),
]
NAMES = {
    SOCIETY: ("社会与社会科学", "Society"), " › ".join(POLITICS): ("政治与经济", "Politics and economics"),
    " › ".join(POLITICS + ["Business and economics"]): ("商业与经济", "Business and economics"),
    " › ".join(POLITICS + ["Business and economics", "Business"]): ("商业", "Business"),
    " › ".join(POLITICS + ["Law"]): ("法律", "Law"), " › ".join(POLITICS + ["Law", "Basics"]): ("法律基础", "Legal basics"),
    "Everyday life": ("日常生活", "Everyday life"), "Everyday life › Cooking, food and drink": ("烹饪与饮食", "Food and drink"),
    "Everyday life › Cooking, food and drink › Drinks": ("饮品", "Drinks"), "Mathematics": ("数学", "Mathematics"),
}
ARTICLES = [
    ("Salary", 4, "Q194489", "salary", "薪资"),
    ("Job interview", 4, "Q1056396", "job interview", "面试"),
    ("Résumé", 4, "Q215064", "résumé", "简历"),
    ("Mortgage", 3, "Q187889", "mortgage loan", "抵押贷款"),
    ("Negotiation", 7, "Q202875", "negotiation", "谈判"),
    ("Espresso", 11, "Q180289", "espresso", "意式浓缩咖啡"),
    ("Game theory", 12, "Q44455", "game theory", "博弈论"),
]
IDS = {}


def release_fixture():
    sections = []
    for path, level, parent in SECTIONS:
        IDS.setdefault(" › ".join(path), kg.new_node_id())
        sections.append({"id": IDS[" › ".join(path)], "path": path, "level": level, "parent": parent})
    articles = []
    for title, section, qid, en, zh in ARTICLES:
        IDS.setdefault(title, kg.new_node_id())
        articles.append({"id": IDS[title], "title": title, "section": section, "qid": qid, "en": en, "zh": zh,
                         "en_alt": ["bargaining"] if title == "Negotiation" else [], "zh_alt": []})
    IDS.setdefault("fund", kg.new_node_id())
    supplement = {"concepts": [{"id": IDS["fund"], "qid": "Q10885877", "parent": {"article": "Mortgage"},
                                "en": "Housing Provident Fund", "zh": "住房公积金", "zh_alt": ["公积金"]}],
                  "aliases": [{"article": "Negotiation", "zh": ["议价"]}]}
    release = {"release": {"id": "2026.11", "source": "wikipedia-vital-articles-level-5", "kind": "major",
                           "snapshot_date": "2026-11-03"}, "sections": sections, "articles": articles}
    names = {path: {"zh": zh, "en": en} for path, (zh, en) in NAMES.items()}
    return release, names, supplement


@pytest.fixture(autouse=True)
def fresh_caches():
    kg._index.clear()
    kg._roots_cache.clear()
    yield
    kg._index.clear()
    kg._roots_cache.clear()


@pytest.fixture
def release():
    rows = kg.release_rows(*release_fixture(), digests={}, now=datetime(2026, 11, 3))
    with engine.begin() as connection:
        kg.write_rows(connection, rows)
    return rows


SYLLABUS = """# 怎么谈工资 · 课程大纲

## 核心掌握项

### 谈判准备
- [ ] 能够解释 BATNA 并用于谈薪（来源：课程设计）
- [ ] 能够估算市场薪资区间

### 谈判过程
- [ ] 能够回应第一次还价

## 不在本课题范围内

- 劳动法诉讼
"""
LESSON = "# 先想好退路\n\nBATNA 是……\n\n## 思考题\n\n1. 你的 BATNA 是什么？\n\n<!-- mastery: 能够解释 BATNA 并用于谈薪; 能够估算市场薪资区间 -->"


def make_course(user, name="怎么谈工资", read=False, answered=False):
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name=name, language="zh")
        db.add(course)
        db.flush()
        db.add(Syllabus(course_id=course.id, content=SYLLABUS))
        lesson = Lesson(course_id=course.id, number=1, content=LESSON)
        db.add(lesson)
        db.flush()
        if read:
            db.add(LearningEvent(course_id=course.id, lesson_number=1, event_type="lesson_completed"))
        if answered:
            db.add(Feedback(lesson_id=lesson.id, content="", thought_answers="我的退路是现在这份工作"))
        db.commit()
        return course.id


def label_of(message, prefix, text):
    """候选列表里某个名字的编号：条目行是「A3. Salary — 路径」，分节行是整条路径「S2. … › Business」。"""
    match = re.search(rf"^\s*({prefix}\d+)\. (?:{re.escape(text)}\b|.* › {re.escape(text)}$)", message, re.M)
    return match.group(1) if match else None


class FakeModel:
    def __init__(self, pick="Salary", also=("Negotiation",), section=None):
        self.calls, self.pick, self.also, self.section = [], pick, also, section

    def __call__(self, system, message, **kwargs):
        name = kwargs["name"]
        self.calls.append((name, message, kwargs))
        if name == "terms-course-coordinate":
            return json.dumps({"search_terms": ["Salary", "Negotiation", "Employment"], "zh_terms": ["薪资谈判"]})
        if name == "pick-course-coordinate":
            return json.dumps({"pick": label_of(message, "A", self.pick) if self.pick else None,
                               "also": [label_of(message, "A", title) for title in self.also]})
        if name == "pick-course-section":
            return json.dumps({"pick": label_of(message, "S", self.section) if self.section else None})
        if name == "write-course-directions":
            return json.dumps({"directions": [{"pick": label_of(message, "C", "面试"), "question": "被问期望薪资时，怎么不先报数？",
                                               "reason": "你学会了谈薪，面试里第一次被问薪资就能用上。"}]})
        raise AssertionError(name)


def step(client, user, course_id):
    return client.post(f"/api/courses/{course_id}/coordinate/step?locale=zh", headers=bearer(user))


def card(client, user, course_id, locale="zh"):
    response = client.get(f"/api/courses/{course_id}/coordinate?locale={locale}", headers=bearer(user))
    assert response.status_code == 200, response.text
    return response.json()


def test_release_import_keeps_identity_apart_from_position(release):
    with TestSession() as db:
        assert db.query(KnNode).count() == len(SECTIONS) + len(ARTICLES) + 1
        primaries = db.query(KnEdge.target_id).filter(KnEdge.is_primary.is_(True)).all()
        assert len(primaries) == len({row[0] for row in primaries}) == db.query(KnNode).count() - 3  # 三个顶层没有上级
        assert {row.status for row in db.query(KnEdge).filter(KnEdge.generated_by.like("import:%"))} == {"confirmed"}
        # Claude 整理的概念挂父是结构判断，只能是 suggested；它和 QID 的对应是定义，confirmed
        assert db.query(KnEdge.status).filter(KnEdge.target_id == IDS["fund"]).scalar() == "suggested"
        assert db.query(KnMatch.status).filter(KnMatch.node_id == IDS["fund"]).scalar() == "confirmed"
        negotiation = {(row.lang, row.kind, row.text, row.source) for row in db.query(KnLabel).filter(KnLabel.node_id == IDS["Negotiation"])}
        assert ("en", "pref", "Negotiation", "wikidata") in negotiation  # 只差大小写时用维基标题的写法
        assert ("zh", "alt", "议价", "bloom") in negotiation
        employment = {(row.lang, row.kind, row.source) for row in db.query(KnLabel).filter(
            KnLabel.node_id == IDS[" › ".join(POLITICS + ["Business and economics", "Business", "Employment"])])}
        assert employment == {("en", "hidden", "l5")}  # 第四层没有 Bloom 名字：只用来检索，不展示
        mortgage = {(row.kind, row.text) for row in db.query(KnLabel).filter(KnLabel.node_id == IDS["Mortgage"], KnLabel.lang == "en")}
        assert mortgage == {("pref", "Mortgage loan"), ("hidden", "Mortgage")}
        assert all(re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", node_id) for (node_id,) in db.query(KnNode.id))


def test_local_search_follows_e1_scoring_and_reads_chinese_labels(release):
    with TestSession() as db:
        index = kg.label_index(db)
    entries, sections = index.search(["salary"], [])
    assert entries[0] == IDS["Salary"]
    entries, _ = index.search(["hot drinks"], [])
    assert IDS["Espresso"] in entries  # 条目也按所在分节的名字得分
    entries, _ = index.search([], ["公积金"])
    assert entries == [IDS["fund"]]
    entries, _ = index.search([], ["议价"])
    assert entries == [IDS["Negotiation"]]
    _, sections = index.search(["law"], [])
    assert sections[0] == IDS[" › ".join(POLITICS + ["Law"])]
    assert index.path_text(IDS["Salary"]).endswith("Business › Employment")


def test_course_is_placed_once_and_reused(client, release, monkeypatch):
    user = create_user("coordinate@example.com")
    course_id = make_course(user)
    fake = FakeModel()
    monkeypatch.setattr(coordinate, "_call_llm", fake)
    before = card(client, user, course_id)
    assert before["state"] == "pending" and before["needs"] == ["anchor", "directions"]
    assert fake.calls == []

    placed = step(client, user, course_id).json()
    assert placed["state"] == "placed" and placed["needs"] == ["directions"]
    here = placed["here"]
    assert here["node_id"] == IDS["Salary"] and here["label"] == "薪资" and here["level"] == "article"
    # 面包屑只显示 Bloom 写了名字的分节：第四层的 Employment 跳过，顶层在上面那条带里
    assert [c["label"] for c in here["crumbs"]] == ["政治与经济", "商业与经济", "商业"]
    assert here["also"] == [{"node_id": IDS["Negotiation"], "label": "谈判"}]
    assert [(b["label"], b["here"]) for b in placed["band"]] == [("日常生活", False), ("数学", False), ("社会与社会科学", True)]
    assert placed["next_item"]["text"] == "能够解释 BATNA 并用于谈薪"
    terms_message = fake.calls[0][1]
    assert "BATNA" in terms_message and "怎么谈工资" in terms_message  # 读大纲，不只看标题
    assert all(call[2]["temperature"] == 0 for call in fake.calls)

    directed = step(client, user, course_id).json()
    assert directed["needs"] == []  # 掌握项不再逐条链到节点：落点和相邻方向算完就没有下一步
    assert [(d["label"], d["question"], d["status"]) for d in directed["directions"]] == [("面试", "被问期望薪资时，怎么不先报数？", "suggested")]
    directions_message = next(message for name, message, _ in fake.calls if name == "write-course-directions")
    assert "面试 (Job interview)" in directions_message and "薪资" not in directions_message.split("Candidates:")[1]

    calls = len(fake.calls)
    assert step(client, user, course_id).status_code == 200
    card(client, user, course_id)
    assert len(fake.calls) == calls  # 算一次就存下来，之后只读库

    with TestSession() as db:
        anchors = {(row.node_id, row.role, row.status) for row in db.query(CourseAnchor).filter_by(course_id=course_id)}
        assert anchors == {(IDS["Salary"], "primary", "suggested"), (IDS["Negotiation"], "also", "suggested")}
        direction = db.query(LearningRecommendation).one()
        assert (direction.node_id, direction.for_course_id, direction.title) == (IDS["Job interview"], course_id, "面试")


def test_directions_stay_off_the_dashboard_until_saved(client, release, monkeypatch):
    user = create_user("coordinate-dashboard@example.com")
    course_id = make_course(user)
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel())
    step(client, user, course_id)
    direction = step(client, user, course_id).json()["directions"][0]
    dashboard = client.get("/api/recommendations", headers=bearer(user)).json()
    assert dashboard["recommendations"] == [] and dashboard["saved"] == []
    assert client.post(f"/api/recommendations/{direction['id']}/save", headers=bearer(user)).status_code == 200
    assert [item["title"] for item in client.get("/api/recommendations", headers=bearer(user)).json()["saved"]] == ["面试"]
    assert card(client, user, course_id)["directions"][0]["status"] == "saved"


def test_refresh_does_not_dismiss_course_directions(client, release, monkeypatch):
    from app import recommendations

    user = create_user("coordinate-refresh@example.com")
    course_id = make_course(user)
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel())
    step(client, user, course_id)
    step(client, user, course_id)
    monkeypatch.setattr(recommendations, "_call_llm", lambda *args, **kwargs: json.dumps(
        [{"kind": "explore", "title": "博弈论", "rationale": "r", "bridge": "b", "source_topics": []}]))
    assert client.post("/api/recommendations/refresh", headers=bearer(user), json={"locale": "zh"}).status_code == 200
    assert card(client, user, course_id)["directions"][0]["status"] == "suggested"


def test_not_interested_hides_a_direction_and_later_courses_skip_that_topic(client, release, monkeypatch):
    user = create_user("coordinate-dismiss@example.com")
    first = make_course(user)
    fake = FakeModel()
    monkeypatch.setattr(coordinate, "_call_llm", fake)
    step(client, user, first)
    direction = step(client, user, first).json()["directions"][0]
    assert direction["label"] == "面试"

    assert client.post(f"/api/recommendations/{direction['id']}/dismiss", headers=bearer(user)).status_code == 200
    assert card(client, user, first)["directions"] == []
    assert client.delete(f"/api/recommendations/{direction['id']}/dismiss", headers=bearer(user)).json()["status"] == "suggested"
    assert [d["status"] for d in card(client, user, first)["directions"]] == ["suggested"]
    client.post(f"/api/recommendations/{direction['id']}/dismiss", headers=bearer(user))

    second = make_course(user, name="谈薪进阶")
    step(client, user, second)
    assert step(client, user, second).json()["directions"] == []
    message = [message for name, message, _ in fake.calls if name == "write-course-directions"][-1]
    assert "面试" not in message.split("Candidates:")[1]

    # 知识地图：相邻方向算过了、只是都关掉了，不再说「进入课程后会给出」
    overview = {c["course_id"]: c for c in client.get("/api/knowledge-map/coordinate?locale=zh", headers=bearer(user)).json()["courses"]}
    assert (overview[first]["directions"], overview[first]["directions_pending"]) == ([], False)
    third = make_course(user, name="还没进过的课")
    overview = {c["course_id"]: c for c in client.get("/api/knowledge-map/coordinate?locale=zh", headers=bearer(user)).json()["courses"]}
    assert overview[third]["directions_pending"] is True


def test_falls_back_to_a_section_then_to_nothing(client, release, monkeypatch):
    user = create_user("coordinate-fallback@example.com")
    first = make_course(user, name="谈判")
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel(pick=None, also=(), section="Business"))
    placed = step(client, user, first).json()
    assert placed["here"]["level"] == "section" and placed["here"]["label"] == "商业"

    second = make_course(user, name="别的课")
    fake = FakeModel(pick=None, also=(), section=None)
    monkeypatch.setattr(coordinate, "_call_llm", fake)
    nothing = step(client, user, second).json()
    assert nothing["state"] == "none" and nothing["here"] is None and nothing["needs"] == []
    with TestSession() as db:
        run = db.get(CourseAnchorRun, second)
        assert (run.anchor, run.directions) == ("none", "none")
        assert db.query(CourseAnchor).filter_by(course_id=second).count() == 0


def test_learning_lights_the_node_with_evidence(client, release, monkeypatch):
    user = create_user("coordinate-state@example.com")
    course_id = make_course(user, read=True)
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel())
    placed = step(client, user, course_id).json()
    assert placed["here"]["state"] == "encountered"
    assert next(b for b in placed["band"] if b["here"])["courses"] == 1
    assert [(c["text"], c["state"]) for c in placed["covered"]] == [("能够估算市场薪资区间", "encountered")]
    assert placed["next_item"]["text"] == "能够回应第一次还价"
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=course_id).one()
        db.add(Feedback(lesson_id=lesson.id, content="", thought_answers="我的退路是现在这份工作"))
        db.commit()
    assert card(client, user, course_id)["here"]["state"] == "explained"
    with TestSession() as db:
        states = {(row.node_id, row.state) for row in db.query(LearnerNodeState).filter_by(user_uuid=user.uuid)}
        assert states == {(IDS["Salary"], "explained"), (IDS["Negotiation"], "explained")}
        evidence = json.loads(db.get(LearnerNodeState, (user.uuid, IDS["Salary"])).evidence)
        assert evidence == [{"course_id": course_id, "lessons": [1], "kind": "explained"}]


def test_second_course_connects_through_a_shared_parent(client, release, monkeypatch):
    user = create_user("coordinate-connect@example.com")
    first = make_course(user, name="怎么谈工资")
    second = make_course(user, name="面试准备")
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel())
    step(client, user, first)
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel(pick="Job interview", also=()))
    placed = step(client, user, second).json()
    assert placed["connect"]["course_name"] == "怎么谈工资" and placed["connect"]["label"] == "商业"
    assert all(b["courses"] == 0 for b in placed["band"])  # 两门课都还没读，顶层不点亮


def test_others_cannot_read_or_run_and_a_step_in_progress_blocks_another(client, release, monkeypatch):
    owner, stranger = create_user("coordinate-owner@example.com"), create_user("coordinate-stranger@example.com")
    course_id = make_course(owner)
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel())
    assert client.get(f"/api/courses/{course_id}/coordinate", headers=bearer(stranger)).status_code == 404
    assert step(client, stranger, course_id).status_code == 404

    with TestSession() as db:
        db.add(CourseAnchorRun(course_id=course_id, version=coordinate.VERSION, evidence="{}",
                               lease_ref="coordinate:other", lease_until=coordinate.utcnow() + timedelta(minutes=1)))
        db.commit()
    assert step(client, owner, course_id).status_code == 409


def test_a_failed_step_backs_off_and_keeps_nothing(client, release, monkeypatch):
    user = create_user("coordinate-failed@example.com")
    course_id = make_course(user)

    def broken(*args, **kwargs):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(coordinate, "_call_llm", broken)
    assert step(client, user, course_id).status_code == 502
    failed = card(client, user, course_id)
    assert failed["state"] == "failed" and failed["retry_after"] > 0
    assert step(client, user, course_id).status_code == 429
    with TestSession() as db:
        run = db.get(CourseAnchorRun, course_id)
        assert (run.anchor, run.attempts, run.lease_ref, run.last_error) == ("pending", 1, None, "RuntimeError")


def test_course_without_content_shows_nothing(client, release):
    user = create_user("coordinate-empty@example.com")
    with TestSession() as db:
        course = Course(user_uuid=user.uuid, name="空课", language="zh")
        db.add(course)
        db.commit()
        course_id = course.id
    assert card(client, user, course_id)["state"] == "empty"
    assert step(client, user, course_id).json()["state"] == "empty"


def overview(client, user, locale="zh"):
    response = client.get(f"/api/knowledge-map/coordinate?locale={locale}", headers=bearer(user))
    assert response.status_code == 200, response.text
    return response.json()


def test_overview_places_every_course_on_the_shared_tree(client, release, monkeypatch):
    user, stranger = create_user("overview@example.com"), create_user("overview-stranger@example.com")
    salary = make_course(user, name="怎么谈工资", read=True, answered=True)
    interview = make_course(user, name="面试准备")
    waiting = make_course(user, name="还没定位的课")
    make_course(stranger, name="别人的课")
    with TestSession() as db:
        db.add(Course(user_uuid=user.uuid, name="空课", language="zh"))
        db.commit()
    fake = FakeModel()
    monkeypatch.setattr(coordinate, "_call_llm", fake)
    step(client, user, salary)
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel(pick="Job interview", also=()))
    step(client, user, interview)
    calls = len(fake.calls)

    data = overview(client, user)
    assert len(fake.calls) == calls  # 总览只读库
    by_name = {c["name"]: c for c in data["courses"]}
    assert set(by_name) == {"怎么谈工资", "面试准备", "还没定位的课"}  # 别人的课、没内容的课不出现
    assert data["needs"] == [waiting]
    assert by_name["还没定位的课"]["state"] == "pending"
    placed = by_name["怎么谈工资"]
    assert placed["state"] == "placed" and placed["read"] and placed["learned"] == "explained"
    assert placed["here"]["label"] == "薪资" and placed["area"] == IDS[SOCIETY]
    assert [p["label"] for p in placed["path"]] == ["政治与经济", "商业与经济", "商业"]  # 全部有名字的上级，不止 3 级
    assert placed["also"] == [{"node_id": IDS["Negotiation"], "label": "谈判"}]
    assert by_name["面试准备"]["read"] is False and by_name["面试准备"]["learned"] is None
    society = next(b for b in data["band"] if b["node_id"] == IDS[SOCIETY])
    assert (society["placed"], society["courses"]) == (2, 1)  # 两门落在这里，读过的只有一门
    assert [b["label"] for b in data["band"]] == ["日常生活", "数学", "社会与社会科学"]


def test_overview_shows_failures_and_unplaceable_courses_without_asking_again(client, release, monkeypatch):
    user = create_user("overview-failed@example.com")
    broken, nowhere = make_course(user, name="出错的课"), make_course(user, name="放不下的课")

    def down(*args, **kwargs):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(coordinate, "_call_llm", down)
    assert step(client, user, broken).status_code == 502
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel(pick=None, also=(), section=None))
    step(client, user, nowhere)
    data = overview(client, user, locale="en")
    by_name = {c["name"]: c for c in data["courses"]}
    assert by_name["出错的课"]["state"] == "failed" and by_name["出错的课"]["retry_after"] > 0
    assert by_name["放不下的课"]["state"] == "none"
    assert data["needs"] == []
    assert data["band"][0]["label"] == "Everyday life"


def test_relabel_shows_wikipedia_names_and_fills_chinese(client, release, monkeypatch):
    base, names, _ = release_fixture()
    employment = " › ".join(POLITICS + ["Business and economics", "Business", "Employment"])
    relabel = {"release": {"id": "2026.11.1", "kind": "minor", "source": "wikipedia-vital-articles-level-5",
                           "snapshot_date": "2026-11-03", "based_on": "2026.11"},
               "section_zh": {employment: "雇佣"}, "article_zh": {}}
    base["articles"][3]["zh"] = ""  # Mortgage 没有中文标签：用翻译补
    relabel["article_zh"]["Mortgage"] = "抵押贷款"
    with engine.begin() as connection:
        done = kg.apply_relabel(connection, base, names, relabel, "sha")
    assert done["updated"] > 0
    with TestSession() as db:
        def pref(node_id, lang):
            return db.query(KnLabel.text, KnLabel.source).filter_by(node_id=node_id, lang=lang, kind="pref").one()
        assert pref(IDS[employment], "en") == ("Employment", "l5")
        assert pref(IDS[employment], "zh") == ("雇佣", "translated")
        assert pref(IDS[" › ".join(POLITICS + ["Law", "Basics"])], "en") == ("Basics", "l5")  # 维基原标题，不再用 Bloom 写的
        assert pref(IDS[" › ".join(POLITICS + ["Law", "Basics"])], "zh") == ("法律基础", "bloom")  # 已有的中文名不动
        assert pref(IDS["Mortgage"], "en") == ("Mortgage", "enwiki")
        alts = {text for (text,) in db.query(KnLabel.text).filter_by(node_id=IDS["Mortgage"], lang="en", kind="alt")}
        assert "Mortgage loan" in alts  # 换下来的名字留作别名
        assert db.query(KnRelease).filter_by(id="2026.11.1").one().kind == "minor"
    user = create_user("relabel@example.com")
    course_id = make_course(user)
    monkeypatch.setattr(coordinate, "_call_llm", FakeModel())
    here = step(client, user, course_id).json()["here"]
    assert [c["label"] for c in here["crumbs"]] == ["商业与经济", "商业", "雇佣"]  # 深层分节有了名字，面包屑不再跳过


# ---------- 模型调用 ----------

def test_a_non_json_reply_is_asked_again_once_on_the_fast_model(client, release, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "LLM_MODEL", "teaching-model")
    monkeypatch.setattr(settings, "LLM_FAST_MODEL", "fast-model")
    user = create_user("coordinate-reask@example.com")
    course_id = make_course(user)
    fake, seen = FakeModel(), []

    def flaky(system, message, **kwargs):
        seen.append((message, kwargs["model"]))
        if len(seen) == 1:
            return "不是 JSON"
        return fake(system, message, **kwargs)
    monkeypatch.setattr(coordinate, "_call_llm", flaky)
    assert step(client, user, course_id).json()["state"] == "placed"
    assert "The previous reply was not a JSON object" not in seen[0][0]
    assert seen[1][0].endswith("The previous reply was not a JSON object. Return only the JSON object.")
    assert {model for _, model in seen} == {"fast-model"}
    with TestSession() as db:
        assert {row.generated_by for row in db.query(CourseAnchor).filter_by(course_id=course_id)} == {
            f"llm:fast-model@{coordinate.VERSION}"}
