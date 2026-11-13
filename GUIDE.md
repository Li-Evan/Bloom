# Installation & Usage Guide

<p align="right"><a href="./GUIDE.zh.md">简体中文</a></p>

This guide helps you set up Bloom One-vs-One Study from scratch and start your first 1-on-1 AI tutoring session.

---

## Prerequisites

You need:

1. **Claude Code** (Anthropic's official CLI tool)
2. **A terminal** (macOS Terminal / iTerm2 / Windows Terminal / whatever you prefer)
3. **A text editor** (VS Code, Cursor, etc., for reading and annotating documents)

### Installing Claude Code

If you haven't installed Claude Code yet:

```bash
npm install -g @anthropic-ai/claude-code
```

After installation, run `claude` to confirm it launches properly. First run requires logging in to your Anthropic account.

> If you're unsure what Claude Code is: it's a CLI tool that lets you chat with Claude in your terminal, and Claude can directly read and write your local files. This is the foundation of how this system works.

---

## Setup

### Step 1: Clone the Repository

```bash
git clone https://github.com/Li-Evan/Bloom-one-vs-one-study.git
cd Bloom-one-vs-one-study
```

### Step 2: Install the Tutor Skill

Install the bundled tutor skill into this clone's local Claude Code skills directory:

```bash
mkdir -p .claude/skills
cp -R skills/bloom-tutor .claude/skills/
```

This keeps the public tutoring protocol in `skills/bloom-tutor/` instead of relying on local agent instruction files.

### Step 3: Launch Claude Code

Start Claude Code in the repository directory:

```bash
claude
```

Ask Claude to use the `bloom-tutor` skill when starting or continuing a course.

### Step 4: Start Your First Topic

In the Claude Code conversation, type:

```
Create a new folder and help me learn [your topic]
```

For example:

```
Create a new folder and help me learn Python decorators
```

```
Create a new folder and help me learn game theory basics
```

```
Create a new folder and help me learn personal income tax
```

Claude will immediately generate:
- `syllabus.md` — course syllabus (defines all abilities you'll master)
- `01.md` — your first lesson document

**Setup complete.** Here's how to use it.

---

## Usage Flow

### 1. Read the Document

Open the generated `.md` file in your text editor. Each document contains:

- **Prerequisites / Difficulty / Estimated reading time**
- **Main content** (knowledge with bold annotations and examples)
- **Thought questions** (2–3 questions, no answers given, designed to deepen your thinking)
- **Feedback section** (where you write your feedback)

### 2. Annotate Your Confusions

While reading, write the following **anywhere you feel confused**:

```
???[Why use recursion here instead of a loop?]
```

Or use full-width question marks:

```
???[What's the intuitive meaning of this formula?]
```

You can place annotations anywhere in the text, as many as you want. These annotations are the most authentic snapshot of your thinking, and the tutor prioritizes them.

### 3. Answer Thought Questions & Write Feedback

At the bottom of the document in the "Your Feedback" section, write:

- Your answers to the thought questions (try to reason through them yourself — wrong answers are fine)
- Your insights, confusions, or topics you'd like the next lesson to dive deeper into
- Anything else you want to say

### 4. Tell the Tutor You've Finished Reading

Go back to the Claude Code terminal and say:

```
I've finished reading
```

The tutor will:
1. Read all your annotations and feedback
2. Possibly ask you 1–2 key questions (max 2 rounds, no endless grilling)
3. Generate the next document

The next document's opening will include:
- **Thought question review** (kept short: if you answered, one or two sentences per answer; if you did not, a single sentence, and the reference answers sit at the end of that lesson)
- **Annotation responses** (only if you annotated; two or three sentences each, and a one-sentence callback for anything already answered in the highlight Q&A)
- **New content** (tailored to your understanding level, starting right after the review)

### 5. Repeat Until Course Completion

When all mastery items in the syllabus are covered, the system automatically generates an **evaluation article** (no new content — final understanding confirmation). After reading the evaluation, the system auto-generates `summary.md` (a complete course summary).

---

## Recording Summary Material

During your learning, if you encounter a particularly important insight you want in the final summary, annotate it:

```
#summary:[The essence of option pricing is replication — constructing a portfolio of known-price assets that reproduces the same cash flows]
```

The `#`-less format also works:

```
summary:[This analogy is brilliant — Nash equilibrium in game theory is like a traffic jam — no one can benefit by unilaterally changing routes]
```

These materials are automatically collected and integrated into `summary.md`.

---

## Advanced Usage

### Nested Directories

Topics can be organized by category:

```
Create a new folder under CFA, help me learn fixed income
```

This creates a `CFA/fixed-income/` directory.

### Parallel Topics

You can study multiple topics simultaneously. When entering Claude Code, tell the tutor which topic you'd like to continue:

```
I want to continue studying Python decorators, I've finished reading 02.md
```

### Slash Commands

| Command | Action |
|---------|--------|
| `/organize-learning` | Scan all topics, log new documents to the learning journal |
| `/view-learning-log` | View historical learning records (newest first) |

---

## FAQ

### Q: Does it cost money?

The system itself is completely free and open-source. You need Claude Code access (requires an Anthropic account).

### Q: What topics are supported?

Anything you want to learn — programming, finance, philosophy, psychology, math, history... no limits.

### Q: Can I generate multiple documents at once?

No. This is a core design principle. The essence of 1-on-1 tutoring is that **every step adjusts based on your feedback**. Batch generation would break this feedback loop.

### Q: Where is my learning data stored?

Entirely on your local filesystem, in the cloned repository directory. No data is uploaded to the cloud. You can use Git to version-control your learning history.

### Q: Can I use other AI?

The bundled `skills/bloom-tutor` package is designed for Claude Code Skills. Other AI agents can work if you import the same instructions into their equivalent skill/instruction system, but results may vary.

### Q: What if I want to change direction mid-course?

Anytime. Write your desired direction change in the feedback section, and the tutor will adapt in the next lesson. Mastery items in the syllabus are the goals; the path is entirely flexible.

---

## Design Philosophy

This system is built on a simple belief:

> **The best learning isn't being lectured — it's being guided to discover.**

Traditional online courses are one-directional — pre-recorded videos won't pause to explain your confusions. ChatGPT-style Q&A is fragmented — you get answers, but no system.

This system aims to balance both: **systematic adaptive learning**. The syllabus ensures you stay on track, and the feedback loop ensures content always matches your level.

Bloom proved that 1-on-1 tutoring achieves +2σ. We believe a well-designed AI agent can approach this effect.
