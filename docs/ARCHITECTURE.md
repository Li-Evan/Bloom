# Bloom Architecture

## System Shape

Bloom has two learning surfaces:

- `backend/`: FastAPI service that stores courses, syllabi, lessons, annotations, feedback, and learning events in SQLite through SQLAlchemy.
- `frontend/`: React/Vite app that creates courses, renders syllabi and lessons, collects feedback, and streams generated lessons through SSE.
- `skills/bloom-tutor/` plus `AGENTS.md` / `Claude.md`: Markdown-first CLI learning workflow used by coding agents.

## Course Creation Flow

Topic course creation starts in `frontend/src/pages/DashboardPage.jsx`.

1. The user enters a topic, optional reference material, and a learning depth.
2. `frontend/src/lib/api.js#createCourse` sends `name`, `reference`, and `learning_depth` to `POST /api/courses`.
3. `backend/app/schemas.py#CreateCourseRequest` validates `learning_depth` as one of `simple`, `standard`, or `deep`.
4. `backend/app/courses.py#create_course` injects the selected depth into `SYLLABUS_PROMPT`.
5. The LLM returns markdown syllabus content, which is stored in `syllabi.content`.
6. The first lesson prompt receives the generated syllabus, so lesson depth follows the syllabus rather than a separate database field.

Source course creation follows the same depth path through `createSourceCourse` and `POST /api/courses/from-source`, but the first lesson remains the uploaded source-reading chapter.

## Learning Depth

Depth is a generation parameter, not persistent course metadata.

- `simple`: 2-3 modules, 8-10 mastery items, focused on the core trunk and high-frequency use cases.
- `standard`: 3-4 modules, 10-12 mastery items, balanced coverage of concepts, reasoning, applications, and misconceptions.
- `deep`: 4-5 modules, 12-15 mastery items, including first principles, mechanisms, boundaries, counterexamples, and transfer judgment.

The selected depth is written into the generated `syllabus.md` / syllabus markdown as visible text. From that point onward, the syllabus remains the single source of truth for course progression.

## Data Model

`backend/app/models.py` defines:

- `Course`: course identity, mode, status, optional source file metadata.
- `Syllabus`: one syllabus per course, stored as markdown.
- `Lesson`: numbered markdown lessons; `number=0` stores the final summary.
- `Annotation`: highlighted Q&A sessions.
- `Feedback`: user feedback and thought-question answers per lesson.
- `LearningEvent`: activity log used for course and global stats.

No migration is needed for learning depth because depth does not require a new column.

## Verification

Backend tests live in `backend/tests/` and run with:

```bash
cd backend && uv run pytest tests/
```

Frontend build verification runs with:

```bash
cd frontend && npm run build
```
