import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";


const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const backend = (path) => readFile(new URL(`../../backend/app/${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);
const get = (messages, dotted) => dotted.split(".").reduce((node, key) => node?.[key], messages);

// --- 目录原位展开 ---

test("右栏目录展开时在右栏里原位展开（列表有最大高度、自己滚动），不再浮在卡片上；卡片的吸附线让出这一组的高度", async () => {
  const nav = await read("components/learn/lesson-nav.tsx");
  const collapsed = nav.slice(nav.indexOf("export function CollapsedNav"), nav.indexOf("// 桌面右侧栏里的章节导航"));
  assert.match(collapsed, /mt-1 max-h-\[min\(14rem,30dvh\)\] overflow-y-auto overscroll-contain rounded-lg border bg-card p-2/);
  assert.doesNotMatch(collapsed, /absolute|shadow-lg/, "展开的列表不再是浮层");
  // 文件名很长时只截文件名：「文件 / 课文」标签不收缩、不换行（以前会被挤成竖排两行）
  assert.match(collapsed, /<span className="shrink-0 whitespace-nowrap font-medium">\{label\}<\/span>/);
  assert.match(collapsed, /<span className="min-w-0 truncate text-muted-foreground">· \{current\}<\/span>/);
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /const observer = new ResizeObserver\(apply\);\s*observer\.observe\(group\);/);
  assert.match(lesson, /area\.style\.setProperty\("--panel-offset"/);
  assert.doesNotMatch(lesson, /"--panel-offset": "3\.5rem"/);
});

// --- 新建课程里整门课的估算 ---

test("学习深度不推导整门课的篇数或费用", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /LEARNING_DEPTHS/);
  assert.doesNotMatch(dialog, /courseEstimate|costs\.create_course|costs\.next_lesson/);
  for (const messages of [zh, en]) assert.doesNotMatch(get(messages, "learn.dashboard.form.depthNote"), /Token|token/);
});

test("资料读取只校验文件，不承诺按页数和分块计算的费用", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.doesNotMatch(dialog, /chooseFilesFirst/);
  assert.match(dialog, /t\("dashboard\.form\.estimateReady"\)/);
  for (const messages of [zh,en]) {
    const form = messages.learn.dashboard.form;
    assert.doesNotMatch(form.estimatePdf, /Token|token/);
    assert.doesNotMatch(form.estimateReady+form.estimatePdf, /\{(?:base|chunk|total|min)\}|预估总价|fixed price/);
  }
});

test("问答回答流式写完时，一直跟在底部的读者把回答的开头滚回可见；回答本来整段看得见、或读者自己往上翻过，都不动", async () => {
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /onScroll=\{\(e\) => \{\s*const el = e\.currentTarget;\s*following\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < 140;/);
  assert.match(panel, /if \(!following\.current\) return;/);
  assert.match(panel, /querySelectorAll<HTMLElement>\("\[data-answer\]"\)/);
  assert.match(panel, /if \(delta < 0 \|\| delta > body\.clientHeight - 24\) body\.scrollTop \+= delta - 12;/);
  assert.equal([...panel.matchAll(/data-answer/g)].length >= 3, true);
});

// --- 下一步学习 ---

test("待学清单的卡片等高、「开始学习」沉到卡片底部对齐，说明折起两行、真被折住了才出现「展开」", async () => {
  const panel = await read("components/learn/recommendation-panel.tsx");
  assert.match(panel, /<article className="flex h-full flex-col rounded-lg border bg-card p-4">/);
  assert.match(panel, /<div className="mt-auto pt-4">\s*<Button\s+variant="outline"/);
  assert.match(panel, /el\.scrollHeight > el\.clientHeight \+ 1/);
  assert.match(panel, /aria-expanded=\{open\}/);
  assert.equal(get(zh, "learn.recs.expand"), "展开");
  assert.equal(get(en, "learn.recs.expand"), "Show more");
});

test("同一操作一个名字——「刷新推荐 / Refresh suggestions」用于下一步学习的按钮和空状态；进度写「已学到 X / Y 个要点」", () => {
  assert.equal(get(zh, "learn.recs.another"), "刷新推荐");
  assert.equal(get(zh, "learn.recs.generate"), "刷新推荐");
  assert.equal(get(en, "learn.recs.another"), "Refresh suggestions");
  assert.equal(get(en, "learn.recs.generate"), "Refresh suggestions");
  assert.equal(get(zh, "learn.course.progress.detail"), "已读内容覆盖 {covered} / {total} 个要点");
  assert.equal(get(zh, "me.overview.mastery_detail"), "已读内容覆盖 {covered} / {total} 个要点");
  assert.equal(get(en, "learn.course.progress.detail"), "Read lessons cover {covered} of {total} key points");
  assert.doesNotMatch(JSON.stringify(zh.learn) + JSON.stringify(zh.me), /已讲到/);
});

// --- 用户中心与课程卡 ---

test("学习记录当天「打开了 N 篇」这一行也带 ⓘ，说明「打开」和统计里的「已读」为什么不一样", async () => {
  const view = await read("components/me/activity-view.tsx");
  assert.match(view, /<StatHint hint=\{t\("day_info"\)\} \/>/);
  assert.match(get(zh, "me.activity.day_info"), /「打开」是点开过的课文.*「已读课文」/);
  assert.match(get(en, "me.activity.day_info"), /“Opened” counts every lesson you opened/);
});

test("课程卡「最近学习」今天写「今天 09:15」（只知道哪天就写「今天」）、昨天写「昨天」，更早写日期，同一个列表里一致", async () => {
  const { studiedLabel } = await import("../src/lib/learn/time.ts");
  const now = new Date(2026, 9, 15, 12, 0, 0);
  const at = (d, h, m) => new Date(2026, 9, d, h, m, 0).toISOString();
  assert.equal(studiedLabel({ at: at(15, 9, 15), exact: true, sortKey: 0 }, "zh", now), "今天 09:15");
  assert.equal(studiedLabel({ at: "2026-10-15", exact: false, sortKey: new Date(2026, 9, 15).getTime() }, "zh", now), "今天");
  assert.equal(studiedLabel({ at: "2026-10-14", exact: false, sortKey: new Date(2026, 9, 14).getTime() }, "zh", now), "昨天");
  assert.equal(studiedLabel({ at: at(14, 22, 5), exact: true, sortKey: 0 }, "zh", now), "昨天 22:05");
  assert.equal(studiedLabel({ at: "2026-10-10", exact: false, sortKey: new Date(2026, 9, 10).getTime() }, "zh", now), "10月10日");
  assert.equal(studiedLabel({ at: "2025-10-10", exact: false, sortKey: new Date(2025, 9, 10).getTime() }, "zh", now), "2025年10月10日");
  assert.equal(studiedLabel({ at: "2026-10-15", exact: false, sortKey: new Date(2026, 9, 15).getTime() }, "en", now), "today");
  assert.match(studiedLabel({ at: at(15, 9, 15), exact: true, sortKey: 0 }, "en", now), /^today 0?9:15/i);
  assert.doesNotMatch(await read("components/learn/course-card.tsx"), /relativeTime/);
});


test("元信息里的行内公式不在中间断行；学习记录手机上第 5 个统计占满一行", async () => {
  const css = await read("app/learn.css");
  assert.match(css, /\.lesson-meta \.katex \{\s*display: inline-block;\s*max-width: 100%;\s*white-space: nowrap;/);
  assert.match(await read("components/learn/stat-strip.tsx"), /max-sm:\[&:last-child:nth-child\(odd\)\]:col-span-2/);
});

test("暗色下划线高亮改用低饱和的底（14–24% 主色）+ 下划线，不再是一整行亮绿", async () => {
  const { HIGHLIGHT_CSS } = await import("../src/lib/learn/highlight.ts");
  const dark = (name) => HIGHLIGHT_CSS.match(new RegExp(`\\.dark ::highlight\\(${name}\\) \\{([^}]*)\\}`))[1];
  for (const [name, percent] of [["bloom-ann", 14], ["bloom-pending", 20], ["bloom-active", 24]]) {
    assert.match(dark(name), new RegExp(`var\\(--primary\\) ${percent}%`), name);
    // 亮色下原来的值不变（只在 .dark 里降）
    assert.match(HIGHLIGHT_CSS, new RegExp(`::highlight\\(${name}\\) \\{\\s*background-color: color-mix\\(in oklab, var\\(--primary\\) (?:24|40|52)%`));
  }
  assert.match(dark("bloom-pending"), /text-decoration: underline/);
});

test("大纲学习进度表的「覆盖要点」一格渲染成列表（旧课程的「；」「 · 」和后端换行的 <br> 都认），篇号一列不折行", async () => {
  const { prepareSyllabus } = await import("../src/lib/learn/syllabus.ts");
  const { rehypeProgressCards, ITEM_BREAK } = await import("../src/lib/learn/rehype-lesson.ts");
  // <br> 先换成私用字符
  const out = prepareSyllabus("## 学习进度\n\n| 课文 | 覆盖掌握项 | 日期 |\n|---|---|---|\n| 第 1 篇 | 甲<br>乙<br/>丙 | 10月15日 |\n").content;
  assert.ok(out.includes(`甲${ITEM_BREAK}乙${ITEM_BREAK}丙`), out);
  const text = (value) => ({ type: "text", value });
  const el = (tagName, children, properties = {}) => ({ type: "element", tagName, properties, children });
  const cell = (value) => el("td", [text(value)]);
  const tree = (value) => ({ type: "root", children: [
    el("h2", [text("学习进度")]),
    el("div", [el("table", [el("tbody", [el("tr", [cell("第 1 篇"), cell(value), cell("10月15日")])])])], { className: ["lesson-table"] }),
  ] });
  for (const [value, items] of [[`甲${ITEM_BREAK}乙`, ["甲", "乙"]], ["解释 A；识别 B；应用 C", ["解释 A", "识别 B", "应用 C"]], ["Explain A · Identify B", ["Explain A", "Identify B"]]]) {
    const t = tree(value);
    rehypeProgressCards()(t);
    const second = t.children[1].children[0].children[0].children[0].children[1];
    assert.deepEqual(second.children[0].children.map((li) => li.children[0].value), items, value);
  }
  // 只有一条的不拆成列表
  const single = tree("只有一条");
  rehypeProgressCards()(single);
  assert.equal(single.children[1].children[0].children[0].children[0].children[1].children[0].type, "text");
  const formatted = tree("");
  const formattedCell = formatted.children[1].children[0].children[0].children[0].children[1];
  formattedCell.children = [el("strong", [text("特征向量")]), text(` 的方向${ITEM_BREAK}计算 `), el("code", [text("Av")])];
  rehypeProgressCards()(formatted);
  assert.equal(formattedCell.children[0].tagName, "ul", "含加粗和代码的掌握项也要分行");
  assert.equal(formattedCell.children[0].children.length, 2);
  assert.equal(formattedCell.children[0].children[0].children[0].tagName, "strong");
  assert.equal(formattedCell.children[0].children[1].children[1].tagName, "code");
  assert.equal(formattedCell.children[0].children[1].children[0].value, "计算 ", "行内格式前的词间空格要保留");
  assert.ok(!JSON.stringify(formattedCell).includes(ITEM_BREAK), "分隔符不能成为可见字符");
  const css = await read("app/learn.css");
  assert.match(css, /\.syllabus-prose \.progress-cards td:first-child \{\s*white-space: nowrap;/);
  assert.match(css, /\.syllabus-prose \.progress-items \{\s*margin: 0;\s*padding-left: 1\.1em;\s*list-style: disc;/);
});

test("中文页里混着汉字的数字、日期、标签不整段套等宽字体（Mono 只包数字和拉丁字母）；短说明用 text-balance、正文用 text-wrap: pretty 避免行尾孤字", async () => {
  for (const file of ["components/me/continue-card.tsx", "components/me/note-card.tsx", "components/me/activity-view.tsx", "components/me/notes-browser.tsx", "components/learn/course.tsx"]) {
    assert.match(await read(file), /<Mono text=/, file);
  }
  assert.doesNotMatch(await read("components/me/continue-card.tsx"), /<p className="mt-3 font-mono text-xs/);
  const css = await read("app/learn.css");
  assert.match(css, /\.lesson-meta:lang\(zh\) \{\s*font-family: var\(--font-sans\);/);
  assert.match(css, /\.lesson-meta \.lesson-mono \{\s*font-family: var\(--font-mono\);/);
  assert.match(css, /\.prose-bloom :is\(p, li, blockquote\) \{\s*text-wrap: pretty;/);
  assert.match(await read("components/learn/lesson-feedback.tsx"), /max-w-md text-balance text-sm text-muted-foreground/);
  const { rehypeLessonMeta } = await import("../src/lib/learn/rehype-lesson.ts");
  const text = (value) => ({ type: "text", value });
  const el = (tagName, children, properties = {}) => ({ type: "element", tagName, properties, children });
  const tree = { type: "root", children: [el("h1", [text("标题")]), el("blockquote", [el("p", [text("预计阅读时间：4 分钟")])])] };
  rehypeLessonMeta()(tree);
  const json = JSON.stringify(tree);
  assert.match(json, /"className":\["lesson-mono"\].*"value":"4"/);
  // 英文整行本来就是等宽，不拆片段
  const english = { type: "root", children: [el("h1", [text("Title")]), el("blockquote", [el("p", [text("Estimated reading time: 4 minutes")])])] };
  rehypeLessonMeta()(english);
  assert.doesNotMatch(JSON.stringify(english), /lesson-mono/);
});
