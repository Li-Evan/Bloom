import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const read = (path) =>
  readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

const LESSON_FILES = [
  "components/learn/lesson.tsx",
  "components/learn/columns.tsx",
  "components/learn/use-bar-hidden.ts",
  "components/learn/use-panel-top.ts",
  "components/learn/lesson-bar.tsx",
  "components/learn/lesson-nav.tsx",
  "components/learn/lesson-feedback.tsx",
  "components/learn/annotation-panel.tsx",
  "components/learn/pdf-viewer.tsx",
  "components/learn/markdown.tsx",
  "lib/learn/highlight.ts",
];

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function parse(name, text) {
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function find(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  ts.forEachChild(node, (child) => {
    find(child, predicate, found);
  });
  return found;
}

test("课文页的组件只用语义令牌：没有 stone-/emerald-/rose-/amber-/white/black/十六进制/rgb 颜色（暗色主题才能成立）", async () => {
  const COLOR =
    /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow|accent|decoration)-(?:stone|emerald|rose|red|amber|yellow|violet|slate|gray|zinc|neutral|green|white|black)\b|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(/;
  for (const file of LESSON_FILES) {
    assert.doesNotMatch(
      stripComments(await read(file)),
      COLOR,
      `${file} 里有硬编码颜色`
    );
  }
  // 样式表里唯一的固定色：PDF 页面是「纸」，暗色下也必须是白底（pdf.js 的画布默认透明）
  const css = stripComments(await read("app/learn.css"));
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, ["#fff"]);
  assert.match(css, /\.pdf-viewer \.pdf-page \{[^}]*background: #fff;/);
});

test("读课文时关掉站点页脚（LessonPage 里渲染 HideFooter，服务端渲染的加载态也有，首屏就没有页脚）；课文打不开的整页提示里页脚照常显示；也没有自带的深色返回条", async () => {
  const page = await read(
    "app/[locale]/(default)/learn/course/[courseId]/lesson/[lessonNum]/page.tsx"
  );
  assert.doesNotMatch(page, /import HideFooter|<HideFooter/);

  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /import HideFooter from "@\/components\/site\/footer\/hide-footer"/);
  // 加载态和读课文各一处；打不开的分支（return <LearnStatus …>）里没有
  assert.equal([...lesson.matchAll(/<HideFooter \/>/g)].length, 2);
  const errorBranch = lesson.slice(lesson.indexOf("if (error && !lesson) {"), lesson.indexOf("const lessonNumberLabel"));
  assert.match(errorBranch, /<LearnStatus kind="lesson" notFound=\{notFound\}/);
  assert.doesNotMatch(errorBranch, /HideFooter/);
  assert.doesNotMatch(lesson, /bg-stone-900|<header/);
  const bar = await read("components/learn/lesson-bar.tsx");
  const shell = await read("components/learn/shell.tsx");
  // 面包屑条和课程页、大纲页是同一个组件（CrumbBar：56px 高、下边线）；课文页让它吸在全站顶栏下面
  assert.match(bar, /<CrumbBar\s+sticky\s+hidden=\{hidden\}/);
  assert.match(shell, /"z-30 h-14 border-b bg-background"/);
  assert.match(shell, /sticky top-\[var\(--header-height\)\] transition-transform duration-150 motion-reduce:transition-none/);
  // 往下滚收起：整条上移出去，藏在全站顶栏（z-50）后面；往上滚出现
  assert.match(shell, /sticky && hidden && "-translate-y-full"/);
  // 面包屑：我的课程 / 课程名 / 第 N 篇
  assert.match(bar, /t\("dashboard\.title"\)/);
  assert.match(bar, /`\/learn\/course\/\$\{courseId\}`/);
  for (const page of ["course.tsx", "syllabus.tsx"]) {
    assert.match(await read(`components/learn/${page}`), /<CrumbBar/, page);
  }
  // 当前页（比如很长的文件名）也能截断，不再压到右边按钮上；lg 以下排成两行：上一层小字在上，当前页在下
  assert.doesNotMatch(shell, /shrink-0 font-medium/);
  assert.match(shell, /<span className="truncate" title=/);
  assert.match(shell, /max-lg:flex-col/);
  assert.match(shell, /!last && i < items\.length - 2 && "shrink-0 max-lg:hidden"/);
});

test("面包屑条：往下滚收起、往上滚出现，靠近页面顶部一直显示；键盘聚焦进条里时出现；减弱动效时不做动画", async () => {
  const { nextBar, BAR_TOP_ZONE, BAR_FLIP_DISTANCE } = await import("../src/lib/learn/bar.ts");
  const shown = (ref) => ({ hidden: false, ref });
  const hidden = (ref) => ({ hidden: true, ref });
  // 显示时：往下滚累计满 24px 才收起（参照位置是往上滚到过的最高位置）
  assert.deepEqual(nextBar(shown(300), 300 + BAR_FLIP_DISTANCE), hidden(300 + BAR_FLIP_DISTANCE));
  assert.deepEqual(nextBar(shown(300), 300 + BAR_FLIP_DISTANCE - 1), shown(300));
  // 收起时：往回滚累计满 24px 才出现（参照位置是往下滚到过的最低位置）
  assert.deepEqual(nextBar(hidden(500), 500 - BAR_FLIP_DISTANCE), shown(500 - BAR_FLIP_DISTANCE));
  assert.deepEqual(nextBar(hidden(500), 500 - BAR_FLIP_DISTANCE + 1), hidden(500));
  // 触控板到底后的回弹：一点点来回抖（每次几个像素、累计不到 24px）既不收也不出现，参照位置只往「更远」的方向跟
  let state = hidden(500);
  for (const y of [503, 497, 504, 496, 505, 498]) state = nextBar(state, y);
  assert.equal(state.hidden, true);
  assert.equal(state.ref, 505);
  state = shown(300);
  for (const y of [296, 303, 295, 304, 298]) state = nextBar(state, y);
  assert.equal(state.hidden, false);
  assert.equal(state.ref, 295);
  // 往下滚一路收起，再往上滚一段（>24px）出现，再往下又收起
  state = shown(100);
  for (const y of [150, 220, 400, 700]) state = nextBar(state, y);
  assert.equal(state.hidden, true);
  state = nextBar(state, 700 - BAR_FLIP_DISTANCE - 5);
  assert.equal(state.hidden, false);
  state = nextBar(nextBar(state, 700), 700 + BAR_FLIP_DISTANCE + 10);
  assert.equal(state.hidden, true);
  // 靠近页面顶部：一直显示，往下滚也不收
  assert.deepEqual(nextBar(hidden(900), BAR_TOP_ZONE), shown(BAR_TOP_ZONE));
  assert.equal(nextBar(shown(0), BAR_TOP_ZONE - 10).hidden, false);

  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /const \[barHidden, revealBar\] = useBarHidden\(\)/);
  assert.match(lesson, /data-bar-hidden=\{barHidden\}/);
  assert.match(lesson, /onReveal=\{revealBar\}/);
  const bar = await read("components/learn/lesson-bar.tsx");
  assert.match(bar, /onFocusCapture=\{onReveal\}/);
  // 条收起时右栏吸顶线跟着往上让回去
  const css = await read("app/learn.css");
  assert.match(css, /\.lesson-page\[data-bar-hidden="true"\] \{\s*--rail-offset: 0px;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.learn-rail \{\s*transition: none;/);
});

test("划线提问卡片：放在正文区之外的右侧栏 / 底部抽屉里（点卡片不会触发课文的选区处理），不再有可拖到视口外的绝对定位", async () => {
  const text = await read("components/learn/lesson.tsx");
  const sf = parse("lesson.tsx", text);

  const article = find(sf, (n) => ts.isJsxElement(n) && n.openingElement.tagName.getText() === "article");
  assert.equal(article.length, 1);
  assert.doesNotMatch(article[0].getText(), /<AnnotationPanel/, "卡片不能放在 <article> 里");

  // 新建提问、已有问答、划线翻译与「问这篇」四种卡片都在 annotationCards 里；平时放在右栏（三页共用的两栏栅格 LearnColumns 的 rail），
  // 「参考原文」面板开着（桌面上右栏被让掉）时放在正文栏里、作为左半屏底部的抽屉，都不在 <article> 里
  const cards = find(sf, (n) => ts.isVariableDeclaration(n) && n.name.getText() === "annotationCards");
  assert.equal(cards.length, 1);
  assert.equal((cards[0].getText().match(/<AnnotationPanel/g) ?? []).length, 4, "新建提问、已有问答、划线翻译与问这篇四种卡片");
  const rail = find(sf, (n) => ts.isJsxAttribute(n) && n.name.getText() === "rail" && n.getText().includes("{annotationCards}"));
  assert.equal(rail.length, 1);
  assert.match(rail[0].getText(), /panelOpen && !sourceOpen &&/);
  assert.match(text, /\{sourceOpen && annotationCards\}/);
  assert.match(text, /docked: sourceOpen/);
  assert.match(await read("components/learn/columns.tsx"), /<aside/);

  assert.doesNotMatch(text, /cardRect|startDrag|startResize|initRect/);

  const panel = await read("components/learn/annotation-panel.tsx");
  // 手机 / 平板：固定在屏幕底部的抽屉，高度不超过视口；桌面（lg）：吸在右栏里的视口内，高度不超过视口，内容在卡片里滚动
  // 键盘开着时抬到键盘上面（--kb-bottom）、高度收进键盘上面那块（--kb-room）；平时贴底
  assert.match(panel, /fixed inset-x-0 bottom-\[var\(--kb-bottom,0px\)\]/);
  assert.match(panel, /useAboveKeyboard\(panelRef\)/);
  assert.match(panel, /window\.innerHeight - vv\.height - vv\.offsetTop/);
  // 手机：已有的问答和译文最多 60dvh（课文至少还能看到 40%），新建提问框和「问这篇」上限宽一些
  assert.match(panel, /props\.kind === "compose" \|\| isChat \? "max-h-\[min\(78dvh,36rem,var\(--kb-room,100dvh\)\)\]" : "max-h-\[min\(60dvh,var\(--kb-room,100dvh\)\)\]"/);
  // 触屏打开卡片不自动聚焦（一聚焦就弹键盘挡住卡片）：只有鼠标 / 触控板的设备才自动聚焦
  assert.match(panel, /matchMedia\("\(pointer: fine\)"\)/);
  assert.doesNotMatch(panel, /autoFocus\n/);
  assert.equal((panel.match(/autoFocus=\{focusOnOpen\}/g) ?? []).length, 2);
  assert.match(panel, /lg:sticky/);
  // 目录行占的高度（--panel-offset）让出来，页面在最顶时右栏顶比吸附线低的那一截（--panel-slack）也从最大高度里扣掉
  assert.match(panel, /lg:top-\[calc\(var\(--header-height\)\+var\(--rail-offset,0px\)\+1rem\+var\(--panel-offset,0px\)\)\]/);
  assert.match(panel, /lg:max-h-\[calc\(100dvh-var\(--header-height\)-var\(--rail-offset,0px\)-2rem-var\(--panel-offset,0px\)-var\(--panel-slack,0px\)\)\]/);
  assert.match(panel, /overflow-y-auto/);
  // 卡片顶部对齐被问的那一段：卡片前面的占位按算好的距离撑高（桌面才生效，详见下面「问答卡片的位置」）
  assert.match(text, /lg:h-\[calc\(var\(--panel-top\)-6rem\)\]/);
  assert.match(text, /usePanelTop\(\{/);
  // 右栏平时的课文导航是吸顶的 .learn-rail；开卡片时让位
  assert.match(text, /"learn-rail hidden lg:block", panelOpen && "lg:hidden"/);
});

test("读者主动打开另一条才换卡片的 key；回答写完临时 id 换成存下来的 id 时不换（不然卡片重挂载、滚动位置回到顶部）；只数读者自己的提问来决定要不要滚到底", async () => {
  const text = await read("components/learn/lesson.tsx");
  assert.match(text, /<AnnotationPanel\s+ref=\{panelRef\}\s+key=\{panelKey\}/);
  assert.doesNotMatch(text, /key=\{openSessionData\.id\}/);
  const open = text.slice(text.indexOf("const openSession ="), text.indexOf("const scrollToSession"));
  assert.match(open, /setPanelKey\(\(k\) => k \+ 1\)/);
  // 流式回答写完后换成存下来的 id 不碰 panelKey；读者这期间打开了别的问答 / 新选区的，不把卡片拽回来
  const create = text.slice(text.indexOf("const handleCreateSession"), text.indexOf("const handleFollowUp"));
  assert.doesNotMatch(create, /setPanelKey/);
  assert.match(create, /setOpenId\(\(cur\) => \(cur === tempId \? saved\.id : cur\)\)/);

  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /const thread = isSession \? props\.session\.messages : isChat \? props\.turns : \[\];/);
  assert.match(panel, /thread\.filter\(\(m\) => m\.role === "user"\)\.length/);
  assert.match(panel, /askedCount > seenCount\.current/);
});

test("问答卡片的位置：顶部对齐被问的段落（占位高度只看被问段落相对右栏的文档位置，和滚动无关），卡片靠 sticky 上下两边始终完整在视口内——含页面最顶 / 最底（区域向上下各伸出容器的内边距）", async () => {
  const hook = await read("components/learn/use-panel-top.ts");
  // 占位高度 = 被问那段相对「右栏本身」顶部的距离（两个元素视口坐标之差，扣掉区域向上多伸出的那一截），夹在右栏本身的高度以内（扣掉上下多伸出的）；
  // 再加上向上多伸出的那一截，因为占位在区域里面。不读窗口高度、不读吸顶线、不读滚动位置（那是滚动相关的量）
  assert.match(hook, /const above = Math\.max\(0, -parseFloat\(style\.marginTop\) \|\| 0\);/);
  assert.match(hook, /const below = Math\.max\(0, -parseFloat\(style\.marginBottom\) \|\| 0\);/);
  // 「问这篇」不对着哪一段（anchor 为 null）：直接放在 minTop，紧贴目录行
  assert.match(hook, /const wanted = anchor === null \? minTop : paper\.getBoundingClientRect\(\)\.top \+ anchor - \(box\.getBoundingClientRect\(\)\.top \+ above\);/);
  assert.match(hook, /const room = Math\.max\(0, box\.clientHeight - above - below - el\.offsetHeight\);/);
  // minTop：右栏顶上放着收成一行的课文目录，卡片顶部离右栏顶部至少这么远
  assert.match(hook, /setTop\(Math\.round\(Math\.min\(Math\.max\(wanted, minTop\), room\)\) \+ above\);/);
  assert.doesNotMatch(hook, /innerHeight|scrollY|pageYOffset|scrollTop/);
  // 手机上卡片是底部抽屉，不算位置
  assert.match(hook, /matchMedia\("\(min-width: 1024px\)"\)/);

  // 占位是卡片的兄弟（不是 padding）：这样卡片向上吸附时能越过它原本的位置
  const lesson = await read("components/learn/lesson.tsx");
  // 占位的高度减掉目录行占的 40 + 56px（目录行吸顶、卡片在它下面的内层容器里）
  assert.match(lesson, /<div aria-hidden="true" className="hidden lg:block lg:h-\[calc\(var\(--panel-top\)-6rem\)\]" \/>/);
  assert.doesNotMatch(lesson, /lg:pt-\[var\(--panel-top\)\]/);
  // sticky 只在自己的容器里挪：卡片所在的区域用负外边距向上伸出页面容器的上内边距（pt-10）、向下伸出下内边距（pb-24），
  // 页面滚到最顶 / 最底时两条吸附线还在区域里，长卡片也不会被顶栏盖住或掉出视口底边。数值要和容器的内边距一致
  assert.match(lesson, /className="relative lg:-mb-24 lg:-mt-10 lg:flex lg:flex-1 lg:flex-col"/);
  assert.match(lesson, /className="relative mx-auto w-full max-w-6xl px-4 pb-24 pt-8 sm:px-6 sm:pt-10 lg:px-8"/);
  // 卡片：sticky 的顶上（顶栏 / 面包屑条下面）和底下（视口底边上面）各一条吸附线，max-h 正好是两条线之间的高度
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /lg:bottom-4/);
  // 目录行占的高度（--panel-offset）让出来，页面在最顶时右栏顶比吸附线低的那一截（--panel-slack）也从最大高度里扣掉
  assert.match(panel, /lg:top-\[calc\(var\(--header-height\)\+var\(--rail-offset,0px\)\+1rem\+var\(--panel-offset,0px\)\)\]/);
  assert.match(panel, /lg:max-h-\[calc\(100dvh-var\(--header-height\)-var\(--rail-offset,0px\)-2rem-var\(--panel-offset,0px\)-var\(--panel-slack,0px\)\)\]/);
  assert.doesNotMatch(panel, /lg:bottom-auto/);
});

test("深链接 ?annotation=<id>：路由页只认一个正整数；课文页加载后滚到那处划线并打开那条问答，找不到就忽略，同一个链接只处理一次", async () => {
  const { annotationParam } = await import("../src/lib/learn/route-params.ts");
  assert.equal(annotationParam("12"), 12);
  assert.equal(annotationParam(["7", "8"]), 7);
  for (const bad of [undefined, "", "0", "-1", "1.5", "abc", "12abc", " 12", "1e3", "007", "99999999999999999999"]) {
    assert.equal(annotationParam(bad), undefined, String(bad));
  }

  const page = await read("app/[locale]/(default)/learn/course/[courseId]/lesson/[lessonNum]/page.tsx");
  assert.match(page, /annotationParam\(\(await searchParams\)\.annotation\)/);
  assert.match(page, /<LessonPage courseId=\{courseId\} lessonNum=\{lessonNum\} annotationId=\{annotationId\} initial=\{initial\} \/>/);

  const lesson = await read("components/learn/lesson.tsx");
  const effect = lesson.slice(lesson.indexOf("// 深链接 ?annotation=<id>"), lesson.indexOf("const clearPendingSelection"));
  assert.match(effect, /if \(loading \|\| !detailsReady \|\| annotationId == null\) return;/);
  assert.match(effect, /const session = sessions\.find\(\(s\) => s\.id === annotationId\);\s*if \(!session\) \{\s*deepLinked\.current = key;\s*return;/);
  assert.match(effect, /if \(deepLinked\.current === key\) return;/);
  assert.match(effect, /scrollToSession\(session\);/);
  assert.match(effect, /setOpenId\(session\.id\);/);
  // 这个效果只滚动、只打开卡片：不调任何会调用模型的接口
  assert.doesNotMatch(effect, /createAnnotation|addAnnotationMessage|generateNextLesson/);
  // 字体换上后的二次滚动：清理时取消；读者动过页面（滚轮、触摸、键盘、拖滚动条，一律看位置）就不再滚
  assert.match(effect, /let cancelled = false;[\s\S]*?if \(!cancelled && Math\.abs\(window\.scrollY - landed\) <= 2\) scrollToSession\(session\);[\s\S]*?return \(\) => \{\s*cancelled = true;/);
  assert.doesNotMatch(effect, /addEventListener\("(wheel|touchstart|keydown)"/);

  // 「我的笔记」「最近的笔记」（同一张笔记卡）的「回到课文」带上它；学习记录里的划线数去「我的笔记」按课程筛好的页面
  const card = await read("components/me/note-card.tsx");
  assert.match(card, /href=\{`\/learn\/course\/\$\{note\.course_id\}\/lesson\/\$\{note\.lesson_number\}\?annotation=\$\{note\.id\}`\}/);
  assert.match(await read("components/me/activity-view.tsx"), /href=\{`\/me\/notes\?course=\$\{c\.course_id\}`\}/);
});

test("「提问 / 发送 / 重试 / 生成下一篇」不显示费用标签，仍只在点击后执行：模型调用只在 handle* 里", async () => {
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.doesNotMatch(panel, /<Cost \/>/);
  const feedback = await read("components/learn/lesson-feedback.tsx");
  assert.doesNotMatch(feedback, /<Cost/);
  const lesson = await read("components/learn/lesson.tsx");
  assert.doesNotMatch(lesson, /<Cost/);
  assert.doesNotMatch(lesson, /askCost:|costs\./);
  assert.equal((lesson.match(/\{\.\.\.panelProps\}/g) ?? []).length, 4, "四种卡片都拿到 panelProps");


  // 回调是挂在按钮 / 输入框的 on* 属性上的，不是渲染时调用
  assert.match(lesson, /onSubmit=\{handleCreateSession\}/);
  assert.match(lesson, /onFollowUp=\{\(\) => handleFollowUp\(openSessionData\.id\)\}/);
  assert.match(lesson, /onReadDone=\{handleReadDone\}/);
  // 面板内部：只有点按钮或按回车才调用传进来的回调
  assert.match(panel, /onClick=\{props\.onSubmit\}/);
  assert.match(panel, /onClick=\{props\.onFollowUp\}/);
  assert.match(panel, /submitOnEnter\(props\.onSubmit,/);
  // 「问这篇」同样只在点「发送」或按回车时调用模型
  assert.match(lesson, /onSend=\{chat\.send\}/);
  assert.match(panel, /onClick=\{props\.onSend\}/);
  assert.match(panel, /submitOnEnter\(props\.onSend,/);
});

test("生成下一篇：状态一变成 generating 就平滑滚到流式内容的开头（减弱动效时直接跳），且预览卡片够高，开头能滚到屏幕顶部", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const sf = parse("lesson.tsx", lesson);
  const effects = find(
    sf,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText() === "useEffect" &&
      n.getText().includes("scrollIntoView")
  );
  assert.equal(effects.length, 1);
  const effect = effects[0].getText();
  assert.match(effect, /if \(!generating\) return;/);
  assert.match(effect, /prefers-reduced-motion: reduce/);
  assert.match(effect, /behavior: reduced \? "auto" : "smooth"/);
  assert.match(effect, /block: "start"/);
  assert.match(effect, /\[generating\]\)$/);
  // 滚动本身不调接口
  assert.doesNotMatch(effect, /generateNextLesson|createAnnotation/);

  const feedback = await read("components/learn/lesson-feedback.tsx");
  assert.match(feedback, /min-h-\[calc\(100dvh-8rem\)\] rounded-xl/);
  const css = await read("app/learn.css");
  assert.match(css, /html:has\(\.lesson-page\) \{\s*scroll-padding-top: calc\(var\(--header-height\) \+ 4rem\);/);
  assert.equal((lesson.match(/className="lesson-page /g) ?? []).length, 2);
});

test("触屏上长按选字不会触发 mouseup：粗指针设备用 selectionchange（等选区稳定）补上，桌面不受影响，只对课文正文内的选区生效", async () => {
  const text = await read("components/learn/lesson.tsx");
  assert.match(text, /matchMedia\("\(pointer: coarse\)"\)\.matches/);
  assert.match(text, /document\.addEventListener\("selectionchange", onChange\)/);
  assert.match(text, /prose\?\.contains\(sel\.anchorNode\)/);
  assert.match(text, /onMouseUp=\{handleTextSelect\}/);
});

test("选字出气泡后鼠标选的字留着（Cmd+C、右键复制能用），只在触屏上收掉选区；点了「标记」才收掉", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /if \(window\.matchMedia\("\(pointer: coarse\)"\)\.matches\) selection\.removeAllRanges\(\);/);
  assert.doesNotMatch(lesson, /^\s*selection\.removeAllRanges\(\);/m);
  assert.match(lesson, /quoteTooLong\(marker\.selectedText\)\) return;\n\s*\/\/[^\n]*\n\s*window\.getSelection\(\)\?\.removeAllRanges\(\);\n\s*const route = highlightRoute;/);
  const pdf = await read("components/learn/pdf-viewer.tsx");
  assert.match(pdf, /if \(window\.matchMedia\("\(pointer: coarse\)"\)\.matches\) sel\.removeAllRanges\(\);/);
  assert.doesNotMatch(pdf, /^\s*sel\.removeAllRanges\(\);/m);
});

test("没写完的提问不会因为点了一下别处就丢：选区消失时保留有内容的提问框", async () => {
  const text = await read("components/learn/lesson.tsx");
  assert.match(text, /setComposer\(\(c\) => \(c\?\.draft\.trim\(\) \? c : null\)\)/);
});

test("Esc 收起卡片：新建提问或追问里写了一半不收起；输入法选字时的 Esc 不算；其它情况收起", async () => {
  const { shouldCloseOnEscape, draftOf, withDraft } = await import("../src/lib/learn/panel-keys.ts");
  const esc = { key: "Escape", defaultPrevented: false, isComposing: false, keyCode: 27 };
  const none = { composer: "", follow: "" };
  assert.equal(shouldCloseOnEscape(esc, none), true);
  assert.equal(shouldCloseOnEscape(esc, { composer: "  ", follow: "\n" }), true);
  // 新建提问写了一半、已有问答里追问写了一半：都不收起
  assert.equal(shouldCloseOnEscape(esc, { composer: "为什么", follow: "" }), false);
  assert.equal(shouldCloseOnEscape(esc, { composer: "", follow: "再讲一下" }), false);
  // 输入法选字中的 Esc（Chrome 的 isComposing，Safari 的 keyCode 229）
  assert.equal(shouldCloseOnEscape({ ...esc, isComposing: true }, none), false);
  assert.equal(shouldCloseOnEscape({ ...esc, isComposing: false, keyCode: 229 }, none), false);
  // 别的键、已被别处处理的 Esc
  assert.equal(shouldCloseOnEscape({ ...esc, key: "Enter" }, none), false);
  assert.equal(shouldCloseOnEscape({ ...esc, defaultPrevented: true }, none), false);

  // 追问草稿按问答各记各的：收起再打开同一条还在，别的问答互不影响
  let drafts = {};
  drafts = withDraft(drafts, 7, "没发完的追问");
  drafts = withDraft(drafts, "tmp-1", "另一条");
  assert.equal(draftOf(drafts, 7), "没发完的追问");
  assert.equal(draftOf(drafts, "7"), "没发完的追问");
  assert.equal(draftOf(drafts, 8), "");
  assert.equal(draftOf(drafts, null), "");
  assert.equal(draftOf(withDraft(drafts, 7, ""), 7), "");

  // 页面：Esc 走 shouldCloseOnEscape；重新打开同一条问答（openSession）不清空草稿
  const page = await read("components/learn/lesson.tsx");
  assert.match(page, /shouldCloseOnEscape\(e, \{ composer: composerDraft, follow: followDraft \}\)/);
  const open = page.slice(page.indexOf("const openSession ="), page.indexOf("const openComposerFromMarker"));
  assert.doesNotMatch(open, /Draft/, "openSession 不该碰追问草稿");
});

test("课文页的反馈：反馈卡片里只有「保存反馈」，「读完了 — 生成下一篇」在单独的「下一步」块里；回看更早的课文显示「下一篇 →」", async () => {
  const feedback = await read("components/learn/lesson-feedback.tsx");
  const card = feedback.slice(
    feedback.indexOf("export function FeedbackCard"),
    feedback.indexOf("function NextStepFrame")
  );
  assert.match(card, /lesson\.feedback\.save/);
  assert.doesNotMatch(card, /lesson\.next\./);
  assert.match(feedback, /export function GenerateStep/);
  assert.match(feedback, /t\("lesson\.next\.goNext"\)/);

  const zh = JSON.parse(await read("i18n/messages/zh.json"));
  const en = JSON.parse(await read("i18n/messages/en.json"));
  assert.equal(zh.learn.lesson.next.goNext, "下一篇 →");
  assert.equal(en.learn.lesson.next.goNext, "Next lesson →");

  // 生成过程中不能再改反馈（保存后才会生成，改了也不会进入这一篇）
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /disabled=\{generating\}/);
});

test("桌面右栏的「文件 / 课文」列表默认收起，点那一行展开：展开了记在本机、换一篇和刷新都还展开着、刷新不闪，下面的划线提问、标记、翻译几组不跟着收", async () => {
  const nav = await read("components/learn/lesson-nav.tsx");
  const rail = nav.slice(nav.indexOf("// 桌面右侧栏里的章节导航"), nav.indexOf("// 手机 / 平板"));
  // 服务端照展开渲染出列表（客户端没展开过就由 CSS 先藏起来），客户端读本机：没记过就是收着
  assert.match(rail, /const collapsed = !useSyncExternalStore\(subscribeLessonNav, readLessonNavExpanded, \(\) => true\);/);
  assert.match(rail, /aria-expanded=\{!collapsed\}/);
  assert.match(rail, /onClick=\{\(\) => saveLessonNavExpanded\(collapsed\)\}/);
  // 收起时不渲染列表、也不滚到当前篇
  assert.match(rail, /lessonsHidden=\{collapsed\} visible=\{visible && !collapsed\}/);
  assert.match(nav, /\{!lessonsHidden && \(\s*<ul ref=\{listRef\} id=\{listId\}/);
  // 只收课文 / 文件列表：几组 RailGroup 在 <ul> 外面
  assert.ok(nav.indexOf("{sessions.length > 0 && (") > nav.indexOf("{!lessonsHidden && ("));
  // 手机抽屉、问答卡片打开时的那一行目录不受影响
  assert.doesNotMatch(nav.slice(nav.indexOf("export function ChapterDrawer")), /lessonsHidden/);

  // 刷新不闪：根布局在首次绘制前按 localStorage 设 <html data-lesson-nav="expanded">，没有它 learn.css 就先藏起紧跟在那一行后面的列表
  const store = await read("lib/learn/lesson-nav.ts");
  assert.match(store, /const KEY = "bloom:lesson-nav-expanded";/);
  assert.match(store, /d\.dataset\.lessonNav="expanded"/);
  assert.match(store, /return document\.documentElement\.dataset\.lessonNav === "expanded";/);
  assert.doesNotMatch(store, /from "react"/, "根布局是服务端组件，引它的模块不能带客户端 hook");
  assert.match(await read("app/layout.tsx"), /<script dangerouslySetInnerHTML=\{\{ __html: LESSON_NAV_SCRIPT \}\} \/>/);
  const css = await read("app/learn.css");
  assert.match(css, /:root:not\(\[data-lesson-nav="expanded"\]\) \.lesson-nav-toggle \+ ul \{\s*display: none;/);
  assert.match(css, /:root:not\(\[data-lesson-nav="expanded"\]\) \.lesson-nav-toggle > svg \{\s*rotate: none;/);
  assert.match(rail, /className="lesson-nav-toggle /);
});

test("桌面右栏滚动时「文件 / 课文」和提问、标记、翻译几组的标题行吸顶：每行只在自己那一组里吸，手机抽屉和问答卡片那一行目录里不吸", async () => {
  const nav = await read("components/learn/lesson-nav.tsx");
  // 「文件 / 课文」那一行和列表包在同一块里，吸顶只吸到列表结束
  assert.match(nav, /<div>\s*\{head\}\s*\{!lessonsHidden && \(\s*<ul ref=\{listRef\}/);
  assert.match(nav, /<ChapterList \{\.\.\.props\} head=\{head\}/);
  assert.match(nav, /className="lesson-nav-toggle rail-head /);
  // 几组的标题行在各自的块里
  const group = nav.slice(nav.indexOf("function RailGroup("));
  assert.match(group, /<div className=\{cn\("mt-4 border-t pt-3", className\)\}>\s*<button[\s\S]*?className="rail-head /);
  const css = await read("app/learn.css");
  // 只在右栏里吸；放在 components 层，hover:bg-muted 盖得过底色
  assert.match(css, /@layer components \{\s*\.learn-rail \.rail-head \{\s*position: sticky;\s*top: 0;\s*z-index: 10;\s*background-color: var\(--background\);/);
  assert.match(css, /\.learn-rail:has\(\.rail-head\) \{\s*scroll-padding-top: 2\.75rem;/);
  // 右栏四周留给聚焦轮廓的 4px：标题上面垫一条同色的，滚上去的列表不从标题上沿露出来；不接鼠标
  assert.match(css, /\.learn-rail \.rail-head::before \{[^}]*bottom: 100%;[^}]*height: 0\.25rem;[^}]*background-color: var\(--background\);[^}]*pointer-events: none;/);
  // 收起时的「先藏列表」仍然靠紧跟在那一行后面的 <ul>
  assert.match(css, /\.lesson-nav-toggle \+ ul/);
});

test("课文列表：用链接（可中键打开）、当前篇 aria-current、已读打勾；桌面是右侧粘性侧栏，小屏是抽屉；「N 个划线提问」点开是本篇问答列表", async () => {
  const nav = await read("components/learn/lesson-nav.tsx");
  assert.match(nav, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(nav, /<Check/);
  assert.match(nav, /t\("lesson\.highlightCount", \{ count: sessions\.length \}\)/);
  assert.match(nav, /<Sheet open=\{open\} onOpenChange=\{onOpenChange\}>/);
  // 划线提问数是个按钮（展开本篇问答列表），点一条打开那条；抽屉里点了还要关抽屉
  assert.match(nav, /aria-expanded=\{open\}/);
  assert.match(nav, /onOpenSession\(s\.id\);\s*onNavigate\?\.\(\);/);
  // 同一列里还有「我的标记（N）」：点一条滚到正文里那一段，行尾的 × 直接删
  assert.match(nav, /t\("lesson\.markedPassages", \{ count: marks\.length \}\)/);
  assert.match(nav, /onJumpMark\?\.\(m\.id\);\s*onNavigate\?\.\(\);/);
  assert.match(nav, /onRemoveMark\(m\.id\)/);

  const lesson = await read("components/learn/lesson.tsx");
  // 右栏的标记列表接的是本篇的标记：点一条滚过去、× 直接删
  assert.match(lesson, /onJumpMark: jumpToMark/);
  assert.match(lesson, /marks: highlights\.map\(\(h\) => \(\{ id: h\.id, original_text: h\.original_text \}\)\)/);
  // 旧的底部「我的标记」列表已经并进右栏，不再有第二份
  assert.doesNotMatch(lesson, /id="saved-highlights"/);
  // 滚到当前篇：只滚传进来的容器（桌面是右侧栏、小屏是抽屉里的 nav），不再向上找可滚动的祖先
  assert.match(lesson, /<LessonNav \{\.\.\.navProps\} scrollRef=\{railRef\} visible=\{!panelOpen\} \/>/);
  assert.match(lesson, /onOpenSession: revealSession/);
  assert.match(nav, /scrollRef=\{boxRef\}/);
  assert.doesNotMatch(nav, /getComputedStyle|parentElement/);
  // display:none 的实例（小屏上的桌面侧栏）和让位时不跑
  assert.match(nav, /!visible \|\| !list \|\| !box \|\| !list\.getClientRects\(\)\.length/);
  assert.match(lesson, /<ChapterDrawer/);
  // 抽屉按钮只在 lg 以下出现
  const bar = await read("components/learn/lesson-bar.tsx");
  assert.match(bar, /<ChaptersButton onClick=\{onOpenNav\} expanded=\{navOpen\} \/>/);
  assert.match(nav, /export function ChaptersButton/);
  assert.match(nav, /h-10 items-center gap-1\.5 rounded-md border border-foreground\/20 px-3\.5 text-\[13px\] font-medium transition-colors hover:border-foreground\/30 hover:bg-muted lg:hidden/);
  // 右栏的标题叫「课文」（课程页之外的两页都一样），不再有「章节」
  const { default: zh } = await import("../src/i18n/messages/zh.json", { with: { type: "json" } });
  const { default: en } = await import("../src/i18n/messages/en.json", { with: { type: "json" } });
  assert.equal(zh.learn.lesson.chapters, zh.learn.syllabus.lessons);
  assert.equal(zh.learn.lesson.chapters, "课文");
  assert.equal(en.learn.lesson.chapters, en.learn.syllabus.lessons);
  assert.equal(en.learn.lesson.chapters, "Lessons");
  assert.doesNotMatch(JSON.stringify({ ...zh.learn.lesson, ...zh.learn.syllabus, ...zh.learn.course }), /章节/);
});

test("页边圆点：可点区域 ≥ 16px（手机 24px、桌面 28px），title 是「查看提问」、aria-label 是「查看提问：问题」，卡片开着的那条放大；被问的句子用更明显的高亮", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const dot = lesson.slice(lesson.indexOf("{!editing && sessions.map((s) => ("), lesson.indexOf("</article>"));
  // 再点同一颗圆点收起卡片（开着时不该只能去卡片右上角点 ×），文案随之变成「收起」
  assert.match(dot, /onClick=\{\(\) => \(openId === s\.id \? closePanel\(\) : openSession\(s\.id\)\)\}/);
  assert.match(dot, /title=\{openId === s\.id \? t\("lesson\.minimize"\) : t\("lesson\.viewSession"\)\}/);
  assert.match(dot, /aria-label=\{openId === s\.id \? t\("lesson\.minimize"\) : t\("lesson\.openSession", \{ question: s\.comment \}\)\}/);
  assert.match(dot, /size-6[^"]*lg:size-7/);
  assert.match(dot, /openId === s\.id \? "size-3\.5 ring-ring\/40" : "size-3 ring-ring\/20"/);
  const zh = JSON.parse(await read("i18n/messages/zh.json"));
  const en = JSON.parse(await read("i18n/messages/en.json"));
  assert.equal(zh.learn.lesson.viewSession, "查看提问");
  assert.match(zh.learn.lesson.openSession, /^查看提问：/);
  assert.equal(en.learn.lesson.viewSession, "View question");
  assert.equal(zh.learn.lesson.minimize, "收起");

  const highlight = await read("lib/learn/highlight.ts");
  assert.match(highlight, /::highlight\(bloom-active\)[^}]*52%/);
  assert.match(lesson, /CSS\.highlights\.set\("bloom-active", active\)/);
  assert.match(lesson, /active\.priority = 2;/);
  // 回答 15px（标准字号；和课文一样乘正文字号 --text-scale，不按区域另调）/ 行高 1.7
  const css = await read("app/learn.css");
  assert.match(css, /\.prose-bloom\.prose-compact \{\s*font-size: calc\(0\.9375rem \* var\(--text-scale\)\);\s*line-height: 1\.7;/);
  assert.doesNotMatch(css, /--compact-scale/);
});

test("正文字号放大时汉字比西文放大得少：按中英文分，不按正文 / 问答区分；默认档不变", async () => {
  const globals = await read("app/globals.css");
  const theme = await read("app/theme.css");
  assert.match(globals, /\.prose-bloom \{\s*font-family: var\(--font-reading\);\s*text-autospace: normal;/); // 汉字和英文、数字之间自动空一条细缝
  assert.match(theme, /:root \{[^}]*--text-scale-cjk: 1;\s*--cjk-ratio: calc\(var\(--text-scale-cjk\) \/ var\(--text-scale\)\);\s*--font-reading: var\(--font-sans\);/);
  // 中文段落整段换成汉字的倍数（夹在里面的英文、数字跟着一起缩），用原样黑体；放在 components 层，别处定的字号照旧优先
  assert.match(globals, /@layer components \{\s*\.prose-bloom > \[data-script="cjk"\] \{\s*--text-scale: var\(--text-scale-cjk\);\s*font-size: calc\(1em \* var\(--cjk-ratio\)\);\s*font-family: var\(--font-sans\);/);
  // 西文：较大档 = 原来的特大（×1.4），特大再大一档；汉字按「看起来和西文一样大」缩到 90% / 85.7% / 85%，
  // 较大档整体和原来的特大一样（汉字 ×1.2）；缩到 80% 以下，中文句子里夹的英文会显得又大又重
  const latin = { lg: 1.2, xl: 1.4, xxl: 1.6 };
  const cjk = { lg: 1.08, xl: 1.2, xxl: 1.36 };
  for (const size of ["lg", "xl", "xxl"]) {
    const scale = Number(theme.match(new RegExp(`:root\\[data-text-size="${size}"\\] \\{\\s*--text-scale: ([\\d.]+);`))[1]);
    assert.equal(scale, latin[size]);
    assert.match(theme, new RegExp(`:root\\[data-text-size="${size}"\\] \\{[^}]*--text-scale-cjk: ${cjk[size]};`));
    assert.match(theme, new RegExp(`:root\\[data-text-size="${size}"\\] \\{[^}]*--font-reading: "Bloom CJK ${size}", var\\(--font-sans\\);`));
    const faces = [...globals.matchAll(new RegExp(`@font-face \\{\\s*font-family: "Bloom CJK ${size}";[^}]*\\}`, "g"))].map((m) => m[0]);
    assert.equal(faces.length, 3); // 常规、中粗、粗：各自对上系统黑体的字重，加粗不靠浏览器假粗
    for (const face of faces) {
      const adjust = Number(face.match(/size-adjust: ([\d.]+)%;/)[1]) / 100;
      assert.ok(Math.abs(adjust * scale - cjk[size]) < 0.001, `${size}: 汉字倍数应为 ×${cjk[size]}`);
      assert.ok(adjust >= 0.85, `${size}: 汉字不能比西文小太多`);
      assert.match(face, /local\("PingFangSC-/);
      assert.match(face, /local\("Microsoft YaHei/);
      assert.match(face, /unicode-range: U\+2460-24FF, U\+2E80-9FFF,/); // 只管汉字、假名、全角标点和 ①，不碰西文
    }
  }
  for (const size of ["sm", "md"]) assert.doesNotMatch(globals, new RegExp(`"Bloom CJK ${size}"`));
  assert.match(theme, /:root\[data-text-size="sm"\] \{\s*--text-scale: 0\.9;\s*--text-scale-cjk: 0\.9;/);
});

test("PDF 课文的划线层用令牌色的 CSS 类，不再在脚本里写固定的黄色", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  assert.doesNotMatch(pdf, /rgba?\(|#fff|250,204,21/);
  assert.match(pdf, /div\.className = "pdf-hl"/);
  const css = await read("app/learn.css");
  assert.match(css, /\.pdf-viewer \.pdf-hl \{[^}]*color-mix\(in oklab, var\(--primary\)/);

  const highlight = await read("lib/learn/highlight.ts");
  assert.match(highlight, /::highlight\(bloom-ann\)[^}]*var\(--primary\)/);
  assert.match(highlight, /::highlight\(bloom-pending\)[^}]*var\(--primary\)/);
});

test("页边小圆点：几条问答落在同一处时纵向错开，顺序不变、不相互覆盖", async () => {
  const { spreadDots } = await import("../src/lib/learn/dots.ts");
  const spread = spreadDots([
    { id: 1, top: 400 },
    { id: "tmp-2", top: 400 },
    { id: 3, top: 405 },
    { id: 4, top: 900 },
  ]);
  assert.deepEqual([...spread.entries()].sort((a, b) => a[1] - b[1]), [
    [1, 400],
    ["tmp-2", 422],
    [3, 444],
    [4, 900],
  ]);
  assert.equal(spreadDots([]).size, 0);
  // 没有重叠时位置原样
  assert.equal(spreadDots([{ id: 1, top: 10 }]).get(1), 10);
});

test("划线定位：原文出现好几处时取离存档位置最近的一处——无偏移时选中第二处、前后偏移（含上千字符）都落回对的那处", async () => {
  const { locateOffsets } = await import("../src/lib/learn/highlight.ts");
  const at = (plain, text, start, end = start + text.length) =>
    locateOffsets({ textContent: plain }, {
      original_text: text,
      position_start: start,
      position_end: end,
    });

  // 评审给的反例：划的是第二个「复利」（存档位置 8）
  const plain = "复利就是利滚利，复利的威力很大";
  assert.deepEqual(at(plain, "复利", 8), [8, 10]);
  assert.deepEqual(at(plain, "复利", 0), [0, 2]);

  // 同一个词出现很多次
  const many = "利息。".repeat(5) + "x" + "利息。".repeat(5);
  const third = many.indexOf("利息", 6);
  assert.deepEqual(at(many, "利息", third), [third, third + 2]);
  assert.equal(many.slice(...at(many, "利息", 22)), "利息");

  // 文本变长（存档比现在偏小：评估篇开头 `<!-- eval-article -->` 以前当文字渲染，加元信息排版，约 26 个字符）
  const body = "开头。" + "填".repeat(300) + "复利很重要" + "填".repeat(300) + "复利的威力" + "。";
  const second = body.lastIndexOf("复利");
  assert.deepEqual(at(body, "复利", second + 26), [second, second + 2]);
  const first = body.indexOf("复利");
  assert.deepEqual(at(body, "复利", first + 26), [first, first + 2]);

  // 文本变短（美元金额修好后渲染文本少了上千字符）：存档位置比现在偏大 1200，甚至超出现在的文末
  const short = "x".repeat(100) + "interest" + "y".repeat(1500) + "interest" + "z".repeat(50);
  const tailAt = short.lastIndexOf("interest");
  assert.deepEqual(at(short, "interest", tailAt + 1200), [tailAt, tailAt + 8]);
  const headAt = short.indexOf("interest");
  assert.deepEqual(at(short, "interest", headAt + 300), [headAt, headAt + 8]);

  // 原文找不到时退回存档位置；存档位置也不可用时是 null
  assert.deepEqual(at("abc", "", 1, 3), [1, 3]);
  assert.deepEqual(at("abc", "不存在", 1, 3), [1, 3]);
  assert.equal(at("abc", "不存在", 2, 2), null);
});

// ── 会调用模型的回调只能挂在 on* 属性上 ──
// 面板和反馈块拆成了单独的组件，no-auto-charge.test 只扫「调用了模型接口的 handle*」，看不到这里的 props.onSubmit 等：
// 它们被调用的地方只能是点击 / 回车的处理函数，不能出现在 useEffect 等副作用里，也不能在渲染时直接调用。
const NOT_EVENTS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useMemo",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "queueMicrotask",
]);

function chargedCallbackViolations(source, names) {
  const sf = parse("x.tsx", source);
  const bad = [];
  const isDeclaration = (n) => {
    const p = n.parent;
    return (
      (ts.isBindingElement(p) && p.name === n) ||
      (ts.isParameter(p) && p.name === n) ||
      (ts.isPropertySignature(p) && p.name === n) ||
      (ts.isJsxAttribute(p) && p.name === n) ||
      ts.isImportSpecifier(p)
    );
  };
  const refs = find(sf, (n) => {
    if (!ts.isIdentifier(n) || !names.includes(n.text) || isDeclaration(n)) return false;
    // props.onSubmit：只取整个属性访问；别的对象上的同名属性不算
    if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) {
      return n.parent.expression.getText() === "props";
    }
    return true;
  }).map((n) => (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n));

  for (const ref of refs) {
    const chain = [];
    for (let n = ref.parent; n; n = n.parent) chain.push(n);
    const attr = chain.find((n) => ts.isJsxAttribute(n) && /^on[A-Z]/.test(n.name.getText()));
    const inEffect = chain.find(
      (n) =>
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        NOT_EVENTS.has(n.expression.text)
    );
    // 直接调用（props.onSubmit()）必须包在事件处理函数里：引用和 on* 属性之间要隔着一个函数
    const invoked = ts.isCallExpression(ref.parent) && ref.parent.expression === ref;
    const wrapped =
      attr &&
      chain
        .slice(0, chain.indexOf(attr))
        .some((n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n));
    if (!attr || inEffect || (invoked && !wrapped)) bad.push(ref.getText());
  }
  return bad;
}

test("调用模型的回调（onSubmit / onFollowUp / onReadDone）只出现在 on* 属性或回车处理里：不在 useEffect 里，不在渲染时直接调用", async () => {
  const panel = await read("components/learn/annotation-panel.tsx");
  const feedback = await read("components/learn/lesson-feedback.tsx");
  // 能找到引用，扫描没有空转
  assert.ok((panel.match(/props\.onSubmit|props\.onFollowUp/g) ?? []).length >= 4);
  assert.ok((feedback.match(/onReadDone/g) ?? []).length >= 3);
  assert.deepEqual(chargedCallbackViolations(panel, ["onSubmit", "onFollowUp"]), []);
  assert.deepEqual(chargedCallbackViolations(feedback, ["onReadDone"]), []);

  // 反例：扫描真的抓得到
  const names = ["onSubmit", "onFollowUp", "onReadDone"];
  const inEffect = `function C(props) { useEffect(() => { props.onSubmit(); }, []); return <b onClick={props.onSubmit} />; }`;
  assert.deepEqual(chargedCallbackViolations(inEffect, names), ["props.onSubmit"]);
  const destructured = `function C({ onReadDone }) { useEffect(() => { onReadDone(); }); return <b onClick={onReadDone} />; }`;
  assert.deepEqual(chargedCallbackViolations(destructured, names), ["onReadDone"]);
  const inRender = `function C(props) { props.onFollowUp(); return <b />; }`;
  assert.deepEqual(chargedCallbackViolations(inRender, names), ["props.onFollowUp"]);
  const immediate = `function C(props) { return <b onClick={props.onSubmit()} />; }`;
  assert.deepEqual(chargedCallbackViolations(immediate, names), ["props.onSubmit"]);
  const timer = `function C(props) { setTimeout(() => props.onSubmit(), 10); return <b />; }`;
  assert.deepEqual(chargedCallbackViolations(timer, names), ["props.onSubmit"]);
  const layout = `function C({ onReadDone }) { useLayoutEffect(() => onReadDone(), []); return null; }`;
  assert.deepEqual(chargedCallbackViolations(layout, names), ["onReadDone"]);
  // 正确写法不报
  const ok = `function C(props) { return <b onClick={() => props.onFollowUp()} onKeyDown={submitOnEnter(props.onSubmit, true)} onFocus={props.onSubmit} />; }`;
  assert.deepEqual(chargedCallbackViolations(ok, names), []);
});

test("没有重复的实现：围栏跟踪只有一份，错误条只有一个组件，表格单元格的样式只写一遍", async () => {
  const text = await read("lib/learn/lesson-text.ts");
  assert.equal((text.match(/function codeLineMask/g) ?? []).length, 1);
  assert.doesNotMatch(text, /fenceLen|fenceChar/);
  assert.ok((text.match(/codeLineMask\(/g) ?? []).length >= 3);

  const lesson = await read("components/learn/lesson.tsx");
  assert.doesNotMatch(lesson, /border-destructive\/30/);
  assert.equal((lesson.match(/<LessonNotice/g) ?? []).length, 3);
  const feedback = await read("components/learn/lesson-feedback.tsx");
  assert.equal((feedback.match(/border-destructive\/30/g) ?? []).length, 1);

  const css = await read("app/learn.css");
  assert.equal((css.match(/\.lesson-table :is\(th, td\) \{/g) ?? []).length, 1);
  // 头部注释说清这些类也用于博客与问答回答
  assert.match(css.split("*/")[0], /博客/);
});

test("划线定位与公式定界符：含 \\( \\[ 的课文渲染后文本变长约 20%（公式的 MathML 与可见文字），旧划线仍落回原处；不含的课文不受影响", async () => {
  const { locateOffsets } = await import("../src/lib/learn/highlight.ts");
  // 本地库课程 17 的两篇（含 71 / 105 个公式）：渲染文本 3442 → 4173、5301 → 6602
  const at = (plain, text, start) =>
    locateOffsets({ textContent: plain }, {
      original_text: text,
      position_start: start,
      position_end: start + text.length,
    });
  // 第二个公式之后的一句独有的话：新文本里比存档位置靠后 700 个字符
  const plain = "甲".repeat(1000) + "这句话在公式之后。" + "乙".repeat(2000);
  const now = plain.indexOf("这句话");
  assert.deepEqual(at(plain, "这句话在公式之后。", now - 731), [now, now + 9]);
  // 同一句话出现两处且相隔足够远：靠近存档位置的那处
  const twice = "这句话。" + "丙".repeat(3000) + "这句话。";
  const second = twice.lastIndexOf("这句话。");
  assert.deepEqual(at(twice, "这句话。", second - 1301), [second, second + 4]);
  assert.deepEqual(at(twice, "这句话。", 0), [0, 4]);
});

test("课文首屏：服务端先取正文、课程和目录随页面带过来，浏览器不再取一遍正文；问答、标记、译文、反馈之后再取；标签页标题前后一致", async () => {
  const { lessonTabTitle } = await import("../src/lib/learn/lessons.ts");
  const t = (key, values = {}) =>
    ({ "common.lessonNumber": `第 ${values.number} 篇`, "lesson.tabTitle": `第 ${values.number} 篇：${values.title}` })[key];
  const lessons = [{ number: 2, title: "第 2 篇：贝叶斯推断" }];
  assert.equal(lessonTabTitle(t, 2, { lesson: null, course: null, lessons }), "第 2 篇：贝叶斯推断");
  assert.equal(lessonTabTitle(t, 3, { lesson: null, course: null, lessons }), "第 3 篇");
  assert.equal(lessonTabTitle(t, 2, { lesson: null, course: { is_project: false }, lessons: null }), "第 2 篇");
  const file = { source_filename: "notes.md" };
  assert.equal(lessonTabTitle(t, 2, { lesson: file, course: { is_project: true }, lessons }), "notes");
  assert.equal(lessonTabTitle(t, 2, { lesson: { source_filename: null }, course: { is_project: true }, lessons }), "第 2 篇");

  const start = await read("lib/learn/lesson-start.ts");
  for (const path of ["/lessons/${lessonNum}`", "/api/courses/${courseId}`", "/lessons`"]) assert.ok(start.includes(path), path);
  assert.doesNotMatch(start, /annotations|highlights|translations|feedback`/);
  assert.match(start, /export const lessonStart = cache\(/);
  assert.match(start, /\.catch\(\(\) => null\)/);

  const page = await read("app/[locale]/(default)/learn/course/[courseId]/lesson/[lessonNum]/page.tsx");
  const body = page.slice(page.indexOf("export default"));
  assert.ok(body.indexOf("notFound()") !== -1 && body.indexOf("notFound()") < body.indexOf("const initial = await lessonStart("), "先校验参数再取");
  assert.match(page, /title: `\$\{lessonTabTitle\(t, Number\(lessonNum\), start\)\} \| Bloom`/);

  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /useState<Lesson \| null>\(seed\?\.lesson \?\? null\)/);
  assert.match(lesson, /useState\(!seed\)/);
  assert.match(lesson, /const tabTitle = lessonTabTitle\(t, currentNum, \{ lesson, course, lessons: allLessons \}\);/);
  // 目录有了就显示，不等问答
  assert.match(lesson, /\{detailsReady \|\| lessonItems\.length \? <LessonNav/);
});

test("标记 / 取消标记先在页面上生效再在后台存，存失败撤回；还没存好的标记不能取消", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const save = lesson.slice(lesson.indexOf("const savePassageHighlight = async"), lesson.indexOf("const removePassageHighlight = async"));
  assert.ok(save.indexOf("setHighlights(items => [...items, { ...fields, id: pendingId") < save.indexOf("await api<PassageHighlight>"), "先画上再存");
  assert.ok(save.indexOf("clearPendingSelection();") < save.indexOf("await api<PassageHighlight>"), "气泡立刻收起");
  assert.match(save, /const pendingId = --pendingMarkRef\.current;/);
  assert.match(save, /catch \(err\) \{[\s\S]*setHighlights\(items => items\.filter\(item => item\.id !== pendingId\)\);[\s\S]*lesson\.markFailed/);
  assert.match(save, /item\.id !== pendingId && item\.id !== saved\.id/);

  const removeAt = lesson.indexOf("const removePassageHighlight = async");
  const remove = lesson.slice(removeAt, lesson.indexOf("const checkBackground", removeAt));
  assert.match(remove, /if \(!removed \|\| id < 0\) return;/);
  assert.ok(remove.indexOf("setHighlights(items => items.filter(item => item.id !== id));") < remove.indexOf("await api("), "先去掉再删");
  assert.match(remove, /err instanceof ApiError && err\.status === 404\)\) return;/);
  assert.match(remove, /\[\.\.\.items, removed\]/);
  assert.match(lesson, /if \(markId > 0\) marks\.set\(markId, range\);/);
  assert.doesNotMatch(lesson, /setMarking\(|marking === "new"/);

  const nav = await read("components/learn/lesson-nav.tsx");
  assert.match(nav, /disabled=\{m\.id < 0\}/);
  assert.doesNotMatch(nav, /removingMark/);
});
