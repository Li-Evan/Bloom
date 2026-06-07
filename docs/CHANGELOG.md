# Changelog

## 2026-06-08

### Added

- Added the recommendation module for the web dashboard.
- Added `LearningRecommendation` persistence with `suggested`, `saved`, `started`, and `dismissed` states.
- Added recommendation APIs:
  - `GET /api/recommendations`
  - `POST /api/recommendations/refresh`
  - `POST /api/recommendations/{id}/save`
  - `DELETE /api/recommendations/{id}/save`
  - `POST /api/recommendations/{id}/start`
- Added a dashboard recommendation panel with three generated next-topic cards, a saved learning queue, refresh, save, remove, and start-learning actions.
- Added backend unit tests for recommendation refresh and state transitions.

### Changed

- Dashboard initial loading now also fetches recommendation state.
- Starting a recommendation reuses the existing course creation flow and passes the recommendation rationale as reference material.

### Impact

- Existing course, lesson, annotation, feedback, stats, and summary APIs remain unchanged.
- Existing SQLite databases get the new `learning_recommendations` table via SQLAlchemy `create_all`.
