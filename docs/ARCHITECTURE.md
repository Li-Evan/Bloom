# Bloom Architecture

Bloom is a self-hosted, single-user adaptive tutor. A Next.js app renders the UI; a FastAPI service owns every piece of data and every model call. There are no accounts and no billing: one local user, your own model API key.

## Runtime layout

```text
frontend/                      Next.js 15 (App Router), React 19, Tailwind CSS 4, next-intl
  src/app/[locale]/(default)/  pages: /learn (courses, syllabus, lessons, map, next), /me (user center)
  src/app/api/backend/         same-origin proxy to the backend (the browser never talks to it directly)
  src/app/api/token/           short-lived backend token for the browser
  src/components/learn|me|site UI; src/lib/ API clients and lesson logic
backend/                       FastAPI, SQLAlchemy 2, Alembic
  app/main.py                  app, routers, housekeeping loop
  app/auth.py                  token verification; the local user is created on first sight
  app/courses.py               course engine: creation, syllabus, lessons, highlight Q&A, feedback, summary, stats
  app/knowledge*.py, coordinate.py   knowledge map and course placement on the knowledge tree
  app/lesson_chat.py, translate.py, highlights.py, notes.py, recommendations.py, teaching*.py
  app/uploads.py, document_import.py, project_archive.py, web_import.py, clippings.py, pdf_reading.py, project_images.py
  alembic/                     migrations (0001 schema, 0002 imports the knowledge tree)
  data/knowledge/              the knowledge tree release (shipped with the code)
  storage/                     runtime data: SQLite database and images (git-ignored)
extension/                     browser web clipper (build it for your Bloom address)
skills/                        Markdown-first CLI tutor for Claude Code (independent of the web app)
```

## Request path and identity

1. Server components call the backend from the Next.js server (`src/lib/backend.ts`). Each render signs one HS256 token with `BACKEND_JWT_SECRET` (`issuer=bloom-frontend`, `scope=user`, 15 minutes) for the fixed local identity in `src/lib/local-user.ts`.
2. Client components call `/api/backend/...` (`src/lib/api-client.ts`). The browser first fetches a token from `/api/token`, refreshes it before expiry and retries once on 401. The proxy (`src/lib/backend-proxy.ts`) validates the path, forwards only `authorization`, `content-type` and `accept`, streams bodies (PDFs, SSE), and never follows upstream redirects.
3. The backend (`app/auth.py`) rejects anything not signed with the same secret. A valid token whose user does not exist yet creates it. All tables still carry `user_uuid`, so every query is scoped by owner.
4. Concurrent GETs from one page are merged into `POST /api/batch`, which runs them in-process and streams one NDJSON line per result.

Bloom has no login, so whoever can open the frontend acts as the local user. Keep it on localhost or behind an authenticating proxy; `docker compose` publishes only the frontend, on 127.0.0.1.

## Model calls

Every chat completion goes through `courses._chat_completion`:

- the model is `LLM_MODEL`, or `LLM_FAST_MODEL` for the knowledge map, course placement and selection translation, or `PDF_READING_MODEL` for PDF page conversion; all use `LLM_BASE_URL` / `LLM_API_KEY`;
- `LLM_EXTRA_BODY` is sent as `extra_body` (for example to switch off hidden reasoning); the reference-answer check may use `LLM_REASONING_EXTRA_BODY` instead;
- the output cap is sent as `max_completion_tokens` for GPT / o-series names and `max_tokens` otherwise (`LLM_MAX_TOKENS_PARAM` overrides);
- empty output raises `EmptyModelOutput`, a stream cut at the length limit raises `TruncatedModelOutput`; long material pipelines retry empty output and transient gateway errors once within their deadline;
- with Langfuse keys set, each user-visible operation is one trace and each call one generation (`app/tracing.py`); without keys tracing is a no-op.

Errors shown to the learner use fixed messages plus a reason: `「fixed message（原因：reason）」` (`app/errors.py` redacts keys, tokens and hosts). The frontend translates known messages through `src/lib/backend-errors.ts`; `tests/backend-errors.test.mjs` checks that every fixed backend message is mapped.

## Course engine

**Creation.** `POST /api/courses/clarify` turns a goal into a few clarifying questions. `POST /api/courses` (topic) and `POST /api/courses/from-materials` (uploaded files: each chunk is summarized, notes are reduced, then synthesized into a knowledge pack with a source index) generate an outline only; the learner reviews it, may edit or regenerate it, and then `POST /api/courses/{id}/first` writes lesson 1. `from-project` and `from-pdf-reading` create "material courses" where every file is a page with no outline. Large files go through chunked uploads (`/api/uploads`, 1 MB parts, SHA-256 checked) and the course routes consume the upload by id.

**Next lesson.** `POST /api/courses/{id}/next` streams SSE. The whole lesson (optional teaching plan, streamed draft, review / brevity rewrite / reference-answer check, save) runs in a worker thread (`_worker_stream`) with its own database session, so a closed tab never loses a lesson; the request side only relays chunks and 10 s heartbeats. One lesson per course is generated at a time (in-process lock, 409 otherwise). When every mastery item is covered the next lesson is an evaluation, and after it a summary closes the course.

**Reading.** These routes live under `/api/courses/{id}/lessons/{n}/`: highlight Q&A (`/annotations`, streamed, saved in the background even after "stop"), passage marks (`/highlights`), selection translation (`/translations`), whole-lesson chat (`/chat`) and lesson feedback (`/feedback`). Feedback scopes that outlive one lesson are kept per course (`/api/courses/{id}/teaching-feedback`). Read / opened events feed stats, the calendar and the knowledge map.

**Material courses** behave like folders: files can be added, moved between material courses, renamed, edited, archived (optionally on read) or deleted. Images inside materials are stored under `IMAGE_STORE_DIR` and served only to the owner via `/api/project-images/{id}`.

## Knowledge map

The shared coordinate system is a frozen snapshot of Wikipedia's Vital Articles level 5 (`data/knowledge/l5-2026.11.json.gz`) plus Bloom-written section names, extra concepts with Wikidata IDs, and display-name revisions; migration `0002` imports it into the `kn_*` tables (opaque node IDs, `contains` / `builds_towards` / `related` edges). `scripts/knowledge/` rebuilds the files from Wikipedia and Wikidata.

- **Placement** (`app/coordinate.py`): per course, step 1 asks the model for search terms, searches the local label index and lets the model pick a primary node and up to three "also" nodes from numbered candidates; step 2 picks neighbouring directions. Results are stored once per course (`course_anchor_run`, with a lease so two windows never run the same step, and back-off after failures).
- **Your topics** (`app/knowledge.py`): after "Update map", every new chunk of a read lesson is one extraction that returns concepts grounded in a quoted passage. Chunks are fingerprinted, so unchanged text is never sent twice.

## Data and housekeeping

- SQLite by default (`backend/storage/bloom.sqlite3`) with WAL, a busy timeout and foreign keys on; Postgres works through `DATABASE_URL`.
- Schema changes go through Alembic (`make migrate`; `render_as_batch=True` so future migrations work on SQLite). CI runs every migration on Postgres and `alembic check`.
- A background task in the API process removes expired uploads and orphaned images every 10 minutes.

## Tests

- `make test-backend`: pytest on an in-memory SQLite database; tests marked `postgres` run when `TEST_DATABASE_URL` points to a throwaway Postgres. The model gateway is pointed at an unreachable address, so no test ever calls a real model.
- `make test-frontend`: Node's test runner over `frontend/tests/*.test.mjs` (pure logic, message files, and source checks).
