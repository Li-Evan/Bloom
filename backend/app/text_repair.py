"""Make extracted document text safe to store and send as UTF-8.

PDF extractors sometimes emit UTF-16 surrogate code points. A valid pair is a
mathematical alphanumeric character (U+1D400 and friends). A lone surrogate is
not Unicode: ``json`` / HTTP / Postgres then raise UnicodeEncodeError and the
upload fails. Rejoin pairs and replace leftovers with U+FFFD.
"""


def repair_unicode(text: str) -> str:
    if not text:
        return text
    try:
        text.encode("utf-8")
        return text
    except UnicodeEncodeError:
        return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
