import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
globalThis.document = { documentElement: { lang: "en" } };

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
const api = await import("../src/lib/learn/api.ts");
const me = await import("../src/lib/me/api.ts");
const { lessonTitle, sortProjectLessons, continueLesson } = await import("../src/lib/learn/lessons.ts");
const { prepareSyllabus } = await import("../src/lib/learn/syllabus.ts");
const { relativeTime } = await import("../src/lib/learn/time.ts");
const { isPdfReadingName } = await import("../src/lib/learn/files.ts");
const { courseLanguageOf, foreignLanguage } = await import("../src/lib/learn/language.ts");
const { recommendationIntent } = await import("../src/lib/learn/recommendation-intent.ts");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// 「我的课程 / 新建课程 / 课程页 / 大纲页 / 下一步学习」用到的文件
const AREA = [
  "components/learn/dashboard.tsx",
  "components/learn/next.tsx",
  "components/learn/course.tsx",
  "components/learn/syllabus.tsx",
  "components/learn/recommendation-panel.tsx",
  "components/learn/shell.tsx",
  "components/learn/badges.tsx",
  "components/learn/course-card.tsx",
  "components/learn/continue-banner.tsx",
  "components/learn/stat-strip.tsx",
  "components/learn/empty-state.tsx",
  "components/learn/columns.tsx",
  "components/learn/empty-courses.tsx",
  "components/learn/delete-course-dialog.tsx",
  "components/learn/creating-dialog.tsx",
  "components/learn/new-course-dialog.tsx",
];

test("学习区（一）的组件只用语义令牌：没有 stone-/emerald-/rose-/amber-/white/black/十六进制颜色", async () => {
  const COLOR =
    /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow|accent|decoration)-(?:stone|emerald|rose|red|amber|violet|slate|gray|zinc|neutral|green|white|black)\b|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(/;
  for (const file of AREA) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(text, COLOR, `${file} 里有硬编码颜色`);
  }
});

test("没有 window.confirm，没有英文大写的状态字样（IN PROGRESS / SYLLABUS / COMPLETED）", async () => {
  for (const file of AREA) {
    const text = await read(file);
    assert.doesNotMatch(text, /\bconfirm\(/, `${file} 用了原生确认框`);
    assert.doesNotMatch(text, /IN PROGRESS|SYLLABUS|COMPLETED|2-Sigma Learning/, file);
  }
});

test("学习区不再有自带的深色副顶栏：页面不再自己渲染 header / bg-stone-900", async () => {
  for (const file of ["dashboard.tsx", "course.tsx", "syllabus.tsx"]) {
    const text = await read(`components/learn/${file}`);
    assert.doesNotMatch(text, /<header[^>]*bg-/, file);
    assert.doesNotMatch(text, /sticky top-0 z-10/, file);
  }
});

test("导航里的「下一步学习」指向 /learn/next，这个页面存在", async () => {
  const { MAIN_NAV } = await import("../src/lib/nav.ts");
  assert.equal(MAIN_NAV.find((i) => i.key === "next").href, "/learn/next");
  const page = await read("app/[locale]/(default)/learn/next/page.tsx");
  assert.match(page, /<NextPage \/>/);
});

// --- 课程语言 ---

function backend(t) {
  const seen = [];
  let tokens = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/backend/uploads")) return json({id:"upload", chunk_bytes:1048576});
    if (String(url).includes("/api/backend/uploads/")) return json({ok:true});
    if (String(url).endsWith("/api/token")) {
      return json({ token: `t${++tokens}`, expires_at: Date.now() / 1000 + 900 });
    }
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].filter(([k]) => k !== "files" && k !== "file")) : init.body ? JSON.parse(init.body) : null;
    seen.push({ path: new URL(String(url), "http://frontend.test").pathname, body });
    return json({ id: 1 });
  });
  return seen;
}

test("三种建课方式都把课程语言带给后端；不传就不带这个字段（后端默认中文）", async (t) => {
  const seen = backend(t);
  const file = new File(["# hi"], "a.md");

  await api.createCourse("主题", "", "simple", "en");
  await api.createCourseFromMaterials("主题", "", [file], "simple", "en");
  await api.createProjectCourse("项目", [file], "en");
  await api.createCourse("主题");

  assert.deepEqual(
    seen.map((s) => [s.path, s.body.language]),
    [
      ["/api/backend/courses", "en"],
      ["/api/backend/courses/from-materials", "en"],
      ["/api/backend/courses/from-project", "en"],
      ["/api/backend/courses", undefined],
    ]
  );
  assert.equal(seen[0].body.learning_depth, "simple");
});

test("刷新推荐带上界面语言 locale；从推荐开课时课程语言取推荐自己的语言", async (t) => {
  const seen = backend(t);
  await api.refreshRecommendations("en");
  await api.refreshRecommendations("zh");
  assert.deepEqual(seen.map((s) => s.body), [{ locale: "en" }, { locale: "zh" }]);

  const next = await read("components/learn/next.tsx");
  assert.match(next, /refreshRecommendations\(courseLanguageOf\(locale\)\)/);
  const start = next.slice(next.indexOf("const handleStartRecommendation"));
  assert.match(start, /createCourse\(\s*item\.title,\s*"",\s*"standard",\s*item\.language,\s*recommendationIntent\(item\)\s*\)/);
});

test("新建课程表单默认用界面语言作为课程语言，并提供中文 / English 选择", async () => {
  const text = await read("components/learn/new-course-dialog.tsx");
  assert.match(text, /useState<CourseLanguage>\(\s*courseLanguageOf\(locale\)\s*\)/);
  // 选项顺序跟着界面语言（lib/learn/language.ts 的 languagesFor，设置里的界面语言同一个）
  assert.match(text, /languagesFor\(locale\)\.map/);
  for (const call of ["createProjectCourse", "createCourseFromMaterials", "createCourse"]) {
    const at = text.indexOf(`await ${call}(`);
    assert.ok(at > 0, call);
    assert.match(text.slice(at, at + 400), /\blanguage\b/, `${call} 没有带 language`);
  }
  assert.equal(courseLanguageOf("zh"), "zh");
  assert.equal(courseLanguageOf("en"), "en");
});

test("课程语言的徽标只在和界面语言不同时出现", () => {
  assert.equal(foreignLanguage("zh", "zh"), null);
  assert.equal(foreignLanguage("en", "en"), null);
  assert.equal(foreignLanguage(undefined, "en"), null);
  assert.equal(foreignLanguage("en", "zh"), "en");
  assert.equal(foreignLanguage("zh", "en"), "zh");
});

test("推荐开课把理由当学习意图交给建课，不当参考资料（参考资料会让大纲每条都标出处、关掉联网检索）", () => {
  const item = { title: "变分法入门", rationale: "你在划线里卡在变分这一步。", bridge: " 它接在你学过的固有时之上。 ", source_topics: ["广义相对论导论"] };
  assert.deepEqual(recommendationIntent(item), {
    goal: "变分法入门", summary: "你在划线里卡在变分这一步。", assumptions: ["它接在你学过的固有时之上。"], answers: [],
  });
  // 老数据可能没有理由和连接：目标和摘要都退回主题名，后端要求它们非空
  assert.deepEqual(recommendationIntent({ title: "Topic", rationale: "", bridge: "" }), { goal: "Topic", summary: "Topic", assumptions: [], answers: [] });
});

test("从推荐开课的请求：reference 为空，learning_intent 带上推荐理由", async (t) => {
  const seen = backend(t);
  await api.createCourse("变分法入门", "", "standard", "zh", recommendationIntent({ title: "变分法入门", rationale: "理由", bridge: "连接" }));
  assert.deepEqual(seen[0].body, {
    name: "变分法入门", reference: "", learning_depth: "standard", language: "zh",
    learning_intent: { goal: "变分法入门", summary: "理由", assumptions: ["连接"], answers: [] },
  });
});

// --- 行为保持不变：点击才调用模型 ---

test("新建课程、刷新推荐、开始学习不显示费用标签", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.doesNotMatch(dialog, /<Cost \/>/);
  assert.doesNotMatch(dialog, /<FreeTag/);
  assert.doesNotMatch(dialog, /MaterialsCost|estimateTotal/);
  const panel = await read("components/learn/recommendation-panel.tsx");
  assert.doesNotMatch(panel, /<Cost \/>/);
  assert.doesNotMatch(await read("components/learn/next.tsx"), /<Cost \/>/);
});

test("建课等待弹窗不能被关掉，成功后保持打开直到页面跳走（防止重复建课）", async () => {
  const text = await read("components/learn/creating-dialog.tsx");
  assert.match(text, /showClose=\{false\}/);
  assert.match(text, /onEscapeKeyDown=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(text, /onInteractOutside=\{\(e\) => e\.preventDefault\(\)\}/);
  const dialog = await read("components/learn/new-course-dialog.tsx");
  const handler = dialog.slice(dialog.indexOf("const handleCreate"));
  assert.match(handler.slice(0, handler.indexOf("const addReferenceFiles")), /router\.push\(mode === "web" \|\| \(course\.is_project && course\.lesson_count === 1\)\s*\? `\/learn\/course\/\$\{course\.id\}\/lesson\/1`\s*: course\.is_project \? `\/learn\/course\/\$\{course\.id\}` : `\/learn\/course\/\$\{course\.id\}\/syllabus`\);\s*\} catch/);
  assert.match(dialog, /if \(creating \|\| checkingGoal \|\| goalTooLong \|\| referenceTooLong \|\| imported\) return;/);
});

test("建课未确认：新建课程弹窗通知页面刷新列表；从推荐开课则去「我的课程」，那里的「正在生成」卡片接着跟", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /isUnconfirmedCreate\(err\)\) \{\s*onUnconfirmed\(pendingId, report\(err\)\)/);
  const next = await read("components/learn/next.tsx");
  assert.match(next, /isUnconfirmedCreate\(err\)\) \{[\s\S]*?router\.push\("\/learn\?unconfirmed=1"\)/);
  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /searchParams\.get\("unconfirmed"\)/);
  assert.match(dashboard, /unconfirmedFlag\.current = true/);
  assert.match(dashboard, /const followUnconfirmedCreate = useCallback\(\s*\(pendingId\?: string, reason\?: string\) => \{/);
});

// --- 删除课程 ---

test("删除课程走应用内对话框，删除后统计立刻重新取", async () => {
  const text = await read("components/learn/dashboard.tsx");
  assert.match(text, /<DeleteCourseDialog/);
  const handler = text.slice(text.indexOf("const handleDelete"), text.indexOf("const lastLesson"));
  assert.ok(handler.indexOf("await deleteCourse(") < handler.indexOf("reloadStats()"), "删除成功后重取统计");
  assert.match(handler, /setCourses\(\(prev\) => prev\.filter/);
  // 只有删成功才关对话框并说一句「已删除」；失败时对话框留着，原因写在对话框里（不再在 finally 里无条件关掉）
  const success = handler.slice(handler.indexOf("try {"), handler.indexOf("} catch"));
  assert.match(success, /setDeleteTarget\(null\);\s*flashDeleted\(/);
  assert.doesNotMatch(handler.slice(handler.indexOf("} catch")), /setDeleteTarget\(null\)/);
  assert.match(handler, /catch \(err\) \{[\s\S]*?setDeleteError\(report\(err\)\)/);
  const dialog = await read("components/learn/delete-course-dialog.tsx");
  assert.match(dialog, /variant="destructive" onClick=\{onConfirm\} loading=\{deleting\}/);
  assert.match(dialog, /\{error && <ErrorBar message=\{error\}/);
});

// --- 焦点、出错提示的位置、长名字、小细节 ---

test("对话框关闭后焦点送回打开它的控件（Radix Dialog 没有 Trigger）；删除成功后改送到「新建课程」按钮", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /onCloseAutoFocus=\{\(e\) => \{\s*e\.preventDefault\(\);[\s\S]*?restoreFocus\(\)/);
  assert.match(dialog, /document\.activeElement/);
  // 送回打开它的控件；它不在了（或由 ?new= 直接打开、从来没记下），送到页头「新建课程」按钮，不落到 body
  assert.match(dialog, /openerRef\.current\?\.isConnected\s*\?\s*openerRef\.current\s*:\s*fallbackFocus\?\.\(\)/);
  // 建课中表单会卸载再出现：这时焦点由等待弹窗接手，不能抢回去
  assert.match(dialog, /if \(creatingRef\.current\) return;/);
  // 建课结果未确认、表单不再回来时，等待弹窗关闭后焦点同样有去处；失败后表单会重新出现，则送到选中的开始方式上
  assert.match(dialog, /<CreatingDialog[\s\S]*?onCloseAutoFocus=\{\(e\) => \{\s*e\.preventDefault\(\);\s*if \(openRef\.current\) focusSelectedMode\(\);\s*else restoreFocus\(\);/);
  assert.match(await read("components/learn/creating-dialog.tsx"), /onCloseAutoFocus=\{onCloseAutoFocus\}/);

  const del = await read("components/learn/delete-course-dialog.tsx");
  assert.match(del, /onCloseAutoFocus=\{\(e\) => \{\s*e\.preventDefault\(\);/);
  assert.match(del, /captured\.current\?\.isConnected\s*\?\s*captured\.current\s*:\s*fallbackFocus\?\.\(\)/);
  // 课程卡片的「更多」菜单关闭时焦点已经不在它上面了：由卡片把菜单按钮明确告诉对话框，取消后焦点送回它
  assert.match(del, /openerProp \?\?/);
  const card = await read("components/learn/course-card.tsx");
  assert.match(card, /onSelect=\{\(\) => onDelete\(course, more\.current\)\}/);

  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /ref=\{newCourseButton\}/);
  // 删除对话框与新建课程对话框都拿到了兜底落点
  assert.equal(dashboard.match(/fallbackFocus=\{\(\) => newCourseButton\.current\}/g).length, 2);
});

test("新建课程失败的提示条放在固定的页脚里（滚动区外），不会落在看不到的地方", async () => {
  const text = await read("components/learn/new-course-dialog.tsx");
  const scrollArea = text.indexOf("overflow-y-auto px-6");
  const footer = text.indexOf("border-t bg-card px-6 py-4");
  const bar = text.indexOf("<ErrorBar");
  assert.ok(scrollArea > 0 && footer > scrollArea, "页脚在滚动区后面");
  assert.ok(bar > footer, "ErrorBar 在页脚里");
  assert.equal(text.match(/<ErrorBar/g).length, 1);
});

test("课程卡片：长课程名不撑破卡片（min-w-0 + break-words），项目课显示「N 个文件」", async () => {
  const card = await read("components/learn/course-card.tsx");
  assert.match(card, /relative flex min-w-0 flex-col/);
  assert.match(card, /<h2 className="[^"]*break-words/);
  assert.match(card, /course\.is_project\s*\?\s*t\("course\.fileCount"/);
  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /grid grid-cols-1 gap-4 sm:grid-cols-2/);
  const course = await read("components/learn/course.tsx");
  assert.match(course, /line-clamp-2 break-words font-medium/);
});

test("费用小标签不再降透明度（对比度）；删除课程时本地先清掉指向它的「继续学习」；LearnPage 没有用不到的 width", async () => {
  const dashboard = await read("components/learn/dashboard.tsx");
  const handler = dashboard.slice(dashboard.indexOf("const handleDelete"), dashboard.indexOf("const lastLesson"));
  assert.match(handler, /last_lesson\?\.course_id === id \? \{ \.\.\.prev, last_lesson: null \}/);
  assert.ok(handler.indexOf("last_lesson: null") < handler.indexOf("reloadStats()"), "先本地清掉，再重取");
  assert.doesNotMatch(await read("components/learn/shell.tsx"), /narrow|width\?:/);
});

// --- 纯函数 ---

test("课文标题去掉编号前缀（列表里编号单独显示）：只认真的编号写法", () => {
  const stripped = [
    ["02 · 用1000人算给你看", "用1000人算给你看"],
    ["01 · Why compound interest", "Why compound interest"],
    ["10 · Wrap-up", "Wrap-up"],
    ["01. Why compound interest", "Why compound interest"],
    ["1. Why compound interest", "Why compound interest"],
    ["1: Why", "Why"],
    ["3、复利", "复利"],
    ["3) 复利", "复利"],
    ["01 Why compound interest", "Why compound interest"],
    ["01 - Intro", "Intro"],
    ["02 — 复利", "复利"],
    ["Lesson 2: The Snowball Effect", "The Snowball Effect"],
    ["lesson 2 · The Snowball", "The Snowball"],
    ["Chapter 3. Interest", "Interest"],
    ["Part 2 - Foo", "Foo"],
    ["第 3 篇：复利", "复利"],
    ["第3篇 复利", "复利"],
    ["第1课·复利", "复利"],
    ["  02 · 前后有空白  ", "前后有空白"],
    ["04｜过度自信：觉得自己会做", "过度自信：觉得自己会做"],
    ["01 | Intro", "Intro"],
  ];
  for (const [input, expected] of stripped) {
    assert.equal(lessonTitle(input), expected, input);
  }

  // 这些本来就是标题的一部分，一个字都不能动
  for (const title of [
    "1-on-1 tutoring",
    "1-on-1",
    "10 ways to remember",
    "3 things I learned",
    "5G networks",
    "100 days of practice",
    "2024 年的预测",
    "2024: the year of review",
    "1.5 million users",
    "3:2 odds",
    "10:30 standup",
    "Part 2 of the story",
    "Part-time jobs",
    "Lesson plans that work",
    "A/B testing",
    "What is 01?",
  ]) {
    assert.equal(lessonTitle(title), title, title);
  }

  // 只有编号没有标题：不返回空串
  assert.equal(lessonTitle("01"), "01");
  assert.equal(lessonTitle("01 ·"), "01 ·");
  assert.equal(lessonTitle(""), "");
  assert.equal(lessonTitle(null), "");
  assert.equal(lessonTitle(undefined), "");
});

const lesson = (id, over) => ({
  id,
  number: id,
  title: "",
  source_filename: null,
  is_read: false,
  created_at: `2026-10-0${id}T00:00:00Z`,
  ...over,
});

test("项目课按名称 / 时间排序，升降序都对；数字按自然顺序（file2 在 file10 前）", () => {
  const files = [
    lesson(1, { source_filename: "file10.md" }),
    lesson(2, { source_filename: "file2.md" }),
    lesson(3, { source_filename: "a.md" }),
  ];
  assert.deepEqual(sortProjectLessons(files, "name", "asc", "en").map((l) => l.source_filename), ["a.md", "file2.md", "file10.md"]);
  assert.deepEqual(sortProjectLessons(files, "name", "desc", "en").map((l) => l.source_filename), ["file10.md", "file2.md", "a.md"]);
  assert.deepEqual(sortProjectLessons(files, "time", "desc", "en").map((l) => l.id), [3, 2, 1]);
  assert.deepEqual(files.map((l) => l.id), [1, 2, 3], "不改原数组");
});

test("项目课的序号按排好的位置编，课文课用自己的篇号", async () => {
  const text = await read("components/learn/course.tsx");
  assert.match(text, /course\.is_project \? index \+ 1 : lesson\.number/);
});

test("「继续学习」去第一篇没读的，都读过就回最后一篇，没有课文是 undefined", () => {
  assert.equal(continueLesson([lesson(1, { is_read: true }), lesson(2), lesson(3)]).id, 2);
  assert.equal(continueLesson([lesson(1, { is_read: true }), lesson(2, { is_read: true })]).id, 2);
  assert.equal(continueLesson([]), undefined);
});

test("大纲：只有表头的「学习进度」整节拿掉，有数据行的保留；开头的一级标题和 HTML 注释去掉；数出掌握项", () => {
  const empty = [
    "# Bayes · 课程大纲",
    "",
    "> 这份大纲",
    "",
    "## 核心掌握项",
    "### 一",
    "- [x] 解释先验",
    "- [ ] 计算后验",
    "<!-- mastery: x -->",
    "",
    "## 学习进度",
    "",
    "| 文档 | 覆盖掌握项 | 生成日期 |",
    "|------|-----------|---------|",
  ].join("\n");
  const a = prepareSyllabus(empty);
  assert.doesNotMatch(a.content, /学习进度|\| 文档/);
  assert.doesNotMatch(a.content, /^# /m);
  assert.doesNotMatch(a.content, /<!--/);
  assert.match(a.content, /^> 这份大纲/);
  assert.deepEqual([a.mastered, a.total], [1, 2]);

  const filled = empty + "\n| 01.md | 1, 2 | 2026-10-14 |\n\n## 附录\n正文";
  const b = prepareSyllabus(filled);
  assert.match(b.content, /## 学习进度/);
  assert.match(b.content, /01\.md/);
  assert.match(b.content, /## 附录/);

  // 英文标题、表格后面还有别的章节
  const en = "## Core mastery items\n- [ ] a\n\n## Learning progress\n\n| Doc | Items | Date |\n|---|---|---|\n\n## Notes\nx";
  const c = prepareSyllabus(en);
  assert.doesNotMatch(c.content, /Learning progress|\| Doc/);
  assert.match(c.content, /## Notes/);

  assert.deepEqual(prepareSyllabus(null), { content: "", mastered: 0, total: 0 });
  // 代码围栏里的方框不算
  assert.equal(prepareSyllabus("```\n- [x] a\n```\n- [ ] b").total, 1);
});

test("相对时间按界面语言；不到一分钟返回 null 由界面写「刚刚」", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(relativeTime("2026-10-14T11:59:30Z", "en", now), null);
  assert.equal(relativeTime("2026-10-14T12:00:30Z", "en", now), null, "时钟略超前也当刚刚");
  assert.equal(relativeTime("2026-10-14T09:00:00Z", "en", now), "3 hours ago");
  assert.equal(relativeTime("2026-10-14T09:00:00Z", "zh", now), "3小时前");
  assert.equal(relativeTime("2026-10-13T12:00:00Z", "en", now), "yesterday");
  assert.equal(relativeTime("not a date", "en", now), null);
});

test("课程徽标：主题 / 资料 / 项目（上传原文、带资料文件建的课都是「资料」）", async () => {
  const text = await read("components/learn/badges.tsx");
  const body = text.slice(text.indexOf("export function courseKind"), text.indexOf("const KIND_ICON"));
  const kind = new Function(
    "isPdfReadingName",
    `${body.replace("export function", "function").replace(/\(\s*course: [\s\S]*?\)\s*\{/, "(course) {")}; return courseKind;`
  )(isPdfReadingName);
  assert.equal(kind({ is_project: true, mode: "topic" }), "project");
  assert.equal(kind({ is_project: false, mode: "source" }), "source");
  assert.equal(kind({ is_project: false, mode: "topic", source_filename: "notes.pdf" }), "source");
  assert.equal(kind({ is_project: false, mode: "topic", source_filename: null }), "topic");
  assert.equal(kind({ is_project: false, mode: "topic" }), "topic");
  // PDF 阅读版（实验）：项目课，课文文件名是 xxx.pdf.md
  assert.equal(kind({ is_project: true, mode: "source", source_filename: "paper.pdf.md" }), "pdf");
  assert.equal(kind({ is_project: true, mode: "source", source_filename: "notes.md" }), "project");
});

// --- 新页面的文案 ---

test("新页面用到的文案两种语言都有：大纲页、课程页、新建课程、占位、删除确认", async () => {
  const load = async (l) => JSON.parse(await read(`i18n/messages/${l}.json`));
  const [en, zh] = await Promise.all([load("en"), load("zh")]);
  const keys = [
    "dashboard.title", "dashboard.continue.last", "dashboard.deleteDialog.body", "dashboard.empty.title",
    "dashboard.form.language", "dashboard.form.modeTopicDesc", "dashboard.form.chunkNote",
    "recs.saved", "recs.wishlist", "course.start", "course.viewSyllabus", "course.progress.course", "course.progress.detail", "dashboard.card.deleteItem",
    "common.modes.project", "common.backToCourses",
  ];
  const at = (m, path) => path.split(".").reduce((n, k) => n?.[k], m.learn);
  for (const key of keys) {
    assert.equal(typeof at(en, key), "string", `en ${key}`);
    assert.equal(typeof at(zh, key), "string", `zh ${key}`);
    assert.doesNotMatch(at(en, key), /[一-鿿]/, `en ${key} 含中文`);
  }
  // 中文页面上不出现英文的状态字样
  assert.equal(zh.learn.course.status.learning, "学习中");
  assert.equal(zh.learn.syllabus.title, "课程大纲");
});

// --- 归档文件 ---

test("归档 / 取消归档发 PUT …/lessons/N/archived，body 只有 archived", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/token")) return json({ token: "t", expires_at: Date.now() / 1000 + 900 });
    seen.push([init.method, new URL(String(url), "http://frontend.test").pathname, JSON.parse(init.body)]);
    return json({ number: 3, is_archived: true, status: "learning", mastery_covered: 1, mastery_total: 2, mastery_progress: 0.5 });
  });
  assert.equal((await api.setLessonArchived(7, 3, true)).mastery_total, 2);
  await api.setLessonArchived(7, 3, false);
  assert.deepEqual(seen, [
    ["PUT", "/api/backend/courses/7/lessons/3/archived", { archived: true }],
    ["PUT", "/api/backend/courses/7/lessons/3/archived", { archived: false }],
  ]);
});

test("归档的文件不在课程页列表、篇数和「继续学习」里，收进最下面的「已归档」；课文页右栏和「下一个」也跳过它们", async () => {
  const course = await read("components/learn/course.tsx");
  assert.match(course, /const listed = normalLessons\.filter\(\(l\) => !l\.is_archived\);/);
  assert.match(course, /sortProjectLessons\(listed, sortBy, sortDir, locale\)/);
  assert.match(course, /t\("course\.fileCount", \{ count: listed\.length \}\)/);
  assert.match(course, /aria-expanded=\{archivedOpen\}/);
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /const railLessons = allLessons\.filter\(\(l\) => !l\.is_archived \|\| l\.number === currentNum\);/);
  assert.match(lesson, /nextAction\(\s*currentNum,\s*railLessons,/);
  assert.match(lesson, /allLessons: railLessons\.map/);
});

test("设置里的「读完立刻归档」发 PUT /api/me/archive-on-read，body 只有 enabled", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/token")) return json({ token: "t", expires_at: Date.now() / 1000 + 900 });
    seen.push([init.method, new URL(String(url), "http://frontend.test").pathname, JSON.parse(init.body)]);
    return json({ enabled: JSON.parse(init.body).enabled });
  });
  assert.equal((await me.saveArchiveOnRead(true)).enabled, true);
  await me.saveArchiveOnRead(false);
  assert.deepEqual(seen, [
    ["PUT", "/api/backend/me/archive-on-read", { enabled: true }],
    ["PUT", "/api/backend/me/archive-on-read", { enabled: false }],
  ]);
});

test("标记已读时后端按设置归档了：课文页把这一篇标成已归档，下一步那里说一句并给撤销；读之前开着设置也先说会归档", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /setAutoArchived\(Boolean\(result\.archived\)\)/);
  assert.match(lesson, /\.\.\.\(result\.archived && \{ is_archived: true \}\)/);
  assert.match(lesson, /autoArchived && currentFile\.is_archived \?/);
  assert.match(lesson, /onClick=\{\(\) => void fileArchived\(currentFile\)\}/);
  assert.match(lesson, /!readSaved && user\?\.archive_on_read && !currentFile\.is_archived/);
  assert.match(lesson, /hint=\{markReadHint\}/);
  const settings = await read("app/[locale]/(default)/me/settings/page.tsx");
  assert.match(settings, /<LearningPanel \/>/);
});
