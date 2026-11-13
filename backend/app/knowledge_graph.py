"""全局知识坐标系的结构层：节点 ID、release 导入、本地标签检索、沿 primary 边的读路径。

骨架是冻结的 Wikipedia Vital Articles Level 5（data/knowledge/l5-<release>.json.gz，scripts/knowledge/build_l5_release.py 生成），
初始展示名：分节用 Bloom 自写的名字（section-names-<release>.json），条目取 Wikidata 的 CC0 标签；minor release
（relabel-<release>.json）把英文换成维基原名，中文缺的用翻译补上。检索只查本地标签表，不向任何外部接口发用户的文字。
"""
import gzip
import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy import and_, select

from app.models import KnEdge, KnLabel, KnNode, KnRelease

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "knowledge"
L5_SOURCE = "import:vital-l5"
CURATED_SOURCE = "curated:claude"
NAMED_LEVELS = (1, 2, 3)  # 分页名、== 和 === 标题：Bloom 给这几层写了展示名
LIVE_STATUSES = ("suggested", "confirmed")
BATCH = 2000


def new_node_id() -> str:
    """不透明的节点 ID（ULID：毫秒时间 + 80 位随机数，26 个字符）。不含名称、语言或路径，合并后也不复用。"""
    value = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")
    return "".join(CROCKFORD[(value >> (5 * i)) & 31] for i in reversed(range(26)))


# ---------- release 导入 ----------

def release_files(release_id: str) -> tuple[Path, Path, Path]:
    return (DATA_DIR / f"l5-{release_id}.json.gz", DATA_DIR / f"section-names-{release_id}.json",
            DATA_DIR / f"supplement-{release_id}.json")


def load_release(release_id: str) -> tuple[dict, dict, dict, dict]:
    paths = release_files(release_id)
    raw = [path.read_bytes() for path in paths]
    digests = {path.name: hashlib.sha256(data).hexdigest() for path, data in zip(paths, raw)}
    return json.loads(gzip.decompress(raw[0])), json.loads(raw[1]), json.loads(raw[2]), digests


def display_en(title: str, label: str) -> str:
    """英文展示名：Wikidata 标签和维基标题只差大小写时用标题的写法（negotiation → Negotiation），否则用标签，全小写的首字母大写。"""
    if not label or label.lower() == title.lower():
        return title
    return label[0].upper() + label[1:] if label == label.lower() and label[0].isalpha() else label


def release_rows(release: dict, names: dict, supplement: dict, digests: dict, now: datetime) -> dict[str, list[dict]]:
    info = release["release"]
    rid = info["id"]
    l5_by = f"{L5_SOURCE}@{rid}"
    curated_by = f"{CURATED_SOURCE}@{rid}"
    rows = {"kn_node": [], "kn_label": [], "kn_edge": [], "kn_match": []}
    seen_labels = set()

    def node(node_id, kind):
        rows["kn_node"].append({"id": node_id, "kind": kind, "visibility": "public", "owner_uuid": None, "status": "active",
                                "release_id": rid, "created_at": now})

    def label(node_id, lang, kind, text, source):
        text = (text or "").strip()[:300]
        if text and (node_id, lang, kind, text) not in seen_labels:
            seen_labels.add((node_id, lang, kind, text))
            rows["kn_label"].append({"node_id": node_id, "lang": lang, "kind": kind, "text": text, "source": source})

    def contains(parent, child, sort_key, status, by):
        rows["kn_edge"].append({"type": "contains", "source_id": parent, "target_id": child, "is_primary": True,
                                "sort_key": sort_key, "status": status, "reason": None, "generated_by": by, "evidence": None,
                                "visibility": "public", "owner_uuid": None, "valid_from": rid, "valid_to": None,
                                "created_at": now, "updated_at": now})

    def match(node_id, scheme, external_id, status, by):
        rows["kn_match"].append({"node_id": node_id, "scheme": scheme, "external_id": external_id, "match_type": "exactMatch",
                                 "status": status, "generated_by": by, "created_at": now})

    sections = release["sections"]
    section_ids = {" › ".join(s["path"]): s["id"] for s in sections}
    for index, section in enumerate(sections):
        node(section["id"], "section")
        label(section["id"], "en", "hidden", section["path"][-1], "l5")
        name = names.get(" › ".join(section["path"]))
        if name:
            label(section["id"], "zh", "pref", name["zh"], "bloom")
            label(section["id"], "en", "pref", name["en"], "bloom")
        if section["parent"] is not None:
            contains(sections[section["parent"]]["id"], section["id"], index, "confirmed", l5_by)
    article_ids = {}
    for index, article in enumerate(release["articles"]):
        node_id = article["id"]
        article_ids[article["title"]] = node_id
        node(node_id, "article")
        pref = display_en(article["title"], article.get("en", ""))
        label(node_id, "en", "pref", pref, "wikidata" if article.get("en") else "enwiki")
        if pref != article["title"]:
            label(node_id, "en", "hidden", article["title"], "enwiki")
        label(node_id, "zh", "pref", article.get("zh"), "wikidata")
        for alt in article.get("en_alt", []):
            label(node_id, "en", "alt", alt, "wikidata")
        for alt in article.get("zh_alt", []):
            label(node_id, "zh", "alt", alt, "wikidata")
        contains(sections[article["section"]]["id"], node_id, index, "confirmed", l5_by)
        # 维基标题不另记 enwiki 映射：和展示名不同时已经存成 hidden 标签，下一版沿用 ID 靠的是数据文件
        if article.get("qid"):
            match(node_id, "wikidata", article["qid"], "confirmed", l5_by)

    def resolve(ref):
        return article_ids[ref["article"]] if "article" in ref else section_ids[ref["section"]]

    for index, concept in enumerate(supplement.get("concepts", [])):
        node(concept["id"], "concept")
        label(concept["id"], "en", "pref", concept["en"], concept.get("en_source", "wikidata"))
        label(concept["id"], "zh", "pref", concept["zh"], concept.get("zh_source", "wikidata"))
        for alt in concept.get("en_alt", []):
            label(concept["id"], "en", "alt", alt, "wikidata")
        for alt in concept.get("zh_alt_wikidata", []):
            label(concept["id"], "zh", "alt", alt, "wikidata")
        for alt in concept.get("zh_alt", []):
            label(concept["id"], "zh", "alt", alt, "bloom")
        # 挂父节点是结构判断：Claude 整理的一律 suggested，等编辑确认；节点本身就是这个 QID 的条目，exactMatch 是定义
        contains(resolve(concept["parent"]), concept["id"], index, "suggested", curated_by)
        match(concept["id"], "wikidata", concept["qid"], "confirmed", curated_by)
    for alias in supplement.get("aliases", []):
        for text in alias.get("zh", []):
            label(resolve(alias), "zh", "alt", text, "bloom")
    summary = {key: len(value) for key, value in rows.items()} | {"files": digests}
    rows["kn_release"] = [{"id": rid, "kind": info["kind"], "source": info["source"], "snapshot_date": info["snapshot_date"],
                           "summary": json.dumps(summary, ensure_ascii=False), "created_at": now}]
    rows["kn_change"] = [{"release_id": rid, "kind": "import", "node_id": None,
                          "detail": json.dumps(summary, ensure_ascii=False), "created_at": now}]
    return rows


IMPORT_ORDER = ("kn_release", "kn_node", "kn_label", "kn_edge", "kn_match", "kn_change")


def import_release(connection, release_id: str) -> dict:
    """把一个 release 的数据文件整版写进去（迁移里调用一次）。"""
    return write_rows(connection, release_rows(*load_release(release_id), now=datetime.now(timezone.utc).replace(tzinfo=None)))


def write_rows(connection, rows: dict[str, list[dict]]) -> dict:
    """表用轻量定义，只写这里给出的列：以后给表加列不影响旧迁移里的这次导入。"""
    for name in IMPORT_ORDER:
        if not rows.get(name):
            continue
        table = sa.table(name, *(sa.column(key) for key in rows[name][0]))
        for start in range(0, len(rows[name]), BATCH):
            connection.execute(table.insert(), rows[name][start:start + BATCH])
    return {name: len(rows.get(name, [])) for name in IMPORT_ORDER}


def relabel_rows(base: dict, names: dict, relabel: dict, labels: list[tuple], now: datetime) -> dict:
    """minor release：只改展示名，不动节点和边。界面直接用维基的原名：英文显示 L5 的分节标题和维基条目标题；
    中文沿用已有的名字，缺的用翻译（relabel 文件）补上。被换下来的英文展示名留作 alt，照样参与检索。
    labels 是库里现有的 (id, node_id, lang, kind, text, source)。返回要改的 pref（按 id）、要加的标签和 release / change 行。"""
    pref = {(node_id, lang): (label_id, text, source) for label_id, node_id, lang, kind, text, source in labels if kind == "pref"}
    alt = {(node_id, lang, text) for _, node_id, lang, kind, text, _ in labels if kind == "alt"}
    updates, inserts = [], []

    def want(node_id, lang, text, source):
        text = (text or "").strip()[:300]
        if not text:
            return
        old = pref.get((node_id, lang))
        if old is None:
            inserts.append({"node_id": node_id, "lang": lang, "kind": "pref", "text": text, "source": source})
        elif old[1] != text or old[2] != source:
            updates.append({"label_id": old[0], "new_text": text, "new_source": source})
            if old[1] != text and (node_id, lang, old[1]) not in alt:
                inserts.append({"node_id": node_id, "lang": lang, "kind": "alt", "text": old[1], "source": old[2]})

    for section in base["sections"]:
        path = " › ".join(section["path"])
        want(section["id"], "en", section["path"][-1], "l5")
        if path in names:
            want(section["id"], "zh", names[path]["zh"], "bloom")
        else:
            want(section["id"], "zh", relabel["section_zh"].get(path), "translated")
    for article in base["articles"]:
        want(article["id"], "en", article["title"], "enwiki")
        if not article.get("zh"):
            want(article["id"], "zh", relabel["article_zh"].get(article["title"]), "translated")
    info = relabel["release"]
    summary = {"updated": len(updates), "inserted": len(inserts), "based_on": info["based_on"]}
    return {"updates": updates, "kn_label": inserts,
            "kn_release": [{"id": info["id"], "kind": "minor", "source": info["source"], "snapshot_date": info["snapshot_date"],
                            "summary": json.dumps(summary), "created_at": now}],
            "kn_change": [{"release_id": info["id"], "kind": "relabel", "node_id": None, "detail": json.dumps(summary), "created_at": now}]}


def relabel_release(connection, release_id: str) -> dict:
    """把 relabel-<release>.json 写进库（迁移里调用一次）。"""
    raw = (DATA_DIR / f"relabel-{release_id}.json").read_bytes()
    relabel = json.loads(raw)
    base, names, _, _ = load_release(relabel["release"]["based_on"])
    return apply_relabel(connection, base, names, relabel, hashlib.sha256(raw).hexdigest())


def apply_relabel(connection, base: dict, names: dict, relabel: dict, digest: str = "") -> dict:
    label = sa.table("kn_label", sa.column("id"), sa.column("node_id"), sa.column("lang"), sa.column("kind"), sa.column("text"),
                     sa.column("source"))
    current = connection.execute(select(label.c.id, label.c.node_id, label.c.lang, label.c.kind, label.c.text, label.c.source)).all()
    rows = relabel_rows(base, names, relabel, current, datetime.now(timezone.utc).replace(tzinfo=None))
    for row in rows["kn_release"] + rows["kn_change"]:
        key = "summary" if "summary" in row else "detail"
        row[key] = json.dumps(json.loads(row[key]) | {"file": digest})
    for start in range(0, len(rows["updates"]), BATCH):
        connection.execute(label.update().where(label.c.id == sa.bindparam("label_id")).values(
            text=sa.bindparam("new_text"), source=sa.bindparam("new_source")), rows["updates"][start:start + BATCH])
    write_rows(connection, {"kn_release": rows["kn_release"], "kn_label": rows["kn_label"], "kn_change": rows["kn_change"]})
    return {"updated": len(rows["updates"]), "inserted": len(rows["kn_label"])}


# ---------- 读路径：沿 primary contains 边 ----------

def live_primary():
    return and_(KnEdge.type == "contains", KnEdge.is_primary.is_(True), KnEdge.valid_to.is_(None),
                KnEdge.status.in_(LIVE_STATUSES))


def ancestors(db, node_ids) -> dict[str, str]:
    """这些节点和它们全部祖先的 child → parent（只走 primary 边）。递归 CTE，Postgres 和 SQLite 都能跑。"""
    node_ids = list(dict.fromkeys(node_ids))
    if not node_ids:
        return {}
    chain = select(KnEdge.target_id, KnEdge.source_id).where(live_primary(), KnEdge.target_id.in_(node_ids)).cte(
        "chain", recursive=True)
    step = select(KnEdge.target_id, KnEdge.source_id).where(live_primary()).join(chain, KnEdge.target_id == chain.c.source_id)
    chain = chain.union(step)
    return dict(db.execute(select(chain.c.target_id, chain.c.source_id)).all())


def path_to_root(node_id, parents: dict[str, str]) -> list[str]:
    """从根到这个节点（含）的 ID 列表。"""
    path = [node_id]
    while path[-1] in parents and len(path) < 20:
        path.append(parents[path[-1]])
    return path[::-1]


def display_labels(db, node_ids, lang: str) -> dict[str, str]:
    """展示名：先取界面语言的 pref，没有就取另一种语言的。没有 pref 的节点（Bloom 还没写名字的深层分节）不出现在结果里。"""
    node_ids = list(dict.fromkeys(node_ids))
    if not node_ids:
        return {}
    found = {}
    for node_id, label_lang, text in db.query(KnLabel.node_id, KnLabel.lang, KnLabel.text).filter(
            KnLabel.node_id.in_(node_ids), KnLabel.kind == "pref"):
        if label_lang == lang or node_id not in found:
            found[node_id] = text
    return found


_roots_cache: dict[tuple, list[str]] = {}


def roots(db) -> list[str]:
    """公共骨架的顶层分节（L5 的 11 个顶层），按英文名排，固定顺序：新学习只点亮、不重排。"""
    key = tuple(db.scalars(select(KnRelease.id).order_by(KnRelease.id)))
    if key not in _roots_cache:
        has_parent = select(KnEdge.target_id).where(live_primary())
        ids = list(db.scalars(select(KnNode.id).where(
            KnNode.kind == "section", KnNode.visibility == "public", KnNode.status == "active", KnNode.id.notin_(has_parent))))
        names = display_labels(db, ids, "en")
        _roots_cache.clear()
        _roots_cache[key] = sorted(ids, key=lambda node_id: names.get(node_id, node_id))
    return _roots_cache[key]


def children(db, parent_id: str) -> list[tuple[str, str]]:
    """一个节点的直接下级（ID, kind），按快照里的顺序。只列公共节点。"""
    return db.query(KnEdge.target_id, KnNode.kind).join(KnNode, KnNode.id == KnEdge.target_id).filter(
        live_primary(), KnEdge.source_id == parent_id, KnNode.visibility == "public", KnNode.status == "active",
    ).order_by(KnEdge.sort_key).all()


# ---------- 本地标签检索 ----------

STOP = {"of", "the", "and", "a", "an", "in", "for", "to", "on", "with", "by", "as", "at", "or"}
CJK = re.compile(r"[㐀-鿿豈-﫿]")


def latin_tokens(text):
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOP]


def stem(token):
    return re.sub(r"(ies|es|s|ing|ed)$", "", token) if len(token) > 4 else token


def stems(text):
    return {stem(t) for t in latin_tokens(text)}


def strip_note(text):
    return re.sub(r"\s*[（(].*?[）)]\s*$", "", text).strip()


def score_en(term, text):
    """同 E1 的 search.py：完全相同 10 分；词全覆盖 6–8 分；部分重合按两边的覆盖比例给分。"""
    term_l, text_l = term.lower().strip(), strip_note(text.lower())
    if term_l == text_l:
        return 10
    tt, xt = stems(term), stems(text_l)
    if not tt or not xt:
        return 0
    hit = len(tt & xt)
    if hit == len(tt):
        return 6 + 2 * hit / len(xt)
    return 4 * hit / len(tt) * hit / len(xt)


def zh_norm(text):
    return re.sub(r"[\s·・,，、:：\-]+", "", unicodedata.normalize("NFKC", strip_note(text))).lower()


def grams(text):
    return set(text) if len(text) < 2 else {text[i:i + 2] for i in range(len(text) - 1)}


def score_zh(term, text):
    """中文按字的二元组算，规则和 score_en 一样。"""
    a, b = zh_norm(term), zh_norm(text)
    if not a or not b:
        return 0
    if a == b:
        return 10
    tt, xt = grams(a), grams(b)
    hit = len(tt & xt)
    if hit == len(tt):
        return 6 + 2 * hit / len(xt)
    return 4 * hit / len(tt) * hit / len(xt)


class LabelIndex:
    """公共节点的全部标签建成的倒排索引。条目（article、concept）按标签打分，再加上所在分节路径的分；分节按自己的标题和整条路径打分。
    打分规则同 E1 的 search.py（课程自动挑落点复核后可接受 93%），另外加了中文检索词对中文标签。"""

    def __init__(self, nodes: dict[str, str], parents: dict[str, tuple[str, int]], labels: list[tuple[str, str, str, str]]):
        self.kind = nodes
        self.parent = {child: parent for child, (parent, _) in parents.items()}
        self.sort = {child: sort for child, (_, sort) in parents.items()}
        self.children = defaultdict(list)
        for child, parent in self.parent.items():
            self.children[parent].append(child)
        # listing 是给模型看的英文名：分节用 L5 的原标题，条目用维基标题（展示名和标题只差大小写时没有 hidden 标签）
        self.listing, self.en_name, self.zh_name, self.labels = {}, {}, {}, []
        self.en_postings, self.zh_postings = defaultdict(list), defaultdict(list)  # list 比 set 省一半多内存
        for node_id, lang, kind, text in labels:
            if node_id not in nodes:
                continue
            if lang == "en" and kind == "hidden":
                self.listing[node_id] = text
            elif lang == "en" and kind == "pref":
                self.listing.setdefault(node_id, text)
                self.en_name[node_id] = text
            elif lang == "zh" and kind == "pref":
                self.zh_name[node_id] = text
            index = len(self.labels)
            self.labels.append((node_id, lang, text))
            if lang == "en":
                for token in stems(text):
                    self.en_postings[token].append(index)
            else:
                for gram in grams(zh_norm(text)):
                    self.zh_postings[gram].append(index)
        self.sections = []
        for node_id, kind in nodes.items():
            if kind == "section":
                ancestry = [self.listing.get(a, "") for a in self.path(node_id)]
                heading = self.listing.get(node_id, "")
                self.sections.append((node_id, heading, " › ".join(ancestry + [heading]), " ".join(ancestry[-1:] + [heading])))

    def path(self, node_id) -> list[str]:
        """从根到这个节点（不含）的祖先 ID。"""
        found = []
        while node_id in self.parent and len(found) < 20:
            node_id = self.parent[node_id]
            found.append(node_id)
        return found[::-1]

    def path_text(self, node_id) -> str:
        return " › ".join(self.listing.get(a, "") for a in self.path(node_id))

    def _label_scores(self, terms, postings, score, keys):
        best = defaultdict(float)
        for term in terms:
            hits = set()
            for key in keys(term):
                hits.update(postings.get(key, ()))
            for index in hits:
                node_id, _, text = self.labels[index]
                best[node_id] = max(best[node_id], score(term, text))
        return best

    def search(self, en_terms, zh_terms=(), k_entries=15, k_sections=8):
        """返回 (条目 ID 列表, 分节 ID 列表)，按分数从高到低。"""
        en_terms = [t for t in en_terms if t and t.strip()]
        zh_terms = [t for t in zh_terms if t and CJK.search(t)]
        title = self._label_scores(en_terms, self.en_postings, score_en, stems)
        for node_id, value in self._label_scores(zh_terms, self.zh_postings, score_zh, lambda t: grams(zh_norm(t))).items():
            title[node_id] = max(title[node_id], value)
        section_scores, near = [], {}
        for section, heading, full, near_text in self.sections:
            names = [heading] + ([self.en_name[section]] if section in self.en_name else [])
            own = max([score_en(t, name) for t in en_terms for name in names]
                      + [score_zh(t, self.zh_name[section]) for t in zh_terms if section in self.zh_name] + [0])
            total = own + 0.2 * max([score_en(t, full) for t in en_terms] + [0])
            if total > 0.5:
                section_scores.append((total, section))
            # E1：条目再加上「上一级 + 所在分节」两个名字合起来的分（×0.3）
            value = max([score_en(t, near_text) for t in en_terms] + [0])
            if value:
                near[section] = value
        pool = {n for n in title if self.kind.get(n) in ("article", "concept")}
        for section, value in near.items():
            if value * 0.3 > 0.5:
                pool.update(c for c in self.children[section] if self.kind.get(c) in ("article", "concept"))
        found = []
        for node_id in pool:
            total = title.get(node_id, 0) + 0.3 * near.get(self.parent.get(node_id), 0)
            if total > 0.5:
                found.append((total, node_id))
        found.sort(key=lambda pair: (-pair[0], self.sort.get(pair[1], 0)))
        section_scores.sort(key=lambda pair: (-pair[0], self.sort.get(pair[1], 0)))
        return [n for _, n in found[:k_entries]], [n for _, n in section_scores[:k_sections]]


_index_lock = threading.Lock()
_index: dict[tuple, LabelIndex] = {}


def label_index(db) -> LabelIndex:
    """每个进程按 release 建一次（约 20 万个标签，几秒）。只在后台作业里用，读路径不碰它。"""
    key = tuple(db.scalars(select(KnRelease.id).order_by(KnRelease.id)))
    with _index_lock:
        if key in _index:
            return _index[key]
        public = and_(KnNode.visibility == "public", KnNode.status == "active")
        nodes = dict(db.execute(select(KnNode.id, KnNode.kind).where(public)).all())
        parents = {child: (parent, sort) for child, parent, sort in db.execute(
            select(KnEdge.target_id, KnEdge.source_id, KnEdge.sort_key).where(live_primary(), KnEdge.visibility == "public"))}
        labels = db.execute(select(KnLabel.node_id, KnLabel.lang, KnLabel.kind, KnLabel.text).order_by(KnLabel.id).execution_options(
            yield_per=5000))  # 边读边建，不把 20 多万行一次读进内存
        _index.clear()
        _index[key] = LabelIndex(nodes, parents, labels)
        return _index[key]
