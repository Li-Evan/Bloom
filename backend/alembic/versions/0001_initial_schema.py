"""Initial schema of the open-source Bloom backend.

Revision ID: 0001_initial
Revises:
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0001_initial'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('courses',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('mode', sa.String(), nullable=False),
    sa.Column('status', sa.String(), nullable=True),
    sa.Column('learning_depth', sa.String(), nullable=False),
    sa.Column('is_project', sa.Boolean(), nullable=False),
    sa.Column('is_clippings', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('language', sa.String(), server_default='zh', nullable=False),
    sa.Column('source_filename', sa.String(), nullable=True),
    sa.Column('source_content', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint("language IN ('zh', 'en')", name='ck_course_language'),
    sa.CheckConstraint("mode IN ('topic', 'source')", name='ck_course_mode'),
    sa.CheckConstraint("status IN ('learning', 'completed')", name='ck_course_status'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('courses', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_courses_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_courses_user_uuid'), ['user_uuid'], unique=False)
        batch_op.create_index('uq_courses_clippings', ['user_uuid'], unique=True, postgresql_where=sa.text('is_clippings'), sqlite_where=sa.text('is_clippings'))

    op.create_table('kn_release',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('source', sa.String(length=64), nullable=False),
    sa.Column('snapshot_date', sa.String(length=10), nullable=False),
    sa.Column('summary', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("kind IN ('major', 'minor')", name='ck_kn_release_kind'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('uuid', sa.String(length=255), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('nickname', sa.String(length=255), nullable=True),
    sa.Column('avatar_url', sa.String(length=255), nullable=True),
    sa.Column('locale', sa.String(length=50), nullable=True),
    sa.Column('archive_on_read', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('email'),
    sa.UniqueConstraint('uuid')
    )
    op.create_table('course_anchor_run',
    sa.Column('course_id', sa.Integer(), nullable=False),
    sa.Column('version', sa.String(length=32), nullable=False),
    sa.Column('anchor', sa.String(length=12), nullable=False),
    sa.Column('directions', sa.String(length=12), nullable=False),
    sa.Column('links', sa.String(length=12), nullable=False),
    sa.Column('evidence', sa.Text(), nullable=False),
    sa.Column('lease_ref', sa.String(length=64), nullable=True),
    sa.Column('lease_until', sa.DateTime(), nullable=True),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('retry_at', sa.DateTime(), nullable=True),
    sa.Column('last_error', sa.String(length=200), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("anchor IN ('pending', 'article', 'section', 'concept', 'none')", name='ck_course_anchor_run_anchor'),
    sa.CheckConstraint("directions IN ('pending', 'done', 'none')", name='ck_course_anchor_run_directions'),
    sa.CheckConstraint("links IN ('pending', 'done', 'none')", name='ck_course_anchor_run_links'),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('course_id')
    )
    op.create_table('kn_node',
    sa.Column('id', sa.String(length=26), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('visibility', sa.String(length=8), nullable=False),
    sa.Column('owner_uuid', sa.String(length=255), nullable=True),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('release_id', sa.String(length=32), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("(visibility = 'private') = (owner_uuid IS NOT NULL)", name='ck_kn_node_owner'),
    sa.CheckConstraint("kind IN ('section', 'article', 'concept')", name='ck_kn_node_kind'),
    sa.CheckConstraint("status IN ('active', 'deprecated')", name='ck_kn_node_status'),
    sa.CheckConstraint("visibility IN ('public', 'private')", name='ck_kn_node_visibility'),
    sa.ForeignKeyConstraint(['release_id'], ['kn_release.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('kn_node', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_kn_node_owner_uuid'), ['owner_uuid'], unique=False)

    op.create_table('learning_events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=False),
    sa.Column('lesson_number', sa.Integer(), nullable=True),
    sa.Column('event_type', sa.String(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('learning_events', schema=None) as batch_op:
        batch_op.create_index('ix_learning_events_course_created', ['course_id', 'created_at'], unique=False)
        batch_op.create_index('ix_learning_events_course_type', ['course_id', 'event_type', 'lesson_number'], unique=False)
        batch_op.create_index(batch_op.f('ix_learning_events_id'), ['id'], unique=False)

    op.create_table('lessons',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=False),
    sa.Column('number', sa.Integer(), nullable=False),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('is_evaluation', sa.Boolean(), nullable=True),
    sa.Column('is_source', sa.Boolean(), nullable=True),
    sa.Column('source_filename', sa.String(), nullable=True),
    sa.Column('source_url', sa.String(), nullable=True),
    sa.Column('archived_at', sa.DateTime(), nullable=True),
    sa.Column('teaching_plan', sa.Text(), nullable=True),
    sa.Column('source_blob', sa.LargeBinary(), nullable=True),
    sa.Column('knowledge_digest', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('course_id', 'number', name='uq_lesson_course_number')
    )
    with op.batch_alter_table('lessons', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_lessons_id'), ['id'], unique=False)
        batch_op.create_index('ix_lessons_source_url', ['source_url'], unique=False, postgresql_where=sa.text('source_url IS NOT NULL'), sqlite_where=sa.text('source_url IS NOT NULL'))

    op.create_table('project_images',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=True),
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('object_key', sa.String(length=80), nullable=False),
    sa.Column('content_type', sa.String(length=32), nullable=False),
    sa.Column('size', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('object_key')
    )
    with op.batch_alter_table('project_images', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_project_images_course_id'), ['course_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_project_images_user_uuid'), ['user_uuid'], unique=False)

    op.create_table('syllabi',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=False),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('course_id')
    )
    with op.batch_alter_table('syllabi', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_syllabi_id'), ['id'], unique=False)

    op.create_table('teaching_style_preferences',
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('preset', sa.String(length=32), nullable=False),
    sa.Column('custom_instructions', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['user_uuid'], ['users.uuid'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_uuid')
    )
    op.create_table('upload_sessions',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('size', sa.Integer(), nullable=False),
    sa.Column('manifest', sa.Text(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_uuid'], ['users.uuid'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('upload_sessions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_upload_sessions_expires_at'), ['expires_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_upload_sessions_user_uuid'), ['user_uuid'], unique=False)

    op.create_table('annotations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('lesson_id', sa.Integer(), nullable=False),
    sa.Column('position_start', sa.Integer(), nullable=False),
    sa.Column('position_end', sa.Integer(), nullable=False),
    sa.Column('original_text', sa.Text(), nullable=False),
    sa.Column('comment', sa.Text(), nullable=False),
    sa.Column('answer', sa.Text(), nullable=True),
    sa.Column('messages', sa.Text(), nullable=True),
    sa.Column('anchor_top', sa.Integer(), nullable=True),
    sa.Column('pdf_position', sa.Text(), nullable=True),
    sa.Column('request_id', sa.String(length=64), nullable=True),
    sa.Column('user_uuid', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint('position_end >= position_start', name='ck_annotation_positions'),
    sa.ForeignKeyConstraint(['lesson_id'], ['lessons.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('annotations', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_annotations_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_annotations_lesson_id'), ['lesson_id'], unique=False)
        batch_op.create_index('uq_annotations_lesson_request', ['lesson_id', 'request_id'], unique=True, postgresql_where=sa.text('request_id IS NOT NULL'), sqlite_where=sa.text('request_id IS NOT NULL'))

    op.create_table('course_anchor',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=False),
    sa.Column('node_id', sa.String(length=26), nullable=False),
    sa.Column('role', sa.String(length=8), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('generated_by', sa.String(length=64), nullable=False),
    sa.Column('evidence', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("role IN ('primary', 'also')", name='ck_course_anchor_role'),
    sa.CheckConstraint("status IN ('suggested', 'confirmed', 'rejected', 'deprecated')", name='ck_course_anchor_status'),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['node_id'], ['kn_node.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('course_id', 'node_id', name='uq_course_anchor')
    )
    with op.batch_alter_table('course_anchor', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_course_anchor_course_id'), ['course_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_course_anchor_node_id'), ['node_id'], unique=False)
        batch_op.create_index('uq_course_anchor_primary', ['course_id'], unique=True, postgresql_where=sa.text("role = 'primary'"), sqlite_where=sa.text("role = 'primary'"))

    op.create_table('feedbacks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('lesson_id', sa.Integer(), nullable=False),
    sa.Column('content', sa.Text(), nullable=True),
    sa.Column('thought_answers', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['lesson_id'], ['lessons.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('feedbacks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_feedbacks_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_feedbacks_lesson_id'), ['lesson_id'], unique=False)

    op.create_table('item_node_link',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=False),
    sa.Column('item_key', sa.String(length=64), nullable=False),
    sa.Column('item_text', sa.Text(), nullable=False),
    sa.Column('node_id', sa.String(length=26), nullable=True),
    sa.Column('match_type', sa.String(length=8), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('generated_by', sa.String(length=64), nullable=False),
    sa.Column('evidence', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("(match_type = 'none') = (node_id IS NULL)", name='ck_item_node_link_node'),
    sa.CheckConstraint("match_type IN ('exact', 'broader', 'none')", name='ck_item_node_link_match'),
    sa.CheckConstraint("status IN ('suggested', 'confirmed', 'rejected', 'deprecated')", name='ck_item_node_link_status'),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['node_id'], ['kn_node.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('course_id', 'item_key', name='uq_item_node_link')
    )
    with op.batch_alter_table('item_node_link', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_item_node_link_course_id'), ['course_id'], unique=False)

    op.create_table('kn_change',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('release_id', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('node_id', sa.String(length=26), nullable=True),
    sa.Column('detail', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("kind IN ('import', 'add', 'deprecate', 'merge', 'split', 'relabel', 'edge')", name='ck_kn_change_kind'),
    sa.ForeignKeyConstraint(['node_id'], ['kn_node.id'], ),
    sa.ForeignKeyConstraint(['release_id'], ['kn_release.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('kn_change', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_kn_change_release_id'), ['release_id'], unique=False)

    op.create_table('kn_edge',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=16), nullable=False),
    sa.Column('source_id', sa.String(length=26), nullable=False),
    sa.Column('target_id', sa.String(length=26), nullable=False),
    sa.Column('is_primary', sa.Boolean(), nullable=False),
    sa.Column('sort_key', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('reason', sa.Text(), nullable=True),
    sa.Column('generated_by', sa.String(length=64), nullable=False),
    sa.Column('evidence', sa.Text(), nullable=True),
    sa.Column('visibility', sa.String(length=8), nullable=False),
    sa.Column('owner_uuid', sa.String(length=255), nullable=True),
    sa.Column('valid_from', sa.String(length=32), nullable=True),
    sa.Column('valid_to', sa.String(length=32), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("(visibility = 'private') = (owner_uuid IS NOT NULL)", name='ck_kn_edge_owner'),
    sa.CheckConstraint("NOT is_primary OR type = 'contains'", name='ck_kn_edge_primary'),
    sa.CheckConstraint("status IN ('suggested', 'confirmed', 'rejected', 'deprecated')", name='ck_kn_edge_status'),
    sa.CheckConstraint("type = 'contains' OR reason IS NOT NULL", name='ck_kn_edge_reason'),
    sa.CheckConstraint("type IN ('contains', 'builds_towards', 'related')", name='ck_kn_edge_type'),
    sa.CheckConstraint("visibility IN ('public', 'private')", name='ck_kn_edge_visibility'),
    sa.ForeignKeyConstraint(['source_id'], ['kn_node.id'], ),
    sa.ForeignKeyConstraint(['target_id'], ['kn_node.id'], ),
    sa.ForeignKeyConstraint(['valid_from'], ['kn_release.id'], ),
    sa.ForeignKeyConstraint(['valid_to'], ['kn_release.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('kn_edge', schema=None) as batch_op:
        batch_op.create_index('ix_kn_edge_source', ['source_id', 'type'], unique=False)
        batch_op.create_index('ix_kn_edge_target', ['target_id', 'type'], unique=False)
        batch_op.create_index('uq_kn_edge_primary', ['target_id'], unique=True, postgresql_where=sa.text("type = 'contains' AND is_primary AND valid_to IS NULL AND status IN ('suggested', 'confirmed')"), sqlite_where=sa.text("type = 'contains' AND is_primary AND valid_to IS NULL AND status IN ('suggested', 'confirmed')"))

    op.create_table('kn_label',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('node_id', sa.String(length=26), nullable=False),
    sa.Column('lang', sa.String(length=8), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('text', sa.String(length=300), nullable=False),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.CheckConstraint("kind IN ('pref', 'alt', 'hidden')", name='ck_kn_label_kind'),
    sa.CheckConstraint("lang IN ('en', 'zh')", name='ck_kn_label_lang'),
    sa.ForeignKeyConstraint(['node_id'], ['kn_node.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('kn_label', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_kn_label_node_id'), ['node_id'], unique=False)
        batch_op.create_index('uq_kn_label_pref', ['node_id', 'lang'], unique=True, postgresql_where=sa.text("kind = 'pref'"), sqlite_where=sa.text("kind = 'pref'"))

    op.create_table('kn_match',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('node_id', sa.String(length=26), nullable=False),
    sa.Column('scheme', sa.String(length=16), nullable=False),
    sa.Column('external_id', sa.String(length=300), nullable=False),
    sa.Column('match_type', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('generated_by', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("match_type IN ('exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch')", name='ck_kn_match_type'),
    sa.CheckConstraint("scheme IN ('wikidata', 'enwiki')", name='ck_kn_match_scheme'),
    sa.CheckConstraint("status IN ('suggested', 'confirmed', 'rejected', 'deprecated')", name='ck_kn_match_status'),
    sa.ForeignKeyConstraint(['node_id'], ['kn_node.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('node_id', 'scheme', 'external_id', name='uq_kn_match')
    )
    with op.batch_alter_table('kn_match', schema=None) as batch_op:
        batch_op.create_index('ix_kn_match_external', ['scheme', 'external_id'], unique=False)

    op.create_table('kn_redirect',
    sa.Column('from_id', sa.String(length=26), nullable=False),
    sa.Column('to_id', sa.String(length=26), nullable=False),
    sa.Column('kind', sa.String(length=24), nullable=False),
    sa.Column('release_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("kind IN ('same_as', 'possibly_equivalent_to')", name='ck_kn_redirect_kind'),
    sa.ForeignKeyConstraint(['from_id'], ['kn_node.id'], ),
    sa.ForeignKeyConstraint(['release_id'], ['kn_release.id'], ),
    sa.ForeignKeyConstraint(['to_id'], ['kn_node.id'], ),
    sa.PrimaryKeyConstraint('from_id', 'to_id')
    )
    with op.batch_alter_table('kn_redirect', schema=None) as batch_op:
        batch_op.create_index('uq_kn_redirect_same_as', ['from_id'], unique=True, postgresql_where=sa.text("kind = 'same_as'"), sqlite_where=sa.text("kind = 'same_as'"))

    op.create_table('knowledge_chunks',
    sa.Column('lesson_id', sa.Integer(), nullable=False),
    sa.Column('part_index', sa.Integer(), nullable=False),
    sa.Column('fingerprint', sa.String(length=64), nullable=False),
    sa.Column('graph', sa.Text(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['lesson_id'], ['lessons.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('lesson_id', 'part_index')
    )
    op.create_table('learner_node_state',
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('node_id', sa.String(length=26), nullable=False),
    sa.Column('state', sa.String(length=12), nullable=False),
    sa.Column('evidence', sa.Text(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("state IN ('encountered', 'explained', 'applied')", name='ck_learner_node_state'),
    sa.ForeignKeyConstraint(['node_id'], ['kn_node.id'], ),
    sa.PrimaryKeyConstraint('user_uuid', 'node_id')
    )
    op.create_table('learning_recommendations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('title', sa.String(), nullable=False),
    sa.Column('rationale', sa.Text(), nullable=False),
    sa.Column('bridge', sa.Text(), nullable=True),
    sa.Column('source_topics', sa.Text(), nullable=True),
    sa.Column('status', sa.String(), nullable=False),
    sa.Column('generation', sa.Integer(), nullable=False),
    sa.Column('language', sa.String(), server_default='zh', nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=True),
    sa.Column('node_id', sa.String(length=26), nullable=True),
    sa.Column('for_course_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint("language IN ('zh', 'en')", name='ck_learning_recommendation_language'),
    sa.CheckConstraint("status IN ('suggested', 'saved', 'started', 'dismissed')", name='ck_learning_recommendation_status'),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['for_course_id'], ['courses.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['node_id'], ['kn_node.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('learning_recommendations', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_learning_recommendations_for_course_id'), ['for_course_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_learning_recommendations_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_learning_recommendations_user_uuid'), ['user_uuid'], unique=False)

    op.create_table('lesson_chats',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('lesson_id', sa.Integer(), nullable=False),
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('messages', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['lesson_id'], ['lessons.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('lesson_id', 'user_uuid', name='uq_lesson_chat')
    )
    with op.batch_alter_table('lesson_chats', schema=None) as batch_op:
        batch_op.create_index('ix_lesson_chats_user', ['user_uuid'], unique=False)

    op.create_table('passage_highlights',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('lesson_id', sa.Integer(), nullable=False),
    sa.Column('position_start', sa.Integer(), nullable=False),
    sa.Column('position_end', sa.Integer(), nullable=False),
    sa.Column('original_text', sa.Text(), nullable=False),
    sa.Column('anchor_top', sa.Integer(), nullable=False),
    sa.Column('pdf_position', sa.Text(), nullable=True),
    sa.Column('user_uuid', sa.String(length=255), nullable=True),
    sa.CheckConstraint('position_end >= position_start', name='ck_passage_highlight_positions'),
    sa.ForeignKeyConstraint(['lesson_id'], ['lessons.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('passage_highlights', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_passage_highlights_lesson_id'), ['lesson_id'], unique=False)

    op.create_table('passage_translations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('lesson_id', sa.Integer(), nullable=False),
    sa.Column('user_uuid', sa.String(length=255), nullable=False),
    sa.Column('position_start', sa.Integer(), nullable=False),
    sa.Column('position_end', sa.Integer(), nullable=False),
    sa.Column('original_text', sa.Text(), nullable=False),
    sa.Column('anchor_top', sa.Integer(), nullable=False),
    sa.Column('pdf_position', sa.Text(), nullable=True),
    sa.Column('target', sa.String(length=8), nullable=False),
    sa.Column('translation', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint('position_end >= position_start', name='ck_passage_translation_positions'),
    sa.ForeignKeyConstraint(['lesson_id'], ['lessons.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('passage_translations', schema=None) as batch_op:
        batch_op.create_index('ix_passage_translations_lesson_user', ['lesson_id', 'user_uuid'], unique=False)

    op.create_table('teaching_feedback',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('course_id', sa.Integer(), nullable=False),
    sa.Column('lesson_id', sa.Integer(), nullable=False),
    sa.Column('target_lesson', sa.Integer(), nullable=False),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('thought_answers', sa.Text(), nullable=False),
    sa.Column('requested_scope', sa.String(length=16), nullable=False),
    sa.Column('effective_scope', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('is_unresolved', sa.Boolean(), nullable=False),
    sa.Column('difficulty_resolved', sa.Boolean(), nullable=False),
    sa.Column('last_applied_lesson', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint("effective_scope IN ('pending','next','course','unresolved')", name='ck_teaching_effective_scope'),
    sa.CheckConstraint("requested_scope IN ('auto','next','course')", name='ck_teaching_requested_scope'),
    sa.CheckConstraint("status IN ('active','superseded','cancelled','resolved')", name='ck_teaching_status'),
    sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['lesson_id'], ['lessons.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('teaching_feedback', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_teaching_feedback_course_id'), ['course_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_teaching_feedback_lesson_id'), ['lesson_id'], unique=False)

    op.create_table('upload_parts',
    sa.Column('upload_id', sa.String(length=32), nullable=False),
    sa.Column('file_index', sa.Integer(), nullable=False),
    sa.Column('part_index', sa.Integer(), nullable=False),
    sa.Column('data', sa.LargeBinary(), nullable=False),
    sa.ForeignKeyConstraint(['upload_id'], ['upload_sessions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('upload_id', 'file_index', 'part_index')
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('upload_parts')
    with op.batch_alter_table('teaching_feedback', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_teaching_feedback_lesson_id'))
        batch_op.drop_index(batch_op.f('ix_teaching_feedback_course_id'))

    op.drop_table('teaching_feedback')
    with op.batch_alter_table('passage_translations', schema=None) as batch_op:
        batch_op.drop_index('ix_passage_translations_lesson_user')

    op.drop_table('passage_translations')
    with op.batch_alter_table('passage_highlights', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_passage_highlights_lesson_id'))

    op.drop_table('passage_highlights')
    with op.batch_alter_table('lesson_chats', schema=None) as batch_op:
        batch_op.drop_index('ix_lesson_chats_user')

    op.drop_table('lesson_chats')
    with op.batch_alter_table('learning_recommendations', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_learning_recommendations_user_uuid'))
        batch_op.drop_index(batch_op.f('ix_learning_recommendations_id'))
        batch_op.drop_index(batch_op.f('ix_learning_recommendations_for_course_id'))

    op.drop_table('learning_recommendations')
    op.drop_table('learner_node_state')
    op.drop_table('knowledge_chunks')
    with op.batch_alter_table('kn_redirect', schema=None) as batch_op:
        batch_op.drop_index('uq_kn_redirect_same_as', postgresql_where=sa.text("kind = 'same_as'"), sqlite_where=sa.text("kind = 'same_as'"))

    op.drop_table('kn_redirect')
    with op.batch_alter_table('kn_match', schema=None) as batch_op:
        batch_op.drop_index('ix_kn_match_external')

    op.drop_table('kn_match')
    with op.batch_alter_table('kn_label', schema=None) as batch_op:
        batch_op.drop_index('uq_kn_label_pref', postgresql_where=sa.text("kind = 'pref'"), sqlite_where=sa.text("kind = 'pref'"))
        batch_op.drop_index(batch_op.f('ix_kn_label_node_id'))

    op.drop_table('kn_label')
    with op.batch_alter_table('kn_edge', schema=None) as batch_op:
        batch_op.drop_index('uq_kn_edge_primary', postgresql_where=sa.text("type = 'contains' AND is_primary AND valid_to IS NULL AND status IN ('suggested', 'confirmed')"), sqlite_where=sa.text("type = 'contains' AND is_primary AND valid_to IS NULL AND status IN ('suggested', 'confirmed')"))
        batch_op.drop_index('ix_kn_edge_target')
        batch_op.drop_index('ix_kn_edge_source')

    op.drop_table('kn_edge')
    with op.batch_alter_table('kn_change', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_kn_change_release_id'))

    op.drop_table('kn_change')
    with op.batch_alter_table('item_node_link', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_item_node_link_course_id'))

    op.drop_table('item_node_link')
    with op.batch_alter_table('feedbacks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_feedbacks_lesson_id'))
        batch_op.drop_index(batch_op.f('ix_feedbacks_id'))

    op.drop_table('feedbacks')
    with op.batch_alter_table('course_anchor', schema=None) as batch_op:
        batch_op.drop_index('uq_course_anchor_primary', postgresql_where=sa.text("role = 'primary'"), sqlite_where=sa.text("role = 'primary'"))
        batch_op.drop_index(batch_op.f('ix_course_anchor_node_id'))
        batch_op.drop_index(batch_op.f('ix_course_anchor_course_id'))

    op.drop_table('course_anchor')
    with op.batch_alter_table('annotations', schema=None) as batch_op:
        batch_op.drop_index('uq_annotations_lesson_request', postgresql_where=sa.text('request_id IS NOT NULL'), sqlite_where=sa.text('request_id IS NOT NULL'))
        batch_op.drop_index(batch_op.f('ix_annotations_lesson_id'))
        batch_op.drop_index(batch_op.f('ix_annotations_id'))

    op.drop_table('annotations')
    with op.batch_alter_table('upload_sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_upload_sessions_user_uuid'))
        batch_op.drop_index(batch_op.f('ix_upload_sessions_expires_at'))

    op.drop_table('upload_sessions')
    op.drop_table('teaching_style_preferences')
    with op.batch_alter_table('syllabi', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_syllabi_id'))

    op.drop_table('syllabi')
    with op.batch_alter_table('project_images', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_images_user_uuid'))
        batch_op.drop_index(batch_op.f('ix_project_images_course_id'))

    op.drop_table('project_images')
    with op.batch_alter_table('lessons', schema=None) as batch_op:
        batch_op.drop_index('ix_lessons_source_url', postgresql_where=sa.text('source_url IS NOT NULL'), sqlite_where=sa.text('source_url IS NOT NULL'))
        batch_op.drop_index(batch_op.f('ix_lessons_id'))

    op.drop_table('lessons')
    with op.batch_alter_table('learning_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_learning_events_id'))
        batch_op.drop_index('ix_learning_events_course_type')
        batch_op.drop_index('ix_learning_events_course_created')

    op.drop_table('learning_events')
    with op.batch_alter_table('kn_node', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_kn_node_owner_uuid'))

    op.drop_table('kn_node')
    op.drop_table('course_anchor_run')
    op.drop_table('users')
    op.drop_table('kn_release')
    with op.batch_alter_table('courses', schema=None) as batch_op:
        batch_op.drop_index('uq_courses_clippings', postgresql_where=sa.text('is_clippings'), sqlite_where=sa.text('is_clippings'))
        batch_op.drop_index(batch_op.f('ix_courses_user_uuid'))
        batch_op.drop_index(batch_op.f('ix_courses_id'))

    op.drop_table('courses')
