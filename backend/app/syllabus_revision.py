"""Bounded source excerpts for editing an existing outline, with source locations."""
import math
import re

MAX_REFERENCE_CHARS = 32_000
CHUNK_CHARS = 2_000


def _terms(text: str) -> set[str]:
    words = set(re.findall(r"[a-z][a-z0-9_-]{2,}", text.lower()))
    for phrase in re.findall(r"[\u4e00-\u9fff]+", text):
        words.update(phrase[i:i + 2] for i in range(len(phrase) - 1))
    return words


def revision_reference(source: str, filename: str, outline: str, changes: str) -> str:
    """Keep short sources intact; retrieve from ALL pages of long ones.

    The current outline remains a separate, complete input. These are explicitly
    excerpts, never a replacement presented as the entire uploaded document.
    """
    if len(source) <= MAX_REFERENCE_CHARS:
        return source
    chunks = []
    page = None
    for section in re.split(r"(<!--\s*page:\s*\d+\s*-->)", source):
        marker = re.fullmatch(r"<!--\s*page:\s*(\d+)\s*-->", section)
        if marker:
            page = int(marker[1])
            continue
        if not section.strip():
            continue
        # Overlap protects definitions and sentences crossing a chunk boundary.
        for start in range(0, len(section), CHUNK_CHARS - 200):
            body = section[start:start + CHUNK_CHARS].strip()
            if body:
                chunks.append((page, start, body))
    if not chunks:
        return ""
    wanted, background = _terms(changes), _terms(outline)
    terms = wanted | background
    lower = [body.lower() for _, _, body in chunks]
    frequency = {term: sum(term in body for body in lower) for term in terms}
    weights = {term: math.log(1 + len(chunks) / (1 + count)) * (4 if term in wanted else 1)
               for term, count in frequency.items()}
    scores = [sum(weight for term, weight in weights.items() if term in body) for body in lower]
    # The opening supplies title/abstract context; the rest is ranked over the full source.
    ranked = list(dict.fromkeys([0, *sorted(range(len(chunks)), key=lambda i: (-scores[i], i))]))
    selected = {}
    size = 0
    for index in ranked:
        page, start, body = chunks[index]
        location = f"page {page}; " if page is not None else ""
        excerpt = f"[Source: {filename}; {location}characters {start + 1}-{start + len(body)}]\n{body}"
        if size + len(excerpt) + 2 > MAX_REFERENCE_CHARS:
            continue
        selected[index] = excerpt
        size += len(excerpt) + 2
    return "\n\n".join(selected[index] for index in sorted(selected))
