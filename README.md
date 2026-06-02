<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo.svg">
    <img alt="Bloom" src="assets/logo.svg" width="360">
  </picture>
</p>

<p align="center">
  <strong>Your Personal AI Tutor — Powered by the 2-Sigma Method</strong>
</p>

<p align="center">
  <em>From average to top 2%. One lesson at a time.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/python-3.11+-blue.svg" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/node-18+-blue.svg" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/react-19-blue.svg" alt="React 19">
  <img src="https://img.shields.io/badge/fastapi-0.115+-blue.svg" alt="FastAPI">
</p>

<p align="center">
  <a href="./README.zh.md">Chinese</a> · English
</p>

---

In 1984, educational psychologist Benjamin Bloom discovered that students receiving **one-on-one tutoring** scored **2 standard deviations (+2σ)** above the classroom average — jumping to the **top 2%**. Bloom called this the "2 Sigma Problem": the effect is proven, but personal tutors don't scale.

**Bloom solves this with AI.** It generates a structured syllabus, delivers lessons one at a time, reads your annotations and feedback, then tailors the next lesson to your exact understanding level — just like a real tutor would.

## Two Ways to Use

| Mode | Setup | Best for |
|------|-------|----------|
| **CLI** | Claude Code + terminal | Power users who like Markdown editors |
| **Web** | Browser (React + FastAPI) | Visual learners, shareable setup |

Both follow the same flow: **syllabus → lesson → annotate → feedback → next lesson → evaluation → summary**.

---

## Quick Start: CLI Mode

Requires only [Claude Code](https://claude.com/claude-code). No backend.

```bash
git clone https://github.com/Li-Evan/Bloom.git
cd Bloom
claude
```

Then say: `Create a new folder and help me learn [any topic]`

See [GUIDE.md](./GUIDE.md) for the full walkthrough.

## Quick Start: Web Mode

### Prerequisites

- Python 3.11+ with [uv](https://docs.astral.sh/uv/)
- Node.js 18+
- An OpenAI-compatible LLM API key (e.g. [DashScope](https://dashscope.console.aliyun.com/), OpenAI, etc.)

### Setup

```bash
git clone https://github.com/Li-Evan/Bloom.git
cd Bloom

# Configure
cp .env.example .env
# Edit .env — fill in LLM_API_KEY

# Backend
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000

# Frontend (new terminal)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. Click **New Course**, enter a topic (optionally paste reference material), and start learning.

### Docker

```bash
cp .env.example .env   # fill in API key
docker compose up -d   # visit http://localhost:3000
```

---

## How It Works

```
Create course → AI generates syllabus + lesson 01
                        ↓
        Read lesson → highlight text → add ??? annotations
                        ↓
        Write feedback → answer thought questions
                        ↓
        Click "Done Reading" → AI generates next lesson
        (includes: review of your answers + ??? responses + new content)
                        ↓
        Repeat until all mastery items checked ✅
                        ↓
        Auto-generate evaluation → then summary
```

## Features

- **Reference material** — paste textbook chapters, papers, or notes when creating a course; AI uses them to shape the curriculum
- **Inline annotations** — select any text and add `???` confusion markers
- **Adaptive lessons** — each lesson addresses your specific gaps from the previous one
- **Chapter sidebar** — quick-jump between lessons while reading
- **Collapsible syllabus** — track mastery progress without clutter
- **Streaming generation** — watch AI write the next lesson in real-time

## Skills

Bloom ships a set of portable **[Claude Code](https://claude.com/claude-code) skills** in [`skills/`](./skills/) — self-contained capability packs you can copy into `~/.claude/skills/` (global) or any project's `.claude/skills/` and use anywhere.

| Skill | What it does |
|-------|-------------|
| **bloom-tutor** | The full interactive tutoring system as one skill — syllabus → adaptive lessons → `???` annotations → evaluation → summary. CLI mode, packaged and portable. |
| **learn-deep** | Default deep-dive entry — runs all five lenses below in one pass, then helps you pick a direction |
| **learn-crossover** | Learn a new concept by leveraging what you already know (structural analogies) |
| **learn-occam** | Decide whether / how deeply something is worth learning (ROI, just-enough) |
| **learn-graph** | Build a knowledge-graph map of a field plus a learning path |
| **learn-prototype** | Learn by building the crappiest working prototype, then iterating |
| **learn-feynman** | Verify true understanding by explaining it back |

Each folder is dependency-free: copy it into a skills directory, then just talk to Claude Code (e.g. *"help me learn X"*, *"I'm done reading"*).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python, FastAPI, SQLAlchemy, SQLite |
| Frontend | React, Vite, Tailwind CSS |
| AI | Any OpenAI-compatible LLM API |
| Container | Docker, docker-compose |
| Font | Outfit, JetBrains Mono |

## Commands

```bash
make dev-backend      # backend with hot reload
make dev-frontend     # frontend dev server
make test             # run pytest
make up / make down   # docker start / stop
```

## Project Structure

```
├── Claude.md              # AI tutor instructions (CLI mode)
├── GUIDE.md               # CLI usage guide
├── .env.example           # env template
├── backend/
│   └── app/
│       ├── courses.py     # all API routes + AI prompt logic
│       ├── models.py      # Course, Lesson, Annotation, Feedback
│       └── config.py      # reads .env
├── frontend/
│   └── src/pages/
│       ├── DashboardPage  # course list + create form
│       ├── CoursePage     # syllabus + lesson list
│       └── LessonPage     # reader + annotations + feedback + AI gen
├── example/               # pre-built topics for CLI mode
└── skills/                # portable Claude Code skills (bloom-tutor + learn-*)
```

## The Science

| Concept | What it means |
|---------|--------------|
| **Bloom's 2 Sigma** | 1-on-1 tutoring = +2σ performance over classroom |
| **Mastery Learning** | Don't move on until the concept is truly understood |
| **Socratic Method** | Ask questions, don't hand answers |
| **Spaced Retrieval** | Thought question reviews at lesson start reinforce memory |
| **Adaptive Path** | Content adjusts to individual feedback in real-time |

## License

[MIT](LICENSE)
