import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";

// 学习区和用户中心的回归保护：404 页面、中文排版、提问气泡、大纲进度表、标题体系、昵称规则等。

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const backend = (path) => readFile(new URL(`../../backend/app/${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);
const get = (messages, dotted) => dotted.split(".").reduce((node, key) => node?.[key], messages);

const { zhTypography, prepareMarkdown } = await import("../src/lib/learn/lesson-text.ts");
const { locateOffsets } = await import("../src/lib/learn/highlight.ts");
const { prepareSyllabus } = await import("../src/lib/learn/syllabus.ts");
const { continueLesson } = await import("../src/lib/learn/lessons.ts");
const { languagesFor } = await import("../src/lib/learn/language.ts");
const markdownConfig = await import("../src/lib/learn/markdown-config.ts");
const bubble = await import("../src/lib/learn/bubble.ts");
const chunks = await import("../src/lib/learn/material-chunks.ts");
const { cleanNickname, nicknameProblem, nicknameProblemFromDetail, MAX_NICKNAME } = await import("../src/lib/me/nickname.ts");
const { request, BackendUnreachableError } = await import("../src/lib/api-common.ts");

async function walk(dir, pattern = /\.tsx?$/) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(path, pattern)));
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

function render(text, { lesson = false, streaming = false, source = false, title, typography = false } = {}) {
  const { remarkPlugins, rehypePlugins, lessonRehypePlugins, sourceLessonRehypePlugins, streamingLessonRehypePlugins } = markdownConfig;
  const plugins = lesson
    ? source
      ? sourceLessonRehypePlugins(title)
      : streaming
        ? streamingLessonRehypePlugins
        : lessonRehypePlugins
    : rehypePlugins;

  // 中文段落的 data-script="cjk"（rehypeScriptBlocks）另有测试，这里比对结构时去掉
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins, rehypePlugins: plugins },
      prepareMarkdown(text, { hideFeedback: lesson, hideBody: lesson, streaming, typography })
    )
  ).replaceAll(' data-script="cjk"', "");
}

// 去掉标签看文字（标题里的中文按词包了不换行的 span，元信息的键和值分在两个 span 里）
const textOf = (html) => html.replace(/<[^>]+>/g, "").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

// 新文案两种语言都有，中文用全角标点（句子里不留半角的 , . ; : ! ? ( )）
const NEW_KEYS = [
  "learn.status.eyebrow", "learn.status.courseNotFoundTitle", "learn.status.courseNotFoundText",
  "learn.status.lessonNotFoundTitle", "learn.status.lessonNotFoundText", "learn.status.toCourses",
  "learn.status.toCourse", "learn.status.toHome", "learn.status.errorEyebrow", "learn.status.courseErrorTitle",
  "learn.status.lessonErrorTitle", "learn.status.errorText", "learn.status.retry",
  "learn.lesson.hint.label", "learn.lesson.hint.mouse", "learn.lesson.hint.touch", "learn.lesson.hint.dismiss",
  "learn.syllabus.progressEmpty", "learn.dashboard.eyebrow", "learn.recs.eyebrow", "learn.course.eyebrow",
  "learn.dashboard.stats.lessonsReadHint",
  "learn.dashboard.form.estimateReading", "learn.dashboard.form.estimateReady", "learn.dashboard.form.estimatePdf",
  "learn.dashboard.form.estimateUnreadable", "learn.dashboard.form.estimateEmpty", "learn.dashboard.form.chunkNote",
  "me.settings.nickname_needs_letter",
];

test("这组新增的文案：中英都有；中文句子里不留半角标点（引号、冒号、逗号、句号、问号、括号）", () => {
  for (const key of NEW_KEYS) {
    const zhText = get(zh, key);
    const enText = get(en, key);
    assert.equal(typeof zhText, "string", `zh 缺 ${key}`);
    assert.equal(typeof enText, "string", `en 缺 ${key}`);
    // 占位符一致（ICU 的 {count, plural, …} 只比名字）
    const names = (text) => [...new Set([...text.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();
    assert.deepEqual(names(zhText), names(enText), key);
    assert.doesNotMatch(zhText.replace(/\{[^}]*\}/g, ""), /[,;:!?()]|\.(?!\d)|"/, `${key}：中文里有半角标点`);
  }
});

// ── 课程 / 课文不存在 ──

test("课程、课文、大纲打不开时整页复用 404 的品牌版面（StatusView）；404 和其它失败分开；课文页打不开时有页脚", async () => {
  const status = await read("components/learn/status-page.tsx");
  assert.match(status, /<StatusView/);
  assert.match(status, /export const isNotFound = \(err: unknown\) => err instanceof ApiError && err\.status === 404/);
  assert.match(status, /const title = t\(notFound \? `\$\{kind\}NotFoundTitle` : `\$\{kind\}ErrorTitle`\);/);
  // 主按钮回我的课程，次按钮回课程（课文）或首页；其它失败有「重试」
  assert.match(status, /<Link href="\/learn">\{t\("toCourses"\)\}<\/Link>/);
  assert.match(status, /window\.location\.reload\(\)/);
  assert.doesNotMatch(status, /text-destructive|role="alert"/);

  for (const file of ["components/learn/course.tsx", "components/learn/syllabus.tsx", "components/learn/lesson.tsx"]) {
    const text = await read(file);
    assert.match(text, /<LearnStatus kind="(?:course|lesson)" notFound=\{notFound\}/, file);
    assert.match(text, /setNotFound\(isNotFound\(err\)\)/, file);
    assert.doesNotMatch(text, /className="text-sm text-destructive"|<p role="alert" className="text-destructive">/, `${file}：不再是裸红字`);
  }
});

// ── 中文排版 ──

test("成对的直引号换成「」，汉字后的半角冒号换成全角（含加粗标签），整段英文原样不动", () => {
  assert.equal(zhTypography('为什么"凭感觉调间距"迟早会崩'), "为什么「凭感觉调间距」迟早会崩");
  assert.equal(zhTypography("难度: 入门\n预计阅读时间: 7 分钟"), "难度：入门\n预计阅读时间：7 分钟");
  assert.equal(zhTypography("**难度**: 入门 · **前置知识**: 会做乘方"), "**难度**：入门 · **前置知识**：会做乘方");
  assert.equal(zhTypography("概念二: D 是对角的"), "概念二：D 是对角的");
  // 整段英文不动（英文课、英文例句）；数字、时间、网址里的冒号不动
  for (const keep of ['He said "hello": nice, 12:30', "Note: this is English.", "时间 12:30 开始", "网址 https://example.com/a:b 里的冒号", "std::vector 里的冒号"]) {
    assert.equal(zhTypography(keep), keep, keep);
  }
  // 中文段落里夹着的英文句子，引号照中文排
  assert.equal(zhTypography('他说 "I think so"，然后走了'), "他说 「I think so」，然后走了");
  // 幂等
  const once = zhTypography('这是"一句"话: 好');
  assert.equal(zhTypography(once), once);
});

test("引号不成对的段落整段不动（宁可不改也不改错），按段落算，一段的问题不连累下一段", () => {
  assert.equal(zhTypography('他说"你好'), '他说"你好');
  assert.equal(zhTypography('第一段"你好"。\n\n第二段只有一个"引号\n\n第三段"成"对'), '第一段「你好」。\n\n第二段只有一个"引号\n\n第三段「成」对');
  // 转义的引号不算
  assert.equal(zhTypography('这是\\"转义\\"的和"正常"的'), '这是\\"转义\\"的和「正常」的');
});

test("代码（围栏、缩进、行内）、公式、链接地址和标题、HTML 标签、裸网址里的引号和冒号都不动", () => {
  assert.equal(zhTypography('```py\nprint("x")  # 注释: 你好\n```\n\n之后"中文"：正常'), '```py\nprint("x")  # 注释: 你好\n```\n\n之后「中文」：正常');
  assert.equal(zhTypography('用 `print("hi")` 打印，"可复制"'), '用 `print("hi")` 打印，「可复制」');
  assert.equal(zhTypography('$a = "b"$ 里的公式，"引号"'), '$a = "b"$ 里的公式，「引号」');
  assert.equal(zhTypography('$$\nx = "y"\n$$\n\n公式后"引号"'), '$$\nx = "y"\n$$\n\n公式后「引号」');
  assert.equal(zhTypography('[文档](http://x.com/a "标题") 和 "引用" 一起'), '[文档](http://x.com/a "标题") 和 「引用」 一起');
  assert.equal(zhTypography('![图](a.png "图注") 中文"引"'), '![图](a.png "图注") 中文「引」');
  assert.equal(zhTypography('<span title="x">中文</span> 里 "引号"'), '<span title="x">中文</span> 里 「引号」');
  assert.equal(zhTypography('网址 https://example.com/a:b?x="1" 之后"引"'), '网址 https://example.com/a:b?x="1" 之后「引」');
  // 前面紧跟「标识符 + ( 或 =」的引号当代码
  assert.equal(zhTypography('用 print("hello") 打印，以及"成对"的'), '用 print("hello") 打印，以及「成对」的');
});

test("走完整的渲染流程——课文、元信息、公式里的美元金额；不开 typography 的原样不变", async () => {
  const source = '# 为什么"凭感觉"会崩\n\n> 难度: 入门\n> 预计阅读时间: 7 分钟\n\n成本是 $5 和 $10，"便宜"。公式 \\(x = 1\\) 之后："好"';
  const html = render(source, { lesson: true, typography: true });
  assert.match(textOf(html), /为什么「凭感觉」会崩/);
  assert.match(html, /<span class="lesson-meta-key">难度：<\/span>/);
  assert.match(html, /「便宜」/);
  assert.match(html, /katex/);
  assert.match(html, /\$5/);
  // 默认不处理
  assert.match(textOf(render(source, { lesson: true })), /"凭感觉"/);
  // 每个会渲染课文 / 问答 / 大纲 / 笔记的地方都开了
  for (const [file, pattern] of Object.entries({
    "lib/learn/outline.ts": /return \{ lesson: !isProject, source: isSourceLesson && !isProject, typography: !isSourceLesson,/,
    "components/learn/lesson.tsx": /<Markdown \{\.\.\.markdownOptions\} sectionIds /,
    "components/learn/annotation-panel.tsx": /<Markdown typography>\{m\.content\}/,
    "components/learn/syllabus.tsx": /<Markdown typography>/,
    "components/learn/course.tsx": /<Markdown typography>\{summary\.content\}/,
    "components/me/note-card.tsx": /<Markdown typography>\{message\.content\}/,
  })) assert.match(await read(file), pattern, file);
  assert.match(await read("components/me/note-card.tsx"), /zhTypography\(plainExcerpt\(note\.original_text\)\)/);
});

test("旧划线存的是直引号 / 半角冒号的原文，课文渲染成弯引号 / 全角冒号之后仍然能找到位置", () => {
  const rendered = "为什么“凭感觉”会崩。难度：入门，之后";
  const root = { textContent: rendered };
  const at = (text, start = 0) => locateOffsets(root, { original_text: text, position_start: start, position_end: start + text.length });
  // 新写法：精确匹配
  assert.deepEqual(at("“凭感觉”会崩"), [3, 3 + "“凭感觉”会崩".length]);
  // 旧写法：直引号折叠后匹配，位置一对一
  assert.deepEqual(at('"凭感觉"会崩'), [3, 3 + '"凭感觉"会崩'.length]);
  // 冒号后的空格渲染时被去掉了：旧原文「难度: 入门」折叠后对上「难度：入门」
  const old = at("难度: 入门");
  assert.equal(rendered.slice(old[0], old[1]), "难度：入门");
  // 找不到仍然回退到存档的位置
  assert.deepEqual(locateOffsets(root, { original_text: "完全不在课文里", position_start: 2, position_end: 6 }), [2, 6]);
});

// ── 提问气泡与提示 ──

test("划词气泡紧挨着选中的字：默认在选区第一行正上方，被顶栏挡住时放最后一行正下方；不再放页边、不再推开段落；PDF 同一套", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /import \{ type BubblePlacement, type Box, placeBubble \} from "@\/lib\/learn\/bubble"/);
  // 第一行 / 最后一行按真正选到字的文本节点量：三击选段、跨段选区的 Range 常结束在「下一块的开头」
  assert.match(lesson, /function edgeLine\(range: Range, edge: "first" \| "last"\): Box \| null/);
  assert.match(lesson, /head: edgeLine\(range, "first"\) \?\? rect,\s*tail: edgeLine\(range, "last"\) \?\? rect,/);
  // 两种位置只差小三角朝哪边
  assert.match(lesson, /data-bubble=\{marker\.bubble\.mode\}/);
  assert.match(lesson, /marker\.bubble\.mode === "above" \? "before:-bottom-1" : "before:-top-1"/);
  // 小三角按 --arrow 对准选中的字，但夹在气泡两头的圆角以内
  assert.match(lesson, /"--arrow": `\$\{marker\.bubble\.arrow\}px`/);
  assert.match(lesson, /before:left-\[clamp\(18px,calc\(50%_\+_var\(--arrow\)\),calc\(100%_-_18px\)\)\]/);
  assert.match(lesson, /text-\[13px\] font-medium text-primary-foreground shadow-md/);
  assert.match(lesson, /whitespace-nowrap/);
  // 旧的「不压字」机制都拿掉了：页边竖气泡、临时撑开段落外边距、为了气泡滚页面
  assert.doesNotMatch(lesson, /openSpace|releaseSpacer|spacerRef|aboveScroll|mode: "margin"|mode === "margin"|window\.scrollBy\(\{ top: scroll/);
  assert.doesNotMatch(lesson, /"fixed"|fixed left-1\/2|safe-area-inset-bottom/);
  // PDF：同一个 placeBubble
  assert.match(lesson, /bubble: placeBubble\(\{ head, tail, box, article: articleRect, topSafe: topSafe\(\)/);
  assert.match(await read("components/learn/pdf-viewer.tsx"), /head: lines\[0\] \?\? box,\s*tail: lines\[lines\.length - 1\] \?\? box,/);
});

test("placeBubble：选区第一行正上方、水平居中在被选中的那段上；顶栏挡住就放最后一行正下方；不出正文左右边缘", () => {
  const { placeBubble, BUBBLE_GAP, BUBBLE_HEIGHT } = bubble;
  const article = { left: 100, top: 50, width: 600 };
  const word = { left: 300, right: 340, top: 400, bottom: 420 };
  const base = { head: word, tail: word, box: word, article, topSafe: 80 };
  assert.equal(BUBBLE_GAP, 8);
  assert.equal(BUBBLE_HEIGHT, 32);
  // 一个词：正上方，居中在这个词上
  assert.deepEqual(placeBubble(base), { mode: "above", top: 400 - 8 - 32 - 50, left: 220, arrow: 0 });
  // 上方被顶栏挡住（气泡顶要在 topSafe 以下）：放到正下方
  assert.deepEqual(placeBubble({ ...base, topSafe: 361 }), { mode: "below", top: 420 + 8 - 50, left: 220, arrow: 0 });
  assert.equal(placeBubble({ ...base, topSafe: 360 }).mode, "above");
  // 跨行：上方居中在第一行被选的部分（选区起点到行尾），下方居中在最后一行被选的部分（行首到选区终点）
  const head = { left: 500, right: 690, top: 400, bottom: 420 };
  const tail = { left: 110, right: 210, top: 460, bottom: 480 };
  const box = { left: 110, right: 690, top: 400, bottom: 480 };
  assert.deepEqual(placeBubble({ ...base, head, tail, box }), { mode: "above", top: 310, left: 495, arrow: 0 });
  assert.deepEqual(placeBubble({ ...base, head, tail, box, topSafe: 400 }), { mode: "below", top: 438, left: 60, arrow: 0 });
  // 贴着正文左右边缘的词：气泡不出正文（两边至少留半个气泡宽；有「翻译」时更宽），往里挪了多少，小三角就往回偏多少，仍对准这个词
  const left = { left: 100, right: 120, top: 400, bottom: 420 };
  assert.deepEqual(placeBubble({ ...base, head: left, tail: left, box: left }), { mode: "above", top: 310, left: 48, arrow: 10 - 48 });
  assert.equal(placeBubble({ ...base, head: left, tail: left, box: left, halfWidth: 80 }).left, 80);
  const right = { left: 680, right: 700, top: 400, bottom: 420 };
  assert.deepEqual(placeBubble({ ...base, head: right, tail: right, box: right }), { mode: "above", top: 310, left: 600 - 48, arrow: 590 - 552 });
});

test("第一次读课文时正文上方有一条可关闭的提示，关掉后记在 localStorage（读写失败不报错），水合前不渲染；触屏说长按", async () => {
  const hint = await read("components/learn/ask-hint.tsx");
  assert.match(hint, /export const ASK_HINT_KEY = "bloom:hint:ask-dismissed"/);
  assert.match(hint, /try \{\s*if \(localStorage\.getItem\(ASK_HINT_KEY\)\) return;\s*\} catch/);
  assert.match(hint, /try \{\s*localStorage\.setItem\(ASK_HINT_KEY, "1"\);\s*\} catch/);
  assert.match(hint, /useState<"hidden" \| "mouse" \| "touch">\("hidden"\)/);
  assert.match(hint, /matchMedia\("\(pointer: coarse\)"\)/);
  assert.match(hint, /aria-label=\{t\("dismiss"\)\}/);
  const lesson = await read("components/learn/lesson.tsx");
  const article = lesson.search(/<article\s+ref=\{contentRef\}/);
  assert.ok(lesson.indexOf("<AskHint />") > lesson.indexOf("{showSourceNext &&") && lesson.indexOf("<AskHint />") < article);
  assert.match(get(zh, "learn.lesson.hint.mouse"), /选中.*「提问」/);
  assert.match(get(zh, "learn.lesson.hint.touch"), /长按/);
  assert.match(get(en, "learn.lesson.hint.mouse"), /Select.*“Ask”/);
});

// ── 新建课程里的分块估算 ──

test("前端的资料份数上限和后端 courses.py 一致", async () => {
  const py = await backend("courses.py");
  const num = (name) => Number(py.match(new RegExp(`^${name}\\s*=\\s*([\\d_]+)`, "m"))[1].replaceAll("_", ""));
  assert.equal(chunks.MATERIAL_MAX_FILES, num("MATERIAL_MAX_FILES"));
});

test("「没有文字」按 Python 的空白定义判断（后端对这样的文件直接拒绝）", () => {
  assert.equal(chunks.isBlankText(" \n\t\n"), true);
  assert.equal(chunks.isBlankText("\u3000 \n"), true);
  assert.equal(chunks.isBlankText("\ufeff"), false); // Python 的 strip 不去 BOM，BOM 算一个字符
});

test("死代码已删：前端不再估算资料分块数，也不再在浏览器里切分资料（只校验读不读得出、有没有字）", () => {
  for (const name of ["estimateChunks", "countChunks", "pastedSection", "markdownSections", "handoutChunks", "chunkSizeLabel", "MATERIAL_LABELS"]) assert.equal(chunks[name], undefined, name);
});

test("文件字节按后端的顺序解码（UTF-8 严格并保留 BOM，再 GB18030，都不行是 null）", () => {
  const bytes = (...values) => new Uint8Array(values).buffer;
  assert.equal(chunks.decodeMaterialBytes(new TextEncoder().encode("# 标题").buffer), "# 标题");
  assert.equal(chunks.decodeMaterialBytes(bytes(0xef, 0xbb, 0xbf, 0x41)), "\ufeffA");
  assert.equal(chunks.decodeMaterialBytes(bytes(0xb1, 0xea, 0xcc, 0xe2)), "标题"); // GBK
  assert.equal(chunks.decodeMaterialBytes(bytes(0xff, 0xff, 0xff)), null);
});

test("主题和资料是同一个入口（资料只作参考，可传 PDF / TXT / Markdown）、「分块」讲清楚；PDF 估不了就如实说", async () => {
  assert.equal(get(zh, "learn.dashboard.form.modeTopic"), "主题或资料");
  assert.match(get(zh, "learn.dashboard.form.modeTopicDesc"), /直接拖入资料/);
  assert.equal(get(en, "learn.dashboard.form.modeTopic"), "Topic or materials");
  assert.match(get(zh, "learn.dashboard.form.dropReference"), /TXT/);
  assert.match(get(en, "learn.dashboard.form.dropReference"), /TXT/);
  const { isReferenceFile } = await import("../src/lib/learn/files.ts");
  for (const name of ["a.pdf", "b.TXT", "c.md", "d.markdown"]) assert.ok(isReferenceFile(new File(["x"], name)), name);
  assert.equal(isReferenceFile(new File(["x"], "e.docx")), false);
  assert.match(get(zh, "learn.dashboard.form.chunkNote"), /重点和来源/);
  assert.match(get(zh,"learn.dashboard.form.estimatePdf"),/能选中.*扫描/);
  const dialog=await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog,/useMaterialEstimate\(referenceFiles, open\)/);
  assert.doesNotMatch(dialog,/estimateTotal|handoutPrice|materialBase|materialChunk/);
  assert.match(dialog,/slice\(0, MATERIAL_MAX_FILES\)/);
  const hook = await read("components/learn/use-material-estimate.ts");
  assert.match(hook, /files\.some\(\(file\) => \/\\\.pdf\$\/i\.test\(file\.name\)\)/);
  assert.match(hook, /setEstimate\(\{ state: "pdf" \}\)/);
  assert.match(hook, /decodeMaterialBytes\(await file\.arrayBuffer\(\)\)/);
  // PDF 不在浏览器里读
  assert.doesNotMatch(hook, /pdfjs|getDocument/);
  // 读过的文件只留「读得出 / 有没有字」的结果（不留全文），增删文件时不重读
  assert.match(hook, /checked\.current\.has\(fileKey\(file\)\)/);
  assert.match(hook, /new Map<string, Checked>\(\)/);
  assert.match(hook, /type Checked = "ok" \| "empty" \| "unreadable";/);
});

test("资料预读：只得出「读得出 / 有字」，不留全文；浏览器读不了文件时进入 failed 并说出是哪个文件，不会一直停在 reading", async () => {
  const { checkMaterialFile } = await import("../src/components/learn/use-material-estimate.ts");
  const file = (bytes) => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer });
  assert.equal(await checkMaterialFile(file([...new TextEncoder().encode("# 标题\n正文")])), "ok");
  assert.equal(await checkMaterialFile(file([0x20, 0x0a, 0x09])), "empty");
  assert.equal(await checkMaterialFile(file([0xff, 0xff, 0xff])), "unreadable");
  const failure = new DOMException("The requested file could not be read", "NotReadableError");
  await assert.rejects(checkMaterialFile({ arrayBuffer: async () => { throw failure; } }), (err) => err === failure);

  const hook = await read("components/learn/use-material-estimate.ts");
  assert.match(hook, /\} catch \{[\s\S]*?setEstimate\(\{ state: "failed", file: file\.name \}\);\s*return;/);
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /estimate\.state === "failed" \? t\("dashboard\.form\.estimateFailed", \{ name: estimate\.file \}\)/);
  for (const messages of [zh, en]) assert.match(get(messages, "learn.dashboard.form.estimateFailed"), /\{name\}/);
});

// ── 对话框高度 ──

test("新建课程对话框桌面上高度固定，切换开始方式不上下跳", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /className="flex flex-col gap-0 overflow-hidden p-0 sm:h-\[46rem\] sm:max-w-2xl/);
});

// ── 原文篇标题、流式预览 ──

const SOURCE_LESSON = "# 原文 · my-notes\n\n> 字数：约 180 字\n> 预计阅读时间：约 1 分钟\n\n## 原文\n\n# 资料自己的标题\n\n## 资料里的小节\n\n正文";

test("原文篇的页面标题用课程名（不是文件名），「原文 / Original text」二级标题变成小标签；资料自己的小节不受影响", () => {
  const html = render(SOURCE_LESSON, { lesson: true, source: true, title: "我的系统思考笔记" });
  assert.match(html, /<h1>/);
  assert.equal(textOf(html.match(/<h1>[\s\S]*?<\/h1>/)[0]), "我的系统思考笔记");
  assert.doesNotMatch(html, /原文 · my-notes/);
  assert.match(html, /<p class="lesson-label">原文<\/p>/);
  assert.match(html, /<h2>(?:<span class="nw">)?资料[\s\S]*?<\/h2>/);
  assert.equal([...html.matchAll(/<h2>/g)].length, 1);
  assert.match(html, /lesson-meta/);
  // 英文
  const english = render("# Your material · notes\n\n> Length: about 180 words\n\n## Original text\n\nBody", { lesson: true, source: true, title: "Thinking in Systems" });
  assert.match(english, /<p class="lesson-label">Original text<\/p>/);
  assert.equal(textOf(english.match(/<h1>[\s\S]*?<\/h1>/)[0]), "Thinking in Systems");
  // 还没取到课程名：标题不动，小标签照做
  const noTitle = render(SOURCE_LESSON, { lesson: true, source: true });
  assert.match(textOf(noTitle), /原文 · my-notes/);
  // 只换第一个二级标题，而且文字整个就是「原文」
  const later = render("# T\n\n## 别的小节\n\n## 原文\n\n正文", { lesson: true, source: true, title: "X" });
  assert.doesNotMatch(later, /lesson-label/);
});

test("小标签的样式在 learn.css 里：13px 等宽、文字绿；原文篇页面带课程名给 Markdown", async () => {
  const css = await read("app/learn.css");
  assert.match(css, /\.prose-lesson \.lesson-label \{[^}]*font-family: var\(--font-mono\);[^}]*font-size: calc\(0\.8125rem \* var\(--text-scale\)\);[^}]*color: var\(--primary-text\)/s);
  assert.match(await read("components/learn/lesson.tsx"), /title=\{course\?\.name\}/);
});

test("生成下一篇的流式预览不显示阅读时间（边写边估的数字以完成后为准），写完的课文照常显示", () => {
  const draft = "# 复利（二）\n\n> 前置知识: 复利公式\n> 难度: 入门\n> 预计阅读时间: 18 分钟\n\n## 回顾\n\n正文";
  const streaming = render(draft, { lesson: true, streaming: true, typography: true });
  assert.doesNotMatch(streaming, /阅读时间|18 分钟/);
  assert.match(textOf(streaming), /前置知识：复利公式/);
  assert.match(textOf(streaming), /难度：入门/);
  const finished = render(draft, { lesson: true, typography: true });
  assert.match(textOf(finished), /预计阅读时间：18 分钟/);
  // 元信息只剩阅读时间时，整个引用块拿掉
  assert.doesNotMatch(render("# 标题\n\n> 预计阅读时间: 18 分钟\n\n正文", { lesson: true, streaming: true }), /blockquote|lesson-meta|阅读时间/);
  assert.match(
    render("# Lesson 2\n\n> Estimated reading time: 18 min\n> Difficulty: easy\n\nBody", { lesson: true, streaming: true }),
    /Difficulty/
  );
  assert.doesNotMatch(render("# Lesson 2\n\n> Estimated reading time: 18 min\n> Difficulty: easy\n\nBody", { lesson: true, streaming: true }), /reading time/i);
});

// ── 口径 ──

test("学习记录日历写「打开了 N 篇」，和「已读完」区分；三处「已读课文」统计都加一句小字说明读完才算", async () => {
  assert.match(get(zh, "me.activity.day_summary"), /打开了/);
  assert.match(get(zh, "me.activity.day_tooltip"), /打开了/);
  assert.match(get(zh, "me.activity.lesson_count"), /打开/);
  assert.match(get(en, "me.activity.day_summary"), /opened/);
  assert.match(get(en, "me.activity.day_tooltip"), /opened/);
  assert.match(get(en, "me.activity.lesson_count"), /opened/);
  // 说法和真实的按钮一致：读完后点「我读完了，生成下一篇」；不提用户没用过的项目课
  assert.match(get(zh, "learn.dashboard.stats.lessonsReadHint"), /「我读完了，生成下一篇」/);
  assert.doesNotMatch(get(zh, "learn.dashboard.stats.lessonsReadHint"), /项目课|标记已读/);
  assert.equal(get(zh, "learn.lesson.next.finished"), "我读完了，生成下一篇");
  assert.match(get(zh, "learn.lesson.markRead"), /标记已读/);
  assert.match(get(en, "learn.dashboard.stats.lessonsReadHint"), /“Finished reading — generate the next lesson”/);
  assert.doesNotMatch(get(en, "learn.dashboard.stats.lessonsReadHint"), /project/i);
  assert.match(get(en, "learn.lesson.next.finished"), /^Finished reading — generate the next lesson$/);
  assert.match(get(en, "learn.lesson.markRead"), /mark as read/);
  assert.match(await read("components/learn/dashboard.tsx"), /info: t\("dashboard\.stats\.lessonsReadHint"\)/);
  assert.match(await read("components/me/activity-stats.tsx"), /info: tStats\("lessonsReadHint"\)/);
  assert.match(await read("app/[locale]/(default)/me/page.tsx"), /info: tStats\("lessonsReadHint"\)/);
  // 统计口径本身没动：还是「已读课文」
  assert.equal(get(zh, "me.overview.stat_lessons"), "已读课文");
});

// ── 大纲「学习进度」 ──

const OUTLINE = (rows) =>
  `# 复利 · 课程大纲\n\n## 核心掌握项\n\n- [ ] 解释复利\n\n## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|------|-----------|---------|\n${rows}\n`;
const EMPTY = "生成课文后会记在这里。";

test("学习进度表只有占位行（待生成……）或只有表头时，换成一行空状态；有真实的行就只留真实的行", () => {
  const placeholders = prepareSyllabus(OUTLINE("| 待生成 | 待生成 | 待生成 |\n| 待生成 | 待生成 | 待生成 |\n| 第 3 篇 | 待生成 | — |"), { emptyProgress: EMPTY });
  assert.match(placeholders.content, /## 学习进度\n\n生成课文后会记在这里。$/);
  assert.doesNotMatch(placeholders.content, /待生成|\| 文档|\| 课文/);
  // 只有表头
  assert.match(prepareSyllabus(OUTLINE(""), { emptyProgress: EMPTY }).content, /生成课文后会记在这里。$/);
  // 真实的行 + 占位行：占位行去掉，真实的留下
  const mixed = prepareSyllabus(OUTLINE("| 第 1 篇 | 解释复利 | 2026-10-15 |\n| 第 2 篇 | 待生成 | 待生成 |\n| 第 3 篇 | Pending | TBD |"), { emptyProgress: EMPTY });
  assert.match(mixed.content, /\| 第 1 篇 \| 解释复利 \| 2026-10-15 \|/);
  assert.doesNotMatch(mixed.content, /待生成|Pending|TBD|生成课文后/);
  // 旧课程表头第一格写的是「文档」，显示时按全站的叫法换成「课文」
  assert.match(mixed.content, /\| 课文 \| 覆盖掌握项 \| 生成日期 \|/);
  // 后端追加的真实行：第一篇覆盖项写「—」、日期是真的——是数据，不是占位
  const backendRows = prepareSyllabus(OUTLINE("| 第 1 篇 | — | 2026-10-15 |\n| 第 2 篇 | 能够甲；能够乙 | 2026-10-16 |"), { emptyProgress: EMPTY });
  assert.match(backendRows.content, /\| 第 1 篇 \| — \| 2026-10-15 \|/);
  assert.match(backendRows.content, /\| 第 2 篇 \| 能够甲；能够乙 \| 2026-10-16 \|/);
  assert.doesNotMatch(backendRows.content, /生成课文后/);
  // 英文
  assert.doesNotMatch(prepareSyllabus(OUTLINE("| Lesson 2 | To be generated | To be generated |").replace("学习进度", "Learning progress"), { emptyProgress: "x" }).content, /To be generated/);
  // 不传空状态文字：整节拿掉（保留原来的行为）
  assert.doesNotMatch(prepareSyllabus(OUTLINE("| 待生成 | 待生成 | 待生成 |")).content, /学习进度/);
  // 掌握项照常数
  assert.deepEqual([placeholders.mastered, placeholders.total], [0, 1]);
});

test("「覆盖的掌握项」一格很长时渲染成能换行的表格，窄屏放在可横向滚动的容器里；日期列不折断", async () => {
  const long = "解释单利与复利的区别；识别本金、利率、年限三个输入；".repeat(8);
  const outline = prepareSyllabus(OUTLINE(`| 第 1 篇 | ${long} | 2026-10-15 |`), { emptyProgress: EMPTY }).content;
  const html = render(outline);
  assert.match(html, /<div class="lesson-table progress-cards">\s*<table>/);
  // 覆盖要点一格是列表（一条一行），不再是一长串
  assert.match(html, /<ul class="progress-items"><li>解释单利与复利的区别<\/li><li>识别本金、利率、年限三个输入<\/li>/);
  const css = await read("app/learn.css");
  assert.match(css, /\.syllabus-prose \.lesson-table td:last-child,\s*\.syllabus-prose \.lesson-table th:last-child \{\s*min-width: 8em;/);
  assert.match(css, /\.lesson-table :is\(th, td\) \{\s*min-width: 5em;/);
  assert.match(await read("components/learn/syllabus.tsx"), /prepareSyllabus\(course\?\.syllabus_content, \{\s*emptyProgress: progressEmpty,/);
});

// ── 标题体系 ──

test("卡片标题统一 16/600 放在卡内左上，页面级才用绿色小标签；最近的笔记也包进一张卡，「查看全部」在标题同一行右侧", async () => {
  const head = await read("components/me/page-head.tsx");
  assert.match(head, /export const CARD_TITLE = "text-base font-semibold tracking-tight"/);
  assert.match(head, /\{title && <h2 className=\{CARD_TITLE\}>\{title\}<\/h2>\}/);
  for (const file of ["components/me/continue-card.tsx"]) {
    const text = await read(file);
    assert.match(text, /<h2 className=\{CARD_TITLE\}>/, file);
    assert.doesNotMatch(text, /<Eyebrow/, `${file}：卡片里不再用页面级的小标签`);
  }
  const overview = await read("app/[locale]/(default)/me/page.tsx");
  assert.match(overview, /<Panel\s+title=\{t\("notes_title"\)\}\s+action=\{notes\.total > 0 \?/);
  assert.doesNotMatch(overview, /aria-labelledby="recent-notes"/);
});

test("我的课程、下一步学习、课程页补了页面小标签（学习 / 推荐 / 课程），所有页头的标题到说明都是 8px（共用一个 PageHead）", async () => {
  const head = await read("components/page-head.tsx");
  assert.doesNotMatch(head, /^"use client"/m);
  assert.match(head, /eyebrow && "mt-2"/);
  assert.match(head, /<p className="mt-2 max-w-2xl text-pretty leading-relaxed text-muted-foreground">/);
  // 用户中心的 PageHead 就是它
  assert.match(await read("components/me/page-head.tsx"), /export \{ PageHead \} from "@\/components\/page-head"/);
  assert.doesNotMatch(await read("components/learn/shell.tsx"), /export function PageHeader/);
  assert.match(await read("components/learn/dashboard.tsx"), /eyebrow=\{t\("dashboard\.eyebrow"\)\}/);
  assert.match(await read("components/learn/next.tsx"), /eyebrow=\{t\("recs\.eyebrow"\)\}/);
  const course = await read("components/learn/course.tsx");
  // 课程页的标题和改名按钮排在一行：小标签到标题的 8px 在这一行上
  assert.match(course, /<Eyebrow>\{t\("course\.eyebrow"\)\}<\/Eyebrow>\s*<div className="mt-2 flex items-start gap-1\.5">\s*<h1 className=\{cn\(PAGE_TITLE, "min-w-0 break-words"\)\}>/);
  assert.match(await read("components/learn/syllabus.tsx"), /<h1 className=\{cn\(PAGE_TITLE, "mt-2 break-words"\)\}>/);
  assert.equal(get(zh, "learn.dashboard.eyebrow"), "学习");
  assert.equal(get(zh, "learn.recs.eyebrow"), "推荐");
  assert.equal(get(zh, "learn.course.eyebrow"), "课程");
  // 手机上页头的按钮仍然撑满一行
  assert.match(head, /max-sm:w-full/);
});


test("语言选项的顺序跟着界面语言：中文界面「中文 | English」，英文界面「English | 中文」；新建课程和设置共用", async () => {
  assert.deepEqual(languagesFor("zh"), ["zh", "en"]);
  assert.deepEqual(languagesFor("en"), ["en", "zh"]);
  assert.match(await read("components/learn/new-course-dialog.tsx"), /languagesFor\(locale\)\.map/);
  const settings = await read("components/me/settings-panels.tsx");
  assert.match(settings, /languagesFor\(locale\)/);
  assert.doesNotMatch(settings, /locales\.map/);
});

test("手机用户中心标签条两端还有标签没露出来时，那一端渐隐（默认 24px，标签条 48px），滚到头就消失", async () => {
  const css = await read("app/learn.css");
  assert.match(css, /\.scroll-fade-x\[data-fade-end="true"\] \{\s*--fade-end: var\(--fade-size, 1\.5rem\);/);
  const nav = await read("components/me/nav.tsx");
  assert.match(nav, /\[--fade-size:3rem\]/);
  assert.match(nav, /data-fade-end=\{fade\.end\}/);
  assert.match(nav, /box\.scrollLeft \+ box\.clientWidth < box\.scrollWidth - 4/);
});


test("代码块、块级公式、表格容器横向可滚时，没露出来的那一端渐隐；块级公式外面包一层 .math-scroll", async () => {
  const fade = await read("components/learn/scroll-fade.tsx");
  assert.match(fade, /data-fade-end=\{fade\.end\}/);
  assert.match(fade, /el\.scrollLeft \+ el\.clientWidth < el\.scrollWidth - 4/);
  // 只在挂载时订阅一次（不再依赖 children）；尺寸、内容、滚动三种变化都会重量；值没变不更新状态
  assert.match(fade, /new ResizeObserver\(schedule\)/);
  assert.match(fade, /new MutationObserver\(schedule\)/);
  assert.match(fade, /\}, \[\]\);/);
  assert.doesNotMatch(fade, /\}, \[children\]\)/);
  assert.match(fade, /setFade\(\(prev\) => \(prev\.start === start && prev\.end === end \? prev : \{ start, end \}\)\)/);
  assert.match(fade, /pre: \(\{ node: _node, \.\.\.props \}\) => <FadeScroll as="pre"/);
  assert.match(fade, /\(\?:lesson-table\|math-scroll\)/);
  assert.match(await read("components/learn/markdown.tsx"), /components=\{scrollFadeComponents\}/);

  const html = render("公式如下：\n\n$$\nx^2 + y^2 = z^2\n$$\n\n行内 $a$ 不包。");
  assert.match(html, /<div class="math-scroll"><span class="katex-display">/);
  assert.equal([...html.matchAll(/math-scroll/g)].length, 1);
  for (const config of [markdownConfig.rehypePlugins, markdownConfig.lessonRehypePlugins, markdownConfig.streamingLessonRehypePlugins, markdownConfig.sourceLessonRehypePlugins("x")]) {
    assert.ok(config.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin).name === "rehypeScrollMath"));
  }
  const css = await read("app/learn.css");
  assert.match(css, /\.prose-lesson \.math-scroll,\s*\.prose-compact \.math-scroll \{\s*overflow-x: auto;/);
  assert.match(css, /\.prose-lesson \.scroll-fade-x:focus-visible,\s*\.prose-compact \.scroll-fade-x:focus-visible \{\s*mask-image: none;/);
});


test("问答卡头「划线提问」用共用的 LABEL_CLASS（13px 等宽小标签）；空输入时「提问 / 发送」是明确的禁用态（半透明 + 不可点的光标）", async () => {
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /import \{ LABEL_CLASS \} from "@\/components\/brand\/eyebrow"/);
  // 不用 <h2>：globals.css 把中文标题字距压成 0，会盖掉小标签的字距；role + aria-level 保留标题语义
  assert.match(panel, /<p role="heading" aria-level=\{2\} className=\{cn\(LABEL_CLASS, "text-accent-foreground"\)\}>/);
  assert.doesNotMatch(panel, /<h2 className=\{cn\(LABEL_CLASS/);
  assert.doesNotMatch(panel, /tracking-\[0\.12em\]/);
  const feedback = await read("components/learn/lesson-feedback.tsx");
  assert.match(feedback, /<p role="heading" aria-level=\{2\} className=\{cn\(LABEL_CLASS, "text-accent-foreground"\)\}>/);
  assert.doesNotMatch(feedback, /<h2 className=\{cn\(LABEL_CLASS/);
  assert.doesNotMatch(feedback, /tracking-\[0\.12em\]/);
  assert.match(panel, /const DISABLED_ASK = "disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"/);
  assert.equal([...panel.matchAll(/className=\{DISABLED_ASK\}/g)].length, 3);
});


test("用户中心服务端取数都带超时（后端卡住时不陪着等到平台超时），超时走「连不上后端」的降级（文案如实说是超时）", async () => {
  const server = await read("lib/me/server.ts");
  assert.match(server, /export const ME_FETCH_TIMEOUT_MS = 8000;/);
  assert.match(server, /signal \?\? AbortSignal\.timeout\(ME_FETCH_TIMEOUT_MS\)/);
  for (const file of await walk("app/[locale]/(default)/me", /^page\.tsx$/)) {
    const text = await read(file);
    assert.doesNotMatch(text, /backendFetch/, `${file} 要用 meFetch`);
  }
  const overview = await read("app/[locale]/(default)/me/page.tsx");
  assert.equal([...overview.matchAll(/meFetch</g)].length, 6);
  // 超时的请求：fetch 一直不返回，AbortSignal.timeout 到点把它中止，变成 BackendUnreachableError（页面已有的降级）
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  // AbortSignal.timeout 的定时器不会让进程保持运行，测试里自己留一个，免得事件循环提前结束
  const keepAlive = setInterval(() => {}, 10);
  try {
    await assert.rejects(
      request("http://backend.test/api/me", null, { signal: AbortSignal.timeout(30) }, () => "zh"),
      (error) => error instanceof BackendUnreachableError && /请求超时/.test(error.message)
    );
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = original;
  }
});

test("「继续学习」的目标按编号算（第一篇没读的），不跟着项目课的排序变；和后端 last_lesson 同一条规则", async () => {
  const lesson = (number, read = false) => ({ id: number * 10, number, is_read: read });
  const byNumber = [lesson(1, true), lesson(2), lesson(3)];
  assert.equal(continueLesson(byNumber).number, 2);
  // 传进来的顺序（比如按名称倒序排过）不影响结果
  assert.equal(continueLesson([...byNumber].reverse()).number, 2);
  assert.equal(continueLesson([lesson(3), lesson(1, true), lesson(2)]).number, 2);
  // 全读完：落在编号最后一个
  assert.equal(continueLesson([lesson(2, true), lesson(1, true), lesson(3, true)]).number, 3);
  assert.equal(continueLesson([]), undefined);
  assert.match(await read("components/learn/course.tsx"), /const target = continueLesson\(listed\);/);
  assert.match(await backend("courses.py"), /项目课没有「最新一篇」[\s\S]*落点 = 第一个没读的文件/);
});

// ── 昵称 ──

test("昵称先规整再校验（和后端同一套规则，常量和判断顺序读后端源码对照），422 显示本地化的人话，不露后端原文", async () => {
  const py = await backend("schemas.py");
  const set = (name) => [...py.match(new RegExp(`${name} = frozenset\\((?:\\{([^}]*)\\}|"([^"]*)")\\)`)).slice(1).find(Boolean).matchAll(/"(\w+)"|\\\\u([0-9a-f]{4})/g)]
    .map((m) => m[1] ?? String.fromCharCode(parseInt(m[2], 16)));
  const fillers = [...py.match(/_NICKNAME_BLANK_FILLERS = frozenset\("([^"]*)"\)/)[1].matchAll(/\\u([0-9a-f]{4})/g)].map((m) => String.fromCharCode(parseInt(m[1], 16)));
  const joiners = [...py.match(/_NICKNAME_JOINERS = "([^"]*)"/)[1].matchAll(/\\u([0-9a-f]{4})/g)].map((m) => String.fromCharCode(parseInt(m[1], 16)));
  const { NICKNAME_RULES } = await import("../src/lib/me/nickname.ts");
  assert.deepEqual([...NICKNAME_RULES.blankFillers].sort(), fillers.sort());
  assert.deepEqual([...NICKNAME_RULES.joiners].sort(), joiners.sort());
  assert.deepEqual([...NICKNAME_RULES.toSpace].sort(), set("_NICKNAME_TO_SPACE_CATEGORIES").sort());
  assert.deepEqual([...NICKNAME_RULES.dropped].sort(), set("_NICKNAME_DROPPED_CATEGORIES").sort());
  assert.equal(MAX_NICKNAME, Number(py.match(/^MAX_NICKNAME = (\d+)/m)[1]));
  // 判断顺序：先看有没有字母或数字，再看长度；两种错误的 type 就是前端认的那两个
  assert.ok(py.indexOf('"nickname_needs_letter"') < py.indexOf('"nickname_too_long"'));
  assert.match(py, /raise PydanticCustomError\("nickname_needs_letter", "昵称至少要有一个字母或数字"\)/);
  assert.match(py, /unicodedata\.category\(ch\)\[0\] in "LN"/);
  assert.match(py, /re\.sub\(r"\\s\+", " ", text\)\.strip\(\)/);

  // 规整：零宽字符、方向控制符去掉；控制类、行段分隔、填充字符换成空格再合并；ZWJ 只在两个非空白字符之间保留
  assert.equal(cleanNickname("\u200bA\u200dB\u202e C \u2028"), "A\u200dB C");
  assert.equal(cleanNickname("a\nb\tc"), "a b c");
  assert.equal(cleanNickname("\u3164abc\u3164"), "abc");
  assert.equal(cleanNickname("\u200dA\u200d B\u200d"), "A B");
  assert.equal(cleanNickname("\ue000小林\u0007"), "小林");
  assert.equal(cleanNickname("  a   b  "), "a b");
  // 合法
  for (const ok of ["fa1", "小林", "A_1", "a🙂b", "---x---", "Ａ１", "a".repeat(50)]) assert.equal(nicknameProblem(ok), null, ok);
  assert.equal(nicknameProblem(`${"a".repeat(49)}\u200b\u200b\u200b`), null); // 长度按规整之后算
  // 没有字母或数字（包括空的、只有零宽字符 / 空白）
  for (const bad of ["", "   ", "\u200b\u200b", "\u3000", "\u3164", "🙂🙂🙂", "---", "!!!", "（）", "😀 😀"]) assert.equal(nicknameProblem(bad), "needsLetter", JSON.stringify(bad));
  // 太长
  assert.equal(nicknameProblem("a".repeat(51)), "length");

  // 后端 422 的 detail：昵称的两条是自定义错误；认不出的 422 也不露英文原文
  const detail = [{ type: "nickname_needs_letter", loc: ["body", "nickname"], msg: "Value error, 昵称至少要有一个字母或数字" }];
  assert.equal(nicknameProblemFromDetail(detail), "needsLetter");
  assert.equal(nicknameProblemFromDetail([{ type: "nickname_too_long", loc: ["body", "nickname"], msg: "Value error, 昵称最多 50 个字符" }]), "length");
  assert.equal(nicknameProblemFromDetail([{ type: "string_type", loc: ["body", "nickname"], msg: "Input should be a valid string" }]), "length");
  assert.equal(nicknameProblemFromDetail("昵称不合法"), "length");
  assert.equal(nicknameProblemFromDetail(undefined), "length");

  const panel = await read("components/me/settings-panels.tsx");
  assert.match(panel, /e instanceof ApiError && e\.status === 422 \? nicknameMessage\(nicknameProblemFromDetail\(e\.detail\)\) : backendError\(e\)/);
  assert.match(panel, /saveNickname\(cleaned\)/);
  assert.match(get(zh, "me.settings.nickname_needs_letter"), /至少一个字母或数字/);
  assert.match(get(en, "me.settings.nickname_needs_letter"), /at least one letter or number/);
});


test("软 404 页面上不写「404」——小标签是「找不到 / Not found」，document.title 是「找不到这门课程 | Bloom」；源码注释写明这是客户端判定的软 404", async () => {
  assert.equal(get(zh, "learn.status.eyebrow"), "找不到");
  assert.equal(get(en, "learn.status.eyebrow"), "Not found");
  for (const messages of [zh, en]) {
    for (const key of ["eyebrow", "courseNotFoundTitle", "courseNotFoundText", "lessonNotFoundTitle", "lessonNotFoundText"]) {
      assert.doesNotMatch(get(messages, `learn.status.${key}`), /404/, key);
    }
  }
  const status = await read("components/learn/status-page.tsx");
  assert.match(status, /document\.title = `\$\{title\} \| Bloom`;/);
  assert.match(status, /客户端判定的「软 404」/);
});

test("判断「没有文字」是线性扫描，不再有 [空白]+$ 的平方级回溯（10 万空白 < 50ms）", () => {
  const spaces = " ".repeat(100_000);
  const start = performance.now();
  assert.equal(chunks.isBlankText(spaces), true);
  assert.equal(chunks.isBlankText(`${spaces}x${spaces}`), false);
  assert.ok(performance.now() - start < 50);
});

test("中文排版按「一行 / 一个列表项 / 一个表格单元格」判断——英文项里的引号不动；链接引用定义行不动", () => {
  assert.equal(zhTypography('- 中文"甲"\n- He said "no"\n- 英文: "x"'), '- 中文「甲」\n- He said "no"\n- 英文：「x」');
  assert.equal(
    zhTypography('| 名称 | 说明 |\n|---|---|\n| 单利 "a" | He said "b" |\n| 复利: 好 | 中文"c" |'),
    '| 名称 | 说明 |\n|---|---|\n| 单利 「a」 | He said "b" |\n| 复利：好 | 中文「c」 |'
  );
  assert.equal(zhTypography('> 引用中文"甲"\n> English "b"'), '> 引用中文「甲」\n> English "b"');
  // 同一行里有汉字就整行处理（中英混排）
  assert.equal(zhTypography('中文"甲" and English "b"'), "中文「甲」 and English 「b」");
  // 链接引用定义整行不动，别的行照常
  assert.equal(zhTypography('[a]: http://x.com "标题"\n正文"引"\n[b]: <http://y.com> "另一个"'), '[a]: http://x.com "标题"\n正文「引」\n[b]: <http://y.com> "另一个"');
  // 引号跨行配不成对：宁可不改
  assert.equal(zhTypography('第一行 "开始\n第二行结束" 这样的跨行引号'), '第一行 "开始\n第二行结束" 这样的跨行引号');
});

test("原文篇（上传的资料、项目课的文件）是学生自己的文字，不做中文排版；标题在列表、导航、继续卡里和 H1 一样走排版（displayLessonTitle）", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const outline = await read("lib/learn/outline.ts");
  assert.match(outline, /return \{ lesson: !isProject, source: isSourceLesson && !isProject, typography: !isSourceLesson, restoreBold: isSourceLesson \}/);
  assert.match(lesson, /<Markdown \{\.\.\.markdownOptions\} sectionIds title=\{course\?\.name\}>/);
  assert.match(lesson, /quoteTypography: !isSourceLesson/);
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /const quote = props\.quoteTypography === false \? clipped : zhTypography\(clipped\)/);
  // AI 的回答照常排版（不看课文是不是原文篇）
  assert.match(panel, /<Markdown typography>\{m\.content\}/);

  const { displayLessonTitle, lessonTitle } = await import("../src/lib/learn/lessons.ts");
  assert.equal(displayLessonTitle('01 · 为什么"凭感觉"会崩'), "为什么「凭感觉」会崩");
  assert.equal(lessonTitle('01 · 为什么"凭感觉"会崩'), '为什么"凭感觉"会崩'); // 搜索、导出用的不带排版
  assert.equal(displayLessonTitle("1-on-1 tutoring"), "1-on-1 tutoring");
  for (const file of ["components/learn/course.tsx", "components/learn/syllabus.tsx", "components/learn/lesson-nav.tsx", "components/learn/continue-banner.tsx", "components/me/continue-card.tsx", "components/me/note-card.tsx"]) {
    const text = await read(file);
    assert.match(text, /displayLessonTitle\(/, file);
    assert.doesNotMatch(text.replace(/displayLessonTitle/g, ""), /[^A-Za-z]lessonTitle\(/, `${file} 还有没排版的标题`);
  }
});

test("大纲进度表的占位词和后端 _PLACEHOLDER_CELLS 一模一样；窄屏上中间列有最小宽度、整张表横向可滑并有渐隐", async () => {
  const py = await backend("courses.py");
  const set = py.match(/_PLACEHOLDER_CELLS = frozenset\(\{([\s\S]*?)\}\)/)[1];
  const backendWords = [...set.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const { PLACEHOLDER_CELLS } = await import("../src/lib/learn/syllabus.ts");
  assert.deepEqual([...PLACEHOLDER_CELLS].sort(), [...backendWords].sort());
  assert.ok(backendWords.includes("无") && backendWords.includes("to be written"));
  // 后端的判断：只看第一格以外的格子；只有一格的行不算占位行
  assert.match(py, /return len\(cells\) > 1 and all\(cell\.lower\(\) in _PLACEHOLDER_CELLS for cell in cells\[1:\]\)/);
  const outline = (rows) => `# x\n\n## 学习进度\n\n| 文档 | 覆盖掌握项 | 生成日期 |\n|---|---|---|\n${rows}\n`;
  for (const word of backendWords.filter((w) => w)) {
    const content = prepareSyllabus(outline(`| 第 2 篇 | ${word} | ${word.toUpperCase()} |`), { emptyProgress: "空" }).content;
    assert.doesNotMatch(content, /第 2 篇/, `占位词「${word}」`);
  }
  // 后端不认的词（前端以前多加的「暂无」）不再算占位
  assert.match(prepareSyllabus(outline("| 第 2 篇 | 暂无 | 暂无 |"), { emptyProgress: "空" }).content, /第 2 篇/);
  assert.match(prepareSyllabus(outline("| 第 2 篇 | **待生成** | 待生成 |"), { emptyProgress: "空" }).content, /第 2 篇/);
  const css = await read("app/learn.css");
  assert.match(css, /\.syllabus-prose \.lesson-table td:nth-child\(2\),\s*\.syllabus-prose \.lesson-table th:nth-child\(2\) \{\s*min-width: 13em;/);
});

test("估算对话框关闭时清掉读过的文件文本；PDF 估价写真实下限；重试按钮是 flex 按钮；stream.ts 的注释说清心跳", async () => {
  const hook = await read("components/learn/use-material-estimate.ts");
  assert.match(hook, /active = true\n\): MaterialEstimate/);
  assert.match(hook, /if \(!active\) \{\s*checked\.current\.clear\(\);\s*return;\s*\}/);
  // 只判断读不读得出、有没有字：不再为了这个把全部资料按后端规则切一遍块（粘贴文字变了也不用重算）
  assert.match(hook, /\}, \[files, active\]\);/);
  assert.doesNotMatch(hook, /estimateChunks/);
  assert.match(get(zh, "learn.dashboard.form.estimatePdf"), /能选中.*扫描/);
  assert.doesNotMatch(get(zh, "learn.dashboard.form.estimatePdf"), /积分起/);

  const lesson = await read("components/learn/lesson.tsx");
  // 「生成下一篇」失败后的重试：检查期间是转圈的 Button（不再只是一行小字变半透明），文字说清在检查什么
  assert.match(lesson, /onClick=\{handleRetryNext\}\s*loading=\{checkingNext\}\s*disabled=\{checkingNext \|\| streaming\}\s*>\s*\{checkingNext \? t\("lesson\.next\.checking"\) : t\("common\.retry"\)\}\s*<\/Button>/);

  const stream = await read("lib/learn/stream.ts");
  assert.match(stream, /重试期间.*后端每 10 秒发一行 SSE 注释 `: keepalive` 当心跳/);
  assert.doesNotMatch(stream, /后端不发心跳/);
  assert.match(await backend("courses.py"), /SSE_HEARTBEAT = ": keepalive\\n\\n"/);
});


test("小标签统一——A 路自写的小标签类改用 LABEL_CLASS，finishing.test 里对这两个文件的豁免删了；原文篇的小标签 CSS 数值和 LABEL_CLASS 一致", async () => {
  const finishing = await readFile(new URL("./finishing.test.mjs", import.meta.url), "utf8");
  assert.match(finishing, /const EYEBROW_EXEMPT = \{\};/);
  assert.doesNotMatch(finishing, /lesson-feedback\.tsx": "A 路文件|annotation-panel\.tsx": "A 路文件/);

  // .lesson-label 是 rehype 插件生成的元素，带不了 Tailwind 类：数值照抄 LABEL_CLASS，两边对着断言
  const eyebrow = await read("components/brand/eyebrow.tsx");
  const label = eyebrow.match(/export const LABEL_CLASS =\s*"([^"]+)"/)[1];
  assert.match(label, /\btext-\[13px\]/);
  assert.match(label, /\bfont-normal\b/);
  assert.match(label, /\btracking-\[0\.2em\]/);
  assert.match(label, /\[&:lang\(zh\)\]:font-medium/);
  assert.match(label, /\[&:lang\(zh\)\]:tracking-\[0\.08em\]/);
  const css = await read("app/learn.css");
  const base = css.match(/\.prose-lesson \.lesson-label \{([^}]*)\}/)[1];
  assert.match(base, /font-size: calc\(0\.8125rem \* var\(--text-scale\)\);/); // 标准字号下 13px，跟着正文字号缩放
  assert.match(base, /font-weight: 400;/);
  assert.match(base, /letter-spacing: 0\.2em;/);
  assert.match(base, /text-transform: uppercase;/);
  assert.match(base, /font-family: var\(--font-mono\);/);
  const zhRule = css.match(/\.prose-lesson \.lesson-label:lang\(zh\) \{([^}]*)\}/)[1];
  assert.match(zhRule, /font-weight: 500;/);
  assert.match(zhRule, /letter-spacing: 0\.08em;/);
});
