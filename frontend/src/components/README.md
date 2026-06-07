# Frontend Components

## Responsibility

`frontend/src/components/` contains reusable React components used by page-level routes.

## Components

- `Markdown.jsx`: renders lesson and syllabus Markdown with math/GFM support.
- `RecommendationPanel.jsx`: renders the dashboard recommendation module.

## RecommendationPanel Contract

Inputs:

- `recommendations`: current 3 suggested topics from `GET /api/recommendations`
- `savedRecommendations`: saved learning queue rows
- `refreshing`: whether recommendation refresh is running
- `startingId`: recommendation id currently being converted into a course
- `onRefresh`, `onSave`, `onRemove`, `onStart`: action handlers owned by `DashboardPage.jsx`

The component is presentational. It does not call the API directly and does not own course creation logic.
