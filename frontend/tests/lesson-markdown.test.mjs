import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

const { stripHtmlComments, hideFeedbackSection, hideBodyHeading, normalizeMath, prepareMarkdown } =
  await import("../src/lib/learn/lesson-text.ts");
const { remarkPlugins, rehypePlugins, lessonRehypePlugins, sourceLessonRehypePlugins, streamingLessonRehypePlugins } = await import(
  "../src/lib/learn/markdown-config.ts"
);
const { wordRuns } = await import("../src/lib/learn/words.ts");
const { isCjkText, rehypeScriptBlocks } = await import("../src/lib/learn/rehype-lesson.ts");

// 和 components/learn/markdown.tsx 里 <Markdown> 做的事一样（那个文件 import 了 CSS，node 里加载不了）
function render(text, lesson = false, streaming = false, source = false, { title, typography = false, restoreBold = false } = {}) {
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
      prepareMarkdown(text, { hideFeedback: lesson, hideBody: lesson, streaming, typography, restoreBold })
    )
  ).replaceAll(' data-script="cjk"', "");
}

// 标题里中文词外面的不换行片段不改变文字：拿掉标签之后和原文一样
const textOf = (html) => html.replace(/<[^>]+>/g, "");

const MASTERY =
  "<!-- mastery: 能够用自然频数重述并求解同一贝叶斯问题; 能够解释先验概率 -->";

test("剥掉 HTML 注释：单行、多行、行内，都不留下痕迹", () => {
  assert.equal(stripHtmlComments(`正文\n\n${MASTERY}`).trim(), "正文");
  assert.equal(
    stripHtmlComments("前<!-- a\nb\nc -->后"),
    "前后"
  );
  assert.equal(
    stripHtmlComments("<!-- eval-article -->\n# 标题"),
    "\n# 标题"
  );
  assert.equal(stripHtmlComments("没有注释的文本"), "没有注释的文本");
});

test("剥掉 HTML 注释：代码块与行内代码里的 <!-- --> 是内容，原样保留", () => {
  const fenced = "示例：\n\n```html\n<!-- 这是 HTML 注释 -->\n<p>x</p>\n```\n\n结束";
  assert.equal(stripHtmlComments(fenced), fenced);
  const tilde = "~~~\n<!-- x -->\n~~~";
  assert.equal(stripHtmlComments(tilde), tilde);
  assert.equal(
    stripHtmlComments("用 `<!-- x -->` 写注释 <!-- 内部 -->"),
    "用 `<!-- x -->` 写注释 "
  );
  // 围栏之后的注释照样被剥
  assert.equal(
    stripHtmlComments("```\n<!-- a -->\n```\n\n<!-- b -->正文"),
    "```\n<!-- a -->\n```\n\n正文"
  );
});

test("没闭合的 <!--：已完成的内容里它是正文，原样显示，后面的内容一个字都不能少（博客、问答回答都走这里）", () => {
  const text = "HTML 注释以 <!-- 开头。后面这句话很重要。\n\n最后一段也很重要。";
  assert.equal(stripHtmlComments(text), text);
  assert.equal(prepareMarkdown(text), text);
  assert.equal(prepareMarkdown(text, { hideFeedback: true }), text);
  const html = render(text);
  assert.match(html, /后面这句话很重要/);
  assert.match(html, /最后一段也很重要/);

  // 以围栏代码结尾的内容同样不受影响
  const fencedEnd = "说明 <!-- 没写完\n\n正文很重要。\n\n```js\nconst a = 1;\n```";
  assert.equal(stripHtmlComments(fencedEnd), fencedEnd);
  assert.equal(stripHtmlComments(fencedEnd, { streaming: true }), fencedEnd);

  // 闭合的照剥，没闭合的在它前面的正文照留
  assert.equal(
    stripHtmlComments("甲 <!-- 单独一个 \n\n乙", {}),
    "甲 <!-- 单独一个 \n\n乙"
  );
});

test("流式预览（streaming）：最后一个没闭合的 <!-- 到文末先藏起来，它之前的正文不动", () => {
  const opts = { streaming: true };
  assert.equal(stripHtmlComments("正文\n\n<!-- mastery: 还没写完", opts), "正文\n\n");
  assert.equal(stripHtmlComments("正文\n\n<!-", opts), "正文\n\n");
  assert.equal(stripHtmlComments("正文 <!", opts), "正文 ");
  assert.equal(stripHtmlComments("正文 <!--", opts), "正文 ");
  // 前面有一个正文里的裸 <!--：只藏最后那个
  assert.equal(
    stripHtmlComments("说明 <!-- 开头。后面。\n\n正文 <!-- mastery: 半截", opts),
    "说明 <!-- 开头。后面。\n\n正文 "
  );
  // 已经闭合的注释在流式里同样被剥
  assert.equal(stripHtmlComments("甲<!-- a -->乙", opts), "甲乙");
  // 不是流式就不藏
  assert.equal(
    stripHtmlComments("正文\n\n<!-- mastery: 还没写完"),
    "正文\n\n<!-- mastery: 还没写完"
  );
  // 渲染结果里也看不到
  assert.doesNotMatch(render("# T\n\n正文\n\n<!-- mastery: 能够", true, true), /mastery|&lt;!--/);
});

test("代码区域里的内容一律不动：缩进代码块、跨行的行内代码、围栏；列表里缩进的续段不是代码", () => {
  // 缩进代码块：注释、$ 都原样
  const indented = "段落\n\n    <!-- 缩进代码里的注释 -->\n    echo $5 and $6\n\n后文 <!-- x -->$7";
  assert.equal(
    prepareMarkdown(indented),
    "段落\n\n    <!-- 缩进代码里的注释 -->\n    echo $5 and $6\n\n后文 \\$7"
  );
  // 缩进代码块里夹着空行也算
  const gap = "前\n\n    a $1\n\n    b $2\n\n后 $3";
  assert.equal(prepareMarkdown(gap), "前\n\n    a $1\n\n    b $2\n\n后 \\$3");
  // 跨行的行内代码
  assert.equal(
    prepareMarkdown("用 `echo\n$5 and $6` 运行 $7"),
    "用 `echo\n$5 and $6` 运行 \\$7"
  );
  assert.equal(
    prepareMarkdown("用 `<!-- a\nb -->` 写注释"),
    "用 `<!-- a\nb -->` 写注释"
  );
  // 注释里夹着反引号：整个注释照剥
  assert.equal(prepareMarkdown("前 <!-- use `x` --> 后"), "前  后");
  // 列表项里缩进的续段是正文：注释照剥、$ 照转义
  assert.equal(
    prepareMarkdown("- 项目\n\n    续段 <!-- c --> $9\n"),
    "- 项目\n\n    续段  \\$9"
  );
  // 缩进的「## 你的反馈」是代码，不当标题
  const fb = "# T\n\n## 思考题\n\n    ## 你的反馈\n\n结尾";
  assert.equal(hideFeedbackSection(fb), fb);
  // 围栏里的 ## 你的反馈 也不当标题（原有行为，围栏跟踪合并后仍然成立）
  const fb2 = "# T\n\n## 思考题\n\n```md\n## 你的反馈\n```\n\n结尾";
  assert.equal(hideFeedbackSection(fb2), fb2);
});

test("渲染结果里没有注释，也没有被转义成文字的注释（<!-- 或 &lt;!--）", () => {
  const html = render(`# 标题\n\n正文\n\n${MASTERY}`);
  assert.doesNotMatch(html, /<!--|&lt;!--|mastery/);
  assert.match(html, /正文/);
  // 博客等非课文内容同样剥掉
  assert.doesNotMatch(render(`段落\n\n${MASTERY}`), /<!--|&lt;!--|mastery/);
});

test("隐藏末尾的「你的反馈」占位小节：中文，连同其后的内容（含 mastery 注释）", () => {
  const lesson = `# 02 · 标题\n\n## 思考题\n\n- 题一\n\n## 你的反馈\n\n> 在这里写下你的问题。\n\n${MASTERY}`;
  const text = prepareMarkdown(lesson, { hideFeedback: true });
  assert.equal(text, "# 02 · 标题\n\n## 思考题\n\n- 题一");
  const html = render(lesson, true);
  assert.doesNotMatch(html, /你的反馈|在这里写下/);
  assert.match(html, /题一/);
});

test("隐藏末尾的「你的反馈 / Your feedback」占位小节：英文，大小写、冒号、加粗都认", () => {
  for (const heading of [
    "## Your feedback",
    "## your FEEDBACK",
    "## Your feedback:",
    "## **Your feedback**",
    "##  你的反馈：",
    "## 你的反馈 ##",
  ]) {
    const lesson = `# T\n\n## Reflection questions\n\n1. Q?\n\n${heading}\n\n> Write here.\n\n### 子节\n\n更多`;
    assert.equal(
      hideFeedbackSection(lesson),
      "# T\n\n## Reflection questions\n\n1. Q?",
      heading
    );
  }
});

test("只隐藏「最后一个」二级标题是反馈的情况：其它位置的同名标题、三级标题、代码块里的都不动", () => {
  const middle = "# T\n\n## 你的反馈\n\n中间的\n\n## 思考题\n\n- 题";
  assert.equal(hideFeedbackSection(middle), middle);

  const h3 = "# T\n\n## 思考题\n\n### 你的反馈\n\n内容";
  assert.equal(hideFeedbackSection(h3), h3);

  const other = "# T\n\n## 反馈回路\n\n讲系统里的反馈。";
  assert.equal(hideFeedbackSection(other), other);

  const fenced = "# T\n\n## 思考题\n\n```md\n## 你的反馈\n```\n\n结尾";
  assert.equal(hideFeedbackSection(fenced), fenced);

  const none = "# T\n\n只有正文，没有二级标题";
  assert.equal(hideFeedbackSection(none), none);
});

test("只在课文里隐藏反馈小节：博客与其它内容里同名标题照常显示", () => {
  const post = "# 文章\n\n## 你的反馈\n\n欢迎留言";
  assert.match(render(post, false), /你的反馈/);
  assert.doesNotMatch(render(post, true), /你的反馈/);
});

test("元信息引用块（中文，两个空格硬换行）排成一行：键、值分开，长的前置知识单独成行", () => {
  const html = render(
    "# 02 · 标题\n\n> 前置知识：第1篇中定义的四个核心概念（先验、似然、假阳性率、后验）；基本乘法运算  \n> 难度：入门  \n> 预计阅读时间：10 分钟  \n\n---\n\n## 正文内容\n\n内容",
    true
  );
  assert.doesNotMatch(html, /<blockquote/);
  assert.match(html, /<div class="lesson-meta">/);
  assert.match(
    html,
    /<span class="lesson-meta-item"><span class="lesson-meta-key">难度：<\/span><span class="lesson-meta-val">入门<\/span><\/span>/
  );
  assert.match(html, /lesson-meta-item lesson-meta-long/);
  // 中文页的元信息行用正文字体，只有数字和拉丁字母包成 .lesson-mono（等宽）
  assert.match(html, /预计阅读时间：<\/span><span class="lesson-meta-val"><span class="lesson-mono">10<\/span> 分钟/);
  // 「正文内容」这一层二级标题本身没有信息，渲染时隐藏；正文照常
  assert.doesNotMatch(html, /正文内容/);
  assert.match(html, /<p>内容<\/p>/);
});

test("元信息引用块（英文，没有硬换行）同样认", () => {
  const html = render(
    "# 01 · Compound interest\n\n> Prerequisites: percentages; basic arithmetic\n> Difficulty: Beginner\n> Estimated reading time: 6 minutes\n\n## Main content\n\nBody",
    true
  );
  assert.doesNotMatch(html, /<blockquote/);
  assert.match(html, /<span class="lesson-meta-key">Prerequisites:<\/span><span class="lesson-meta-val">percentages; basic arithmetic<\/span>/);
  assert.match(html, /<span class="lesson-meta-key">Difficulty:<\/span><span class="lesson-meta-val">Beginner<\/span>/);
  assert.match(html, /Estimated reading time:<\/span><span class="lesson-meta-val">6 minutes/);
});

test("普通引用块不会被当成元信息：不在标题后面，或者有一行不是元信息键", () => {
  const later = "# T\n\n正文\n\n> 难度：入门";
  assert.match(render(later, true), /<blockquote>/);
  const mixed = "# T\n\n> 难度：入门\n> 这是一句普通的话";
  assert.match(render(mixed, true), /<blockquote>/);
  const note = "# T\n\n> 📝 本模块评估你对上一篇思考题的回答。\n\n## 复盘";
  assert.match(render(note, true), /<blockquote>/);
  // 非课文内容不做这个变换
  assert.match(render("# T\n\n> 难度：入门", false), /<blockquote>/);
});

test("表格外包一层可横向滚动的容器（课文与非课文都是）", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
  for (const lesson of [true, false]) {
    const html = render(md, lesson);
    assert.match(html, /<div class="lesson-table"><table>/);
    assert.equal((html.match(/lesson-table/g) ?? []).length, 1);
  }
});

test("美元金额里的 $ 不当成公式：一对 $ 之间夹着金额时，整段不会被渲染成 LaTeX", () => {
  const text =
    "Suppose you deposit $1,000 and the rate is 10%, which is $100. After three years: $1,000 + $100 + $100 + $100 = $1,300. Between $5-$10 is fine; it costs $5.";
  assert.equal(normalizeMath(text), text.replaceAll("$", "\\$"));
  const html = render(text);
  assert.doesNotMatch(html, /katex/);
  assert.match(html, /\$1,000 and the rate is 10%, which is \$100\. After/);
});

test("真正的公式照常渲染：行内 $…$（含以数字开头的）、$$ 显示公式、行内代码与代码块里的 $ 不动", () => {
  const inline = "Let $x^2 + y^2 = r^2$ hold, with $5x$ and $a$, $b$.";
  assert.equal(normalizeMath(inline), inline);
  assert.equal((render(inline).match(/class="katex"/g) ?? []).length, 4);

  const block = "$$\nE = mc^2\n$$";
  assert.equal(normalizeMath(block), block);
  assert.match(render(block), /katex-display/);

  const code = "用 `echo $HOME` 或\n\n```bash\necho $5 and $6\n```\n";
  assert.equal(normalizeMath(code), code);

  // 同一段里金额和公式混着：金额转义，公式照旧
  const mixed = "It costs $5 today, and $x$ is the rate.";
  assert.equal(normalizeMath(mixed), "It costs \\$5 today, and $x$ is the rate.");

  // 已经转义的、没配对的 $
  assert.equal(normalizeMath("a \\$5 b"), "a \\$5 b");
  assert.equal(normalizeMath("only $ here"), "only \\$ here");
});

test("Markdown 组件：所有内容都经过 prepareMarkdown，只有 lesson 才隐藏反馈小节；课文页给课文与流式预览传 lesson", async () => {
  const markdown = await readFile(
    new URL("../src/components/learn/markdown.tsx", import.meta.url),
    "utf8"
  );
  assert.match(markdown, /markdownText\(children, \{ lesson, streaming, typography, restoreBold \}\)/);
  const text = await readFile(new URL("../src/lib/learn/lesson-text.ts", import.meta.url), "utf8");
  assert.match(text, /prepareMarkdown\(text, \{ hideFeedback: lesson, hideBody: lesson, \.\.\.options \}\)/);
  // 课文：原文篇带课程名、流式预览不带阅读时间、其余是普通课文；非课文用通用的
  assert.match(markdown, /useMemo\(\(\) => sourceLessonRehypePlugins\(title\), \[title\]\)/);
  assert.match(markdown, /lesson \? \(source \? sourcePlugins : streaming \? streamingLessonRehypePlugins : lessonPlugins\) : rehypePlugins/);
  // 思考题小节末尾的说明（参考答案写在下一篇末尾）由课文页的 Markdown 补上
  assert.match(markdown, /const note = t\("thoughtsNote"\)/);
  assert.match(markdown, /lessonRehypePluginsWithNote\(note\)/);
  assert.match(markdown, /components=\{scrollFadeComponents\}/);
  // 课文图片不发送来源，否则微信防盗链会换成占位图
  const fade = await readFile(new URL("../src/components/learn/zoomable-image.tsx", import.meta.url), "utf8");
  assert.equal(fade.match(/referrerPolicy="no-referrer"/g)?.length, 2); // 正文缩略图和放大后的查看器

  const page = await readFile(
    new URL("../src/components/learn/lesson.tsx", import.meta.url),
    "utf8"
  );
  assert.match(page, /<Markdown \{\.\.\.markdownOptions\} sectionIds title=\{course\?\.name\}>\s*\{lesson\?\.content\}\s*<\/Markdown>/);
  assert.match(page, /<GeneratingCard ref=\{streamRef\} content=\{streamContent\} \/>/);

  const feedback = await readFile(
    new URL("../src/components/learn/lesson-feedback.tsx", import.meta.url),
    "utf8"
  );
  assert.match(feedback, /<Markdown lesson typography streaming>\s*\{content\}\s*<\/Markdown>/);
  // 问答回答：流式写入中的那一条传 streaming，已保存的消息不传
  const panel = await readFile(
    new URL("../src/components/learn/annotation-panel.tsx", import.meta.url),
    "utf8"
  );
  assert.match(panel, /<Markdown typography streaming>\{props\.streamText\}<\/Markdown>/);
  assert.match(panel, /<Markdown typography>\{m\.content\}<\/Markdown>/);
});

// ── \( … \) 与 \[ … \] ──
const katexCount = (html) => (html.match(/class="katex"/g) ?? []).length;
const displayCount = (html) => (html.match(/katex-display/g) ?? []).length;

test("公式定界符：行内 \\( … \\) 转成 $…$，去掉内侧空白，渲染成公式", () => {
  assert.equal(normalizeMath("设 \\(P\\) 是本金"), "设 $P$ 是本金");
  // 内侧的首尾空白去掉：不然 `$ x $` 违反 pandoc 的首尾空格规则
  assert.equal(normalizeMath("利息 \\( I = P \\times r \\) 。"), "利息 $I = P \\times r$ 。");
  const html = render("单利利息 \\(I = P \\times r \\times n\\)，其中 \\(P\\) 是本金。");
  assert.equal(katexCount(html), 2);
  assert.doesNotMatch(html, /\\\(|\(P\)/);
  // 多行的折成一行
  assert.equal(normalizeMath("a \\(x +\n  y\\) b"), "a $x + y$ b");
  // 闭合的 \\) 紧跟数字也是公式（不受 pandoc「收尾 $ 后不能跟数字」的限制：转出来的不再参与配对）
  assert.equal(katexCount(render("设 \\(x\\)2 与 \\(y\\)")), 2);
});

test("公式定界符：块级 \\[ … \\]——单独占行的保持行结构，多行、单行、夹在文字中间的都成块级公式", () => {
  // 模型最常见的写法：定界符单独占行
  const standalone = "公式如下：\n\n\\[\nI = P \\times r\n\\]\n\n其中 P 是本金。";
  assert.equal(normalizeMath(standalone), "公式如下：\n\n$$\nI = P \\times r\n$$\n\n其中 P 是本金。");
  assert.equal(displayCount(render(standalone)), 1);
  // 多行
  const multi = "\\[\na = 1 \\\\\nb = 2\n\\]";
  assert.equal(normalizeMath(multi), "$$\na = 1 \\\\\nb = 2\n$$");
  assert.equal(displayCount(render(multi)), 1);
  // 一行写完
  assert.equal(normalizeMath("\\[ E = mc^2 \\]"), "$$\nE = mc^2\n$$");
  // 夹在文字中间：断成独立的块，前后文字各自成段
  const inline = "由此得 \\[ F = P(1+r)^n \\] 其中 n 是期数。";
  assert.equal(normalizeMath(inline), "由此得\n$$\nF = P(1+r)^n\n$$\n其中 n 是期数。");
  const html = render(inline);
  assert.equal(displayCount(html), 1);
  assert.match(html, /由此得/);
  assert.match(html, /其中 n 是期数/);
  // 开头的 \\[ 后面还有内容、结尾的 \\] 前面有内容
  assert.equal(normalizeMath("\\[ a = 1\nb = 2 \\]"), "$$\na = 1\nb = 2\n$$");
});

test("公式定界符：引用块与列表项里的块级公式不破坏结构（真实课文里就是 `> \\[` 这种写法）", () => {
  const quote = "> **单利利息公式**\n> \\[\n> I = P \\times r \\times n\n> \\]\n> 其中 \\(I\\) 表示总利息。";
  assert.equal(
    normalizeMath(quote),
    "> **单利利息公式**\n> $$\n> I = P \\times r \\times n\n> $$\n> 其中 $I$ 表示总利息。"
  );
  const html = render(quote);
  assert.match(html, /<blockquote>/);
  assert.equal(displayCount(html), 1);
  assert.equal(katexCount(html), 2);

  // 引用块里夹在文字中间的：新行沿用 `> ` 前缀
  assert.equal(normalizeMath("> 得 \\[ x = 1 \\] 即可"), "> 得\n> $$\n> x = 1\n> $$\n> 即可");
  // 列表项里：新行沿用列表项缩进，仍在这一项里
  const list = "- 公式 \\[ x = 1 \\] 成立\n- 下一项";
  assert.equal(normalizeMath(list), "- 公式\n  $$\n  x = 1\n  $$\n  成立\n- 下一项");
  const listHtml = render(list);
  assert.equal((listHtml.match(/<li>/g) ?? []).length, 2);
  assert.equal(displayCount(listHtml), 1);
});

test("公式定界符：代码区域（围栏、缩进、行内代码）不动；转义的反斜杠不动；已有的 $ 公式不动", () => {
  const fenced = "```latex\n\\(P\\) and \\[ x = 1 \\]\n```";
  assert.equal(normalizeMath(fenced), fenced);
  const indented = "段落\n\n    \\(P\\) \\[ x \\]\n\n后文 \\(Q\\)";
  assert.equal(normalizeMath(indented), "段落\n\n    \\(P\\) \\[ x \\]\n\n后文 $Q$");
  assert.equal(normalizeMath("写作 `\\(P\\)` 与 \\(Q\\)"), "写作 `\\(P\\)` 与 $Q$");
  assert.equal(normalizeMath("用 `a \n\\(P\\)` 跨行"), "用 `a \n\\(P\\)` 跨行");
  // \\( 是转义的反斜杠加括号：不是公式
  assert.equal(normalizeMath("路径 \\\\(x\\\\) 与 \\\\[y\\\\]"), "路径 \\\\(x\\\\) 与 \\\\[y\\\\]");
  // 已有的 $ 与 $$ 写法照旧
  assert.equal(normalizeMath("设 $P$ 与 \\(Q\\)"), "设 $P$ 与 $Q$");
  assert.equal(normalizeMath("$$\nx\n$$ 与 \\(Q\\)"), "$$\nx\n$$ 与 $Q$");
});

test("公式定界符：流式输出中只来了开头（没有闭合）不转换，等后续内容；闭合前有空行的也不转", () => {
  for (const half of ["设 \\(P \\times r", "设 \\(", "公式 \\[\nI = P \\times", "\\[", "末尾一个反斜杠 \\"]) {
    assert.equal(normalizeMath(half), half, half);
    assert.equal(prepareMarkdown(half, { streaming: true }), half.trim(), half);
  }
  // 后面的内容到了，同一份文本再转就是公式
  assert.equal(normalizeMath("设 \\(P \\times r\\) 是"), "设 $P \\times r$ 是");
  // 闭合前隔着空行：不是同一个公式
  const gap = "设 \\(P\n\n另一段 \\) 结束";
  assert.equal(normalizeMath(gap), gap);
  // 逐字符流式喂入：每个前缀都不抛错、不丢字，最终与一次转完一致
  const full = "单利 \\(I = P r\\) 与\n\\[\nF = P(1+r)\n\\]\n完。";
  for (let n = 1; n <= full.length; n++) {
    const partial = prepareMarkdown(full.slice(0, n), { streaming: true });
    assert.ok(typeof partial === "string");
  }
  assert.equal(prepareMarkdown(full), "单利 $I = P r$ 与\n$$\nF = P(1+r)\n$$\n完。");
});

test("公式定界符：看起来是普通文字的不转（\\[可选\\]、\\(see below\\)）；里面带 $ 的不转", () => {
  for (const prose of ["参数 \\[可选\\]", "写法 \\[optional\\]", "见 \\(see below\\)", "说明 \\(这里是括号里的话\\)"]) {
    assert.equal(normalizeMath(prose), prose, prose);
  }
  assert.equal(normalizeMath("价格 \\(\\$5\\) 起"), "价格 \\(\\$5\\) 起");
  // 单个变量、带运算符 / 数字的是公式
  assert.equal(normalizeMath("\\(n\\) \\(x y\\) \\(a-b\\) \\(x_1\\) \\(2^3\\)"), "$n$ $x y$ $a-b$ $x_1$ $2^3$");
});

test("公式定界符：有 LaTeX 命令或数学运算符就是公式（含汉字也转）；只有既无命令也无运算符时才排除汉字文字和编号、年份、范围", () => {
  // 中文公式：KaTeX 在数学模式里能渲染汉字，必须转成公式
  assert.equal(normalizeMath("\\[ 利息 = 本金 \\times 利率 \\]"), "$$\n利息 = 本金 \\times 利率\n$$");
  assert.equal(normalizeMath("利息 \\( 本金 \\times 利率 \\) 。"), "利息 $本金 \\times 利率$ 。");
  assert.equal(normalizeMath("\\(第 1 步 = 准备\\)"), "$第 1 步 = 准备$");
  assert.equal(normalizeMath("\\(\\text{本金} \\times r\\)"), "$\\text{本金} \\times r$");
  assert.equal(normalizeMath("\\[ \\text{利息} = P r \\]"), "$$\n\\text{利息} = P r\n$$");
  assert.equal(normalizeMath("\\(年利率 > 5\\%\\)"), "$年利率 > 5\\%$");
  assert.equal(normalizeMath("\\(本金 + 利息\\)"), "$本金 + 利息$");
  for (const op of ["=", "^", "_", "<", ">", "+", "×", "÷", "−", "≤", "≥", "≠", "≈", "±", "*", "|"]) {
    assert.equal(normalizeMath(`\\(利率 ${op} 本金\\)`), `$利率 ${op} 本金$`, op);
  }
  assert.equal(normalizeMath("\\(利息/本金\\)"), "\\(利息/本金\\)", "汉字之间的斜杠不算运算");
  assert.equal(normalizeMath("\\(利息 / 2\\)"), "$利息 / 2$");
  assert.equal(normalizeMath("\\[可选/必填\\]"), "\\[可选/必填\\]");
  assert.equal(normalizeMath("\\(and/or\\)"), "\\(and/or\\)");

  // 既没有命令也没有运算符：汉字文字、编号、年份、范围都不是公式
  for (const notMath of [
    "参考文献 \\[1\\]", "见 \\[2024\\]", "页码 \\[1-3\\]", "页码 \\[1–3\\]", "步骤 \\(第 1 步\\)", "共 \\(3 条\\)",
    "\\[1, 2\\]", "\\[ 1 2 3 \\]", "\\(2\\)", "\\(第 1 步\\)和\\(第 2 步\\)", "\\[1,2,3\\]", "\\(Figure 1\\)", "参数 \\[可选\\]",
  ]) {
    assert.equal(normalizeMath(notMath), notMath, notMath);
  }
  // 真正的公式不受影响：数字加运算符、上下标、小数、LaTeX 命令、单个变量
  assert.equal(normalizeMath("\\(1+2\\) \\(0.5\\) \\(10\\%\\) \\(x_1\\) \\(\\frac{1}{2}\\) \\(1/2\\) \\(a-b\\) \\(-1\\) \\(3x\\)"), "$1+2$ $0.5$ $10\\%$ $x_1$ $\\frac{1}{2}$ $1/2$ $a-b$ $-1$ $3x$");
  // 渲染：中文公式是 KaTeX 公式（没有渲染错误），编号和范围原样留着方括号，没有 katex
  const zhFormula = render("\\[ 利息 = 本金 \\times 利率 \\]");
  assert.equal(katexCount(zhFormula), 1);
  assert.equal(displayCount(zhFormula) > 0, true);
  assert.doesNotMatch(zhFormula, /katex-error/);
  assert.match(zhFormula, /利息/);
  assert.doesNotMatch(zhFormula, /\[ 利息/);
  assert.equal(katexCount(render("参考文献 \\[1\\]、\\[2024\\]、\\[1-3\\] 与 \\(第 1 步\\)")), 0);
  assert.match(render("参考文献 \\[1\\]"), /\[1\]/);
  assert.match(render("页码 \\[1-3\\]"), /\[1-3\]/);
});

test("公式定界符：单行块级 \\[ … \\] 在表格行或标题行里退化为行内公式，不拆坏表格和标题；段落里的仍是块级", () => {
  assert.equal(normalizeMath("| 名称 | 公式 |\n| --- | --- |\n| 单利 | \\[ I = P r n \\] |"), "| 名称 | 公式 |\n| --- | --- |\n| 单利 | $I = P r n$ |");
  assert.equal(normalizeMath("## 单利 \\[ I = P r n \\]"), "## 单利 $I = P r n$");
  assert.equal(normalizeMath("### \\[ x^2 \\]"), "### $x^2$");
  assert.equal(normalizeMath("> | a | \\[ x = 1 \\] |"), "> | a | $x = 1$ |");
  assert.equal(normalizeMath("  | 单利 | \\[ x = 1 \\] |"), "  | 单利 | $x = 1$ |");
  // 行内 \( \) 本来就是行内
  assert.equal(normalizeMath("| 单利 | \\( x = 1 \\) |"), "| 单利 | $x = 1$ |");
  // 普通段落里（包括只是含有 # 或 | 的段落）仍是块级
  assert.equal(normalizeMath("由此得 \\[ x = 1 \\] 即可"), "由此得\n$$\nx = 1\n$$\n即可");
  assert.equal(normalizeMath("#标签 \\[ x = 1 \\]"), "#标签\n$$\nx = 1\n$$");
  assert.equal(normalizeMath("a | b \\[ x = 1 \\]"), "a | b\n$$\nx = 1\n$$");
  // 表格行里没有闭合的（半截）不转，也不会吃掉后面的行
  assert.equal(normalizeMath("| a | \\[ x = 1 |\n| b | c |"), "| a | \\[ x = 1 |\n| b | c |");

  const table = "| 名称 | 公式 |\n| --- | --- |\n| 单利 | \\[ I = P r n \\] |\n| 复利 | \\[ F = P(1+r)^n \\] |";
  const html = render(table);
  assert.equal(katexCount(html), 2);
  assert.equal([...html.matchAll(/<tr>/g)].length, 3, "表头加两行数据，表格没有被拆开");
  assert.doesNotMatch(html, /katex-display/);
  const heading = render("## 单利 \\[ I = P r n \\]");
  assert.match(heading, /^<h2[^>]*>[\s\S]*katex[\s\S]*<\/h2>/);
  assert.doesNotMatch(heading, /katex-display/);
});

test("公式定界符与美元金额混排：金额的 $ 照旧转义，转出来的公式不被金额的 $ 吃掉", () => {
  const mixed = "存入 $1,000，年利率 \\(r = 5\\%\\)，三年后是 $1,157.63，即 \\(F = P(1+r)^n\\)。";
  assert.equal(
    normalizeMath(mixed),
    "存入 \\$1,000，年利率 $r = 5\\%$，三年后是 \\$1,157.63，即 $F = P(1+r)^n$。"
  );
  const html = render(mixed);
  assert.equal(katexCount(html), 2);
  assert.match(html, /\$1,000/);
  assert.match(html, /\$1,157\.63/);
  // 金额在公式前后、公式里有 \\text{$…} 之类带 $ 的不转，也不影响别的
  assert.equal(normalizeMath("\\(\\text{$5}\\) 和 \\(x\\)"), "\\(\\text{\\$5}\\) 和 $x$");
});

test("公式定界符：照模型真实输出格式写的整篇课文——没有残留的 \\( \\[ 括号，公式都渲染出来", async () => {
  const lesson = [
    "# 单利与复利",
    "",
    "> 前置知识：百分数运算、能解 \\(x \\cdot r = I\\) 这类一步方程",
    "> 难度：入门",
    "",
    "## 正文内容",
    "",
    "每期产生的利息，只按本金 \\(P\\) 计算。",
    "",
    "> **单利利息公式**",
    "> \\[",
    "> I = P \\times r \\times n",
    "> \\]",
    "> 其中 \\(I\\) 表示总利息。",
    "",
    "同一个数 \\(1.06\\) 连乘了 4 次：",
    "",
    "\\[",
    "F = 10000 \\times 1.06^4 = 10000 \\times 1.2625",
    "\\]",
  ].join("\n");
  const html = render(lesson, true);
  assert.equal(displayCount(html), 2);
  // 行内 4 个（前置知识里的 x·r=I、P、I、1.06）+ 块级 2 个
  assert.equal(katexCount(html), 6);
  assert.match(html, /<div class="lesson-meta">/);
  assert.doesNotMatch(html.replace(/<annotation[\s\S]*?<\/annotation>/g, ""), /\\\(|\\\)|\\\[|\\\]|\(P\)/);
});

test("公式定界符转换对划线定位的影响：只有含 \\( \\[ 的课文受影响，其它课文的渲染文本一个字不变", () => {
  const plain = "# 标题\n\n没有公式的课文，有 $5 和 $6 两笔钱，`code \\(x\\)`。\n\n```\n\\(P\\)\n```";
  // 没有定界符：转换前后的文本与只做美元转义的结果完全一致
  const withoutDelimiters = plain.replaceAll("\\(", "(").replaceAll("\\)", ")");
  assert.equal(normalizeMath(withoutDelimiters), withoutDelimiters.replace("$5 和 $6", "\\$5 和 \\$6"));
  // 渲染出的文本：行内 \\(P\\) 以前是转义的括号「(P)」，现在是公式（KaTeX 的 MathML 与可见文字），
  // 文本变长——所以这些课文里的旧划线靠 locateOffsets 的「取最近一处」找回（见 highlight.ts）
  const before = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, "设 \\(P\\) 是本金"));
  const after = render("设 \\(P\\) 是本金");
  assert.match(before, /\(P\)/);
  assert.match(after, /class="katex"/);
});

// ── 大纲里的 GFM 任务列表：复选框要有可访问名称 ──

test("任务列表（大纲的掌握项）的复选框用那一项的文字做 aria-label；嵌套的子项各管各的；课文和大纲两套插件都带", () => {
  const syllabus = [
    "## 掌握项",
    "- [ ] 能够解释先验概率",
    "- [x] 能够用**自然频数**重述同一问题",
    "  - [ ] 子项：写出 \\(P(A|B)\\) 的含义",
    "- 普通列表项",
    "",
    "- [ ] 松散列表里的一项",
    "",
    "- [X] 另一项",
  ].join("\n");
  for (const lesson of [false, true]) {
    const html = render(syllabus, lesson);
    const labels = [...html.matchAll(/<input[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(labels, [
      "能够解释先验概率",
      "能够用自然频数重述同一问题",
      "子项：写出 P(A|B) 的含义",
      "松散列表里的一项",
      "另一项",
    ]);
    // 父项的名字里不含子项的文字
    assert.doesNotMatch(labels[1], /子项/);
    assert.equal([...html.matchAll(/<input[^>]*type="checkbox"/g)].length, 5);
    assert.equal([...html.matchAll(/<input[^>]*checked/g)].length, 2);
    assert.doesNotMatch(html, /<input(?![^>]*aria-label)[^>]*type="checkbox"/, "每个复选框都有名字");
  }
  // 没有任务列表的内容不受影响
  assert.doesNotMatch(render("- 一项\n- 另一项"), /aria-label/);
});

test("「正文内容 / Main content」这一层二级标题隐藏，只在整个标题就是它的时候；代码里的、别的标题、三级标题不动", () => {
  assert.equal(hideBodyHeading("# 标题\n\n## 正文内容\n\n### 小节\n\n文字"), "# 标题\n\n\n### 小节\n\n文字");
  assert.equal(hideBodyHeading("## Main content\n\n### A"), "\n### A");
  assert.equal(hideBodyHeading("## **正文内容**：\n\n正文"), "\n正文");
  // 别的标题、三级标题不动
  const keep = "## Main content strategy\n\n### 正文内容\n\n## 正文内容的写法";
  assert.equal(hideBodyHeading(keep), keep);
  // 代码围栏里的不动
  const fenced = "```md\n## 正文内容\n```";
  assert.equal(hideBodyHeading(fenced), fenced);
  // 只有 lesson 才隐藏
  assert.match(prepareMarkdown("## 正文内容\n\n文字", { hideBody: false }), /## 正文内容/);
  assert.doesNotMatch(prepareMarkdown("## 正文内容\n\n文字", { hideBody: true }), /正文内容/);
});

test("原文篇的头部：旧数据里的占位（前置知识、难度、「按原文长度而定」）不显示，新数据里的字数和阅读时间保留", () => {
  const oldZh = "# 原始材料：notes.md\n\n> 前置知识：无\n> 难度：按原始材料而定\n> 预计阅读时间：按原文长度而定\n\n## 原文\n\n正文";
  const html = render(oldZh, true, false, true);
  assert.doesNotMatch(html, /前置知识|难度|按原文长度|lesson-meta/);
  assert.doesNotMatch(html, /<blockquote/);
  assert.match(html, /<h1>/);
  assert.match(html, /正文/);

  const oldEn = "# Source material: notes.md\n\n> Prerequisites: none\n> Difficulty: depends on the source material\n> Estimated reading time: depends on the length of the source\n\n## Original text\n\nBody";
  assert.doesNotMatch(render(oldEn, true, false, true), /Prerequisites|Difficulty|depends on|lesson-meta/);

  // 新数据：字数 / 阅读时间是真实值，排成一行小字
  const fresh = "# 原文 · notes\n\n> 字数：约 783 字\n> 预计阅读时间：约 2 分钟\n\n## 原文\n\n正文";
  const shown = render(fresh, true, false, true);
  assert.match(shown, /<div class="lesson-meta">/);
  assert.match(shown, /字数：<\/span><span class="lesson-meta-val">约 <span class="lesson-mono">783<\/span> 字/);
  assert.match(shown, /预计阅读时间：<\/span><span class="lesson-meta-val">约 <span class="lesson-mono">2<\/span> 分钟/);
  const freshEn = "# Your material · notes\n\n> Length: about 783 words\n> Estimated reading time: about 4 min\n\n## Original text\n\nBody";
  assert.match(render(freshEn, true, false, true), /Length:<\/span><span class="lesson-meta-val">about 783 words/);

  // 不是原文篇时，旧占位照旧按元信息排版（普通课文没有这些占位，不受影响）
  assert.match(render(oldZh, true), /前置知识/);
  // 占位和真实值混着：只拿掉占位
  const mixed = "# T\n\n> 前置知识：无\n> 字数：约 10 字\n\n正文";
  const mixedHtml = render(mixed, true, false, true);
  assert.doesNotMatch(mixedHtml, /前置知识/);
  assert.match(mixedHtml, /字数/);
});

test("标题里的中文按词切开，每个词一个不换行的片段（折行只在词与词之间）；文字内容一个字不变，代码、普通段落、英文标题不动", () => {
  const runs = wordRuns("为什么买市场是一种策略");
  assert.equal(runs.map((r) => r.text).join(""), "为什么买市场是一种策略");
  // 「为什么」是一个词，不会被拆开
  assert.ok(runs.some((r) => r.keep && r.text === "为什么"), JSON.stringify(runs));
  // 单字不包（没有折行的意义）
  assert.ok(runs.every((r) => !r.keep || [...r.text].length >= 2));
  // 没有中文：原样一段
  assert.deepEqual(wordRuns("Why buy the market"), [{ text: "Why buy the market", keep: false }]);
  assert.deepEqual(wordRuns(""), [{ text: "", keep: false }]);

  const html = render("# 为什么买市场是一种策略\n\n## 复利的威力\n\n正文里的为什么不动\n\n### Why `代码里的为什么`", true);
  assert.match(html, /<h1>.*<span class="nw">为什么<\/span>/);
  assert.match(html, /<h2>.*<span class="nw">/);
  assert.equal(textOf(html), "为什么买市场是一种策略\n复利的威力\n正文里的为什么不动\nWhy 代码里的为什么");
  // 正文段落没有被包
  assert.match(html, /<p>正文里的为什么不动<\/p>/);
  // 标题里的行内代码不动
  assert.match(html, /<code>代码里的为什么<\/code>/);
  // 非课文（博客、问答回答）不做这个变换
  assert.doesNotMatch(render("# 为什么买市场", false), /class="nw"/);
});

test("中文里的加粗：收尾的 ** 前是全角标点、后面紧跟汉字时也能闭合（CommonMark 原规则在这里关不上，** 会原样露出来）", async () => {
  const cases = [
    "**原生币和代币都是资产类别，不是公司类别。**公司可以发行资产",
    "它叫**「稳定币」**是因为",
    "先看**结论：**再看过程",
    "前文。**加粗**后文",
  ];
  for (const text of cases) {
    for (const lesson of [false, true]) {
      const html = render(text, lesson, false, false, { typography: true });
      assert.match(html, /<strong>/, `${lesson ? "课文" : "非课文"}：${text}\n${html}`);
      assert.doesNotMatch(textOf(html), /\*\*/, html);
    }
  }
  // 英文和代码里的 ** 照旧
  assert.match(render("This is **bold**, right."), /<strong>bold<\/strong>/);
  assert.match(render("`a ** b`"), /<code>a \*\* b<\/code>/);

  // 修好以前划的线，原文里带着露出来的 **：照样找回
  const { locateOffsets } = await import("../src/lib/learn/highlight.ts");
  const plain = "不是公司类别。公司可以发行资产";
  const saved = "不是公司类别。**公司";
  assert.deepEqual(locateOffsets({ textContent: plain }, { original_text: saved, position_start: 2, position_end: 2 + saved.length }), [0, 9]);
});

test("导入的原文（txt、Word、网页）：导入时被转义成 \\*\\* 的加粗还原成加粗；乘方、代码、AI 写的课文不动", () => {
  // 后端 document_import.plain_text / markdownify / trafilatura 的实际输出：原文里的 ** 都成了 \*\*
  const imported = [
    "顺着这两个特征看，稀缺的有四样。\n\n\\*\\*判断与品味。\\*\\*人人都能生成，谁来说这个值得看。",
    "\\*\\*信任与担责。\\*\\*AI 的产出没有人背书。\\\n下一行",
    "它叫\\*\\*「稳定币」\\*\\*是因为",
    "- \\*\\*人的沉淀\\*\\*：过去用户的数据",
    "See \\*\\*bold\\*\\* here",
  ];
  for (const text of imported) {
    const html = render(text, false, false, false, { restoreBold: true });
    assert.match(html, /<strong>/, `${text}\n${html}`);
    assert.doesNotMatch(textOf(html), /\*/, html);
  }

  const literal = [
    "x\\*\\*2 + y\\*\\*2", // 乘方
    "2\\*\\*10 和 3\\*\\*5",
    "def f(\\*\\*kwargs, \\*\\*opts)",
    "\\*\\* 两边是空格 \\*\\*",
    "`\\*\\*代码\\*\\*`",
    "示例：\n\n```\n\\*\\*代码块\\*\\*\n```",
  ];
  for (const text of literal) {
    const html = render(text, false, false, false, { restoreBold: true });
    assert.doesNotMatch(html, /<strong>/, `${text}\n${html}`);
  }
  // 没开的地方（AI 写的课文、问答）：模型有意写的 \*\* 照旧显示成星号
  assert.doesNotMatch(render("用 \\*\\*文字\\*\\* 表示加粗", true), /<strong>/);
});

// ── 中文段落标 data-script="cjk"：整段按汉字的字号排，夹在里面的英文、数字跟着一起缩（globals.css）──
test("中文段落标 data-script=\"cjk\"：汉字不少于英文单词就算中文；英文段落里夹几个汉字不标", () => {
  assert.equal(isCjkText("我自己今年6月开始更新个人账号，一条Codex超小白教程带来了1万多粉丝"), true);
  assert.equal(isCjkText("用 React 的 useEffect 和 useState 管理 state"), true);
  assert.equal(isCjkText("The word 学习 means learning, and 复习 means review."), false);
  assert.equal(isCjkText("8000"), false);
  assert.equal(isCjkText(""), false);
  const markup = (text, plugins = rehypePlugins) =>
    renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins: plugins }, text));
  const html = markup("# 小红书起号\n\n有朋友一条笔记从100涨粉到8000，一跃成为AI博主签约MCN。\n\nIn other cases, the wiki 学习 was less useful.\n\n- 第一条\n- 第二条");
  assert.match(html, /<h1 data-script="cjk">/);
  assert.match(html, /<p data-script="cjk">有朋友/);
  assert.match(html, /<p>In other cases/);
  assert.match(html, /<ul data-script="cjk">\n<li>第一条<\/li>/); // 只标顶层的块，列表项、引用里的段落不再标，字号不会叠着缩
  // 代码和公式里的字母不算英文单词
  assert.match(markup("用 `useEffect(() => { fetchData(); return cleanup; })` 管理副作用"), /<p data-script="cjk">/);
  assert.match(markup("其中 $\\alpha + \\beta + \\gamma + \\delta + \\epsilon$ 是参数"), /<p data-script="cjk">/);
  // 表格按包好的容器标（要在 rehypeWrapTables 之后）
  assert.match(markup("| 课文 | 日期 |\n| --- | --- |\n| 第一篇 | 今天 |"), /<div class="lesson-table" data-script="cjk">/);
  // 课文、原文篇、流式预览、其它内容四套插件都带它，都放在最后
  for (const plugins of [rehypePlugins, lessonRehypePlugins, streamingLessonRehypePlugins, sourceLessonRehypePlugins("课程")]) {
    assert.equal(plugins.at(-1), rehypeScriptBlocks);
  }
});
