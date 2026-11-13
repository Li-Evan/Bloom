import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "next-intl";

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);

const notes = await import("../src/lib/me/notes.ts");
const activity = await import("../src/lib/me/activity.ts");
const { timeFormatOptions } = await import("../src/lib/me/time-style.ts");

const CJK = /[一-鿿]/;
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();
const tags = (text) => [...new Set([...text.matchAll(/<(\w+)>/g)].map((m) => m[1]))].sort();
function leaves(node, prefix = "") {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]
  );
}

// ── 文案 ──

for (const ns of ["me"]) {
  test(`${ns} 命名空间：en 与 zh 键集、占位符、标签一致，非空，en 不含中文，是合法的 ICU 消息`, () => {
    const enLeaves = new Map(leaves(en[ns]));
    const zhLeaves = new Map(leaves(zh[ns]));
    assert.deepEqual([...enLeaves.keys()].sort(), [...zhLeaves.keys()].sort());
    for (const [key, text] of enLeaves) {
      assert.ok(typeof text === "string" && text.length > 0, `en ${key}`);
      assert.doesNotMatch(text, CJK, `en ${key} 含中文`);
      const zhText = zhLeaves.get(key);
      assert.ok(zhText.length > 0, `zh ${key}`);
      assert.deepEqual(placeholders(text), placeholders(zhText), key);
      assert.deepEqual(tags(text), tags(zhText), `${key} 的标签`);
    }
    for (const [locale, messages] of [["en", en], ["zh", zh]]) {
      const errors = [];
      const t = createTranslator({ locale, messages, namespace: ns, onError: (e) => errors.push(e) });
      for (const [key, text] of locale === "en" ? enLeaves : zhLeaves) {
        const values = Object.fromEntries(
          [...placeholders(text), ...tags(text)].map((name) => [name, tags(text).includes(name) ? (c) => c : name === "count" ? 2 : "x"])
        );
        assert.ok(String(t.rich(key, values)).length > 0, `${locale} ${key}`);
      }
      assert.deepEqual(errors.map((e) => e.message), [], locale);
    }
  });
}

test("中文界面的用户中心文案里没有英文单词作为界面文字（品牌名、AI、GitHub、Google 除外）", () => {
  // Markdown 是导出的文件格式名，界面上就叫这个；Outfit、Public Sans 是字体名（设置 → 字体）
  const allowed = /Bloom|GitHub|Google|Markdown|Outfit|Public Sans|\bAI\b/g;
  for (const [key, text] of leaves(zh.me)) {
    const stripped = text.replace(/\{[^}]*\}|<[^>]*>/g, "").replace(allowed, "");
    assert.doesNotMatch(stripped, /[A-Za-z]{2,}/, `${key}: ${text}`);
  }
});

test("旧的控制台命名空间已删除，没有残留的 NOT SET 之类英文占位", () => {
  for (const messages of [en, zh]) {
    for (const key of ["my_orders", "my_credits", "my_invites", "invite_landing"]) {
      assert.equal(messages[key], undefined, key);
    }
    assert.equal(messages.user?.my_orders, undefined);
    assert.equal(messages.user?.user_center, undefined);
  }
});

// ── 路由 ──

const PAGES = ["", "activity", "notes", "teaching", "settings"];
const pagePath = (dir) => `app/[locale]/(default)/me/${dir}${dir ? "/" : ""}page.tsx`;

test("用户中心的 5 个页面都存在，旧的 (console) 页面、console 组件、个人中心页都已删除", async () => {
  for (const dir of PAGES) await access(join(root, pagePath(dir)));
  for (const gone of [
    "app/[locale]/(default)/(console)",
    "components/console",
    "components/invite",
    "components/billing",
    "components/learn/profile.tsx",
    "app/[locale]/(default)/learn/profile",
  ]) {
    await assert.rejects(access(join(root, gone)), gone);
  }
});

test("用户中心布局声明 noindex、动态渲染，导航的每一项都对应一个页面", async () => {
  const layout = await read("app/[locale]/(default)/me/layout.tsx");
  assert.match(layout, /robots:\s*{\s*index:\s*false/);
  assert.match(layout, /dynamic = "force-dynamic"/);

  const nav = await read("components/me/nav.tsx");
  const hrefs = [...nav.matchAll(/href: "(\/me[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.sort(), ["/me", "/me/activity", "/me/notes", "/me/settings", "/me/teaching"]);
  for (const href of hrefs) {
    const dir = href.replace(/^\/me\/?/, "");
    await access(join(root, pagePath(dir)));
    assert.equal(typeof en.me.nav[dir || "overview"], "string", href);
  }
});

// ── 设置：改昵称 ──

test("改昵称：PATCH /api/me，成功后更新全站共用的用户资料（顶栏的名字与头像首字读它），并刷新服务端渲染的内容", async () => {
  const api = await read("lib/me/api.ts");
  assert.match(api, /"\/api\/me", \{ method: "PATCH", json: \{ nickname \}/);
  const panels = await read("components/me/settings-panels.tsx");
  // 提交的是去掉看不见的字符和首尾空白之后的昵称（lib/me/nickname.ts，和后端同一套规则）
  assert.match(panels, /saveNickname\(cleaned\)/);
  assert.match(panels, /setUser\(\(prev/);
  assert.match(panels, /router\.refresh\(\)/);
  // 顶栏的「我的」入口和手机抽屉的头像首字读的就是 AppContext 里的 user
  for (const file of ["components/site/header/me-link.tsx", "components/site/header/mobile-menu.tsx"]) {
    const source = await read(file);
    assert.match(source, /const \{ user \} = useAppContext\(\)/, file);
    assert.match(source, /user\?\.nickname/, file);
  }
});

// ── 配色与可访问性 ──

async function files(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("用户中心的页面与组件只用语义令牌：没有 stone/emerald/gray 色阶、十六进制色、white/black", async () => {
  const targets = [...(await files("components/me")), ...(await files("app/[locale]/(default)/me")), ...(await files("lib/me"))];
  for (const file of targets) {
    const text = (await read(file)).replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(text, /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:stone|emerald|zinc|gray|slate|neutral|amber|rose|red|green)-\d/, file);
    assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/, file);
    assert.doesNotMatch(text, /\b(?:bg|text|border)-(?:white|black)\b/, file);
  }
});

test("图标按钮都有本地化的 aria-label，没有写死的中文或英文界面文字", async () => {
  for (const file of await files("components/me")) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.deepEqual([...text.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g)].map((m) => m[1]), [], file);
    assert.doesNotMatch(text, /aria-label="[^"{]*[一-鿿A-Za-z]/, `${file} 有写死的 aria-label`);
  }
});

// ── 纯函数 ──

const note = (over) => ({
  id: 1, course_id: 1, course_name: "间隔重复", lesson_number: 1, lesson_title: "01 · 记忆曲线",
  original_text: "遗忘曲线", question: "什么是遗忘曲线？", answer_preview: "遗忘曲线描述记忆衰减。", message_count: 2,
  created_at: "2026-10-14T08:00:00Z", updated_at: "2026-10-14T08:00:00Z", ...over,
});

test("笔记：课文标题和学习区共用 lessonTitle 去编号前缀（不误伤标题本身），摘录压成一段干净的文字", async () => {
  const { lessonTitle } = await import("../src/lib/learn/lessons.ts");
  assert.equal(lessonTitle("01 · 为什么阳性不等于有病"), "为什么阳性不等于有病");
  assert.equal(lessonTitle("2. Compound interest"), "Compound interest");
  assert.equal(lessonTitle("三个习惯"), "三个习惯");
  assert.equal(lessonTitle(""), "");
  // 旧的 cleanLessonTitle 会误伤这些、又认不出这些
  for (const keep of ["1-on-1 辅导怎么做", "3:2 的赔率是什么意思", "1.5 倍速的代价", "10 ways to remember"]) {
    assert.equal(lessonTitle(keep), keep, keep);
  }
  assert.equal(lessonTitle("第 2 篇：复利的力量"), "复利的力量");
  assert.equal(lessonTitle("Lesson 2: Compound interest"), "Compound interest");
  // 笔记页、导出、搜索、继续学习卡都走它，不再有第二份去编号的写法
  // 搜索、导出用不带排版的 lessonTitle；显示的地方用 displayLessonTitle（再做中文排版，和课文里的 H1 一致）
  for (const file of ["lib/me/notes.ts", "lib/me/export.ts"]) {
    const text = await read(file);
    assert.match(text, /lessonTitle/, file);
    assert.doesNotMatch(text, /cleanLessonTitle|displayLessonTitle/, file);
  }
  for (const file of ["components/me/note-card.tsx", "components/me/continue-card.tsx"]) {
    const text = await read(file);
    assert.match(text, /displayLessonTitle/, file);
    assert.doesNotMatch(text, /cleanLessonTitle/, file);
  }
  assert.equal(notes.plainExcerpt("**我们常混淆**“原因”\n\n- A = “患者有病”，  B"), "我们常混淆“原因” A = “患者有病”， B");
  assert.equal(notes.plainExcerpt("前文 ```py\nx=1\n``` 后文"), "前文 后文");
});

test("笔记：搜索看摘录、提问、回答、课程名、课文标题（不分大小写），按课程筛选，两者可叠加", () => {
  const list = [
    note({ id: 1 }),
    note({ id: 2, course_id: 2, course_name: "Bayes", question: "Why does the prior matter?", original_text: "prior", answer_preview: "", lesson_title: "01 · Priors" }),
    note({ id: 3, course_id: 2, course_name: "Bayes", question: "另一个问题", original_text: "后验", answer_preview: "", lesson_title: "x" }),
  ];
  const ids = (query, course = null) => notes.filterNotes(list, query, course).map((n) => n.id);
  assert.deepEqual(ids(""), [1, 2, 3]);
  assert.deepEqual(ids("遗忘"), [1]);
  assert.deepEqual(ids("PRIOR"), [2]);
  assert.deepEqual(ids("bayes"), [2, 3]);
  assert.deepEqual(ids("", 2), [2, 3]);
  assert.deepEqual(ids("问题", 2), [3]);
  assert.deepEqual(ids("问题", 1), []);
  assert.deepEqual(ids("   "), [1, 2, 3]);
});

test("笔记：按课程分组保持时间顺序，课程列表带条数；高亮片段把命中的部分切出来", () => {
  const list = [note({ id: 1, course_id: 2, course_name: "B" }), note({ id: 2, course_id: 1, course_name: "A" }), note({ id: 3, course_id: 2, course_name: "B" })];
  assert.deepEqual(notes.groupByCourse(list).map((g) => [g.courseId, g.notes.map((n) => n.id)]), [[2, [1, 3]], [1, [2]]]);
  assert.deepEqual(notes.noteCourses(list), [{ id: 2, name: "B", count: 2 }, { id: 1, name: "A", count: 1 }]);
  assert.deepEqual(notes.splitMatches("What is the Prior? prior!", "prior"), [
    { text: "What is the ", hit: false }, { text: "Prior", hit: true }, { text: "? ", hit: false }, { text: "prior", hit: true }, { text: "!", hit: false },
  ]);
  assert.deepEqual(notes.splitMatches("abc", ""), [{ text: "abc", hit: false }]);
  assert.deepEqual(notes.splitMatches("abc", "x"), [{ text: "abc", hit: false }]);
});

test("追问次数：消息里提问和回答各一条，一问一答是 2 条（没有追问）", () => {
  assert.equal(notes.followUps(0), 0);
  assert.equal(notes.followUps(2), 0);
  assert.equal(notes.followUps(4), 1);
  assert.equal(notes.followUps(6), 2);
  assert.equal(notes.followUps(3), 0);
});

test("学习强度、月历、热力图：强度分档，月历周一开头，热力图最后一列是今天所在的那一周", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7, 8, 100].map(activity.level), [0, 1, 1, 2, 2, 3, 4, 4]);
  assert.equal(activity.dateKey(2026, 9, 4), "2026-10-04");
  // 2026-10-01 是周四：前面补 3 个空格
  const cells = activity.monthCells(2026, 9);
  assert.deepEqual(cells.slice(0, 4), [null, null, null, 1]);
  assert.equal(cells.length, 3 + 31);

  const today = new Date(2026, 9, 14); // 周三
  const weeks = activity.heatWeeks(today, 12);
  assert.equal(weeks.length, 12);
  assert.ok(weeks.every((w) => w.length === 7));
  const last = weeks[11];
  assert.equal(last[0].key, "2026-10-12"); // 周一
  assert.equal(last[2].key, "2026-10-14");
  assert.deepEqual(last.map((c) => c.future), [false, false, false, true, true, true, true]);
  assert.equal(weeks[0][0].key, "2026-07-27"); // 11 周前的周一
  // 跨年也对
  assert.equal(activity.heatWeeks(new Date(2026, 0, 3), 2)[0][0].key, "2025-12-22");
});

test("问候按本地小时分五档：5–11 早上，11–13 中午，13–18 下午，18–23 晚上，其余夜深了", () => {
  assert.deepEqual([0, 2, 4, 5, 10, 11, 12, 13, 17, 18, 22, 23].map(activity.dayPart), [
    "night", "night", "night", "morning", "morning", "noon", "noon", "afternoon", "afternoon", "evening", "evening", "night",
  ]);
  // 每一档两种语言都有文案，夜里的那句不是「晚上好」
  for (const part of ["morning", "noon", "afternoon", "evening", "night"]) {
    assert.equal(typeof en.me.overview[`greeting_${part}`], "string", part);
    assert.equal(typeof zh.me.overview[`greeting_${part}`], "string", part);
  }
  assert.equal(zh.me.overview.greeting_night, "{name}，夜深了");
  assert.match(en.me.overview.greeting_night, /midnight oil/);
});

// ── 收尾轮：用户中心的小问题 ──

test("时间：今年内不带年份，别的年份带上年份（日期、日期加时间两种写法，date / full 两个别名也一样）", () => {
  const now = new Date("2026-10-15T08:00:00Z");
  const format = (locale, style, iso) =>
    new Intl.DateTimeFormat(locale, timeFormatOptions(style, iso, { now, timeZone: "UTC" })).format(new Date(iso));
  assert.equal(format("en", "day", "2026-10-14T08:00:00Z"), "Oct 14");
  assert.equal(format("en", "day", "2025-10-14T08:00:00Z"), "Oct 14, 2025");
  assert.match(format("zh", "day", "2025-10-14T08:00:00Z"), /2025年10月14日/);
  assert.doesNotMatch(format("zh", "day", "2026-10-14T08:00:00Z"), /2026/);
  assert.match(format("en", "datetime", "2025-12-31T23:30:00Z"), /2025/);
  assert.doesNotMatch(format("en", "datetime", "2026-01-01T00:30:00Z"), /2026/);
  // date / full 是 day / datetime 的别名：同样今年内不带年份、别的年份带上
  assert.equal(format("en", "date", "2026-10-14T08:00:00Z"), "Oct 14");
  assert.equal(format("en", "date", "2027-10-14T08:00:00Z"), "Oct 14, 2027");
  assert.match(format("zh", "full", "2026-10-14T08:00:00Z"), /^10月14日 ?08:00$/);
  assert.match(format("zh", "full", "2025-10-14T08:00:00Z"), /^2025年10月14日 ?08:00$/);
  // 按显示用的时区比较年份：UTC 的 12 月 31 日在东八区已经是明年
  const tokyo = (iso) => new Intl.DateTimeFormat("en", timeFormatOptions("day", iso, { now: new Date("2027-01-01T00:30:00+08:00"), timeZone: "Asia/Shanghai" })).format(new Date(iso));
  assert.equal(tokyo("2026-12-31T20:00:00Z"), "Jan 1");
  assert.equal(tokyo("2026-12-31T10:00:00Z"), "Dec 31, 2026");
});

test("笔记搜索：看得见的字才算命中（课文标题的编号前缀不算），命中课程名和课文标题时界面里也高亮", async () => {
  const list = [note({ id: 1, lesson_title: "01 · 记忆曲线" }), note({ id: 2, lesson_title: "02 · 间隔重复的原理", question: "q", original_text: "o", answer_preview: "a", course_name: "x" })];
  assert.deepEqual(notes.filterNotes(list, "01", null).map((n) => n.id), []);
  assert.deepEqual(notes.filterNotes(list, "记忆曲线", null).map((n) => n.id), [1]);
  assert.deepEqual(notes.filterNotes(list, "原理", null).map((n) => n.id), [2]);

  const card = await read("components/me/note-card.tsx");
  assert.match(card, /<Marked text=\{note\.course_name\} query=\{query\} \/>/);
  assert.match(card, /<Marked text=\{title\} query=\{query\} \/>/);
  const browser = await read("components/me/notes-browser.tsx");
  assert.match(browser, /<Marked text=\{group\.courseName\} query=\{query\} \/>/);
});

test("笔记计数：还没载入完（或超过 1000 条的载入上限）时，搜索结果说清楚只覆盖最近已载入的这些", async () => {
  const browser = await read("components/me/notes-browser.tsx");
  assert.match(browser, /notes\.length < initial\.total[\s\S]*?t\("count_filtered_partial", \{ shown: filtered\.length, loaded: notes\.length, total: initial\.total \}\)/);
  const t = (locale, messages, values) => createTranslator({ locale, messages, namespace: "me.notes" })("count_filtered_partial", values);
  assert.equal(t("zh", zh, { shown: 3, loaded: 1000, total: 1234 }), "在最近的 1,000 条笔记里找到 3 条（共 1,234 条）");
  assert.equal(t("en", en, { shown: 3, loaded: 1000, total: 1234 }), "Found 3 in your latest 1,000 notes (1,234 in all)");
});

test("/api/me 取不到（自动重试用完）：昵称框给「重试」入口，不一直停在骨架屏", async () => {
  const retry = await read("components/me/profile-retry.tsx");
  assert.match(retry, /reloadUser\(\)/);
  assert.match(retry, /role="alert"/);
  const panels = await read("components/me/settings-panels.tsx");
  assert.match(panels, /!user && userLoadFailed && <ProfileRetry/);
});

test("概览里的「新建课程」直接打开新建对话框（/learn?new=1）；有课程时仍是「打开我的课程」", async () => {
  const card = await read("components/me/continue-card.tsx");
  assert.match(card, /href=\{hasCourses \? "\/learn" : "\/learn\?new=1"\}/);
  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /searchParams\.get\("new"\)/);
});

test("没有遗留指向旧个人中心的文案或链接：learn.profile 命名空间已删，英文界面里「个人中心」的叫法统一为用户中心", () => {
  for (const messages of [en, zh]) assert.equal(messages.learn.profile, undefined);
  assert.doesNotMatch(JSON.stringify(zh), /个人中心/);
  assert.doesNotMatch(JSON.stringify(en), /personal center|my profile/i);
});
