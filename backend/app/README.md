# Backend App Module

## Responsibility

`backend/app/` contains the FastAPI application, database models, Pydantic schemas, and route modules for the Bloom web app.

## Files

- `main.py`: creates the FastAPI app, installs CORS, includes routers, and serves the frontend build when present.
- `database.py`: configures the SQLAlchemy engine/session and SQLite compatibility updates.
- `models.py`: defines persistent tables for courses, lessons, annotations, feedback, events, and recommendations.
- `schemas.py`: defines request and response models shared by route modules.
- `courses.py`: owns the learning flow: course creation, source upload, lesson generation, annotations, feedback, stats, and summaries.
- `recommendations.py`: owns next-topic recommendation generation, refresh, save, remove, and start state transitions.

## Recommendation Inputs and Outputs

Input sources:

- `Course.name`, `Course.status`, and mastery progress from `Syllabus.content`
- Lesson titles extracted from `Lesson.content`
- Prior and saved `LearningRecommendation.title` values used as an avoid list

Output rows:

- `LearningRecommendation.title`: course-ready topic name
- `LearningRecommendation.rationale`: why this topic is useful now
- `LearningRecommendation.bridge`: how it connects to previous learning
- `LearningRecommendation.source_topics`: JSON list of related learned topics
- `LearningRecommendation.status`: `suggested`, `saved`, `started`, or `dismissed`

## Route Boundaries

`recommendations.py` never creates course content directly. The frontend starts a recommendation by calling `POST /api/courses`, then marks the recommendation as started with the created `course_id`.
