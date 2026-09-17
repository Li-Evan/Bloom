# Interface languages

The self-hosted web app supports **中文** and **English**. Use the **Interface language / 界面语言** selector at the top of any page, including loading and error screens. Switching languages does not reload the page or discard a feedback/question draft.

## Initial language and persistence

The app first uses an explicit choice stored under `bloom.ui.locale` in local storage. Without a saved choice, it uses the first supported language in the browser's ordered preferences: Chinese regional tags map to `zh-CN`, and English regional tags map to `en`. Other browser languages fall back to English. Environments with no browser language information retain Chinese.

An explicit selection is saved for subsequent visits and synchronized to other open tabs. If browser privacy settings block local storage, switching still works for the current page; persistence across reloads is unavailable. Clearing the saved preference restores browser-language detection.

## Scope

The selector changes interface labels, actions, placeholders, confirmation dialogs, known error messages, document title/language, date formatting, file-name sorting, calendar weekdays and count/plural labels. It covers the dashboard, course, syllabus, lesson, profile, recommendations and PDF viewer controls.

This is **UI localization**, not content translation. It does not rewrite course names, uploaded files, generated syllabi/lessons/summaries, recommendations, questions, answers, annotations or feedback. It does not select the LLM's output language or change backend prompts. Unknown server/provider diagnostics are preserved rather than replaced with a generic error that would hide debugging information.

## Adding or changing a UI message

`frontend/src/i18n/en.js` maps Chinese source messages to English. Chinese remains the fallback. Use `const { t } = useI18n()` in the component and resolve labels during rendering, including labels stored in arrays. Do not translate at module initialization, and do not run translation over generated Markdown or user content.

Use whole phrases with named placeholders instead of concatenating translated fragments:

```jsx
{t('第 {number} 篇', { number: '08' })}
{t('{count} 篇课文', { count: lessons.length })}
```

English count messages use `{ one, other }` entries selected by `Intl.PluralRules`. Numeric placeholder values are formatted with `Intl.NumberFormat`; strings such as zero-padded lesson numbers are preserved. Keep placeholder names identical across translations. Messages are rendered as text, not HTML.

Use `formatError(error)` when displaying a raw error stored in state so switching language also updates an already-visible known error. Add exact known API errors to the catalog; keep unknown diagnostics intact.

## Validation

Run the dependency-free tests with Node.js 22 or newer:

```sh
cd frontend
npm test
```

The localization tests cover preference precedence, regional tags, storage failures, persistence, cross-tab updates, subscriber cleanup, pluralization, interpolation, error handling, dictionary/placeholder coverage and source guards against untranslated UI text and translation of Markdown content. The existing stream tests remain unchanged.

After installing the project's dependencies, also run `npm run build` and `npm run lint`. These tests do not replace a browser smoke test. Check both languages at desktop and mobile widths, creating topic/source/project courses, opening a lesson and syllabus, sending/following up/stopping highlight questions, saving feedback, recommendations and the learning calendar. Switch with a draft or active generation, reload, open another tab, and confirm that content, drafts and request state remain intact. Verify PDF highlight tooltips change language without fetching the PDF again.
