"""python -m scripts.knowledge.build_l5_release --cache <目录> --out data/knowledge/l5-2026.11.json.gz [--previous <旧版文件>]

冻结一份 Wikipedia Vital Articles Level 5 快照，做成全局知识坐标系的一个 release（设计见 docs/ARCHITECTURE.md「Knowledge map」）。

1. 下载 L5 全部分页，记下每个分节是分页名还是哪一级标题、在页里的先后。
2. 用英文维基 pageprops 查每个条目的 Wikidata QID（跟随重定向）。
3. 用 Wikidata 取 QID 的中英文标签和别名（CC0），中文按 zh-hans → zh-cn → zh → zh-sg → zh-my → 繁体取；
   没有简体写法时用 OpenCC 转成简体（Wikidata 的 zh 标签约三分之一是繁体）。
4. 给每个分节和条目发不透明 ID（ULID）。给了 --previous 时沿用旧版的 ID：分节按路径、条目按 QID（没有就按标题）对上。

只向维基百科和 Wikidata 发 L5 的公开标题和 QID，不碰任何用户数据。下载结果缓存在 --cache 里，重跑不重复请求。
"""
import argparse
import gzip
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

import opencc

from app.knowledge_graph import new_node_id

WIKI = "https://en.wikipedia.org/w/api.php"
WIKIDATA = "https://www.wikidata.org/w/api.php"
UA = {"User-Agent": "BloomKnowledgeRelease/0.1 (https://github.com/Li-Evan/Bloom)"}
ZH_ORDER = ("zh-hans", "zh-cn", "zh", "zh-sg", "zh-my", "zh-hant", "zh-tw", "zh-hk", "zh-mo")
SIMPLIFIED = {"zh-hans", "zh-cn", "zh-sg", "zh-my"}
MAX_ALIASES = {"en": 2, "zh": 3}  # Wikidata 的别名噪音不小，多了只会让检索候选变杂、表变大
TO_SIMPLIFIED = opencc.OpenCC("t2s")


def simplified(code, text):
    return text if code in SIMPLIFIED else TO_SIMPLIFIED.convert(text)


def get(api, params):
    url = api + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": 2})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as response:
                return json.load(response)
        except Exception:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"request failed: {params}")


def cached(cache, name, fetch):
    path = cache / name
    if path.exists():
        return json.loads(path.read_text())
    value = fetch()
    path.write_text(json.dumps(value, ensure_ascii=False))
    return value


def cache_name(title):
    # 分页名里有只差大小写的（重定向和正文），macOS 的文件系统不分大小写：文件名带上标题的哈希
    return "page-" + re.sub(r"[^A-Za-z0-9]+", "_", title)[-80:] + "-" + hashlib.sha1(title.encode()).hexdigest()[:10] + ".json"


def cached_map(cache, name, keys, fetch_batch, size=50):
    """按 key 增量缓存：已经查过的（包括查不到的，记为 null）不再请求。"""
    path = cache / name
    known = json.loads(path.read_text()) if path.exists() else {}
    missing = [key for key in keys if key not in known]
    for start in range(0, len(missing), size):
        batch = missing[start:start + size]
        found = fetch_batch(batch)
        for key in batch:
            known[key] = found.get(key)
        if start // size % 20 == 0:
            path.write_text(json.dumps(known, ensure_ascii=False))
        time.sleep(0.1)
    path.write_text(json.dumps(known, ensure_ascii=False))
    return known


def clean_heading(text):
    text = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\{\{[^}]*\}\}|'''|''|<[^>]+>", "", text)
    return re.sub(r"\s*\(\s*[\d,]+\s*(articles?)?\s*\)\s*$", "", text).strip()


def parse_pages(cache):
    pages = cached(cache, "pages.json", lambda: [p["title"] for p in get(WIKI, {
        "action": "query", "list": "allpages", "apprefix": "Vital_articles/Level_5/", "apnamespace": 4, "aplimit": 500,
    })["query"]["allpages"]])
    sections, entries, seen = {}, [], set()

    def section(path, level):
        if path not in sections:
            sections[path] = {"path": list(path), "level": level, "sort": len(sections)}
        return path

    for title in sorted(pages):
        wikitext = cached(cache, cache_name(title), lambda: get(WIKI, {
            "action": "parse", "page": title, "prop": "wikitext"})["parse"]["wikitext"])
        if wikitext.lstrip().upper().startswith("#REDIRECT") or not re.search(r"^#+\s*.*?\[\[", wikitext, re.M):
            continue
        parts = title.split("Level 5/", 1)[-1].split("/")
        for depth in range(1, len(parts) + 1):
            section(tuple(parts[:depth]), 1)
        heads = {}
        for line in wikitext.splitlines():
            heading = re.match(r"^(={2,6})\s*(.*?)\s*\1\s*$", line)
            if heading:
                level = len(heading.group(1))
                heads = {k: v for k, v in heads.items() if k < level}
                heads[level] = clean_heading(heading.group(2))
                continue
            item = re.match(r"^#+\s*(.*?)\[\[([^\]|#]+)", line)
            if item and item.group(2).strip().lower() not in seen:
                seen.add(item.group(2).strip().lower())
                path = tuple(parts)
                for level in sorted(heads):
                    path = section(path + (heads[level],), level)
                entries.append({"title": item.group(2).strip(), "section": path, "sort": len(entries)})
    return sections, entries


def resolve_qids(cache, titles):
    def fetch(batch):
        data = get(WIKI, {"action": "query", "titles": "|".join(batch), "prop": "pageprops", "ppprop": "wikibase_item",
                          "redirects": 1})["query"]
        alias = {}
        for step in ("normalized", "redirects"):
            for row in data.get(step, []):
                alias[row["to"]] = alias.get(row["from"], row["from"])
        found = {}
        for page in data.get("pages", []):
            qid = page.get("pageprops", {}).get("wikibase_item")
            if qid:
                found[alias.get(page["title"], page["title"])] = qid
        return found
    return cached_map(cache, "qids-v2.json", titles, fetch)


def wikidata_labels(cache, qids):
    languages = "|".join(("en",) + ZH_ORDER)

    def fetch(batch):
        data = get(WIKIDATA, {"action": "wbgetentities", "ids": "|".join(batch), "props": "labels|aliases", "languages": languages})
        return {qid: {"labels": {k: v["value"] for k, v in entity.get("labels", {}).items()},
                      "aliases": {k: [a["value"] for a in v] for k, v in entity.get("aliases", {}).items()}}
                for qid, entity in data.get("entities", {}).items()}
    return cached_map(cache, "wikidata-v2.json", qids, fetch)


def label_fields(entity):
    labels, aliases = entity.get("labels", {}), entity.get("aliases", {})
    zh = next((simplified(code, labels[code]) for code in ZH_ORDER if labels.get(code)), "")
    zh_alt = []
    for code in ZH_ORDER:
        for value in [labels.get(code, "")] + aliases.get(code, []):
            value = simplified(code, value) if value else value
            if value and value != zh and value not in zh_alt:
                zh_alt.append(value)
    en = labels.get("en", "")
    en_alt = [value for value in aliases.get("en", []) if value != en][:MAX_ALIASES["en"]]
    return {"en": en, "zh": zh, "en_alt": en_alt, "zh_alt": zh_alt[:MAX_ALIASES["zh"]]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--release", default="2026.11")
    parser.add_argument("--snapshot-date", default="2026-11-03")
    parser.add_argument("--previous")
    args = parser.parse_args()
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)

    sections, entries = parse_pages(cache)
    titles = [entry["title"] for entry in entries]
    qids = resolve_qids(cache, titles)
    entities = wikidata_labels(cache, sorted({qid for qid in qids.values() if qid}))

    old_sections, old_articles = {}, {}
    if args.previous:
        previous = json.loads(gzip.open(args.previous).read())
        old_sections = {tuple(s["path"]): s["id"] for s in previous["sections"]}
        old_articles = {a.get("qid") or a["title"]: a["id"] for a in previous["articles"]}

    order = sorted(sections.values(), key=lambda s: s["sort"])
    index = {tuple(s["path"]): i for i, s in enumerate(order)}
    out_sections = [{
        "id": old_sections.get(tuple(s["path"])) or new_node_id(),
        "path": s["path"], "level": s["level"],
        "parent": index.get(tuple(s["path"][:-1])),
    } for s in order]
    out_articles = []
    for entry in entries:
        qid = qids.get(entry["title"])
        out_articles.append({
            "id": old_articles.get(qid or entry["title"]) or new_node_id(),
            "title": entry["title"], "section": index[entry["section"]], "qid": qid,
            **label_fields(entities.get(qid) or {}),
        })
    release = {"release": {"id": args.release, "source": "wikipedia-vital-articles-level-5", "kind": "major",
                           "snapshot_date": args.snapshot_date},
               "sections": out_sections, "articles": out_articles}
    with gzip.open(args.out, "wt", encoding="utf-8") as handle:
        json.dump(release, handle, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({"sections": len(out_sections), "articles": len(out_articles),
                      "with_qid": sum(1 for a in out_articles if a["qid"]),
                      "with_zh": sum(1 for a in out_articles if a["zh"])}))


if __name__ == "__main__":
    main()
