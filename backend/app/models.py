from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean, LargeBinary, CheckConstraint, Index, UniqueConstraint, text
from sqlalchemy.orm import deferred, relationship

from app.database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    """开源版只有一个本地用户（app/auth.py 第一次用到时建出来）；各表仍按 user_uuid 归属，查询不用改。"""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    uuid = Column(String(255), unique=True, nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    nickname = Column(String(255))
    avatar_url = Column(String(255))
    locale = Column(String(50))
    # 设置里的「读完立刻归档」：资料课里点「标记已读」时顺手把这个文件归档
    archive_on_read = Column(Boolean, nullable=False, default=False, server_default="false")
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


class KnowledgeChunk(Base):
    __tablename__ = 'knowledge_chunks'
    lesson_id = Column(Integer, ForeignKey('lessons.id', ondelete='CASCADE'), primary_key=True)
    part_index = Column(Integer, primary_key=True)
    fingerprint = Column(String(64), nullable=False)
    graph = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, nullable=False)


class Course(Base):
    __tablename__ = "courses"
    __table_args__ = (
        CheckConstraint("status IN ('learning', 'completed')", name="ck_course_status"),
        CheckConstraint("mode IN ('topic', 'source')", name="ck_course_mode"),
        CheckConstraint("language IN ('zh', 'en')", name="ck_course_language"),
        # 每人最多一门「网页剪藏」
        Index("uq_courses_clippings", "user_uuid", unique=True,
              postgresql_where=text("is_clippings"), sqlite_where=text("is_clippings")),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_uuid = Column(String(255), nullable=False, index=True)
    name = Column(String, nullable=False)
    mode = Column(String, default="topic", nullable=False)
    status = Column(String, default="learning")
    learning_depth = Column(String, default="standard", nullable=False)
    is_project = Column(Boolean, default=False, nullable=False)
    # 浏览器插件剪下来的网页都进这门项目课（app/clippings.py）；认它靠这个标记，不靠课名（课名可以改）
    is_clippings = Column(Boolean, default=False, server_default="false", nullable=False)
    language = Column(String, default="zh", server_default="zh", nullable=False)  # 课程语言，建课时确定，之后不变
    source_filename = Column(String, nullable=True)
    source_content = deferred(Column(Text, nullable=True))
    created_at = Column(DateTime, default=_utcnow)

    syllabus = relationship("Syllabus", back_populates="course", uselist=False, cascade="all, delete-orphan")
    lessons = relationship("Lesson", back_populates="course", order_by="Lesson.number", cascade="all, delete-orphan")
    teaching_feedback = relationship("TeachingFeedback", cascade="all, delete-orphan")
    learning_events = relationship("LearningEvent", back_populates="course", cascade="all, delete-orphan")


class ProjectImage(Base):
    __tablename__ = "project_images"
    id = Column(String(32), primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="SET NULL"), nullable=True, index=True)
    user_uuid = Column(String(255), nullable=False, index=True)
    object_key = Column(String(80), nullable=False, unique=True)
    content_type = Column(String(32), nullable=False)
    size = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class Syllabus(Base):
    __tablename__ = "syllabi"

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), unique=True, nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow)

    course = relationship("Course", back_populates="syllabus")


class Lesson(Base):
    __tablename__ = "lessons"
    __table_args__ = (
        UniqueConstraint("course_id", "number", name="uq_lesson_course_number"),
        Index("ix_lessons_source_url", "source_url",
              postgresql_where=text("source_url IS NOT NULL"), sqlite_where=text("source_url IS NOT NULL")),
    )

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False)
    number = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    is_evaluation = Column(Boolean, default=False)
    is_source = Column(Boolean, default=False)
    source_filename = Column(String, nullable=True)
    source_url = Column(String, nullable=True)  # 剪藏来的网页地址：同一网页再剪一次直接打开这一篇
    # 资料课里归档的文件：课程页列表把它收进「已归档」，不算已读进度和「继续学习」，照常能打开
    archived_at = Column(DateTime, nullable=True)
    teaching_plan = Column(Text, nullable=True)  # frozen plan + feedback revision IDs for this generated lesson
    source_blob = deferred(Column(LargeBinary, nullable=True))  # 原始文件二进制（PDF 等，前端 pdf.js 原生渲染）
    # 知识地图的分块指纹缓存 JSON {"head": 正文开头的 md5, "sig": 课程名与语言的摘要, "parts": [各块指纹]}：
    # 读地图时只让数据库算 md5 比对，对得上就不必把正文读出来重新切块（app/knowledge.py learned_parts）
    knowledge_digest = deferred(Column(Text, nullable=True))
    created_at = Column(DateTime, default=_utcnow)

    course = relationship("Course", back_populates="lessons")
    annotations = relationship("Annotation", back_populates="lesson", cascade="all, delete-orphan")
    feedback = relationship("Feedback", back_populates="lesson", uselist=False, cascade="all, delete-orphan")


class Annotation(Base):
    __tablename__ = "annotations"
    __table_args__ = (
        CheckConstraint("position_end >= position_start", name="ck_annotation_positions"),
        # 同一篇课文里一个 request_id 只对应一条批注（停止保存与后台保存合并的兜底）
        Index("uq_annotations_lesson_request", "lesson_id", "request_id", unique=True,
              postgresql_where=text("request_id IS NOT NULL"), sqlite_where=text("request_id IS NOT NULL")),
    )

    id = Column(Integer, primary_key=True, index=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False, index=True)
    position_start = Column(Integer, nullable=False)
    position_end = Column(Integer, nullable=False)
    original_text = Column(Text, nullable=False)
    comment = Column(Text, nullable=False)
    answer = Column(Text, default="")
    messages = Column(Text, default="")  # JSON: [{"role": "user"|"assistant", "content": str}]
    anchor_top = Column(Integer, default=0)  # vertical offset (px) within the article, for margin dot
    pdf_position = Column(Text, nullable=True)  # JSON: PDF 几何高亮 {page, rects:[{x,y,w,h} 归一化 0~1]}
    request_id = Column(String(64), nullable=True)  # 前端这次提问的 id：停止时存的半截回答和后台存的完整回答靠它对上
    user_uuid = Column(String(255), nullable=True)  # 谁问的：笔记页按它列
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)  # 会话最近一次有新内容（追问、中断保存）的时间

    lesson = relationship("Lesson", back_populates="annotations")


class Feedback(Base):
    __tablename__ = "feedbacks"

    id = Column(Integer, primary_key=True, index=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False, index=True)
    content = Column(Text, default="")
    thought_answers = Column(Text, default="")
    created_at = Column(DateTime, default=_utcnow)

    lesson = relationship("Lesson", back_populates="feedback")


class LearningEvent(Base):
    """Track learning activities for analytics."""
    __tablename__ = "learning_events"
    __table_args__ = (
        Index("ix_learning_events_course_type", "course_id", "event_type", "lesson_number"),
        Index("ix_learning_events_course_created", "course_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False)
    lesson_number = Column(Integer, nullable=True)
    event_type = Column(String, nullable=False)  # lesson_opened, lesson_completed, annotation_added, feedback_submitted
    created_at = Column(DateTime, default=_utcnow)

    course = relationship("Course", back_populates="learning_events")


class LearningRecommendation(Base):
    __tablename__ = "learning_recommendations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('suggested', 'saved', 'started', 'dismissed')",
            name="ck_learning_recommendation_status",
        ),
        CheckConstraint("language IN ('zh', 'en')", name="ck_learning_recommendation_language"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_uuid = Column(String(255), nullable=False, index=True)
    title = Column(String, nullable=False)
    rationale = Column(Text, nullable=False)
    bridge = Column(Text, default="")
    source_topics = Column(Text, default="[]")
    status = Column(String, default="suggested", nullable=False)
    generation = Column(Integer, default=1, nullable=False)
    language = Column(String, default="zh", server_default="zh", nullable=False)  # 标题与理由用的语言，从推荐开课时课程取它
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="SET NULL"), nullable=True)
    # 单门课坐标卡片上的「相邻方向」：落在知识坐标的哪个节点、是给哪门课算的。首页的三个推荐两列都为空
    node_id = Column(String(26), ForeignKey("kn_node.id"), nullable=True)
    for_course_id = Column(Integer, ForeignKey("courses.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class TeachingFeedback(Base):
    __tablename__ = "teaching_feedback"
    __table_args__ = (
        CheckConstraint("requested_scope IN ('auto','next','course')", name="ck_teaching_requested_scope"),
        CheckConstraint("effective_scope IN ('pending','next','course','unresolved')", name="ck_teaching_effective_scope"),
        CheckConstraint("status IN ('active','superseded','cancelled','resolved')", name="ck_teaching_status"),
    )
    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False, index=True)
    target_lesson = Column(Integer, nullable=False)
    content = Column(Text, nullable=False, default="")
    thought_answers = Column(Text, nullable=False, default="")
    requested_scope = Column(String(16), nullable=False, default="auto")
    effective_scope = Column(String(16), nullable=False, default="pending")
    status = Column(String(16), nullable=False, default="active")
    is_unresolved = Column(Boolean, nullable=False, default=False)
    difficulty_resolved = Column(Boolean, nullable=False, default=False)
    last_applied_lesson = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    lesson = relationship("Lesson")


class UploadSession(Base):
    __tablename__ = "upload_sessions"
    id = Column(String(32), primary_key=True)
    user_uuid = Column(String(255), ForeignKey("users.uuid", ondelete="CASCADE"), nullable=False, index=True)
    size = Column(Integer, nullable=False)
    manifest = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)


class UploadPart(Base):
    __tablename__ = "upload_parts"
    upload_id = Column(String(32), ForeignKey("upload_sessions.id", ondelete="CASCADE"), primary_key=True)
    file_index = Column(Integer, primary_key=True)
    part_index = Column(Integer, primary_key=True)
    data = Column(LargeBinary, nullable=False)


class TeachingStylePreference(Base):
    __tablename__ = "teaching_style_preferences"
    user_uuid = Column(String(255), ForeignKey("users.uuid", ondelete="CASCADE"), primary_key=True)
    preset = Column(String(32), nullable=False)
    custom_instructions = Column(Text, nullable=False, default="")


class PassageHighlight(Base):
    """A saved passage, independent from questions and teaching feedback."""
    __tablename__ = "passage_highlights"
    __table_args__ = (CheckConstraint("position_end >= position_start", name="ck_passage_highlight_positions"),)
    id = Column(Integer, primary_key=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False, index=True)
    position_start = Column(Integer, nullable=False)
    position_end = Column(Integer, nullable=False)
    original_text = Column(Text, nullable=False)
    anchor_top = Column(Integer, nullable=False, default=0)
    pdf_position = Column(Text, nullable=True)
    user_uuid = Column(String(255), nullable=True)


class PassageTranslation(Base):
    """A saved selection translation of one learner."""
    __tablename__ = "passage_translations"
    __table_args__ = (CheckConstraint("position_end >= position_start", name="ck_passage_translation_positions"),
                      Index("ix_passage_translations_lesson_user", "lesson_id", "user_uuid"))
    id = Column(Integer, primary_key=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False)
    user_uuid = Column(String(255), nullable=False)
    position_start = Column(Integer, nullable=False)
    position_end = Column(Integer, nullable=False)
    original_text = Column(Text, nullable=False)
    anchor_top = Column(Integer, nullable=False, default=0)
    pdf_position = Column(Text, nullable=True)
    target = Column(String(8), nullable=False)
    translation = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class LessonChat(Base):
    """「问这篇」的对话：每人每篇一份，课文删了跟着删。"""
    __tablename__ = "lesson_chats"
    __table_args__ = (UniqueConstraint("lesson_id", "user_uuid", name="uq_lesson_chat"),
                      Index("ix_lesson_chats_user", "user_uuid"))
    id = Column(Integer, primary_key=True)
    lesson_id = Column(Integer, ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False)
    user_uuid = Column(String(255), nullable=False)
    messages = Column(Text, nullable=False, default="[]")  # JSON: [{"role": "user"|"assistant", "content": str, "partial"?: true}]
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)


def course_access(user_uuid: str):
    """这门课属于这个用户。"""
    return Course.user_uuid == user_uuid


# 全局知识坐标系的五条契约：
# 1. 节点 ID 不透明，名称、语言、位置都不在 ID 里；合并后旧 ID 只做重定向，不删不复用。
# 2. 学习侧（课程落点、掌握项链接、学习状态、推荐）只存 node_id。
# 3. 关系只有一张边表，每条边带类型、状态、出处、版本区间和可见性。
# 4. 私有节点和边只能往公共节点下挂，公共层不收用户的原始字符串。
# 5. 模型只在检索出的候选里按编号选，决定落库复用，不每次重判。
KN_STATUS = "status IN ('suggested', 'confirmed', 'rejected', 'deprecated')"
KN_VISIBILITY = "visibility IN ('public', 'private')"
KN_OWNER = "(visibility = 'private') = (owner_uuid IS NOT NULL)"


class KnRelease(Base):
    """一次结构发布：major 增删节点、改结构，minor 只改标签和关系。内容变化记在 kn_change。"""
    __tablename__ = "kn_release"
    __table_args__ = (CheckConstraint("kind IN ('major', 'minor')", name="ck_kn_release_kind"),)
    id = Column(String(32), primary_key=True)
    kind = Column(String(8), nullable=False)
    source = Column(String(64), nullable=False)
    snapshot_date = Column(String(10), nullable=False)
    summary = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class KnNode(Base):
    __tablename__ = "kn_node"
    __table_args__ = (
        CheckConstraint("kind IN ('section', 'article', 'concept')", name="ck_kn_node_kind"),
        CheckConstraint(KN_VISIBILITY, name="ck_kn_node_visibility"),
        CheckConstraint(KN_OWNER, name="ck_kn_node_owner"),
        CheckConstraint("status IN ('active', 'deprecated')", name="ck_kn_node_status"),
    )
    id = Column(String(26), primary_key=True)
    kind = Column(String(8), nullable=False)
    visibility = Column(String(8), nullable=False, default="public")
    owner_uuid = Column(String(255), nullable=True, index=True)
    status = Column(String(12), nullable=False, default="active")
    release_id = Column(String(32), ForeignKey("kn_release.id"), nullable=True)  # 公共节点从哪一版开始有
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class KnLabel(Base):
    """节点的名字：pref 是展示名（每种语言至多一个），alt 是别名，hidden 只用来检索。同一个字面可以属于不同节点。
    同一节点不重复的字面由写入方去重（导入时就去重了），不另建四列的唯一索引：27 万行上它比表本身还大。"""
    __tablename__ = "kn_label"
    __table_args__ = (
        CheckConstraint("lang IN ('en', 'zh')", name="ck_kn_label_lang"),
        CheckConstraint("kind IN ('pref', 'alt', 'hidden')", name="ck_kn_label_kind"),
        Index("uq_kn_label_pref", "node_id", "lang", unique=True,
              postgresql_where=text("kind = 'pref'"), sqlite_where=text("kind = 'pref'")),
    )
    id = Column(Integer, primary_key=True)
    node_id = Column(String(26), ForeignKey("kn_node.id"), nullable=False, index=True)
    lang = Column(String(8), nullable=False)
    kind = Column(String(8), nullable=False)
    text = Column(String(300), nullable=False)
    source = Column(String(32), nullable=False)  # l5（分节原标题）、enwiki（条目标题）、wikidata、bloom（Bloom 写的）、translated（翻译补的中文）


class KnEdge(Base):
    """contains：target 属于 source 这个主题（只存直接边，多父合法，每个节点恰好一条 primary）；
    builds_towards：学好 source 有助于学 target（软先修，永不锁定）；related：有实质联系。后两种必须写 reason。
    L5 导入的 contains 是 confirmed，模型生成的边一律 suggested，被否的边留作 rejected。"""
    __tablename__ = "kn_edge"
    __table_args__ = (
        CheckConstraint("type IN ('contains', 'builds_towards', 'related')", name="ck_kn_edge_type"),
        CheckConstraint(KN_STATUS, name="ck_kn_edge_status"),
        CheckConstraint(KN_VISIBILITY, name="ck_kn_edge_visibility"),
        CheckConstraint(KN_OWNER, name="ck_kn_edge_owner"),
        CheckConstraint("type = 'contains' OR reason IS NOT NULL", name="ck_kn_edge_reason"),
        CheckConstraint("NOT is_primary OR type = 'contains'", name="ck_kn_edge_primary"),
        Index("ix_kn_edge_target", "target_id", "type"),
        Index("ix_kn_edge_source", "source_id", "type"),
        Index("uq_kn_edge_primary", "target_id", unique=True,
              postgresql_where=text("type = 'contains' AND is_primary AND valid_to IS NULL AND status IN ('suggested', 'confirmed')"),
              sqlite_where=text("type = 'contains' AND is_primary AND valid_to IS NULL AND status IN ('suggested', 'confirmed')")),
    )
    id = Column(Integer, primary_key=True)
    type = Column(String(16), nullable=False)
    source_id = Column(String(26), ForeignKey("kn_node.id"), nullable=False)
    target_id = Column(String(26), ForeignKey("kn_node.id"), nullable=False)
    is_primary = Column(Boolean, nullable=False, default=False)
    sort_key = Column(Integer, nullable=False, default=0)
    status = Column(String(12), nullable=False, default="suggested")
    reason = Column(Text, nullable=True)
    generated_by = Column(String(64), nullable=False)
    evidence = Column(Text, nullable=True)
    visibility = Column(String(8), nullable=False, default="public")
    owner_uuid = Column(String(255), nullable=True)
    valid_from = Column(String(32), ForeignKey("kn_release.id"), nullable=True)
    valid_to = Column(String(32), ForeignKey("kn_release.id"), nullable=True)  # 哪一版起失效；当前有效的为空
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)


class KnMatch(Base):
    """节点对外部身份的映射，用 SKOS 的五种类型：只有 exactMatch 可以传递推理。"""
    __tablename__ = "kn_match"
    __table_args__ = (
        CheckConstraint("scheme IN ('wikidata', 'enwiki')", name="ck_kn_match_scheme"),
        CheckConstraint("match_type IN ('exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch')",
                        name="ck_kn_match_type"),
        CheckConstraint(KN_STATUS, name="ck_kn_match_status"),
        UniqueConstraint("node_id", "scheme", "external_id", name="uq_kn_match"),
        Index("ix_kn_match_external", "scheme", "external_id"),
    )
    id = Column(Integer, primary_key=True)
    node_id = Column(String(26), ForeignKey("kn_node.id"), nullable=False)  # 按节点查走 uq_kn_match
    scheme = Column(String(16), nullable=False)
    external_id = Column(String(300), nullable=False)
    match_type = Column(String(16), nullable=False)
    status = Column(String(12), nullable=False, default="suggested")
    generated_by = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class KnRedirect(Base):
    """合并记 same_as（恰好一个目标），拆分记 possibly_equivalent_to（多个目标，要人判断）。读路径自动跟随。"""
    __tablename__ = "kn_redirect"
    __table_args__ = (
        CheckConstraint("kind IN ('same_as', 'possibly_equivalent_to')", name="ck_kn_redirect_kind"),
        Index("uq_kn_redirect_same_as", "from_id", unique=True,
              postgresql_where=text("kind = 'same_as'"), sqlite_where=text("kind = 'same_as'")),
    )
    from_id = Column(String(26), ForeignKey("kn_node.id"), primary_key=True)
    to_id = Column(String(26), ForeignKey("kn_node.id"), primary_key=True)
    kind = Column(String(24), nullable=False)
    release_id = Column(String(32), ForeignKey("kn_release.id"), nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class KnChange(Base):
    """每个 release 的 delta。整版导入只记一行 import（带各类数量和数据文件的 sha256），之后的增删合并逐条记。"""
    __tablename__ = "kn_change"
    __table_args__ = (
        CheckConstraint("kind IN ('import', 'add', 'deprecate', 'merge', 'split', 'relabel', 'edge')", name="ck_kn_change_kind"),
    )
    id = Column(Integer, primary_key=True)
    release_id = Column(String(32), ForeignKey("kn_release.id"), nullable=False, index=True)
    kind = Column(String(16), nullable=False)
    node_id = Column(String(26), ForeignKey("kn_node.id"), nullable=True)
    detail = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class CourseAnchor(Base):
    """课程落在坐标系的哪里：1 个 primary，至多 3 个 also。属于这门课（课程主人私有），课删了一起删。"""
    __tablename__ = "course_anchor"
    __table_args__ = (
        CheckConstraint("role IN ('primary', 'also')", name="ck_course_anchor_role"),
        CheckConstraint(KN_STATUS, name="ck_course_anchor_status"),
        UniqueConstraint("course_id", "node_id", name="uq_course_anchor"),
        Index("uq_course_anchor_primary", "course_id", unique=True,
              postgresql_where=text("role = 'primary'"), sqlite_where=text("role = 'primary'")),
    )
    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    node_id = Column(String(26), ForeignKey("kn_node.id"), nullable=False, index=True)
    role = Column(String(8), nullable=False)
    status = Column(String(12), nullable=False, default="suggested")
    generated_by = Column(String(64), nullable=False)
    evidence = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class CourseAnchorRun(Base):
    """一门课的坐标作业：落点、相邻方向两步各算一次，结果存下来复用（重跑不稳，不能每次打开都重算）。
    lease_* 防止两个窗口同时跑同一步；失败按次数退避。links 列属于已停用的掌握项链接步骤，不再读写。"""
    __tablename__ = "course_anchor_run"
    __table_args__ = (
        CheckConstraint("anchor IN ('pending', 'article', 'section', 'concept', 'none')", name="ck_course_anchor_run_anchor"),
        CheckConstraint("directions IN ('pending', 'done', 'none')", name="ck_course_anchor_run_directions"),
        CheckConstraint("links IN ('pending', 'done', 'none')", name="ck_course_anchor_run_links"),
    )
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), primary_key=True)
    version = Column(String(32), nullable=False)
    anchor = Column(String(12), nullable=False, default="pending")
    directions = Column(String(12), nullable=False, default="pending")
    links = Column(String(12), nullable=False, default="pending")
    evidence = Column(Text, nullable=False, default="{}")
    lease_ref = Column(String(64), nullable=True)
    lease_until = Column(DateTime, nullable=True)
    attempts = Column(Integer, nullable=False, default=0)
    retry_at = Column(DateTime, nullable=True)
    last_error = Column(String(200), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)


class ItemNodeLink(Base):
    """大纲掌握项链到哪个节点：exact 正好是它，broader 挂到直接上级，none 是模型判断没有。E2 精度不过门，一直没有展示；
    这一步已停用，不再写入，表里只剩之前算出的行。"""
    __tablename__ = "item_node_link"
    __table_args__ = (
        CheckConstraint("match_type IN ('exact', 'broader', 'none')", name="ck_item_node_link_match"),
        CheckConstraint("(match_type = 'none') = (node_id IS NULL)", name="ck_item_node_link_node"),
        CheckConstraint(KN_STATUS, name="ck_item_node_link_status"),
        UniqueConstraint("course_id", "item_key", name="uq_item_node_link"),
    )
    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    item_key = Column(String(64), nullable=False)  # 规范化后的掌握项原文的 sha256
    item_text = Column(Text, nullable=False)
    node_id = Column(String(26), ForeignKey("kn_node.id"), nullable=True)
    match_type = Column(String(8), nullable=False)
    status = Column(String(12), nullable=False, default="suggested")
    generated_by = Column(String(64), nullable=False)
    evidence = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=_utcnow, nullable=False)


class LearnerNodeState(Base):
    """学习者对一个节点了解到哪：encountered 读过覆盖它的课文，explained 答过思考题，applied 用到了新情境。都附证据，不推断掌握。"""
    __tablename__ = "learner_node_state"
    __table_args__ = (CheckConstraint("state IN ('encountered', 'explained', 'applied')", name="ck_learner_node_state"),)
    user_uuid = Column(String(255), primary_key=True)
    node_id = Column(String(26), ForeignKey("kn_node.id"), primary_key=True)
    state = Column(String(12), nullable=False)
    evidence = Column(Text, nullable=False, default="[]")
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
