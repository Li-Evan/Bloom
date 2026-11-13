"""全局知识坐标系在真实 Postgres 上：导入的 release 结构完整，同一门课的同一步只有一个请求在跑模型。

TEST_DATABASE_URL 指向的库要先迁移到最新（alembic upgrade head，会导入 release 2026.11 和改名的 2026.11.1）。
"""
import json
import os
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import coordinate
from app import knowledge_graph as kg
from app.models import Course, CourseAnchorRun, Lesson, Syllabus
from tests.integration.pg import pg_engine, pg_user, run_all  # noqa: F401

# ruff: noqa: F811

pytestmark = [pytest.mark.postgres, pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="Requires isolated Postgres")]


def test_release_is_a_tree_with_bloom_names_on_the_top_levels(pg_engine):
    with pg_engine.connect() as conn:
        counts = dict(conn.execute(text("SELECT kind, count(*) FROM kn_node WHERE release_id = '2026.11' GROUP BY kind")).all())
        assert counts["section"] == 4515 and counts["article"] == 49753 and counts["concept"] > 30
        live = "{e}type = 'contains' AND {e}is_primary AND {e}valid_to IS NULL AND {e}status IN ('suggested', 'confirmed')"
        orphans = conn.execute(text(f"""SELECT count(*) FROM kn_node n WHERE NOT EXISTS (
            SELECT 1 FROM kn_edge e WHERE e.target_id = n.id AND {live.format(e='e.')})""")).scalar()
        assert orphans == 11  # 只有 L5 的 11 个顶层没有上级
        # 每个节点只有一条 primary 上级：从 11 个顶层往下走能走到全部节点，就说明没有环、没有断开的子树
        reached = conn.execute(text(f"""WITH RECURSIVE down(node) AS (
            SELECT n.id FROM kn_node n WHERE NOT EXISTS (SELECT 1 FROM kn_edge e WHERE e.target_id = n.id AND {live.format(e='e.')})
            UNION SELECT e.target_id FROM kn_edge e JOIN down ON e.source_id = down.node AND {live.format(e='e.')}
        ) SELECT count(*) FROM down""")).scalar()
        assert reached == sum(counts.values())
        # release 2026.11.1：分节全部用维基原标题做英文名；中文名上三层是 Bloom 写的 1,245 个，其余是翻译
        names = dict(conn.execute(text("""SELECT l.lang || ':' || l.source, count(*) FROM kn_label l JOIN kn_node n ON n.id = l.node_id
            WHERE n.kind = 'section' AND l.kind = 'pref' GROUP BY 1""")).all())
        assert names == {"en:l5": 4515, "zh:bloom": 1245, "zh:translated": 3270}
        assert conn.execute(text("SELECT kind FROM kn_release WHERE id = '2026.11.1'")).scalar() == "minor"


def test_label_index_builds_from_postgres(pg_engine):
    with Session(pg_engine) as db:
        started = time.monotonic()
        index = kg.label_index(db)
        built = time.monotonic() - started
        entries, _ = index.search(["Negotiation", "Salary"], ["谈判"])
        assert {index.listing[n] for n in entries[:3]} >= {"Negotiation", "Salary"}
        entries, _ = index.search([], ["公积金"])
        assert index.listing.get(entries[0]) == "Housing Provident Fund"
    assert built < 60


@pytest.fixture
def course(pg_engine, pg_user):
    with Session(pg_engine) as db:
        row = Course(user_uuid=pg_user, name="怎么谈工资", language="zh")
        db.add(row)
        db.flush()
        db.add(Syllabus(course_id=row.id, content="# 大纲\n\n### 准备\n- [ ] 能够解释 BATNA"))
        db.add(Lesson(course_id=row.id, number=1, content="# BATNA\n\n……"))
        db.commit()
        course_id = row.id
    yield course_id
    with Session(pg_engine) as db:
        db.query(Course).filter(Course.id == course_id).delete()
        db.commit()


def test_one_request_runs_a_step_while_others_get_busy(pg_engine, pg_user, course, monkeypatch):
    def slow(system, message, **kwargs):
        time.sleep(1.5)
        if kwargs["name"] == "terms-course-coordinate":
            return json.dumps({"search_terms": ["Salary"], "zh_terms": []})
        return json.dumps({"pick": "A1", "also": []})

    monkeypatch.setattr(coordinate, "_call_llm", slow)
    user = SimpleNamespace(uuid=pg_user)

    def work(db):
        try:
            return coordinate.coordinate_step(course, "zh", user, db)["state"]
        except HTTPException as exc:
            return exc.status_code

    results = run_all(pg_engine, [work] * 4)
    assert sorted(map(str, results)) == ["409", "409", "409", "placed"]
    with Session(pg_engine) as db:
        run = db.get(CourseAnchorRun, course)
        assert run.anchor == "article" and run.lease_ref is None
