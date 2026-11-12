import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "next-intl";

// 学习区、课文页、用户中心的回归保护。
// 课文页的深链接、面包屑条、问答卡片、标题断行等分别在 lesson-page / lesson-markdown 测试里。

process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
globalThis.document = { documentElement: { lang: "zh" } };

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);
const t = (locale, namespace, key, values) =>
  createTranslator({ locale, messages: locale === "zh" ? zh : en, namespace })(key, values);

const { studiedCourses, listCourses } = await import("../src/lib/learn/recommendation-source.ts");
const { previewText } = await import("../src/lib/me/annotations.ts");
const { buildNotesMarkdown } = await import("../src/lib/me/export.ts");
const { dayPart } = await import("../src/lib/me/activity.ts");
const { courseProgress } = await import("../src/lib/learn/progress.ts");
const annotations = await import("../src/lib/me/annotations.ts");
const exporter = await import("../src/lib/me/export.ts");

// ── 课程进度 ──

test("进度统一叫「课程进度 / Course progress」，旁边写「已讲到 X / Y 个要点」；所有出现处都改了，没有「掌握进度 / Mastery」", async () => {
  assert.equal(zh.learn.course.progress.course, "课程进度");
  assert.equal(en.learn.course.progress.course, "Course progress");
  assert.equal(t("zh", "learn.course.progress", "detail", { covered: 5, total: 12 }), "已读内容覆盖 5 / 12 个要点");
  assert.equal(t("en", "learn.course.progress", "detail", { covered: 5, total: 12 }), "Read lessons cover 5 of 12 key points");
  assert.equal(zh.me.overview.mastery, "课程进度");
  assert.equal(en.me.overview.mastery, "Course progress");
  assert.equal(t("zh", "me.overview", "mastery_detail", { covered: 1, total: 2 }), "已读内容覆盖 1 / 2 个要点");

  // 课程页右栏、大纲页、课程卡（悬停说明）、用户中心概览的「继续学习」卡都走同一个口径（lib/learn/progress.ts：后端的 mastery_covered / mastery_total）
  for (const file of [
    "components/learn/course.tsx",
    "components/learn/syllabus.tsx",
    "components/learn/course-card.tsx",
    "components/me/continue-card.tsx",
  ]) {
    assert.match(await read(file), /courseProgress\(course\)/, file);
  }
  for (const file of ["components/learn/course.tsx", "components/learn/syllabus.tsx"]) {
    assert.match(await read(file), /course\.progress\.detail/, file);
  }
  assert.match(await read("lib/learn/progress.ts"), /mastery_covered/);
  const types = await read("lib/learn/types.ts");
  assert.match(types, /mastery_covered\?: number;/);
  assert.match(types, /mastery_total\?: number;/);

  assert.doesNotMatch(JSON.stringify(zh), /掌握进度|已掌握 \{/);
  assert.doesNotMatch(JSON.stringify(en.learn) + JSON.stringify(en.me), /Mastery|mastered/);
});

test("「继续学习」：课程已完结（last_lesson.course_completed）时去课程页，不然去那一篇（学习区横幅与用户中心概览都是）", async () => {
  for (const file of ["components/learn/continue-banner.tsx", "components/me/continue-card.tsx"]) {
    const text = await read(file);
    assert.match(text, /course_completed/, file);
    assert.match(text, /`\/learn\/course\/\$\{(?:lesson|last)\.course_id\}`/, file);
  }
  assert.match(await read("lib/learn/types.ts"), /course_completed\?: boolean;/);
});

// ── 上传原文课 ──

test("原文是独立辅助材料，不占课程目录编号", async () => {
  const course = await read("components/learn/course.tsx");
  assert.match(course, /<SourceMaterial courseId=\{courseId\}/);
  assert.match(course, /course.is_project \|\| !l.is_source/);
  const source = await read("components/learn/source-material.tsx");
  assert.match(source, /<PdfViewer/);
  assert.match(source, /<Markdown restoreBold>/);
  assert.match(source, /whitespace-pre-wrap/);
});

// ── 建课等待 ──

test("建课等待弹窗按建课方式（主题 / 主题加资料 / 项目）给步骤和预计时间，没有「串行」这种开发词，小字 13px", async () => {
  const dialog = await read("components/learn/creating-dialog.tsx");
  for (const kind of ["topic", "materials", "project", "pdf"]) {
    assert.match(dialog, new RegExp(`${kind}: \\{ steps:`), kind);
  }
  assert.match(dialog, /text-\[13px\] text-subtle-foreground/);
  const form = await read("components/learn/new-course-dialog.tsx");
  assert.match(form, /kind=\{mode === "pdf" \? "pdf" : withMaterials \? "materials" : mode === "project" \|\| mode === "web" \? "project" : "topic"\}/);

  for (const [lang, messages] of [["zh", zh], ["en", en]]) {
    const creating = messages.learn.dashboard.creating;
    for (const [kind, steps, hint] of [
      ["topic", ["analyze", "syllabus", "finish"], "hintTopic"],
      ["materials", ["parse", "merge", "syllabus"], "hintMaterials"],
      ["project", ["read", "finish"], "hintProject"],
      ["pdf", ["render", "convert", "finish"], "hintPdf"],
    ]) {
      assert.deepEqual(Object.keys(creating[kind]), steps, `${lang} ${kind}`);
      assert.equal(typeof creating[hint], "string", `${lang} ${hint}`);
    }
  }
  assert.doesNotMatch(JSON.stringify(zh.learn.dashboard.creating), /串行|AI 串行/);
  assert.doesNotMatch(JSON.stringify(en.learn.dashboard.creating), /serial|sequential/i);
  // 各方式的时间说法不同：主题约 20–60 秒，资料按分钟，项目显示解压与图片保存
  assert.match(zh.learn.dashboard.creating.hintTopic, /确认后再生成第一篇/);
  assert.match(zh.learn.dashboard.creating.hintMaterials, /分钟/);
  assert.match(zh.learn.dashboard.creating.hintProject, /解压.*图片/);
});

// ── 新建课程表单 ──

test("学习深度每档一句大白话（几个要点、适合谁），并写明之后能按反馈调整", async () => {
  for (const messages of [zh, en]) {
    const { simple, standard, deep } = messages.learn.depth;
    assert.match(simple.hint, /8–10/);
    assert.match(standard.hint, /10–12/);
    assert.match(deep.hint, /12–15/);
  }
  assert.doesNotMatch(JSON.stringify(zh.learn.depth), /主干路径|完整掌握|原理展开/);
  assert.match(zh.learn.dashboard.form.depthNote, /反馈调整/);
  assert.match(en.learn.dashboard.form.depthNote, /feedback/);
  assert.match(await read("components/learn/new-course-dialog.tsx"), /t\("dashboard\.form\.depthNote"\)/);
});

test("主题模式下输入框叫「想学什么 / What do you want to learn?」，示例是主题式的；别的模式仍叫「课程名称」", async () => {
  assert.equal(zh.learn.dashboard.form.nameTopic, "想学什么");
  assert.equal(en.learn.dashboard.form.nameTopic, "What do you want to learn?");
  assert.doesNotMatch(zh.learn.dashboard.form.namePlaceholderTopic, /博弈论基础/);
  assert.match(await read("components/learn/new-course-dialog.tsx"), /mode === "topic" \? t\("dashboard\.form\.nameTopic"\) : t\("dashboard\.form\.name"\)/);
});

test("新建课程表单里语言选择是与上方对齐的分段控件（整行宽，两段）；三个文件拖放区键盘聚焦时有可见轮廓；资料说明按「文件」说", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /grid grid-cols-2 gap-1 rounded-lg border bg-muted p-1/);
  assert.doesNotMatch(dialog, /sm:max-w-xs/);
  // 资料说明讲它会提炼重点和来源，不讲「分块」这种开发词
  assert.match(zh.learn.dashboard.form.chunkNote, /重点和来源/);
  assert.doesNotMatch(zh.learn.dashboard.form.chunkNote + en.learn.dashboard.form.chunkNote, /分块|chunk of about/);
});

// ── 下一步学习 ──

test("推荐卡片写「因为你学过《课程名》」——只列得出对应课程名的主题；对不上的（大纲里的掌握项原文）不显示", async () => {
  const courses = ["复利与指数基金入门", "Linear Algebra Basics", "Python"];
  assert.deepEqual(studiedCourses(["复利与指数基金入门"], courses), ["复利与指数基金入门"]);
  // 模型写的是课程名的一部分或带了书名号
  assert.deepEqual(studiedCourses(["《复利与指数基金入门》"], courses), ["复利与指数基金入门"]);
  assert.deepEqual(studiedCourses(["linear algebra basics"], courses), ["Linear Algebra Basics"]);
  // 掌握项原文对不上任何课程：不显示
  assert.deepEqual(studiedCourses(["Compute a posterior probability from given prior, likelihood, and false-positive rate"], courses), []);
  assert.deepEqual(studiedCourses(["能够用自然频数重述并求解同一贝叶斯问题"], courses), []);
  assert.deepEqual(studiedCourses(undefined, courses), []);
  assert.deepEqual(studiedCourses(["复利与指数基金入门"], []), []);
  // 最多两门，不重复
  assert.deepEqual(studiedCourses(["Python", "Python", "复利与指数基金入门", "Linear Algebra Basics"], courses), ["Python", "复利与指数基金入门"]);

  assert.equal(listCourses(["A", "B"], "zh"), "《A》《B》");
  assert.equal(listCourses(["A", "B"], "en"), "“A” and “B”");
  assert.equal(t("zh", "learn.recs", "because", { courses: "《A》" }), "因为你学过《A》");
  assert.equal(t("en", "learn.recs", "because", { courses: "“A”" }), "Because you studied “A”");

  const panel = await read("components/learn/recommendation-panel.tsx");
  assert.doesNotMatch(panel, /topics\.join/);
  // 收藏按钮除了图标还有文字
  assert.match(panel, /\{t\("saveShort"\)\}/);
  assert.equal(zh.learn.recs.saveShort, "收藏");
  assert.equal(en.learn.recs.saveShort, "Save");
});

// ── 统计条 ──

test("统计块只有一种长相（StatStrip）：我的课程、用户中心概览 / 学习记录都用它；术语统一「连续学习天数」「最长连续天数」", async () => {
  for (const file of [
    "components/learn/dashboard.tsx",
    "app/[locale]/(default)/me/page.tsx",
    "components/me/activity-stats.tsx",
  ]) {
    assert.match(await read(file), /<StatStrip/, file);
  }
  for (const gone of ["components/learn/stats-strip.tsx", "components/me/stat-tile.tsx"]) {
    await assert.rejects(access(join(root, gone)), `${gone} 还在`);
  }
  assert.equal(zh.learn.dashboard.stats.streak, "连续学习天数");
  assert.equal(zh.me.activity.stat_streak, "连续学习天数");
  assert.equal(zh.me.activity.stat_longest, "最长连续天数");
  assert.equal(zh.me.overview.stat_longest, "最长连续天数");
  assert.doesNotMatch(JSON.stringify(zh), /当前连续天数/);
  assert.equal(en.learn.dashboard.stats.streak, en.me.activity.stat_streak);
  // 分隔线画在格子自己的右边和下边，外层裁掉多出来的：格子数不整齐也没有灰块
  const strip = await read("components/learn/stat-strip.tsx");
  assert.match(strip, /-mb-px -mr-px grid grid-cols-2/);
  assert.match(strip, /border-b border-r/);
  assert.match(strip, /text-\[13px\] text-muted-foreground/);
});

// ── 重复按钮与空状态 ──

test("没有内容时页头不再放第二个主按钮（我的课程「新建课程」、下一步学习「生成推荐」只留空状态卡片里的）", async () => {
  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /!loading && courses\.length > 0 && \(\s*<Button\s+ref=\{newCourseButton\}/);
  assert.match(dashboard, /<EmptyCourses onStart=\{openCreate\} buttonRef=\{newCourseButton\} \/>/);
  assert.match(await read("components/learn/empty-courses.tsx"), /<Button ref=\{buttonRef\}/);
  const next = await read("components/learn/next.tsx");
  assert.match(next, /!loading &&\s*\(recommendations\.length > 0 \|\| refreshing\) && \(\s*<Button/);
});

test("空状态只有两种——页面级（EmptyAction：实线卡 + 钟形曲线插图 + 标题 + 一句话 + 按钮，所有页面都用同一张插图）和区块级（EmptyHint：虚线框 + 一行字）", async () => {
  const state = await read("components/learn/empty-state.tsx");
  assert.match(state, /export function EmptyAction/);
  assert.match(state, /export function EmptyHint/);
  assert.match(state, /rounded-xl border bg-card/);
  assert.match(state, /border border-dashed/);
  assert.equal([...state.matchAll(/border-dashed/g)].length, 1);

  const files = {
    "components/learn/empty-courses.tsx": /<EmptyAction[\s\S]*?art=\{<BellCurve/,
    "components/learn/recommendation-panel.tsx": /<EmptyAction title=\{t\("empty"\)\}/,
    "components/me/continue-card.tsx": /<EmptyAction\s+title=/,
    "app/[locale]/(default)/me/notes/page.tsx": /<EmptyAction title=/,
  };
  for (const [file, pattern] of Object.entries(files)) assert.match(await read(file), pattern, file);
  for (const file of [
    "components/learn/recommendation-panel.tsx",
    "app/[locale]/(default)/me/page.tsx",
    "components/me/notes-browser.tsx",
  ]) {
    assert.match(await read(file), /<EmptyHint/, file);
  }
  // 插画（钟形曲线）由 EmptyAction 自己带（默认小号，「我的课程」传带标注的大一号），各页面不自己放
  assert.match(state, /art = <BellCurve tone="auto" annotated=\{false\}/);
  assert.doesNotMatch(state, /icon\??:/);
  for (const file of [
    "app/[locale]/(default)/me/notes/page.tsx",
    "app/[locale]/(default)/me/activity/page.tsx",
    "components/me/continue-card.tsx",
  ]) {
    assert.doesNotMatch(await read(file), /BellCurve/, file);
  }
  assert.match(await read("app/[locale]/(default)/me/activity/page.tsx"), /<EmptyAction title=/);
  // 原来各写各的虚线框已经换掉：虚线框只在 EmptyHint 里
  for (const file of ["components/me/notes-browser.tsx", "app/[locale]/(default)/me/page.tsx"]) {
    assert.doesNotMatch(await read(file), /border-dashed/, file);
  }
});

// ── 手机 ──

test("课程卡片的删除收进「更多」菜单（仍走确认对话框）；触屏上菜单按钮一直可见；用户中心手机标签条两端渐隐", async () => {
  const card = await read("components/learn/course-card.tsx");
  assert.match(card, /<DropdownMenu>/);
  assert.match(card, /<DropdownMenuItem\s+variant="destructive"\s+onSelect=\{\(\) => onDelete\(course, more\.current\)\}/);
  assert.match(card, /\[@media\(hover:hover\)\]:opacity-0 \[@media\(hover:hover\)\]:group-hover:opacity-100/);
  assert.doesNotMatch(card, /sm:opacity-0/);
  assert.match(await read("components/learn/dashboard.tsx"), /onDelete=\{\(target, opener\) => \{\s*setDeleteOpener\(opener\);\s*setDeleteTarget\(target\);/);
  assert.equal(zh.learn.dashboard.card.deleteItem, "删除课程");

  const nav = await read("components/me/nav.tsx");
  assert.match(nav, /scroll-fade-x flex gap-1 overflow-x-auto/);
  assert.match(nav, /data-fade-end=\{fade\.end\}/);
  const css = await read("app/learn.css");
  assert.match(css, /\.scroll-fade-x \{[\s\S]*?mask-image: linear-gradient/);
  assert.match(css, /\.scroll-fade-x\[data-fade-end="true"\] \{\s*--fade-end: var\(--fade-size, 1\.5rem\);/);
});

// ── 输入框聚焦 ──

test("输入框聚焦只画一圈（2px 轮廓压在 1px 描边上），不是描边变色再隔 2px 画一圈", async () => {
  for (const file of ["components/ui/input.tsx", "components/ui/textarea.tsx"]) {
    const text = await read(file);
    assert.match(text, /focus-visible:border-ring focus-visible:bg-card focus-visible:outline-offset-\[-1px\]/, file);
    assert.doesNotMatch(text, /focus-visible:border-primary/, file);
  }
});


test("问候按浏览器本地时间五档；凌晨不再说「晚上好」", () => {
  assert.deepEqual([2, 7, 11, 12, 15, 20, 23].map(dayPart), ["night", "morning", "noon", "noon", "afternoon", "evening", "night"]);
  assert.equal(t("zh", "me.overview", "greeting_night", { name: "Alex" }), "Alex，夜深了");
  assert.equal(t("zh", "me.overview", "greeting_noon", { name: "Alex" }), "Alex，中午好");
  assert.equal(t("en", "me.overview", "greeting_night", { name: "Alex" }), "Burning the midnight oil, Alex?");
});

test("英文设置里叫「Display name」，不是「Nickname」（中文还是昵称）", () => {
  assert.equal(en.me.settings.nickname, "Display name");
  assert.doesNotMatch(JSON.stringify(en.me.settings), /Nickname/);
  assert.equal(en.me.settings.saved, "Display name updated");
  assert.equal(zh.me.settings.nickname, "昵称");
});

test("学习记录切换月份时，选中的那天不在新月份里就清空右边的明细（显示「点一个有颜色的日期」）", async () => {
  const view = await read("components/me/activity-view.tsx");
  assert.match(view, /const goMonth = \(next: Date\) => \{[\s\S]*?setSelected\(\(current\) => \(current\?\.startsWith\(prefix\) \? current : null\)\)/);
  assert.equal([...view.matchAll(/goMonth\(new Date\(/g)].length, 2);
  assert.doesNotMatch(view, /onClick=\{\(\) => setMonth\(/);
  assert.match(zh.me.activity.pick_day, /点一个有颜色的日期/);
});

test("学习记录日历里没有记录的日子不画底色；选中是 2px 主色环；热力图按卡片宽度等分铺满", async () => {
  const view = await read("components/me/activity-view.tsx");
  assert.match(view, /const CELL = \[\s*"text-subtle-foreground",/);
  assert.doesNotMatch(view, /ring-2 ring-foreground/);
  // 选中环用 --ring（亮绿主色在浅底上对比不够，焦点环也是 --ring）
  assert.match(view, /ring-2 ring-ring ring-offset-2 ring-offset-card/);
  assert.match(view, /ring-2 ring-ring ring-offset-1 ring-offset-card/);
  const heat = await read("components/me/mini-heatmap.tsx");
  assert.match(heat, /repeat\(\$\{weeks\}, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(heat, /28px/);
  assert.match(view, /repeat\(\$\{weeks\}, minmax\(0, 1fr\)\)/);
});

// ── 笔记 ──

test("笔记里的回答摘要被后端截成 200 字时补「…」，英文停在最后一个空格而不是半个词中间；展开全文取完整对话", async () => {
  // 没截过：原样
  assert.deepEqual(previewText("很短的回答。"), { text: "很短的回答。", cut: false });
  // 中文：按字截，补省略号
  const zhText = "字".repeat(200);
  assert.deepEqual(previewText(zhText), { text: zhText, cut: true });
  // 英文：停在最后一个空格
  const enText = "interest compounds ".repeat(12).slice(0, 197) + "wor";
  assert.equal(enText.length, 200);
  const result = previewText(enText);
  assert.equal(result.cut, true);
  assert.doesNotMatch(result.text, /wor$/);
  assert.match(result.text, /(interest|compounds)$/);
  // 末尾的标点和空白不留
  assert.equal(previewText(`${"字".repeat(198)}，`).text.endsWith("，"), false);

  const card = await read("components/me/note-card.tsx");
  assert.match(card, /\{preview\.cut && "…"\}/);
  assert.match(card, /fullConversation\(note\)/);
  assert.match(card, /aria-expanded=\{open\}/);
  // 副标题和实际功能一致：课程筛选只有多门课时才有
  assert.doesNotMatch(zh.me.notes.description, /可以搜索、按课程筛选/);
  assert.match(zh.me.notes.description, /课程多了还能按课程筛选/);
});

test("「我的笔记」页头和设置里都能「导出为 Markdown」：分页取全笔记，按课程分组，回答取完整对话，课文链接带 ?annotation=", async () => {
  assert.match(await read("app/[locale]/(default)/me/notes/page.tsx"), /actions=\{!\(notes instanceof Error\) && notes\.total > 0 \? <ExportNotes \/> : undefined\}/);
  assert.match(await read("components/me/settings-panels.tsx"), /<Row label=\{t\("export_title"\)\} hint=\{t\("export_hint"\)\}>\s*<ExportNotes \/>/);
  // 只在点击时开始取数据，只发 GET
  const button = await read("components/me/export-notes.tsx");
  assert.match(button, /onClick=\{run\}/);
  assert.doesNotMatch(button, /useEffect/);
  const exporter = await read("lib/me/export.ts");
  assert.match(exporter, /getNotesPage\(page, PAGE\)/);
  assert.doesNotMatch(exporter, /method: "(POST|PUT|PATCH|DELETE)"/);

  const note = (over) => ({
    id: 1,
    course_id: 7,
    course_name: "复利",
    lesson_number: 1,
    lesson_title: "01 · 复利的威力",
    original_text: "**复利**就是\n利滚利",
    question: "为什么？",
    answer_preview: "因为利息也生息",
    message_count: 2,
    created_at: "2026-10-14T12:00:00Z",
    updated_at: "2026-10-14T12:00:00Z",
    ...over,
  });
  const labels = {
    title: "我的 Bloom 笔记",
    exported: "导出于 2026-10-15，共 3 条笔记",
    lesson: (n) => `第 ${n} 篇`,
    summary: "课程总结",
    question: "问",
    answer: "答",
    open: "回到课文",
    truncated: "只取到了开头",
  };
  const md = buildNotesMarkdown(
    [
      { note: note({ id: 2, lesson_number: 2, lesson_title: "02 · 第二篇" }), messages: [{ role: "user", content: "再问" }, { role: "assistant", content: "# 小标题\n\n回答全文" }] },
      { note: note({ id: 1 }), messages: [{ role: "user", content: "为什么？" }, { role: "assistant", content: "因为利息也生息，完整的回答。" }, { role: "user", content: "追问" }, { role: "assistant", content: "追答" }] },
      { note: note({ id: 3, course_id: 8, course_name: "线性代数" }), messages: null },
    ],
    { labels, origin: "https://bloom.test", localePath: (p) => `/zh${p}` }
  );
  // 课程分组，课程内按课文编号
  assert.ok(md.indexOf("## 复利") < md.indexOf("## 线性代数"));
  assert.ok(md.indexOf("### 第 1 篇 · 复利的威力") < md.indexOf("### 第 2 篇 · 第二篇"));
  // 完整对话（含追问）：提问和回答整段放进引用块；回答里的 # 标题降成粗体行；取不到完整回答时用摘要加说明
  assert.match(md, /\*\*答\*\*\n\n> 因为利息也生息，完整的回答。/);
  assert.match(md, /\*\*问\*\*\n\n> 追问/);
  assert.match(md, /> \*\*小标题\*\*\n>\n> 回答全文/);
  assert.doesNotMatch(md, /^#{1,6} 小标题/m);
  // 摘要「因为利息也生息」没到 200 字上限，说明没被截过：不加「…」也不加说明
  assert.doesNotMatch(md, /因为利息也生息…/);
  assert.doesNotMatch(md, /只取到了开头/);
  // 划线原文去掉 Markdown 记号压成一行，深链接带语言和 annotation
  assert.match(md, /^> 复利就是 利滚利$/m);
  assert.match(md, /\[回到课文\]\(https:\/\/bloom\.test\/zh\/learn\/course\/7\/lesson\/1\?annotation=1\)/);
  assert.match(md, /^# 我的 Bloom 笔记\n\n导出于 2026-10-15，共 3 条笔记\n\n## /);
  assert.ok(md.endsWith("---\n"));
});

test("导出的转义：用户和模型写的内容放进引用块，未闭合的代码围栏补齐，标题里的用户文字转义，「…」只在真被截断时加", () => {
  const base = {
    id: 1,
    course_id: 7,
    course_name: "复利",
    lesson_number: 1,
    lesson_title: "01 · 复利",
    original_text: "摘句",
    question: "问",
    answer_preview: "短回答",
    message_count: 2,
    created_at: "2026-10-14T12:00:00Z",
    updated_at: "2026-10-14T12:00:00Z",
  };
  const labels = {
    title: "标题",
    exported: "导出",
    lesson: (n) => `第 ${n} 篇`,
    summary: "总结",
    question: "问",
    answer: "答",
    open: "回",
    truncated: "只取到了开头",
  };
  const opts = { labels, origin: "https://b.test", localePath: (p) => p };
  const build = (items) => exporter.buildNotesMarkdown(items, opts);
  const lines = (md) => md.split("\n");

  // 1. 回答停在代码块里（围栏没闭合）：补上收尾的围栏，后面的笔记不被吞
  const unclosed = build([
    { note: { ...base, id: 1 }, messages: [{ role: "user", content: "写个例子" }, { role: "assistant", content: "先看代码：\n\n```python\nprint(1)\n# 注释不是标题" }] },
    { note: { ...base, id: 2, lesson_number: 2, lesson_title: "02 · 第二篇" }, messages: [{ role: "user", content: "再问" }, { role: "assistant", content: "回答二" }] },
  ]);
  assert.match(unclosed, /> ```python\n> print\(1\)\n> # 注释不是标题\n> ```\n/);
  // 每一行代码都在引用块里，后面的课文标题还是标题（不在围栏里）
  assert.match(unclosed, /\n### 第 2 篇 · 第二篇\n/);
  assert.match(unclosed, /\n---\n/);
  // 围栏没闭合的、波浪线围栏同理
  assert.match(build([{ note: base, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "~~~\ncode" }] }]), /> ~~~\n> code\n> ~~~\n/);
  // 已经闭合的不重复补
  assert.equal([...build([{ note: base, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "```\nx\n```" }] }]).matchAll(/> ```/g)].length, 2);

  // 2. 提问里的「---」和「# 标题」不会变成分隔线 / 标题：独占一行的 --- 只有笔记之间那一条
  const dash = build([{ note: base, messages: [{ role: "user", content: "xxx\n---" }, { role: "assistant", content: "yyy\n---\n# 回答里的标题" }] }]);
  assert.equal(lines(dash).filter((l) => l === "---").length, 1);
  assert.match(dash, /> xxx\n> ---/);
  assert.match(dash, /> yyy\n> ---\n> \*\*回答里的标题\*\*/);

  // 3. 取不到完整对话的回退分支：提问同样放进引用块（# 标题不降成文件的标题）
  const fallback = build([{ note: { ...base, question: "# 假标题\n- 项" }, messages: null }]);
  assert.match(fallback, /\*\*问\*\*\n\n> # 假标题\n> - 项/);
  assert.doesNotMatch(fallback, /^# 假标题/m);

  // 4. 课程名、课文标题里的 Markdown 特殊字符转义：`* [ ]` 不被解释，行内代码不被打开
  const hostile = build([{ note: { ...base, course_name: "* [ ] 课程_名 <b> `x`", lesson_title: "01 · 用 # 和 [链接](u)\n换行" }, messages: null }]);
  assert.match(hostile, /^## \\\* \\\[ \\\] 课程\\_名 \\<b\\> \\`x\\`$/m);
  assert.match(hostile, /^### 第 1 篇 · 用 \\# 和 \\\[链接\\\]\(u\)\s*换行$|^### 第 1 篇 · 用 \\# 和 \\\[链接\\\]\(u\) 换行$/m);

  // 5. 回答末尾的「…」和说明只在摘要真被截断（200 字上限）时才有
  const short = build([{ note: { ...base, answer_preview: "完整的短回答" }, messages: null }]);
  assert.match(short, /> 完整的短回答\n/);
  assert.doesNotMatch(short, /…|只取到了开头/);
  const cut = build([{ note: { ...base, answer_preview: "字".repeat(200) }, messages: null }]);
  assert.match(cut, new RegExp(`> ${"字".repeat(200)}…\\n`));
  assert.match(cut, /\*只取到了开头\*/);
});

test("清扫：学习区与用户中心里，亮绿 --primary 不拿来画浅底上的状态（选中环、选中描边、当前步骤、「今天」环、页边圆点）——这些用 --ring（亮 #009966，浅底 ≥ 3:1）；填充（bg-primary）、半透明的装饰描边、悬停提示不受限", async () => {
  const { readdir } = await import("node:fs/promises");
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await walk(path)));
      else if (/\.tsx$/.test(entry.name)) out.push(path);
    }
    return out;
  };
  // 逐个 class 看：去掉变体前缀后是实心的 ring-primary / border-primary / outline-primary 才算（带透明度 /40 的不算）。
  // 放过两种：悬停提示（hover: / group-hover: / peer-hover:），以及同一行里有「同样变体前缀的 bg-primary」（实心填充 + 同色描边）。
  // data-[…]: aria-[…]: focus: focus-visible: has-[…]: dark: 等其它变体照样要查——状态环常藏在这些后面
  const solidPrimary = (line) => {
    const tokens = line.split(/[\s"'`]+/);
    const found = [];
    for (const token of tokens) {
      const m = token.match(/^(.*?)(?:ring|border|outline)-primary$/);
      if (!m) continue;
      const prefix = m[1];
      if (prefix && /^(?:(?:group-|peer-)?hover:)+$/.test(prefix)) continue;
      if (tokens.includes(`${prefix}bg-primary`)) continue;
      found.push(token);
    }
    return found;
  };
  const hits = [];
  for (const file of [...(await walk("components/learn")), ...(await walk("components/me")), ...(await walk("app/[locale]/(default)/me"))]) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "");
    text.split("\n").forEach((line, i) => {
      if (solidPrimary(line.replace(/\/\/.*$/, "")).length) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
  // 守卫本身有效：这些要查出来
  for (const bad of [
    "border-primary bg-accent",
    "ring-2 ring-primary",
    "data-[state=on]:border-primary",
    "aria-[current=true]:ring-primary",
    "focus:ring-primary",
    "focus-visible:outline-primary",
    "has-[:focus-visible]:border-primary",
    "dark:border-primary bg-primary",
    "border-primary data-[x]:bg-primary",
    'cn("border-primary", on && "bg-accent")',
  ]) {
    assert.equal(solidPrimary(bad).length, 1, bad);
  }
  // 这些放过：透明度、令牌、悬停提示、同前缀的实心填充
  for (const ok of [
    "border-primary/30",
    "hover:border-primary/40",
    "hover:border-primary",
    "group-hover:ring-primary",
    "ring-primary/20",
    "border-ring",
    "ring-ring",
    "bg-primary",
    "text-primary-foreground",
    "ring-offset-card",
    "border-primary bg-primary text-primary-foreground",
    "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
  ]) {
    assert.deepEqual(solidPrimary(ok), [], ok);
  }
  // 具体几处
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.equal([...dialog.matchAll(/"border-ring bg-accent/g)].length, 3, "深度 / 语言选项、开始方式卡、拖放区的选中描边");
  assert.match(await read("components/learn/creating-dialog.tsx"), /i === step && "border-ring"/);
  assert.match(await read("components/me/activity-view.tsx"), /key === today && "ring-1 ring-ring/);
  assert.match(await read("lib/learn/highlight.ts"), /::highlight\(bloom-ann\)[^}]*text-decoration-color: var\(--ring\)/);
  assert.match(await read("lib/learn/highlight.ts"), /::highlight\(bloom-active\)[^}]*text-decoration-color: var\(--ring\)/);
  // 图标和链接里的文字绿用 text-primary-text（悬停也是）
  assert.match(await read("app/[locale]/(default)/me/page.tsx"), /"size-4 text-primary-text"/);
  assert.match(await read("components/me/continue-card.tsx"), /text-primary-text/);
  assert.match(await read("components/learn/lesson-nav.tsx"), /size-4 shrink-0 text-primary-text/);
  assert.match(await read("components/learn/new-course-dialog.tsx"), /hover:text-primary-text/);
});

test("钟形曲线：浅色版的「+2σ」「前 2%」标注用 #007a55 一档（--bc-em-text，浅底 ≥ 4.5:1），深色版 #00d492（v4 emerald）", async () => {
  const curve = await read("components/brand/bell-curve.tsx");
  assert.match(curve, /auto: "\[--bc-em:#009966\] \[--bc-em-text:#007a55\]/);
  assert.match(curve, /dark:\[--bc-em-text:#00d492\]/);
  assert.match(curve, /dark: "\[--bc-em:#00d492\] \[--bc-em-text:#00d492\]/);
  assert.equal([...curve.matchAll(/fill: "var\(--bc-em-text\)"/g)].length, 2);
  assert.doesNotMatch(curve, /fill: "var\(--bc-em\)"/);
  // 曲线本身（描线、渐变）仍用 --bc-em
  assert.match(curve, /stroke: "var\(--bc-em\)"/);
});

// ── 文案：两种语言成对 ──

test("本轮新增的文案两种语言成对、占位符一致，中文用全角标点", () => {
  const keys = [
    ["learn", "learn.course.progress.course"],
    ["learn", "learn.recs.because"],
    ["learn", "learn.dashboard.form.depthNote"],
    ["learn", "learn.dashboard.creating.hintMaterials"],
    ["me", "me.notes.expand"],
    ["me", "me.notes.export_header"],
    ["me", "me.settings.export_hint"],
    ["me", "me.overview.greeting_night"],
  ];
  const at = (messages, path) => path.split(".").reduce((node, k) => node?.[k], messages);
  const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();
  for (const [, path] of keys) {
    const [a, b] = [at(zh, path), at(en, path)];
    assert.equal(typeof a, "string", path);
    assert.equal(typeof b, "string", path);
    assert.deepEqual(placeholders(a), placeholders(b), path);
    assert.doesNotMatch(a, /[?!]|\w:\s/, `${path} 里有半角标点`);
  }
});

test("口径：数字只用后端的 mastery_covered / mastery_total，已完结的课显示「已完成」，不编造「total / total」", async () => {
  const course = { status: "learning", mastery_progress: 0.4, mastery_covered: 4, mastery_total: 10 };
  assert.deepEqual(courseProgress(course), { completed: false, percent: 40, covered: 4, total: 10 });
  // 后端给的已讲到数不会超过总数（防御：超出就夹住）；缺字段按 0
  assert.equal(courseProgress({ ...course, mastery_covered: 14 }).covered, 10);
  assert.deepEqual(courseProgress({ status: "learning", mastery_progress: 0 }), { completed: false, percent: 0, covered: 0, total: 0 });
  // 已完结：completed 为真，covered 仍是后端给的数（不被改成 total）
  const done = courseProgress({ status: "completed", mastery_progress: 0.7, mastery_covered: 7, mastery_total: 10 });
  assert.equal(done.completed, true);
  assert.equal(done.covered, 7);

  // 课程页、大纲页、用户中心概览：完结时只写「已完成」，不写「已讲到 X / Y 个要点」
  const course_ = await read("components/learn/course.tsx");
  assert.doesNotMatch(course_, /completed \? total/);
  assert.match(course_, /progress\.completed \? \(\s*<p[^>]*>\s*<Check[\s\S]*?t\("common\.completed"\)/);
  assert.match(course_, /!progress\.completed && progress\.total > 0/);
  const syllabus = await read("components/learn/syllabus.tsx");
  assert.match(syllabus, /!progress\.completed && \(\s*<>\s*\{t\("course\.progress\.detail"/);
  const card = await read("components/me/continue-card.tsx");
  assert.match(card, /progress\.completed \? \(\s*<span[^>]*>\{t\("completed"\)\}/);
  assert.match(card, /!progress\.completed && progress\.total > 0/);
  assert.equal(zh.me.overview.completed, "已完成");
  assert.equal(en.me.overview.completed, "Completed");
});

test("「继续学习」横幅在课程已完结时，读屏名字和链接目标一致（「打开课程《X》」），不再说「继续学习第 N 篇」", async () => {
  const banner = await read("components/learn/continue-banner.tsx");
  assert.match(banner, /lesson\.course_completed\s*\?\s*t\("dashboard\.continue\.ariaCompleted", \{ course: lesson\.course_name \}\)/);
  assert.equal(t("zh", "learn.dashboard.continue", "ariaCompleted", { course: "复利" }), "打开课程《复利》");
  assert.equal(t("en", "learn.dashboard.continue", "ariaCompleted", { course: "Compounding" }), "Open course “Compounding”");
});

test("课文列表里「N 个划线提问」按钮的 aria-controls 用 useId 生成（桌面右栏和手机抽屉各有一份，id 不能重复）", async () => {
  const nav = await read("components/learn/lesson-nav.tsx");
  // 两个可折叠分组（「N 个划线提问」「我的标记（N）」）共用 RailGroup，id 由 useId 生成
  assert.match(nav, /function RailGroup\(/);
  assert.match(nav, /const id = useId\(\);/);
  assert.match(nav, /aria-controls=\{id\}/);
  assert.match(nav, /<ul id=\{id\}/);
  assert.doesNotMatch(nav, /lesson-asks/);
});

test("统计条的 <dl>：dt（名字）在 dd（数字）之前，看上去数字在上靠 CSS 的 order", async () => {
  const strip = await read("components/learn/stat-strip.tsx");
  assert.ok(strip.indexOf("<dt") < strip.indexOf("<dd"), "dt 要在 dd 之前");
  assert.match(strip, /<dt className="order-2 /);
  assert.match(strip, /<dd className="order-1 font-mono text-3xl/);
  assert.doesNotMatch(strip, /order-first/);
});

test("笔记卡的「展开全文」只在确实有更多可看时出现：回答被后端截断、追问过、或提问 / 回答摘要在卡片上真被 line-clamp 折住（量出来，不靠字数猜；随卡片宽度变）", async () => {
  const card = await read("components/me/note-card.tsx");
  assert.match(card, /const canExpand = preview\.cut \|\| note\.message_count > 2 \|\| clamped;/);
  assert.doesNotMatch(card, /QUESTION_CLAMP|question\.length/);
  assert.doesNotMatch(card, /Boolean\(note\.answer_preview\)/);
  // 折住的两个元素（提问、回答摘要）各挂 ref，量 scrollHeight > clientHeight；尺寸变了（卡片宽度变）和字体加载完都重量
  assert.match(card, /<dd ref=\{questionRef\} className=\{cn\("font-medium", !open && "line-clamp-2"\)\}>/);
  assert.match(card, /<dd ref=\{answerRef\} className=\{cn\(!open && "line-clamp-2"\)\}>/);
  assert.match(card, /el\.scrollHeight > el\.clientHeight/);
  assert.match(card, /new ResizeObserver\(measure\)/);
  assert.match(card, /document\.fonts\?\.ready\.then/);
  // 展开后折叠样式没了、量不出来：展开时不量，沿用展开前的结果，按钮才不会在展开时消失
  assert.match(card, /useLayoutEffect\(\(\) => \{\n    if \(open\) return;/);
});

test("课程页已读节点的描边用 --ring（浅底 ≥ 3:1），不是半透明亮绿（约 1.5:1）", async () => {
  const course = await read("components/learn/course.tsx");
  assert.match(course, /\? "border-ring bg-accent text-accent-foreground"/);
  assert.doesNotMatch(course, /border-primary\/40 bg-accent/);
});

// ── 笔记全文缓存：不会一直用旧的 ──

function mockLessons(t, lessons) {
  const calls = [];
  let tokens = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/token")) {
      return new Response(JSON.stringify({ token: `t${++tokens}`, expires_at: Date.now() / 1000 + 900 }), { status: 200 });
    }
    const path = new URL(String(url), "http://frontend.test").pathname;
    calls.push(path);
    const hit = path.match(/\/api\/backend\/courses\/(\d+)\/lessons\/(\d+)\/annotations$/);
    return new Response(JSON.stringify(lessons[`${hit[1]}/${hit[2]}`] ?? []), { status: 200 });
  });

  return calls;
}
const ann = (id, count) => ({ id, messages: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })) });
const noteOf = (id, count, course = 901, lesson = 1) => ({ id, course_id: course, lesson_number: lesson, message_count: count });

test("展开笔记：回课文追问过之后再回来，笔记接口的消息数比缓存里多，就清掉这一篇重取，拿到最新对话；新建的笔记（缓存里没有）同理", async (t) => {
  const lessons = { "901/1": [ann(1, 2)] };
  const calls = mockLessons(t, lessons);
  assert.equal((await annotations.fullConversation(noteOf(1, 2))).length, 2);
  // 同一篇再展开别的笔记：用缓存，不重取
  assert.equal((await annotations.fullConversation(noteOf(1, 2))).length, 2);
  assert.equal(calls.length, 1);

  // 回课文追问了一次（后端现在有 4 条），笔记接口给的 message_count 变成 4：缓存里只有 2 条 → 重取
  lessons["901/1"] = [ann(1, 4), ann(2, 2)];
  assert.equal((await annotations.fullConversation(noteOf(1, 4))).length, 4);
  assert.equal(calls.length, 2);
  // 刚建的笔记（缓存刚刷新过，已经有）直接用缓存
  assert.equal((await annotations.fullConversation(noteOf(2, 2))).length, 2);
  assert.equal(calls.length, 2);

  // 另一篇课文里新建的笔记：缓存里没有这篇，取一次；之后又新建了一条（缓存里没有这条）：重取
  const other = { "902/3": [ann(5, 2)] };
  Object.assign(lessons, other);
  assert.equal((await annotations.fullConversation(noteOf(5, 2, 902, 3))).length, 2);
  lessons["902/3"] = [ann(5, 2), ann(6, 2)];
  assert.equal((await annotations.fullConversation(noteOf(6, 2, 902, 3))).length, 2);
  assert.equal(calls.length, 4);

  // 重取一次也找不到这条（已被删、或不属于这篇）：返回 null（界面说取不到完整回答），不抛错，也只重取这一次
  const before = calls.length;
  assert.equal(await annotations.fullConversation(noteOf(99, 2, 902, 3)), null);
  assert.equal(calls.length, before + 1);
});

test("课文页里问答变了（提问、追问、删除、中途停止）就作废这篇课文在「我的笔记」里的全文缓存，回去再展开拿到最新对话", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /import \{ forgetLessonAnnotations \} from "@\/lib\/me\/annotations";/);
  // 提问和追问的 finally（成功、失败、被中途停止都走这里）各一处，删除成功一处，停止之后拉到后台写完的回答换上时一处
  assert.equal([...lesson.matchAll(/forgetLessonAnnotations\(Number\(courseId\), Number\(lessonNum\)\);/g)].length, 4);
  const check = lesson.slice(lesson.indexOf("const checkBackground"), lesson.indexOf("const waitForBackground"));
  assert.match(check, /setSessions[\s\S]*?forgetLessonAnnotations/);
  const create = lesson.slice(lesson.indexOf("const handleCreateSession"), lesson.indexOf("const handleFollowUp"));
  assert.match(create, /finally \{[\s\S]*?forgetLessonAnnotations/);
  const follow = lesson.slice(lesson.indexOf("const handleFollowUp"), lesson.indexOf("const handleStopStreaming"));
  assert.match(follow, /finally \{[\s\S]*?forgetLessonAnnotations/);
  const del = lesson.slice(lesson.indexOf("const handleDeleteSession"), lesson.indexOf("const handleSubmitFeedback"));
  assert.match(del, /await deleteAnnotation\([\s\S]*?forgetLessonAnnotations/);
});

test("导出一律直接取最新，不走展开用的缓存：先展开过（缓存了旧对话），回课文追问后导出，导出里有追问", async (t) => {
  const lessons = { "903/1": [ann(1, 2)] };
  const calls = mockLessons(t, lessons);
  await annotations.fullConversation(noteOf(1, 2, 903, 1)); // 缓存了 2 条
  lessons["903/1"] = [ann(1, 4)];
  const [item] = await exporter.attachConversations([{ ...noteOf(1, 4, 903, 1), course_name: "c", lesson_title: "t", original_text: "o", question: "q", answer_preview: "a", created_at: "2026-10-14T12:00:00Z", updated_at: "2026-10-14T12:00:00Z" }]);
  assert.equal(item.messages.length, 4);
  assert.equal(calls.length, 2, "导出重新取了，没用缓存");
  // 一次导出里同一篇课文只取一次
  calls.length = 0;
  const base = { course_name: "c", lesson_title: "t", original_text: "o", question: "q", answer_preview: "a", created_at: "2026-10-14T12:00:00Z", updated_at: "2026-10-14T12:00:00Z" };
  await exporter.attachConversations([{ ...base, ...noteOf(1, 4, 903, 1) }, { ...base, ...noteOf(1, 4, 903, 1), id: 1 }]);
  assert.equal(calls.length, 1);
  const source = await read("lib/me/export.ts");
  assert.doesNotMatch(source, /lessonAnnotations/);
});
