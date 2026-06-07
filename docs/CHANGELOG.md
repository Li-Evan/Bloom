# Changelog

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

### Changed

- Updated CLI/skill syllabus rules so Markdown workflows use the same default depth behavior as the Web app.
- Updated README feature lists to mention learning-depth selection.
- Dashboard initial loading now also fetches recommendation state.
- Starting a recommendation reuses the existing course creation flow and passes the recommendation rationale as reference material.

### Tests

- Added backend prompt-level tests to verify selected depth reaches the LLM request.
- Added backend unit tests for recommendation refresh and state transitions.

### Impact

- Existing course, lesson, annotation, feedback, stats, and summary APIs remain unchanged.
- Existing SQLite databases get the new `learning_recommendations` table via SQLAlchemy `create_all`.
