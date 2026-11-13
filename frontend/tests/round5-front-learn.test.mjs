import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  BACKGROUND_CHECK_MS,
  BACKGROUND_WAIT_MS,
  answerAfter,
  countQuestion,
  settledAnswer,
} from "../src/lib/learn/background-answer.ts";
import { splitForDisplay } from "../src/lib/learn/progressive-text.ts";

// 学习区的回归保护：停止后的后台回答、流式中切换问答、建课澄清、生成中卡片、PDF 懒渲染、长原文分段等。

const root = new URL("../src/", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([json("i18n/messages/en.json"), json("i18n/messages/zh.json")]);
const get = (messages, dotted) => dotted.split(".").reduce((node, key) => node?.[key], messages);

const user = (content) => ({ role: "user", content });
const bot = (content) => ({ role: "assistant", content });
const ann = (id, messages, over = {}) => ({
  id, lesson_id: 1, original_text: "原文", comment: messages[0].content, anchor_top: 0,
  position_start: 3, position_end: 5, pdf_position: null, answer: "", created_at: "", messages, ...over,
});

// --- 1：停止时一个字都还没收到 / 已存下半截 ---

test("后台回答：约 20 秒、60 秒后各拉一次，最多等 2 分钟", () => {
  assert.deepEqual([...BACKGROUND_CHECK_MS], [20_000, 60_000, 120_000]);
  assert.equal(BACKGROUND_WAIT_MS, 120_000);
});

test("后台回答：首次提问还没收到字——认后台新建的那一条（本地没有、同一处选区、同一个问题、已经有回答）", () => {
  const selection = { original_text: "原文", position_start: 3, position_end: 5, pdf_position: null };
  const wait = { id: "tmp-1", question: "为什么", nth: 0, partial: "", selection };
  const local = [ann(7, [user("为什么"), bot("旧的回答")]), { ...ann(0, [user("为什么")]), id: "tmp-1" }];
  // 本地已经有的同一问题（之前问过的）不算
  assert.equal(settledAnswer(wait, [local[0]], local), undefined);
  // 别处选区 / 别的问题不算
  assert.equal(settledAnswer(wait, [ann(9, [user("为什么"), bot("答")], { position_start: 4 })], local), undefined);
  assert.equal(settledAnswer(wait, [ann(9, [user("是什么"), bot("答")])], local), undefined);
  assert.equal(settledAnswer(wait, [ann(9, [user("为什么"), bot("答")], { pdf_position: "{}" })], local), undefined);
  const hit = ann(9, [user("为什么"), bot("后台写完的回答")]);
  assert.equal(settledAnswer(wait, [local[0], hit], local), hit);
});

test("后台回答：已存下半截——这一条的回答和存下的半截不一样了才算写完；追问认第 nth 次出现的那个问题", () => {
  const partial = { id: 7, question: "为什么", nth: 0, partial: "半截" };
  assert.equal(settledAnswer(partial, [ann(7, [user("为什么"), bot("半截")])], []), undefined);
  const full = ann(7, [user("为什么"), bot("半截之后的完整回答"), user("再问"), bot("答")]);
  assert.equal(settledAnswer(partial, [full], []), full);
  assert.equal(settledAnswer(partial, [ann(8, full.messages)], []), undefined, "别的问答不算");

  // 追问没收到字：同一个问题之前问过（nth=1），旧的那次的回答不能当成这次
  const follow = { id: 7, question: "举个例子", nth: 1, partial: "" };
  const before = [user("为什么"), bot("答"), user("举个例子"), bot("例子一")];
  assert.equal(settledAnswer(follow, [ann(7, before)], []), undefined);
  assert.equal(settledAnswer(follow, [ann(7, [...before, user("举个例子")])], []), undefined, "问题到了、回答还没写");
  const done = ann(7, [...before, user("举个例子"), bot("例子二")]);
  assert.equal(settledAnswer(follow, [done], []), done);
  assert.equal(countQuestion(before, "举个例子"), 1);
  assert.equal(answerAfter(done.messages, "举个例子", 1), "例子二");
  assert.equal(answerAfter(done.messages, "举个例子", 2), undefined);
});

test("课文页：停止时还没收到字不删气泡，留一行说明并等后台；已存下半截的、在等后台的问答不能删（悬停写明原因）", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const create = lesson.slice(lesson.indexOf("const handleCreateSession"), lesson.indexOf("const handleFollowUp"));
  assert.match(create, /if \(!partial\.trim\(\)\) \{\s*waitForBackground\(\{ id: tempId, question: q, nth: 0, partial: "", selection \}\);/);
  // 只有后端明确报错、请求没被受理的才去掉临时气泡
  assert.match(create, /\} else \{\s*setSessions\(\(prev\) => prev\.filter\(\(s\) => s\.id !== tempId\)\);/);
  assert.doesNotMatch(create, /免费/);
  const follow = lesson.slice(lesson.indexOf("const handleFollowUp"), lesson.indexOf("const handleStopStreaming"));
  assert.match(follow, /if \(!partial\.trim\(\)\) \{\s*waitForBackground\(\{ id: sessionId, question: q, nth, partial: "" \}\);/);
  // 后台已经先写完（存下来的就是完整回答）就不等
  assert.match(lesson, /if \(savedAnswer\.trimEnd\(\) === partial\.trimEnd\(\)\) \{\s*waitForBackground/);
  // 拉的是最新的问答列表（不走缓存）
  assert.match(lesson, /getAnnotations\(courseId, lessonNum, true\)/);
  assert.match(await read("lib/learn/api.ts"), /fresh \? \{ cache: "no-store" \} : undefined/);
  // 删除：正在写的、在等后台的都挡住
  assert.match(lesson, /const deleteBlocked = \(id: number \| string\) => \{\s*if \(streamingId === id\) return t\("lesson\.deleteWhileAnswering"\);/);
  assert.match(lesson, /if \(deleteBlocked\(id\)\) return;/);
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /blockedReason=\{props\.deleteBlocked\}/);
  assert.match(panel, /title=\{blockedReason \?\? label\}/);
  // 被挡住的按钮还能悬停（不用 disabled + pointer-events-none），点了没反应
  assert.match(panel, /onClick=\{blockedReason \? undefined : onClick\}/);
  for (const messages of [zh, en]) {
    for (const key of ["backgroundPending", "backgroundPartial", "backgroundExpired", "backgroundCheckFailed", "deleteWhileAnswering", "deleteWhileBackground", "followUpWaiting", "followUpUnsaved"]) {
      assert.ok(get(messages, `learn.lesson.${key}`), key);
    }
  }
  assert.match(get(zh, "learn.lesson.backgroundPending"), /已停止显示。回答仍会在后台写完并保存，稍后会出现在这里/);
  assert.match(get(en, "learn.lesson.backgroundPending"), /will still finish and be saved in the background/);
});

// --- 2：流式中打开别的问答或新选区 ---

test("课文页：只有正在流式写入的那一条拿到 streaming / streamText；提问框开着时不再把会话卡片顶出来", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /const \[streamingId, setStreamingId\] = useState<number \| string \| null>\(null\);/);
  assert.doesNotMatch(lesson, /setStreaming\(/);
  assert.match(lesson, /const openStreaming = openSessionData !== undefined && streamingId === openSessionData\.id;/);
  assert.match(lesson, /streaming=\{openStreaming\}\s*streamText=\{openStreaming \? streamText : ""\}/);
  assert.match(lesson, /\{openSessionData && !composer && \(/);
  // 停止 / 出错时临时气泡被去掉：只在读者还开着它时才关卡片
  assert.match(lesson, /setOpenId\(\(cur\) => \(cur === tempId \? null : cur\)\);/);
  assert.doesNotMatch(lesson, /setOpenId\(saved\.id\)|setOpenId\(ann\.id\)/);
});

// --- 课文页其余几处 ---

test("课文页：回答流式中「我读完了」禁用并写明原因；重试也禁用", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /blockedReason=\{streaming \? t\("lesson\.next\.waitAnswer"\) : undefined\}/);
  assert.match(lesson, /if \(styleBusy \|\| !detailsReady \|\| streaming\) return;/);
  assert.match(lesson, /disabled=\{checkingNext \|\| streaming\}/);
  const feedback = await read("components/learn/lesson-feedback.tsx");
  assert.match(feedback, /<NextStepFrame hint=\{blockedReason \?\? t\("lesson\.nextStep\.generateHint"\)\}>/);
  assert.match(feedback, /disabled=\{Boolean\(blockedReason\)\}/);
  assert.ok(get(zh, "learn.lesson.next.waitAnswer") && get(en, "learn.lesson.next.waitAnswer"));
});

test("课文页：参考原文面板（portal）里的 mouseup 不清掉提问框；临时 id 的问答不能追问", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  // 先排除参考原文面板里的 mouseup，再看问答是否加载好：没加载好时不出气泡，但正文里选了字要在屏幕底部说一声（不再静默返回）
  assert.match(lesson, /const handleTextSelect = \(e\?: React\.MouseEvent\) => \{[^}]*?e\.target\.closest\("\[data-reference-panel\]"\)\) return;\s*(?:\/\/[^\n]*\s*)?if \(!detailsReady\) \{[\s\S]*?setSelectionNote\(t\("lesson\.askNotReady"\)\);[\s\S]*?return;\s*\}/);
  assert.match(await read("components/learn/source-material.tsx"), /<SheetContent data-reference-panel/);
  assert.match(lesson, /if \(typeof sessionId !== "number"\) return;/);
  assert.match(lesson, /typeof openSessionData\.id === "string" && !openStreaming/);
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /disabled=\{Boolean\(props\.followUpBlocked\)\}/);
  assert.match(panel, /\|\| Boolean\(props\.followUpBlocked\)\}/);
  assert.match(get(zh, "learn.lesson.followUpUnsaved"), /这条回答没有保存成功.*请重新提问/);
});

test("课文页：「生成下一篇」的守卫看 ref，重试检查完调用最新的 handleReadDone", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /const setGenerating = useCallback\(\(value: boolean\) => \{\s*generatingRef\.current = value;\s*setGeneratingState\(value\);/);
  assert.match(lesson, /if \(generatingRef\.current\) return;\s*setGenerating\(true\);/);
  assert.match(lesson, /await handleReadDoneRef\.current\(\);/);
});

// --- 3：澄清问题选填 ---

test("新建课程：澄清问题给学生看过之后，再提交一律 skip_questions，不填也不会被同样的问题再问一遍", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /skip_questions: skipQuestions \|\| goalQuestions\.length > 0/);
});

test("新建课程：主题课粘贴的参考资料超过后端上限，提示并禁用提交，不先跑目标分析", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /const REFERENCE_MAX_CHARS = 50000;/);
  const schemas = await readFile(new URL("../../backend/app/schemas.py", import.meta.url), "utf8");
  assert.match(schemas, /reference: str = Field\("", max_length=50000\)/);
  // 只有不带文件的主题课走 CreateCourseRequest；按字符（码点）数，和 Python 的 len 一样
  assert.match(dialog, /mode === "topic" && !referenceFiles\.length && reference\.length > REFERENCE_MAX_CHARS\s*\? Array\.from\(reference\.trim\(\)\)\.length/);
  assert.match(dialog, /if \(creating \|\| checkingGoal \|\| goalTooLong \|\| referenceTooLong \|\| imported\) return;/);
  assert.match(dialog, /disabled=\{creating \|\| checkingGoal \|\| goalTooLong \|\| referenceTooLong \|\| \(mode === "web" && !webPreview\)\}/);
  for (const messages of [zh, en]) assert.match(get(messages, "learn.dashboard.form.referenceTooLong"), /\{max\}[\s\S]*\{count\}/);
});

// --- 4：生成中卡片 ---

test("生成中卡片：「结果未确认」只劝先刷新列表核对，确认没有再重建；刷新是主按钮", async () => {
  const card = await read("components/learn/generating-courses.tsx");
  // 刷新是主按钮、重新创建是描边按钮；点下去都转圈换字（等列表时不再毫无变化）
  assert.match(card, /<Button loading=\{refreshing\} disabled=\{!!busy\} onClick=\{\(\) => check\(item, "refresh"\)\}>\s*\{refreshing \? t\("refreshing"\) : t\("refresh"\)\}\s*<\/Button>/);
  assert.match(card, /<Button variant="outline" loading=\{retrying\} disabled=\{!!busy\} onClick=\{\(\) => check\(item, "retry"\)\}>/);
  // 结果未确认的运行中卡片也有「刷新列表」（文案叫人刷新）；刷完还没有这门课，卡片上写出刷新的时刻
  assert.match(card, /\{\(stalled \|\| item\.unconfirmed\) && \(/);
  assert.match(card, /t\("stillMissing", \{/);
  assert.doesNotMatch(get(zh, "learn.generating.stalledBody"), /这不表示后台仍在生成/);
  assert.match(get(zh, "learn.generating.stalledBody"), /先点「刷新列表」核对[\s\S]*确认没有这门课，再重新创建/);
  assert.match(get(en, "learn.generating.stalledBody"), /Refresh list[\s\S]*Only create it again once a refresh confirms/);
});

test("我的课程：只有还有卡片在「正在生成」时才每秒走表，都停滞或没有时停掉", async () => {
  const dashboard = await read("components/learn/dashboard.tsx");
  assert.match(dashboard, /const hasRunning = pending\.items\.some\(\(item\) => pendingState\(item, now\) === "running"\);/);
  assert.match(dashboard, /if \(loading \|\| !hasRunning\) return;\s*setNow\(Date\.now\(\)\);\s*const tick = setInterval/);
});

// --- 5：PDF 懒渲染 ---

test("PDF：文档只下载解析一次（可中止），每页先放固定尺寸占位，只画看得见的页上下各 2 页，远的放掉画布；宽度变化防抖", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  assert.match(pdf, /const RENDER_AROUND = 2;/);
  assert.match(pdf, /const RESIZE_DEBOUNCE_MS = 200;/);
  assert.match(pdf, /const download = new AbortController\(\);/);
  assert.match(pdf, /getLessonFile\(courseId, lessonNum, download\.signal\)/);
  assert.match(pdf, /download\.abort\(\);/);
  // 下载解析的 effect 不依赖宽度（只多一个「重试」的次数）；排版的 effect 复用 doc
  assert.match(pdf, /\}, \[courseId, lessonNum, report, attempt\]\);/);
  assert.match(pdf, /\}, \[doc, containerWidth, report\]\);/);
  assert.match(pdf, /new IntersectionObserver\(/);
  // 占位上设好文字层的缩放：不设的话文字层退回页面默认字号，划线取到的字和画面错位
  assert.match(pdf, /pageEl\.style\.cssText = `width:\$\{viewport\.width\}px;height:\$\{viewport\.height\}px;--total-scale-factor:\$\{viewport\.scale\};`;/);
  assert.match(await read("app/learn.css"), /\.pdf-viewer \.pdf-page \{[^}]*--scale-round-x: 1px;\s*--scale-round-y: 1px;/);
  assert.match(pdf, /canvas\.width = 0;\s*canvas\.height = 0;\s*canvas\.remove\(\);/);
  assert.match(pdf, /free\(p\.canvas\);/);
  assert.match(pdf, /if \(applied\) timer = setTimeout\(apply, RESIZE_DEBOUNCE_MS\);/);
  // 放大以后画布按「像素比 × 捏合倍数」重画（单张画布像素有上限），不是把小图拉大
  assert.match(pdf, /const pixelRatio = \(\) => \(window\.devicePixelRatio \|\| 1\) \* \(window\.visualViewport\?\.scale \|\| 1\);/);
  assert.match(pdf, /Math\.min\(ratio, Math\.sqrt\(maxPixels \/ \(p\.width \* p\.height\)\)\)/);
  assert.match(pdf, /window\.visualViewport\?\.addEventListener\("resize", onZoom\);/);
  assert.match(pdf, /window\.visualViewport\?\.removeEventListener\("resize", onZoom\);/);
  assert.doesNotMatch(pdf, /MAX_OUTPUT_SCALE/);
  // 高亮按 viewport 尺寸放在占位里，不等页面画出来
  assert.match(pdf, /left:\$\{r\.x \* p\.width\}px;top:\$\{r\.y \* p\.height\}px;/);
  assert.match(await read("lib/learn/api.ts"), /\{ signal \}/);
});

test("PDF 缩放按钮：放大缩小原地改尺寸、视口中间那一点不跑；按钮贴着可见部分右下角，外框用 clip 才贴得住", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  assert.match(pdf, /const ZOOM_STEPS = \[0\.5, 0\.75, 1, 1\.25, 1\.5, 1\.75, 2\];/);
  // 换倍数不进排版 effect 的依赖（那会拆掉重建、滚动位置丢掉），而是原地改每页尺寸，停下来再排队重画画布、更新文字层
  assert.match(pdf, /\}, \[doc, containerWidth, report\]\);/);
  assert.match(pdf, /rezoomRef\.current\?\.\(pageZoom\);/);
  assert.match(pdf, /p\.textLayer\?\.update\(\{ viewport: p\.viewport \}\);/);
  // 滚回原位不用 behavior: "instant"（老 Safari 不认会抛错，缩放停在半路）：临时关掉平滑滚动再改 scrollTop
  assert.match(pdf, /jumpBy\(scroller, after\.top \+ fy \* after\.height - y\);/);
  assert.match(pdf, /target\.style\.scrollBehavior = "auto";\s*target\.scrollTop \+= dy;\s*target\.style\.scrollBehavior = previous;/);
  assert.doesNotMatch(pdf, /behavior: "instant"/);
  // 连点只重画一次；缩放出错不带崩整篇课文
  assert.match(pdf, /repaintTimer = setTimeout\(repaint, ZOOM_REPAINT_MS\);/);
  assert.match(pdf, /try \{\s*rezoomRef\.current\?\.\(pageZoom\);\s*\} catch/);
  // 放大时外框跟着变宽：整页容器上设 --pdf-extra，测宽度时不把自己撑出来的宽度当成容器变宽；卸载时去掉
  assert.match(pdf, /const extra = Math\.max\(0, Math\.round\(fitWidth \* \(zoom - 1\)\)\);/);
  assert.match(pdf, /if \(pageZoomRef\.current !== 1\) return;/);
  assert.match(pdf, /rezoomRef\.current = null;\s*for \(const el of frames\) el\?\.style\.removeProperty\("--pdf-extra"\);/);
  const css = await read("app/learn.css");
  assert.match(css, /\[data-learn-page\]\[style\*="--pdf-extra"\] \{\s*max-width: calc\(72rem \+ var\(--pdf-extra\)\);/);
  assert.match(css, /\[data-learn-page\]\[style\*="--pdf-extra"\] \[data-learn-columns\] \{\s*grid-template-columns: minmax\(0, calc\(720px \+ var\(--pdf-extra\)\)\) 19rem;/);
  assert.match(pdf, /className="pdf-viewer w-full overflow-x-auto"/);
  assert.match(pdf, /sticky bottom-4 z-10 h-0/);
  for (const key of ["zoom", "zoomOut", "zoomIn", "zoomReset"]) assert.match(pdf, new RegExp(`t\\("pdf\\.${key}"\\)`));
  for (const lang of ["zh", "en"]) {
    const messages = JSON.parse(await read(`i18n/messages/${lang}.json`));
    for (const key of ["zoom", "zoomOut", "zoomIn", "zoomReset"]) assert.ok(messages.learn.pdf[key], `${lang} 缺 learn.pdf.${key}`);
  }
  for (const file of ["components/learn/lesson.tsx"]) {
    const src = await read(file);
    assert.match(src, /isPdf && "overflow-clip rounded-xl border bg-card"/, file);
    assert.doesNotMatch(src, /isPdf && "overflow-hidden/, file);
  }
  assert.match(await read("app/learn.css"), /\.pdf-viewer \.pdf-page \{[^}]*margin: 0 auto 1rem;/);
});

test("PDF 放大缩小、滚动不掉帧：显卡画，一次只画一页、先画近的，文字层在页面外搭好，点缩放的当下不重排文字层", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  // 画布交给显卡画（pdf.js 默认关着：每页都在主线程上一个像素一个像素地画）
  assert.match(pdf, /pdfjsLib\.getDocument\(\{ data, enableHWA: true, \.\.\.PDFJS_ASSET_URLS \}\)/);
  // 排队：一次只画一页，挑离屏幕上露出来的页最近的；换上新画布、重排文字层、画下一页各占一帧
  assert.match(pdf, /const p = \[\.\.\.queue\]\.reduce\(\(a, b\) => \(away\(b\) < away\(a\) \? b : a\)\);/);
  assert.match(pdf, /await sharpen\(p\);\s*await breathe\(\);[^;]*\s*settle\(p\);\s*p\.textLayer\?\.update\(\{ viewport: p\.viewport \}\);\s*\}\s*await breathe\(\);/);
  assert.match(pdf, /const breathe = \(\) => new Promise<void>\(\(resolve\) => requestAnimationFrame\(\(\) => setTimeout\(resolve\)\)\);/);
  // 不绕过排队直接画
  assert.doesNotMatch(pdf, /void (draw|sharpen)\(/);
  // 放大缩小后画布要不要重画，看像素宽度对不对（连点时按旧尺寸画完的那张不会被当成新的）
  assert.match(pdf, /if \(!p\.canvas \|\| p\.canvas\.width === pixelWidth\(p\)\) return;/);
  // 文字层在页面外搭好再放回画布和高亮层之间：在页面里搭，每放一段字量一次字宽就要算一次样式
  assert.match(pdf, /p\.textLayerDiv\.remove\(\);\s*try \{\s*await textLayer\.render\(\);\s*\} finally \{\s*p\.pageEl\.insertBefore\(p\.textLayerDiv, p\.hlLayer\);/);
  // 点缩放的当下：有文字层的页只改宽高、文字层整层拉伸；--total-scale-factor 等轮到这页重画时再改（settle），放掉的页也要恢复
  assert.match(pdf, /p\.textLayerDiv\.style\.scale = String\(p\.viewport\.scale \/ laid\);\s*\} else fit\(p\.pageEl, p\.viewport\);/);
  assert.match(pdf, /if \(!p\.textLayerDiv\.style\.scale\) return;\s*fit\(p\.pageEl, p\.viewport\);\s*p\.textLayerDiv\.style\.scale = "";/);
  assert.match(pdf, /p\.textLayer = undefined;\s*settle\(p\);/);
  // --pdf-extra 注册成不继承，用到它的整页容器和栅格各设一遍：按默认的继承，改一下整页每个元素的样式都要重算
  assert.match(await read("app/learn.css"), /@property --pdf-extra \{\s*syntax: "<length>";\s*inherits: false;\s*initial-value: 0px;\s*\}/);
  assert.match(pdf, /const frames = \[frame, frame && host\.closest<HTMLElement>\("\[data-learn-columns\]"\)\];/);
  assert.match(pdf, /for \(const el of frames\) \{\s*if \(extra\) el\?\.style\.setProperty\("--pdf-extra", `\$\{extra\}px`\);/);
});

test("PDF 文字层在 Safari 27 之前也搭得出来，而且和画布上的字一样宽：自己用 reader 读文字，文字层和量字宽的画布标同一种语言", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  // pdf.js 6.4 的 page.getTextContent() 用 for await 读流，Safari 27 之前会抛错（整篇报「没能加载」、没有文字层）：不调它，也不自己写 for await
  assert.doesNotMatch(pdf, /await [\w.]+\.getTextContent\(|for await \(/);
  assert.match(pdf, /const reader = page\.streamTextContent\(\)\.getReader\(\);/);
  assert.match(pdf, /const \{ value, done \} = await reader\.read\(\);\s*if \(done\) return content;/);
  assert.match(pdf, /const textContent = await readText\(p\.page\);/);
  // PDF 没写语言时 pdf.js 给量字宽的画布标空语言，文字层跟着页面是 zh，两边 sans-serif 落到不同字体，透明文字比画布上的字宽 5% 多：
  // 两边都明确标成同一种（PDF 写了的用它的，没写用页面的），不留空
  assert.match(pdf, /const lang = textContent\.lang \|\| document\.documentElement\.lang \|\| "en";\s*p\.textLayerDiv\.lang = lang;/);
  assert.match(pdf, /textContentSource: \{ \.\.\.textContent, lang \},/);
});

test("PDF 拖选时鼠标落到字外面的空白处，选区不跳到页首页尾：每页文字层末尾放 .endOfContent，按着拖的时候铺开", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  const guard = await read("lib/learn/pdf-blank-selection.ts");
  // 文字层搭好后在末尾放 .endOfContent 并登记；放掉这页时一起去掉。样式用 pdf.js 自带的
  assert.match(pdf, /end\.className = "endOfContent";\s*p\.textLayerDiv\.append\(end\);\s*blanks\.set\(p\.textLayerDiv, end\);/);
  assert.match(pdf, /p\.textLayerDiv\.classList\.remove\("selecting"\);\s*blanks\.delete\(p\.textLayerDiv\);/);
  assert.match(pdf, /const unguard = guardBlankSelection\(blanks, \(y\) => \{/);
  assert.match(pdf, /observer\.disconnect\(\);\s*unguard\(\);/);
  assert.match(pdf, /import "pdfjs-dist\/web\/pdf_viewer\.css";/);
  // 只在按着拖的时候铺开，松手、被系统接管、窗口失焦都收起：一直铺着的话点空白处收不掉选区（「提问」气泡关不掉）
  assert.match(guard, /if \(!dragging\) return;/);
  for (const type of ["pointerup", "pointercancel"]) assert.ok(guard.includes(`document.addEventListener("${type}", stop, { signal });`), type);
  assert.match(guard, /window\.addEventListener\("blur", stop, \{ signal \}\);/);
  assert.match(guard, /end\.removeAttribute\("style"\);\s*layer\.classList\.remove\("selecting"\);/);
  // Firefox 和 Chrome 148 起选区自己留在原地；更早的 Chrome 和 Safari 要把它挪到选区正在动的那一端旁边、改成可选
  assert.match(guard, />= 148;\s*if \(staysPut\) return;/);
  assert.match(guard, /end\.style\.userSelect = "text";\s*node\.parentElement!\.insertBefore\(end, movingStart \? node : node\.nextSibling\);/);
});

test("PDF 从空白处起拖（页边、行与行之间、高亮上）：不交给浏览器，自己定起点、跟着鼠标延伸，贴边自己滚", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  const guard = await read("lib/learn/pdf-blank-selection.ts");
  // 只接管鼠标在本阅读器的页面里、又没按在字上的那一下；双击、Shift 点、手指点的照旧交给浏览器
  assert.match(guard, /if \(event\.button \|\| event\.detail > 1 \|\| event\.shiftKey \|\| event\.ctrlKey \|\| !mouse\) return;/);
  assert.match(guard, /const layer = target\.closest\?\.\("\.pdf-page"\)\?\.querySelector\("\.textLayer"\);\s*if \(!layer \|\| !layers\.has\(layer\)\) return;/);
  // 「按在字上」按字框算：浏览器的命中范围比字框高（字体自带的上下高度），下一行的字盖住上一行最下面几个像素，那里按下去不算按在下一行上
  assert.match(guard, /if \(target\.matches\(TEXT\)\) \{\s*const \{ left, right, top, bottom \} = target\.getBoundingClientRect\(\);\s*if \(event\.clientX >= left && event\.clientX <= right && event\.clientY >= top && event\.clientY <= bottom\) return;\s*\}/);
  // 拦下浏览器自己的选区后，它顺带做的两件事自己做：输入框失去焦点，原来的选区收起（点空白处要能关掉「提问」气泡）
  assert.match(guard, /event\.preventDefault\(\);\s*\(document\.activeElement as HTMLElement \| null\)\?\.blur\(\);\s*stop\(\);\s*anchor = from;\s*document\.getSelection\(\)\?\.collapse\(from\.node, from\.offset\);/);
  assert.match(guard, /setBaseAndExtent\(anchor\.node, anchor\.offset, to\.node, to\.offset\)/);
  // 动出 4px 才算拖：点高亮、点空白处时手抖一两个像素，不能选上一个字（高亮就打不开了）
  assert.match(guard, /const DRAG_SLOP = 4;/);
  assert.match(guard, /if \(still && Math\.hypot\(event\.clientX - pointer\.x, event\.clientY - pointer\.y\) < DRAG_SLOP\) return;\s*still = false;/);
  // 松手没收到时不能让选区跟着没按下的鼠标跑；松手、失焦都结束
  assert.match(guard, /if \(!\(event\.buttons & 1\)\) return stop\(\);/);
  assert.match(guard, /const stop = \(\) => \{\s*dragging = false;\s*anchor = undefined;/);
  // 字的位置自己量（鼠标下面可能盖着高亮）；空白、竖排的字不当起点
  assert.doesNotMatch(guard, /caret(Position|Range)FromPoint\(/);
  assert.match(guard, /!node\.data\.trim\(\) \|\| span\.style\.getPropertyValue\("--rotate"\)/);
  assert.match(guard, /nearestTextBox\(boxes, layer\.getBoundingClientRect\(\)\.width \* SEGMENT_GAP, x, y\)/);
  // 贴到可见范围上下边时自己滚（课文页滚窗口，参考原文面板滚面板），滚了以后鼠标下面换了字，选区跟上
  assert.match(guard, /if \(!still\) autoscroll\(pointer\.y\);\s*requestAnimationFrame\(follow\);/);
  assert.match(guard, /document\.addEventListener\("scroll", extend, \{ capture: true, signal \}\);/);
  assert.match(pdf, /const scroller = scrollerOf\(host\);[\s\S]{0,260}if \(past\) jumpBy\(scroller, Math\.max\(-AUTOSCROLL_MAX, Math\.min\(AUTOSCROLL_MAX, past \/ 4\)\)\);/);
});

test("PDF 拖选经过已有的高亮不断；从高亮上起拖选了字不算点它", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  const css = await read("app/learn.css");
  // 浏览器自己的拖选进行中（文字层带 .selecting），这一页的高亮不接鼠标；平时照样能点、有手形
  assert.match(css, /\.pdf-viewer \.textLayer\.selecting ~ \.pdf-hl-layer \.pdf-hl \{\s*pointer-events: none;\s*\}/);
  assert.match(css, /\.pdf-viewer \.pdf-hl \{[^}]*pointer-events: auto;\s*cursor: pointer;\s*\}/);
  // 文字层的每段字不加 overflow: clip（裁回字框能修命中范围，但 CPU 慢 4 倍时连续滚动掉的帧多两成）
  assert.doesNotMatch(css, /\.textLayer span[^{]*\{[^}]*overflow: clip/);
  assert.match(pdf, /div\.onclick = \(\) => window\.getSelection\(\)\?\.isCollapsed !== false && openHighlightRef\.current\?\.\(hl\.id\);/);
});

test("PDF 的字体和解码文件发布成同源静态文件并告诉 pdf.js；库和 worker 用 legacy 构建（旧浏览器没有 Math.sumPrecise）", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  // 四类文件的地址：同源、带 pdfjs-dist 的版本号、末尾带 /（pdf.js 不带 / 直接抛错）
  assert.match(pdf, /const PDFJS_ASSETS = `\/pdfjs\/\$\{pdfjsLib\.version\}\/`;/);
  for (const [key, dir] of [["cMapUrl", "cmaps"], ["standardFontDataUrl", "standard_fonts"], ["wasmUrl", "wasm"], ["iccUrl", "iccs"]]) {
    assert.ok(pdf.includes(`${key}: \`\${PDFJS_ASSETS}${dir}/\``), key);
  }
  // 默认构建在 Chrome 147 / Safari 26.2 之前的浏览器里转不了内嵌字体：库、类型、worker 都从 legacy 构建来
  assert.match(pdf, /import \* as pdfjsLib from "pdfjs-dist\/legacy\/build\/pdf\.mjs";/);
  assert.match(pdf, /"pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs",\s*import\.meta\.url/);
  assert.doesNotMatch(pdf, /from "pdfjs-dist"|"pdfjs-dist\/build\//);

  // 拷贝脚本：四个目录整个拷到 public/pdfjs/<版本号>/，dev 和 build 之前都跑；拷出来的不进 git
  const script = await readFile(new URL("../scripts/copy-pdfjs-assets.mjs", import.meta.url), "utf8");
  assert.match(script, /for \(const dir of \["cmaps", "standard_fonts", "wasm", "iccs"\]\)/);
  assert.match(script, /path\.join\(dest, version, dir\)/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["dev", "build"]) assert.match(pkg.scripts[name], /^node scripts\/copy-pdfjs-assets\.mjs && /, name);
  assert.match(await readFile(new URL("../.gitignore", import.meta.url), "utf8"), /^\/public\/pdfjs\/$/m);
  // 包里确实有这四个目录，JPEG 2000 / JBIG2 的 wasm 和 wasm 用不了时的 JS 解码器都在（Safari 编译不了 openjpeg.wasm，靠后者）
  const { createRequire } = await import("node:module");
  const { existsSync } = await import("node:fs");
  const dist = join(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"), "..");
  for (const file of [
    "cmaps/GBK-EUC-H.bcmap", "cmaps/UniGB-UCS2-H.bcmap", "standard_fonts/FoxitSymbol.pfb", "standard_fonts/LiberationSans-Regular.ttf",
    "wasm/openjpeg.wasm", "wasm/openjpeg_nowasm_fallback.js", "wasm/jbig2.wasm", "wasm/jbig2_nowasm_fallback.js", "wasm/qcms_bg.wasm",
    "iccs/CGATS001Compat-v2-micro.icc", "legacy/build/pdf.mjs", "legacy/build/pdf.worker.min.mjs",
  ]) assert.ok(existsSync(join(dist, file)), `pdfjs-dist 里没有 ${file}`);

  // 地址带版本号、内容不变：长期缓存
  const config = (await import("../next.config.mjs")).default;
  const rule = (await config.headers()).find((r) => r.source === "/pdfjs/:path*");
  assert.deepEqual(rule?.headers, [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]);
});

// --- 6：长原文分段 ---

test("长原文分段显示：Markdown 只在空行处、不在代码块中间切；纯文本任意换行处切；拼回来和原文一样", () => {
  const para = (i) => `第 ${i} 段 ${"字".repeat(30)}`;
  const md = Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n");
  const parts = splitForDisplay(md, true, 100);
  assert.ok(parts.length > 2);
  assert.equal(parts.join("\n"), md);
  for (const part of parts.slice(1)) assert.match(part, /^\n?第 \d+ 段/);

  const fenced = `${"a".repeat(120)}\n\n\`\`\`\ncode\n\ncode\n\`\`\`\n\nafter`;
  const fencedParts = splitForDisplay(fenced, true, 100);
  assert.ok(fencedParts.every((part) => (part.match(/```/g) ?? []).length % 2 === 0), "代码块不被切开");
  assert.equal(fencedParts.join("\n"), fenced);

  const txt = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const txtParts = splitForDisplay(txt, false, 60);
  assert.ok(txtParts.length > 3);
  assert.equal(txtParts.join("\n"), txt);
  assert.deepEqual(splitForDisplay("短", true), ["短"]);
});

test("参考原文：长文分段渐进渲染，滚到接近底部再接下一段", async () => {
  const source = await read("components/learn/source-material.tsx");
  assert.match(source, /splitForDisplay\(source\.content, !txt\)/);
  assert.match(source, /root: el\.closest\("\[data-reference-scroll\]"\), rootMargin: "0px 0px 1500px 0px"/);
  assert.match(source, /parts\.slice\(0, shown\)/);
  assert.ok(get(zh, "learn.outlineSetup.loadingMore") && get(en, "learn.outlineSetup.loadingMore"));
});

test("大纲编辑：不再用 maxLength 悄悄截断，超过后端上限提示并禁用保存；「开始学习」完成后已离开页面就不跳转", async () => {
  const syllabus = await read("components/learn/syllabus.tsx");
  assert.doesNotMatch(syllabus, /maxLength=\{/);
  assert.match(syllabus, /const OUTLINE_MAX_CHARS = 50000;/);
  const courses = await readFile(new URL("../../backend/app/courses.py", import.meta.url), "utf8");
  assert.match(courses, /len\(req\.content\) > 50000/);
  assert.match(syllabus, /disabled=\{!!working \|\| !draft\.trim\(\) \|\| draftTooLong\}/);
  assert.match(syllabus, /if \(mountedRef\.current\) \{\s*\/\/[^\n]*\n\s*leaving = true;\s*router\.push\(`\/learn\/course\/\$\{courseId\}\/lesson\/\$\{lesson\.number\}`\);/);
  for (const messages of [zh, en]) assert.match(get(messages, "learn.outlineSetup.outlineTooLong"), /\{max\}[\s\S]*\{count\}/);
});
