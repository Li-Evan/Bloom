import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";


const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);
const get = (messages, dotted) => dotted.split(".").reduce((node, key) => node?.[key], messages);

const pend = await import("../src/lib/learn/pending-courses.ts");

// --- 正在生成的课程 ---

const T0 = Date.parse("2026-10-15T10:00:00Z");
const item = (over = {}) => ({ id: "a", name: "理财入门：指数基金", kind: "topic", startedAt: T0, known: [1, 2], ...over });
const course = (id, name, created = T0 + 20_000) => ({ id, name, created_at: new Date(created).toISOString() });

test("课程列表里出现提交之后才有的同名新课程，这条记录就算完成；已有的课程、没有对上的不算", () => {
  const list = [item()];
  assert.deepEqual(pend.settlePending(list, [course(1, "理财入门：指数基金", T0 - 86_400_000), course(2, "别的")], T0 + 5000).remaining, list);

  const { remaining, settled } = pend.settlePending(list, [course(1, "x"), course(2, "y"), course(9, "理财入门：指数基金")], T0 + 30_000);
  assert.deepEqual(remaining, []);
  assert.deepEqual(settled.map((s) => [s.pending.id, s.courseId]), [["a", 9]]);
});

test("课名按 NFKC、大小写、多余空白规整后对比；有课名的记录不会认领别的名字的新课程", () => {
  const { settled } = pend.settlePending([item({ name: "  Python  装饰器 " })], [course(5, "python 装饰器")], T0 + 30_000);
  assert.equal(settled.length, 1);
  const none = pend.settlePending([item({ name: "A" })], [course(5, "B")], T0 + 30_000);
  assert.equal(none.settled.length, 0);
  assert.equal(none.remaining.length, 1);
});

test("没填课名的（上传原文、项目文件，后端用文件名生成）按先后顺序认领新课程；认领过的课程不会被别的记录再认领", () => {
  const a = item({ id: "a", name: "", kind: "source", startedAt: T0 });
  const b = item({ id: "b", name: "", kind: "source", startedAt: T0 + 1000 });
  const first = pend.settlePending([a, b], [course(7, "Notes", T0 + 20_000)], T0 + 30_000);
  assert.deepEqual(first.settled.map((s) => [s.pending.id, s.courseId]), [["a", 7]]);
  assert.deepEqual(first.remaining.map((r) => [r.id, r.known]), [["b", [1, 2, 7]]]);
  // 剩下的那条之后再看这份列表（课程 7 还在），也不会把它认领走
  assert.equal(pend.settlePending(first.remaining, [course(7, "Notes", T0 + 20_000)], T0 + 40_000).settled.length, 0);
  const second = pend.settlePending(first.remaining, [course(7, "Notes", T0 + 20_000), course(8, "Other", T0 + 50_000)], T0 + 60_000);
  assert.deepEqual(second.settled.map((s) => [s.pending.id, s.courseId]), [["b", 8]]);
});

test("本机时钟比服务器快一点（2 分钟内）也认得出；早得多的课程不算", () => {
  assert.equal(pend.settlePending([item()], [course(9, "理财入门：指数基金", T0 - 90_000)], T0 + 5000).settled.length, 1);
  assert.equal(pend.settlePending([item()], [course(9, "理财入门：指数基金", T0 - 10 * 60_000)], T0 + 5000).settled.length, 0);
});

test("对话框里建课成功的课程，让还在等的记录都知道它不是自己的", () => {
  const out = pend.withKnownCourse([item({ id: "a", known: [1] }), item({ id: "b", known: [1, 5] })], 5);
  assert.deepEqual(out.map((i) => i.known), [[1, 5], [1, 5]]);
});

test("按建课方式等够最长时间（主题课 10 分钟，资料 / 原文 / 项目课 15 分钟）还没出现才算「结果未确认」；超过一天的记录丢掉", () => {
  assert.equal(pend.pendingState(item(), T0 + 9 * 60_000 + 59_000), "running");
  assert.equal(pend.pendingState(item(), T0 + 10 * 60_000), "stalled");
  for (const kind of ["materials", "source", "project", "pdf"]) {
    assert.equal(pend.pendingState(item({ kind }), T0 + 14 * 60_000 + 59_000), "running", kind);
    assert.equal(pend.pendingState(item({ kind }), T0 + 15 * 60_000), "stalled", kind);
  }
  assert.deepEqual(pend.PENDING_STALE_MS, { topic: 10 * 60_000, materials: 15 * 60_000, source: 15 * 60_000, project: 15 * 60_000, pdf: 15 * 60_000 });
  // 资料课后端最长要跑满解析总时限（MATERIAL_TOTAL_TIMEOUT_SECONDS，默认 720 秒），前端代理最多等 900 秒：在那之前不能说「未确认」、给「重新创建」
  assert.ok(pend.PENDING_STALE_MS.materials > 800_000);
  assert.deepEqual(pend.settlePending([item()], [], T0 + 25 * 3600_000).remaining, []);
  assert.deepEqual(pend.parsePending(JSON.stringify([item()]), T0 + 25 * 3600_000), []);
});

test("存储里读出来的东西不可信——坏 JSON、字段不对的整条丢掉，最多留 5 条", () => {
  assert.deepEqual(pend.parsePending(null, T0), []);
  assert.deepEqual(pend.parsePending("{", T0), []);
  assert.deepEqual(pend.parsePending('{"a":1}', T0), []);
  const good = item();
  assert.deepEqual(pend.parsePending(JSON.stringify([good, { id: 1 }, { ...good, kind: "x" }, { ...good, known: ["a"] }]), T0 + 1000), [good]);
  // 旧版本存下的记录还带着金额字段：整条照样读回来，只是不再带这些字段
  assert.deepEqual(pend.parsePending(JSON.stringify([{ ...good, cost: 3, costFrom: true }]), T0 + 1000), [good]);
  // 每种建课方式写下的记录都读得回来：PDF 阅读版曾经漏掉，「正在生成」卡片一重读就没了
  for (const kind of ["topic", "materials", "source", "project", "pdf"]) {
    assert.deepEqual(pend.parsePending(JSON.stringify([{ ...good, kind }]), T0 + 1000), [{ ...good, kind }], kind);
  }
  const many = Array.from({ length: 8 }, (_, i) => item({ id: String(i) }));
  assert.deepEqual(pend.parsePending(JSON.stringify(many), T0 + 1000).map((i) => i.id), ["3", "4", "5", "6", "7"]);
  assert.equal(JSON.parse(pend.serializePending(many)).length, 5);
});

test("同名的课正在生成时，新建对话框才提示；没填课名的、已经「好像出了问题」的不提示", () => {
  const running = item();
  assert.equal(pend.runningWithName([running], " 理财入门：指数基金 ", T0 + 1000)?.id, "a");
  assert.equal(pend.runningWithName([running], "别的", T0 + 1000), undefined);
  assert.equal(pend.runningWithName([running], "", T0 + 1000), undefined);
  assert.equal(pend.runningWithName([running], "理财入门：指数基金", T0 + 6 * 60_000)?.id, "a");
  assert.equal(pend.runningWithName([running], "理财入门：指数基金", T0 + 10 * 60_000), undefined);
});

test("已等多久按分、秒拆开", () => {
  assert.deepEqual(pend.elapsedParts(T0, T0 + 75_500), { minutes: 1, seconds: 15 });
  assert.deepEqual(pend.elapsedParts(T0, T0 - 1000), { minutes: 0, seconds: 0 });
});

test("存储按用户分开；浏览器禁用存储时读写都不抛错", () => {
  assert.notEqual(pend.pendingStorageKey("u1"), pend.pendingStorageKey("u2"));
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    pend.writePending("u1", [item({ startedAt: Date.now() })]);
    assert.equal(pend.readPending("u1").length, 1);
    assert.equal(pend.readPending("u2").length, 0);
    pend.writePending("u1", []);
    assert.equal(store.size, 0);
    globalThis.localStorage = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    assert.deepEqual(pend.readPending("u1"), []);
    assert.doesNotThrow(() => pend.writePending("u1", [item()]));
  } finally {
    delete globalThis.localStorage;
  }
});

test("「我的课程」顶部有生成中卡片，提交时记录、成功或明确失败时去掉、结果未确认时留着，课程出现后自动消失", async () => {
  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /<GeneratingCourses/);
  assert.match(dashboard, /settlePending\(current\(\), list\)/);
  assert.match(dashboard, /const every = pollIntervalMs\(pendingRef\.current\.current\(\)\);\s*if \(every !== null && !document\.hidden && Date\.now\(\) - lastPoll\.current >= every - 100\) reloadCourses\(\);\s*\}, POLL_RUNNING_MS\)/);
  assert.match(dashboard, /onStart=\{startPending\}/);
  assert.match(dashboard, /onFinish=\{pending\.remove\}/);
  assert.match(dashboard, /known: courses\.map\(\(course\) => course\.id\)/);
  const dialog = await read("components/learn/new-course-dialog.tsx");
  const handler = dialog.slice(dialog.indexOf("const handleCreate"), dialog.indexOf("const addReferenceFiles"));
  assert.ok(handler.indexOf("onStart?.(") < handler.indexOf("await createProjectCourse("), "先记录再发请求");
  assert.match(handler, /if \(pendingId\) onFinish\?\.\(pendingId\);\s*if \(!mountedRef\.current\) return;/);
  // 结果未确认：记录留着，只有明确失败才去掉
  assert.match(handler, /isUnconfirmedCreate\(err\)\) \{\s*onUnconfirmed\(pendingId, report\(err\)\);\s*onOpenChange\(false\);\s*\} else \{\s*if \(pendingId\) onFinish\?\.\(pendingId\);/);
  const next = await read("components/learn/next.tsx");
  assert.match(next, /pending\.add\(\{[\s\S]*?known: courseIds\.current/);
  assert.match(next, /isUnconfirmedCreate\(err\)\) \{[\s\S]*?router\.push\("\/learn\?unconfirmed=1"\)[\s\S]*?\} else \{\s*pending\.remove\(pendingId\)/);
});

test("卡片的文案中英都有；已等多久的秒数对读屏隐藏", async () => {
  for (const key of ["label", "stalledLabel", "title", "titleUntitled", "unconfirmed", "waited", "seconds", "minutes", "stalledTitle", "stalledBody", "refresh", "retry", "dismiss", "doneTitle", "open", "expect.topic", "expect.materials", "expect.source", "expect.project", "expect.pdf"]) {
    assert.ok(get(zh, `learn.generating.${key}`) && get(en, `learn.generating.${key}`), key);
  }
  const card = await read("components/learn/generating-courses.tsx");
  assert.match(card, /aria-hidden="true"\s*>\s*\{t\("waited", \{ time \}\)\}/);
  assert.match(card, /role="status"/);
});

// --- 中文引号统一「」 ---

const { zhTypography } = await import("../src/lib/learn/lesson-text.ts");
const { locateOffsets } = await import("../src/lib/learn/highlight.ts");

test("直引号、模型自己写的弯引号都转成「」；嵌套的一层用『』；等长替换", () => {
  assert.equal(zhTypography('他说"好"'), "他说「好」");
  assert.equal(zhTypography("他说“好”"), "他说「好」");
  assert.equal(zhTypography("同一课里“弯引号”和\"直引号\"交替"), "同一课里「弯引号」和「直引号」交替");
  assert.equal(zhTypography("他说“她说‘好的’”"), "他说「她说『好的』」");
  assert.equal(zhTypography("他说“她说“好”吗”"), "他说「她说『好』吗」");
  assert.equal(zhTypography("他说「她说“好”」"), "他说「她说『好』」");
  // 模型已经写了「」『』的原样保留
  assert.equal(zhTypography("他说「她说『好』」"), "他说「她说『好』」");
  for (const text of ['他说"好"', "他说“她说‘好的’”", "之后“中文”：正常"]) {
    assert.equal(zhTypography(text).length, text.length, text);
  }
  // 幂等
  const once = zhTypography('这是“一句”话: "好"');
  assert.equal(zhTypography(once), once);
});

test("单弯引号只在双引号里面、成对时才转——所有格撇号、单独的撇号不动；英文段落不动", () => {
  assert.equal(zhTypography("这个 don’t 不是引号“好”"), "这个 don’t 不是引号「好」");
  assert.equal(zhTypography("外面‘不’是嵌套"), "外面‘不’是嵌套");
  assert.equal(zhTypography("他说“它的 ‘半个括号”"), "他说「它的 ‘半个括号」");
  assert.equal(zhTypography('English “curly” and "straight" stay'), 'English “curly” and "straight" stay');
});

test("代码、公式、链接地址里的引号不动；弯引号单边不成对也能转（自带方向）；直引号不成对仍整格不动", () => {
  assert.equal(zhTypography('用 `“x”` 和 $a“b”$ 以及“中文”'), '用 `“x”` 和 $a“b”$ 以及「中文」');
  assert.equal(zhTypography("[文档](http://x.com/a “标题”) 和“引用”"), "[文档](http://x.com/a “标题”) 和「引用」");
  assert.equal(zhTypography("他说“你好"), "他说「你好");
  assert.equal(zhTypography('他说"你好'), '他说"你好');
  assert.equal(zhTypography("```\nprint(“x”)\n```\n\n之后“中文”"), "```\nprint(“x”)\n```\n\n之后「中文」");
});

test("按一行 / 一个列表项 / 一个表格单元格判断，英文项里的弯引号不动，中英混排的格子照转", () => {
  assert.equal(zhTypography("- 中文“甲”\n- He said “no”\n- 英文：“x”"), "- 中文「甲」\n- He said “no”\n- 英文：「x」");
  assert.equal(zhTypography("| a | b |\n|---|---|\n| “中文” | “English” |"), "| a | b |\n|---|---|\n| 「中文」 | “English” |");
});

test("划线定位不受影响——旧划线存的是直引号 / 弯引号原文，换成「」之后照样找得到，位置一对一", () => {
  const html = "他说「好」，然后说『行』。";
  const root = { textContent: html };
  const old = (text) => ({ original_text: text, position_start: 2, position_end: 2 + text.length });
  assert.deepEqual(locateOffsets(root, old('"好"')), [2, 5]);
  assert.deepEqual(locateOffsets(root, old("“好”")), [2, 5]);
  assert.deepEqual(locateOffsets(root, old("「好」")), [2, 5]);
});

test("课文、问答、笔记都走 zhTypography（开着 typography）；原文篇不转", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const outline = await read("lib/learn/outline.ts");
  assert.match(outline, /return \{ lesson: !isProject, source: isSourceLesson && !isProject, typography: !isSourceLesson, restoreBold: isSourceLesson \}/);
  assert.match(lesson, /<Markdown \{\.\.\.markdownOptions\} sectionIds title=\{course\?\.name\}>/);
  const note = await read("components/me/note-card.tsx");
  assert.match(note, /zhTypography|typography/);
});

// --- 笔记摘录按句子边界截断 ---

const { clipExcerpt } = await import("../src/lib/me/notes.ts");

test("短摘录原样；长摘录在句末截断并加「…」，不在半句话里断", () => {
  assert.equal(clipExcerpt("很短的一句。"), "很短的一句。");
  const long = "第一句讲复利的定义，说明利息也会生利息。第二句举一个例子，一万元存十年，年利率百分之十。第三句再说一遍结论，时间越长增长越快。第四句补充一个提醒，不要把短期波动当成长期规律。第五句收尾，投资之前先弄清楚风险。";
  const out = clipExcerpt(long, 80);
  assert.ok(out.endsWith("。…"), out);
  assert.ok(long.startsWith(out.slice(0, -1)), "截在原文的某个句末");
  assert.ok(out.length < long.length);
  const english = "Imagine two people each put $1,000 into a savings account. One earns simple interest and the other earns compound interest. After thirty years the gap is large, and it keeps growing every single year after that.";
  const clipped = clipExcerpt(english, 120);
  assert.ok(clipped.endsWith("account. One earns simple interest and the other earns compound interest.…") || clipped.endsWith("account.…"), clipped);
  assert.ok(!/savings\s*$/.test(clipped));
});

test("整段只有一句时退到逗号、空格处，实在不行才硬切；小数点、缩写的句号不算句末", () => {
  const one = "这是一整句很长很长的话，中间只有逗号，没有任何句号，所以只能退到最后一个逗号那里截断，再加上省略号表示后面还有内容";
  const out = clipExcerpt(one, 60);
  assert.ok(out.endsWith("…") && !out.endsWith("，…"), out);
  assert.ok(one.startsWith(out.slice(0, -1)));
  const decimals = "The value is 3.14 and the other is 2.72 so the ratio stays near one point one five or so in all of the cases we checked here today";
  assert.ok(!clipExcerpt(decimals, 50).includes("3.…"));
  assert.ok(clipExcerpt("x".repeat(500), 100).endsWith("…"));
});

test("搜索命中在被截掉的后半段时，从命中那一句开始截，命中的词看得见", () => {
  const sentences = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 句是普通的内容，没有什么特别。`);
  sentences[10] = "这一句里有关键的蜂鸣器，必须看得见。";
  const text = sentences.join("");
  assert.ok(!clipExcerpt(text, 80).includes("蜂鸣器"));
  const out = clipExcerpt(text, 80, "蜂鸣器");
  assert.ok(out.startsWith("…") && out.includes("蜂鸣器"), out);
});

test("笔记卡的摘录走 clipExcerpt、搜索命中的底色够深（亮暗都看得出）", async () => {
  const card = await read("components/me/note-card.tsx");
  assert.match(card, /clipExcerpt\(zhTypography\(plainExcerpt\(note\.original_text\)\), 220, query\)/);
  assert.match(await read("components/me/marked.tsx"), /bg-primary\/60/);
});

// --- 课程卡与新建课程 ---

test("「更多操作」按钮的名字只写「更多操作」，课名用 aria-describedby 关联；整卡链接覆盖标题", async () => {
  const card = await read("components/learn/course-card.tsx");
  assert.match(card, /aria-label=\{t\("dashboard\.card\.moreLabel"\)\}/);
  assert.match(card, /aria-describedby=\{nameId\}/);
  assert.match(card, /id=\{nameId\}/);
  assert.match(card, /after:absolute after:inset-0/);
  assert.equal(get(zh, "learn.dashboard.card.moreLabel"), "更多操作");
  assert.equal(get(en, "learn.dashboard.card.moreLabel"), "More actions");
});

test("新建课程里没有「AI 解析并发」，接口也不再带 parse_concurrency", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.doesNotMatch(dialog, /concurrency|<select/i);
  assert.doesNotMatch(await read("lib/learn/api.ts"), /parse_concurrency|parseConcurrency/);
  for (const messages of [zh, en]) assert.equal(get(messages, "learn.dashboard.form.concurrency"), undefined);
});

test("建课方式说明聚焦功能，不带费用提示，同时保留选项卡布局", async () => {
  const dialog=await read("components/learn/new-course-dialog.tsx");
  assert.doesNotMatch(dialog,/handoutPrice|materialChunk|estimateTotal/);
  for(const messages of [zh,en]) {
    assert.doesNotMatch(messages.learn.dashboard.form.modeTopicDesc,/Token|token/);
    assert.doesNotMatch(messages.learn.dashboard.form.depthNote,/Token|token/);
  }
  assert.match(dialog,/text-sm font-semibold/);
  assert.doesNotMatch(dialog,/modeCost|credits\.tokenCost/);
});

// --- 设置 ---

test("显示名称的说明写真正出现的地方（顶栏的「我的」入口和手机抽屉、用户中心侧栏、问候语），不再提已经没有的邀请页", async () => {
  assert.match(zh.me.settings.nickname_hint, /顶栏、用户中心的侧栏和问候语/);
  assert.match(en.me.settings.nickname_hint, /header, the user center sidebar and greeting/);
  assert.doesNotMatch(zh.me.settings.nickname_hint + en.me.settings.nickname_hint, /邀请|invite/i);
  for (const file of ["components/site/header/me-link.tsx", "components/site/header/mobile-menu.tsx", "components/me/nav.tsx"]) {
    assert.match(await read(file), /nickname/, file);
  }
});

// --- 统计格的说明收进「i」；点击区 ≥ 40px ---

test("「已读课文」的长说明走 info（收进 i 图标），短补充仍写在名字下面；不再提项目课", async () => {
  const strip = await read("components/learn/stat-strip.tsx");
  assert.match(strip, /info\?: string;/);
  assert.match(strip, /\{item\.info && <StatHint hint=\{item\.info\} \/>\}/);
  assert.match(strip, /max-sm:\[&:last-child:nth-child\(odd\)\]:col-span-2/);
  const hint = await read("components/learn/stat-hint.tsx");
  assert.match(hint, /onClick=\{\(\) => setOpen\(true\)\}/);
  assert.match(hint, /size-10/);
  assert.match(hint, /aria-label=\{hint\}/);
});

test("「展开全文」「回到课文」「查看完整记录」「关闭提示」「课文」按钮的点击区都 ≥ 40px，版面不变", async () => {
  assert.match(await read("components/me/note-card.tsx"), /-mb-2\.5 mt-0\.5 inline-flex items-center gap-1 rounded-sm py-2\.5/);
  assert.match(await read("components/me/note-card.tsx"), /-my-2\.5 inline-flex shrink-0 items-center gap-1 py-2\.5/);
  assert.match(await read("components/me/page-head.tsx"), /-my-2\.5 inline-flex items-center py-2\.5/);
  assert.match(await read("components/learn/ask-hint.tsx"), /-my-2 -mr-1 flex size-10/);
});

// --- 同一个热力图窗口 ---

test("概览的小热力图和学习记录的足迹用同一个窗口（26 周，手机 13 周）", async () => {
  const { HEAT_WEEKS, HEAT_WEEKS_PHONE } = await import("../src/components/me/use-heat-weeks.ts");
  assert.deepEqual([HEAT_WEEKS, HEAT_WEEKS_PHONE], [26, 13]);
  for (const file of ["components/me/mini-heatmap.tsx", "components/me/activity-view.tsx"]) assert.match(await read(file), /useHeatWeeks\(\)/, file);
});


test("侧栏里当前篇也显示「已反馈」，保存后立刻补上", async () => {
  const nav = await read("components/learn/lesson-nav.tsx");
  assert.match(nav, /l\.has_feedback && t\("common\.feedbackDone"\)/);
  assert.match(await read("components/learn/lesson.tsx"), /l\.number === currentNum && feedbackSaved && !l\.has_feedback \? \{ \.\.\.l, has_feedback: true \}/);
});

test("学过的课在前、按最近学习排序（精确时间的排在同一天里最前），没学过的按创建时间在后", async () => {
  const { studiedByCourse, orderCourses } = await import("../src/lib/learn/course-order.ts");
  const courses = [
    { id: 1, created_at: "2026-10-10T00:00:00Z" },
    { id: 2, created_at: "2026-10-11T00:00:00Z" },
    { id: 3, created_at: "2026-10-12T00:00:00Z" },
    { id: 4, created_at: "2026-10-13T00:00:00Z" },
  ];
  const calendar = {
    days: [
      { date: "2026-10-12", courses: [{ course_id: 1 }] },
      { date: "2026-10-14", courses: [{ course_id: 2 }, { course_id: 3 }] },
    ],
  };
  const studied = studiedByCourse(calendar, { course_id: 3, opened_at: "2026-10-14T09:00:00" });
  assert.equal(studied.get(3).exact, true);
  assert.equal(studied.get(2).exact, false);
  assert.deepEqual(orderCourses(courses, studied).map((c) => c.id), [3, 2, 1, 4]);
  // 没有日历（取不到）：全按创建时间
  assert.deepEqual(orderCourses(courses, studiedByCourse(null, null)).map((c) => c.id), [4, 3, 2, 1]);
  assert.equal(get(zh, "learn.dashboard.card.lastStudied"), "最近学习 {time}");
});

test("课文取到之后才记「打开」，从笔记深链接（?annotation=）打开的和找不到的都不记", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const effect = lesson.slice(lesson.indexOf("const opened = (l: Lesson) =>"), lesson.indexOf("window.scrollTo(0, 0);"));
  assert.match(effect, /if \(!viaDeepLink\.current\) \{\s*recordLessonOpened\(courseId, lessonNum\)/);
  // 只在拿到课文之后记：服务端带来的直接记，自己取的在 then 里记（不是并行发出），取不到的不记
  assert.match(effect, /if \(start\) \{\s*opened\(start\.lesson\);/);
  assert.match(effect, /\.then\(\(l\) => \{ if \(active\) opened\(l\); \}\)/);
  assert.doesNotMatch(effect.slice(effect.lastIndexOf(".catch((err) =>")), /opened\(|recordLessonOpened/);
  assert.match(lesson, /viaDeepLink\.current = annotationId !== undefined;/);
});


test("推荐全收藏后的空状态", async () => {
  const panel = await read("components/learn/recommendation-panel.tsx");
  assert.match(panel, /\) : savedRecommendations\.length > 0 \? \(/);
  assert.equal(get(zh, "learn.recs.allSaved"), "推荐都在待学清单里了");
  assert.doesNotMatch(get(zh, "learn.recs.subtitle") + get(en, "learn.recs.subtitle"), /3|three|三/);
});

test("浏览器标题统一「页面名 | Bloom」——课程、大纲、课文页取到数据后设", async () => {
  assert.match(await read("components/learn/course.tsx"), /<DocumentTitle title=\{`\$\{course\.name\} \| Bloom`\} \/>/);
  assert.match(await read("components/learn/syllabus.tsx"), /<DocumentTitle title=\{`\$\{t\("syllabus\.crumb"\)\} · \$\{course\.name\} \| Bloom`\} \/>/);
  assert.match(await read("components/learn/lesson.tsx"), /<DocumentTitle title=\{`\$\{tabTitle\} \| Bloom`\} \/>/);
  assert.equal(get(zh, "learn.lesson.tabTitle"), "第 {number} 篇：{title}");
  assert.equal(get(en, "learn.lesson.tabTitle"), "Lesson {number}: {title}");
  assert.match(await read("app/[locale]/(default)/learn/layout.tsx"), /title: `\$\{t\("title"\)\} \| Bloom`/);
  assert.equal(get(zh, "learn.title"), "学习");
});

test("日期只有两种写法——今年「10月15日」、别的年份带年份；学习区的 formatDay 和用户中心同一个；大纲进度表的 ISO 日期显示时换掉", async () => {
  const { formatDay } = await import("../src/lib/learn/time.ts");
  const now = new Date("2026-10-15T12:00:00");
  assert.equal(formatDay("2026-10-14T10:00:00", "en", now), "Oct 14");
  assert.equal(formatDay("2025-10-14T10:00:00", "en", now), "Oct 14, 2025");
  assert.match(formatDay("2025-10-14T10:00:00", "zh", now), /^2025年10月14日$/);
  assert.match(formatDay("2026-10-14T10:00:00", "zh", now), /^10月14日$/);
  const { prepareSyllabus } = await import("../src/lib/learn/syllabus.ts");
  const out = prepareSyllabus("## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|---|---|---|\n| 第 1 篇 | 甲 | 2026-10-15 |\n", {
    formatDate: (y, m, d) => `${m}月${d}日`,
  }).content;
  assert.match(out, /\| 课文 \| 覆盖掌握项 \| 生成日期 \|/);
  assert.match(out, /\| 第 1 篇 \| 甲 \| 10月15日 \|/);
  assert.doesNotMatch(out, /2026-10-15/);
});


test("概览里的卡片不再顶端对齐（items-start）；设置页纯文字的值不再多一截内边距", async () => {
  assert.doesNotMatch(await read("app/[locale]/(default)/me/page.tsx"), /grid items-start gap-6 xl:/);
  const settings = await read("components/me/settings-panels.tsx");
  assert.doesNotMatch(settings, /<p className="py-2 text-sm/);
});

test("手机课程页进度压成一行、大纲页课文目录进抽屉、学习进度表窄屏变卡片", async () => {
  const course = await read("components/learn/course.tsx");
  assert.match(course, /function ProgressStrip/);
  assert.match(course, /lg:hidden"/);
  assert.match(course, /learn-rail mb-8 max-lg:hidden/);
  const syllabus = await read("components/learn/syllabus.tsx");
  assert.match(syllabus, /actions=\{<><TextSizeMenu \/><ChaptersButton onClick=\{\(\) => setShowNav\(true\)\} expanded=\{showNav\} \/><\/>\}/);
  assert.match(syllabus, /<ChapterDrawer/);
  assert.match(syllabus, /learn-rail max-lg:hidden/);
  const css = await read("app/learn.css");
  assert.match(css, /@media \(max-width: 639px\) \{\s*\.syllabus-prose \.lesson-table\.progress-cards \{/);
  const { rehypeProgressCards } = await import("../src/lib/learn/rehype-lesson.ts");
  const tree = { type: "root", children: [
    { type: "element", tagName: "h2", children: [{ type: "text", value: "学习进度" }] },
    { type: "element", tagName: "div", properties: { className: ["lesson-table"] }, children: [] },
    { type: "element", tagName: "h2", children: [{ type: "text", value: "别的" }] },
    { type: "element", tagName: "div", properties: { className: ["lesson-table"] }, children: [] },
  ] };
  rehypeProgressCards()(tree);
  assert.deepEqual(tree.children[1].properties.className, ["lesson-table", "progress-cards"]);
  assert.deepEqual(tree.children[3].properties.className, ["lesson-table"]);
});

test("标签条渐隐 48px（默认 24px，由 --fade-size 控制）", async () => {
  assert.match(await read("components/me/nav.tsx"), /\[--fade-size:3rem\]/);
  assert.match(await read("app/learn.css"), /--fade-start: var\(--fade-size, 1\.5rem\);/);
});

test("问答卡片打开时右栏的课文目录收成一行（CollapsedNav），卡片离它至少 56px；Esc 只收起列表", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /<CollapsedNav \{\.\.\.navProps\} \/>/);
  assert.match(lesson, /minTop: 56,/);
  const nav = await read("components/learn/lesson-nav.tsx");
  assert.match(nav, /export function CollapsedNav/);
  assert.match(nav, /event\.key === "Escape" && open/);
  assert.match(nav, /event\.stopPropagation\(\)/);
});

test("小标签标题用 <p role=heading aria-level=2>，不被中文标题字距为 0 的规则盖掉", async () => {
  for (const file of ["components/learn/annotation-panel.tsx", "components/learn/lesson-feedback.tsx"]) {
    const text = await read(file);
    assert.match(text, /<p role="heading" aria-level=\{2\} className=\{cn\(LABEL_CLASS/, file);
    assert.doesNotMatch(text, /<h2 className=\{cn\(LABEL_CLASS/, file);
  }
  assert.match(await readFile(join(root, "app/globals.css"), "utf8"), /:is\(h1, h2, h3, h4\):lang\(zh\) \{\s*letter-spacing: 0;/);
});

test("站内换页回到页面顶部（改语言、锚点、后退不算）", async () => {
  const layout = await read("app/[locale]/(default)/layout.tsx");
  assert.match(layout, /<ScrollToTop \/>/);
  const scroll = await read("components/scroll-to-top.tsx");
  assert.match(scroll, /usePathname\(\)/);
  assert.match(scroll, /@\/i18n\/navigation/);
  assert.match(scroll, /addEventListener\("popstate", mark\)/);
  assert.match(scroll, /window\.location\.hash \|\| window\.scrollY === 0/);
  assert.match(scroll, /behavior: "instant"/);
});

test("思考题小节标题加 lesson-thoughts、末尾补说明（只补一次，在下一个二级标题之前）", async () => {
  const { rehypeThoughtQuestions } = await import("../src/lib/learn/rehype-lesson.ts");
  const h = (tag, text) => ({ type: "element", tagName: tag, children: [{ type: "text", value: text }] });
  const tree = { type: "root", children: [h("h2", "正文内容"), h("p", "a"), h("h2", "思考题"), h("ol", "1"), { type: "text", value: "\n" }, h("h2", "上一篇思考题参考答案"), h("p", "b")] };
  rehypeThoughtQuestions({ note: "参考答案在下一篇" })(tree);
  const names = tree.children.map((n) => n.tagName ?? "#text");
  assert.deepEqual(names, ["h2", "p", "h2", "ol", "#text", "p", "#text", "h2", "p"]);
  assert.deepEqual(tree.children[2].properties.className, ["lesson-thoughts"]);
  assert.deepEqual(tree.children[5].properties.className, ["lesson-note"]);
  assert.equal(tree.children[5].children[0].value, "参考答案在下一篇");
  // 英文标题；没有思考题小节就什么都不加
  const en = { type: "root", children: [h("h2", "Reflection questions"), h("p", "q")] };
  rehypeThoughtQuestions({ note: "x" })(en);
  assert.equal(en.children.length, 4); // 补进一个换行文本节点和说明段落
  assert.deepEqual(en.children[3].properties.className, ["lesson-note"]);
  const none = { type: "root", children: [h("h2", "别的"), h("p", "q")] };
  rehypeThoughtQuestions({ note: "x" })(none);
  assert.equal(none.children.length, 2);
  assert.match(get(zh, "learn.lesson.thoughtsNote"), /参考答案会写在下一篇的末尾/);
});

test("内圆角和外层同心：分段控件（外层 rounded-md + 1px 边 + 2px 内边距）里的按钮用 calc(var(--radius-md) - 3px)，跟着圆角令牌走，不写死 7px", async () => {
  for (const file of ["components/me/settings-panels.tsx", "components/me/notes-browser.tsx"]) {
    const text = await read(file);
    assert.match(text, /rounded-\[calc\(var\(--radius-md\)-3px\)\]/, file);
    assert.doesNotMatch(text, /rounded-\[7px\]/, file);
  }
});



test("生成中和未确认状态只说在生成、大概多久；没收到应答的说尚未确认，不提金额", async () => {
  const card=await read("components/learn/generating-courses.tsx");
  assert.match(card,/item\.unconfirmed/);
  assert.match(card,/t\("unconfirmed", \{ expect \}\)/);
  assert.doesNotMatch(card,/item\.cost|chargedFrom|chargedUnknown|reserved/);
  assert.match(get(zh,"learn.generating.unconfirmed"),/尚未确认/);
  assert.match(get(en,"learn.generating.unconfirmed"),/isn’t confirmed yet/);
  const dialog=await read("components/learn/new-course-dialog.tsx");
  // 记录里不再带金额：onStart 只交课名和类型
  assert.doesNotMatch(dialog,/const price|costFrom/);
  assert.match(dialog,/onUnconfirmed\(pendingId, report\(err\)\);/);
  assert.match(card,/item\.unconfirmed && item\.reason/);
});

test("记录里的 unconfirmed / reason / knownReady 读写不丢，字段不对的只丢这个字段", () => {
  const good = { id: "a", name: "x", kind: "materials", startedAt: T0, known: [1], unconfirmed: true, reason: "超时", knownReady: false };
  assert.deepEqual(pend.parsePending(JSON.stringify([good]), T0 + 1000), [good]);
  const plain = pend.parsePending(JSON.stringify([{ ...good, unconfirmed: 1, reason: 3, knownReady: true }]), T0 + 1000)[0];
  assert.equal("unconfirmed" in plain || "reason" in plain || "knownReady" in plain, false);
});

test("列表没加载完就提交的记录（knownReady: false）先不认领，等列表加载完按「一分钟之前就有的课程」补出 known", () => {
  const early = item({ id: "e", name: "", kind: "source", known: [], knownReady: false });
  // 列表里有一门提交前 10 分钟就在的课：它不是这次生成的
  const old = course(5, "老课", T0 - 10 * 60_000);
  const first = pend.settlePending([early], [old], T0 + 5000);
  assert.equal(first.settled.length, 0);
  assert.deepEqual(first.remaining[0].known, [5]);
  assert.equal(first.remaining[0].knownReady, true);
  // 补好之后新出现的课才会被认领
  const second = pend.settlePending(first.remaining, [old, course(6, "新", T0 + 20_000)], T0 + 30_000);
  assert.deepEqual(second.settled.map((s) => s.courseId), [6]);
  // 一分钟之内创建的课不会被当成「早就有」：留着让它被认领
  assert.equal(pend.settlePending([early], [course(7, "刚建的", T0 - 30_000)], T0 + 5000).settled.length, 1);
});

test("「等得有点久」之后每 60 秒查一次、最多再查 30 分钟，之后停；在生成时每 5 秒；没有记录不查", () => {
  const run = item({ startedAt: T0 });
  assert.equal(pend.pollIntervalMs([], T0), null);
  assert.equal(pend.pollIntervalMs([run], T0 + 10_000), 5_000);
  assert.equal(pend.pollIntervalMs([run], T0 + 10 * 60_000), 60_000);
  assert.equal(pend.pollIntervalMs([run], T0 + 10 * 60_000 + 29 * 60_000), 60_000);
  assert.equal(pend.pollIntervalMs([run], T0 + 10 * 60_000 + 30 * 60_000), null);
  // 资料课从 15 分钟起算
  assert.equal(pend.pollIntervalMs([item({ kind: "materials" })], T0 + 12 * 60_000), 5_000);
  assert.equal(pend.pollIntervalMs([item({ kind: "materials" })], T0 + 15 * 60_000 + 29 * 60_000), 60_000);
  // 还有一条在生成的：照 5 秒
  assert.equal(pend.pollIntervalMs([run, item({ id: "b", startedAt: T0 + 11 * 60_000 })], T0 + 11 * 60_000 + 1000), 5_000);
});

test("Dashboard 按 pollIntervalMs 轮询，课程列表加载完才记 knownReady", async () => {
  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /const every = pollIntervalMs\(pendingRef\.current\.current\(\)\);/);
  assert.match(dashboard, /knownReady: listLoaded\.current/);
  assert.match(dashboard, /if \(pendingId\) pendingRef\.current\.patch\(pendingId, \{ unconfirmed: true, reason \}\);/);
  assert.match(await read("components/learn/next.tsx"), /knownReady: courseIdsLoaded\.current/);
});

test("弯引号方向反了、直引号和弯引号混着配对、直引号个数是奇数——这一格的双引号都不转；同一格里别的对也不转", () => {
  for (const bad of ["他说”好”", "他说“好“", '他说"好”', "他说“好”，又说”不好”", '他说"好', '他说"好"，他又说"不']) {
    assert.equal(zhTypography(bad), bad, bad);
  }
  // 配对正常的照转；一格里出现问题只影响这一格（按行判断）
  assert.equal(zhTypography("他说“好”\n他说”坏”"), "他说「好」\n他说”坏”");
  // 结尾漏写收尾的 “（流式写到一半）方向是对的，照转
  assert.equal(zhTypography("他说“你好"), "他说「你好");
  // 嵌套的弯引号、直引号里套弯引号都算对
  assert.equal(zhTypography("他说“她说“好”吗”"), "他说「她说『好』吗」");
  assert.equal(zhTypography('他说"她说“好”吗"'), "他说「她说『好』吗」");
});

test("划线定位的折叠把嵌套单引号 ‘ ’ 也折回去（旧划线带 ‘’，现在渲染成『』）", () => {
  const root = { textContent: "他说「她说『好的』」。" };
  const found = locateOffsets(root, { original_text: "她说‘好的’", position_start: 3, position_end: 8 });
  assert.ok(found && root.textContent.slice(found[0], found[1]) === "她说『好的』", String(found));
});

test("收起的目录按钮不用 aria-haspopup，开着时用 aria-controls 指向列表", async () => {
  const nav = await read("components/learn/lesson-nav.tsx");
  const collapsed = nav.slice(nav.indexOf("export function CollapsedNav"), nav.indexOf("// 桌面右侧栏里的章节导航"));
  assert.doesNotMatch(collapsed, /aria-haspopup/);
  assert.match(collapsed, /aria-controls=\{open \? listId : undefined\}/);
  assert.match(collapsed, /id=\{listId\}/);
});

test("收起的目录行吸顶，卡片放在目录行下面的内层容器里（吸附线让出目录行的高度，页面在最顶时最大高度再扣一截）", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  // 目录行展开时在这一组里原位展开，--panel-offset 由 useLayoutEffect 量这一组的高度设上（不再是固定的 3.5rem）
  assert.match(lesson, /ref=\{navGroupRef\}\s+className="sticky top-\[calc\(var\(--header-height\)\+var\(--rail-offset,0px\)\+1rem\)\] z-30 mb-3 hidden lg:mt-10 lg:block"/);
  assert.match(lesson, /"--panel-top": `\$\{panelTop\}px`, "--panel-slack": "1\.5rem"/);
  assert.match(lesson, /area\.style\.setProperty\("--panel-offset", `\$\{Math\.round\(group\.getBoundingClientRect\(\)\.height\) \+ 12\}px`\)/);
  assert.match(lesson, /<div className="lg:flex-1">\s*\{\/\* 占位/);
  assert.doesNotMatch(lesson, /absolute inset-x-0 top-10 z-30/);
  assert.match(lesson, /lg:h-\[calc\(var\(--panel-top\)-6rem\)\]/);
});

