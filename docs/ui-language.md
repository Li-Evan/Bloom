# Interface languages

The web app supports **English** and **中文** through next-intl. English has no path prefix; Chinese lives under `/zh/...` (`localePrefix: "as-needed"`). The header has a language switch, and Settings → Display has the same choice.

## How the language is chosen

| Situation | Result |
|---|---|
| New browser with `Accept-Language: zh-CN` opens `/learn` | Goes to `/zh/learn` |
| New browser with `Accept-Language: en-US` opens `/learn` | Stays on `/learn` (English) |
| The user switched languages before | That choice wins (next-intl's `NEXT_LOCALE` cookie) |
| The address already has a prefix (`/zh/...`) | The address wins |

Detection is on unless `NEXT_PUBLIC_LOCALE_DETECTION=false`. `NEXT_PUBLIC_*` values are baked in at build time, so restart the dev server or rebuild after changing them.

## Scope

This is interface localization, not content translation. Course names, uploaded files, generated outlines and lessons, answers, highlights and feedback are never rewritten. The language a model writes in is the **course language**, chosen when the course is created (the new-course form defaults to the current interface language) and fixed afterwards.

Backend errors: the Chinese interface shows the backend's own message; the English interface shows the translation of known messages (`frontend/src/lib/backend-errors.ts`, texts under `errors.*`) and leaves unknown ones as they are, so the reason for a failure is never hidden.

## Adding or changing a message

- Add the same key to `frontend/src/i18n/messages/en.json` and `zh.json`. Learning UI texts go into the `learn` namespace.
- Write whole phrases with named placeholders, never concatenated fragments: `"lessonNumber": "Lesson {number}"`. Use ICU `plural` for counts: `"lessonCount": "{count, plural, one {# lesson} other {# lessons}}"`. Both languages must use the same placeholder names; `tests/messages.test.mjs` checks this.
- Lesson numbers are not zero-padded in text ("第 1 篇 / Lesson 1"); the padded "01" is only for the narrow number column in lists.
- When the backend gains a new fixed error message, add it to `KNOWN_ERROR_KEYS` and translate it under `errors.*`; `tests/backend-errors.test.mjs` fails otherwise.
