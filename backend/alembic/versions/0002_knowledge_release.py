"""Import the global knowledge coordinate system: a frozen snapshot of Wikipedia Vital Articles Level 5 (release 2026.11),
then its display-name revision (release 2026.11.1). The data files are in backend/data/knowledge/; scripts/knowledge/
shows how they were built. Wikipedia titles are CC BY-SA, Wikidata labels CC0.

Revision ID: 0002_knowledge_release
Revises: 0001_initial
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_knowledge_release"
down_revision = "0001_initial"
branch_labels = None
depends_on = None

RELEASE = "2026.11"
RELABEL = "2026.11.1"


def upgrade():
    from app.knowledge_graph import import_release, relabel_release

    bind = op.get_bind()
    print(import_release(bind, RELEASE))
    print(relabel_release(bind, RELABEL))


def downgrade():
    bind = op.get_bind()
    ids = sa.select(sa.column("id")).select_from(sa.table("kn_node")).where(sa.column("release_id") == RELEASE)
    # 学习侧引用了这一版节点就不能回退：先确认没有课程落点、链接、学习状态、带节点的推荐
    for table in ("course_anchor", "item_node_link", "learner_node_state", "learning_recommendations"):
        used = bind.execute(sa.select(sa.func.count()).select_from(sa.table(table, sa.column("node_id"))).where(
            sa.column("node_id").in_(ids))).scalar()
        if used:
            raise RuntimeError(f"{table} still references release {RELEASE} nodes")
    bind.execute(sa.text("DELETE FROM kn_change WHERE release_id IN (:release, :relabel)"), {"release": RELEASE, "relabel": RELABEL})
    for table in ("kn_match", "kn_label"):
        bind.execute(sa.text(f"DELETE FROM {table} WHERE node_id IN (SELECT id FROM kn_node WHERE release_id = :release)"),
                     {"release": RELEASE})
    bind.execute(sa.text("DELETE FROM kn_edge WHERE valid_from = :release"), {"release": RELEASE})
    bind.execute(sa.text("DELETE FROM kn_node WHERE release_id = :release"), {"release": RELEASE})
    bind.execute(sa.text("DELETE FROM kn_release WHERE id IN (:release, :relabel)"), {"release": RELEASE, "relabel": RELABEL})
