# Knowledge tree release

These files are the shared coordinate system behind the knowledge map. Migration `0002_knowledge_release` imports them into the `kn_*` tables; nothing here is read at request time.

| File | What it holds | Source |
|---|---|---|
| `l5-2026.11.json.gz` | Sections and articles of Wikipedia's [Vital Articles, level 5](https://en.wikipedia.org/wiki/Wikipedia:Vital_articles/Level/5), snapshot of 2026-11-03, each with an opaque Bloom ID, its Wikidata QID and Chinese / English labels | Wikipedia (structure and titles), Wikidata (labels and aliases) |
| `section-names-2026.11.json` | Short display names for the sections, written for Bloom | Bloom |
| `supplement-2026.11.json` | Extra concepts that have a Wikidata QID but are not in level 5, hung under a level-5 article or section, plus extra Chinese aliases | Wikidata labels, Bloom aliases |
| `relabel-2026.11.1.json` | Display-name revision: English uses the Wikipedia titles and headings; missing Chinese names are filled with translations | Wikipedia titles, Bloom translations |

`scripts/knowledge/build_l5_release.py` and `build_supplement.py` rebuild the first and third file from Wikipedia and Wikidata. They only send public titles and QIDs, never user data.

## Licences

- Wikipedia content is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); the section structure and article titles here come from the Wikipedia pages linked above.
- Wikidata data is [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
