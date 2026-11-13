# Changelog

## 0.3.0 — 2026-11-12

The web app was rebuilt. It is still self-hosted and single-user, with no accounts and no billing.

### Changed

- Frontend moved from React + Vite to Next.js 15 (App Router) with a new interface, Chinese / English UI (next-intl), light and dark themes, and a same-origin proxy to the backend.
- Backend database moved to Alembic migrations. SQLite stays the default (now in `backend/storage/`); Postgres is supported.
- The backend now requires `BACKEND_JWT_SECRET`, shared with the frontend server; `make setup` generates it.
- Breaking: the old `bloom.db` is not migrated. The new version starts with an empty database.

### Added

- Course creation from a goal with clarifying questions, from uploaded materials (PDF, Word, PowerPoint, Excel, EPUB, Markdown, ZIP) with a cited knowledge pack, from project files or folders, from web articles, and "PDF reading" (vision-model page conversion).
- Outline review before lesson 1 (edit or regenerate), adaptive lessons with teaching plans and feedback scopes, evaluation lesson and course summary.
- Highlight Q&A threads, passage marks, selection translation with in-context meaning and word roots, whole-lesson chat.
- Teaching styles, lesson table of contents, reading time, text size and font settings.
- Knowledge map on a shared knowledge tree (Wikipedia Vital Articles level 5 snapshot) with course placement and neighbouring directions.
- Next-step recommendations with a wishlist; user center with activity heatmap, notes and Markdown export.
- Material courses as folders: move, rename, edit, archive, delete files.
- Browser web clipper extension.
- Optional Langfuse tracing of model calls.

## 2026-06-08

### Added

- Added `simple`, `standard`, and `deep` learning-depth selection for course creation.
- Injected the selected depth into syllabus generation prompts for both topic courses and source-based courses.
- Added a three-option depth selector to the dashboard create-course form.
- Added the recommendation module for the web dashboard.
- Added `LearningRecommendation` persistence with `suggested`, `saved`, `started`, and `dismissed` states.
- Added recommendation APIs:
  - `GET /api/recommendations`
  - `POST /api/recommendations/refresh`
  - `POST /api/recommendations/{id}/save`
  - `DELETE /api/recommendations/{id}/save`
  - `POST /api/recommendations/{id}/start`
- Added a dashboard recommendation panel with three generated next-topic cards, a saved learning queue, refresh, save, remove, and start-learning actions.
- Documented the depth and recommendation design in `docs/ARCHITECTURE.md`.
- Added the personal center page (`/profile`) with overview stat cards, a month learning calendar, and a six-month contribution heatmap.
- Added `GET /api/calendar`, aggregating learning activity into per-day course / lesson / highlight summaries; clicking a calendar day shows what was studied.
- Added a personal-center entry in the dashboard header and documented the calendar design in `docs/ARCHITECTURE.md`.

### Changed

- Updated CLI/skill syllabus rules so Markdown workflows use the same default depth behavior as the Web app.
- Updated README feature lists to mention learning-depth selection.
- Dashboard initial loading now also fetches recommendation state.
- Starting a recommendation reuses the existing course creation flow and passes the recommendation rationale as reference material.
- Unified the streak and calendar day grouping to the server local date (`_event_local_date`), fixing early-morning activity being counted under the previous UTC day.
- Calendar highlight counts are derived from `Annotation` rows rather than answer events, so follow-up turns are no longer double-counted.

### Tests

- Added backend prompt-level tests to verify selected depth reaches the LLM request.
- Added backend unit tests for recommendation refresh and state transitions.
- Added backend unit tests for the learning calendar endpoint (empty database and aggregated single-day activity).

### Impact

- Existing course, lesson, annotation, feedback, stats, and summary APIs remain unchanged.
- Existing SQLite databases get the new `learning_recommendations` table via SQLAlchemy `create_all`.
