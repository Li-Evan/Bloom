# Changelog

## 2026-06-08

### Added

- Added `simple`, `standard`, and `deep` learning-depth selection for course creation.
- Injected the selected depth into syllabus generation prompts for both topic courses and source-based courses.
- Added a three-option depth selector to the dashboard create-course form.
- Documented the depth design in `docs/ARCHITECTURE.md`.

### Changed

- Updated CLI/skill syllabus rules so Markdown workflows use the same default depth behavior as the Web app.
- Updated README feature lists to mention learning-depth selection.

### Tests

- Added backend prompt-level tests to verify selected depth reaches the LLM request.
