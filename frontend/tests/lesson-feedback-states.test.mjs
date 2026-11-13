import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// 课文页的交互反馈：点了有变化、等得久写明在做什么和已等多久、失败就近说并且不丢读者打的字

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [zh, en] = await Promise.all([json("i18n/messages/zh.json"), json("i18n/messages/en.json")]);
const get = (messages, dotted) => dotted.split(".").reduce((node, key) => node?.[key], messages);
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));

test("划线提问 / 追问没被受理：问题放回输入框，原因写在卡片里（不报到页底）；停止后「正在停止…」", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const create = between(lesson, "const handleCreateSession", "const handleFollowUp");
  assert.match(create, /setComposer\(\(c\) => c \?\? \{ \.\.\.asked, error: message \|\| undefined \}\)/);
  const follow = between(lesson, "const handleFollowUp", "const handleStopStreaming");
  assert.match(follow, /withDraft\(prev, sessionId, now\.trim\(\) \? `\$\{typed\}\\n\$\{now\}` : typed\)/);
  for (const handler of [create, follow, between(lesson, "const handleDeleteSession", "const handleSubmitFeedback")]) {
    assert.doesNotMatch(handler, /setError\(/);
  }
  assert.match(lesson, /const openError = openSessionData && cardError\?\.id === openSessionData\.id \? cardError\.message : undefined;/);
  assert.match(lesson, /setStopping\(true\);\s*abortRef\.current\.abort\(\);/);

  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /<p role="alert" className="text-pretty text-\[13px\] text-destructive">\{props\.error\}<\/p>/);
  assert.match(panel, /loading=\{props\.stopping\}/);
  // 不能提问时按钮旁边写原因
  assert.match(panel, /<p id="ask-busy"/);
  for (const key of ["askWhileAnswering", "askWhileGenerating", "askWhileSwitching", "stopping"]) {
    assert.ok(get(zh, `learn.lesson.${key}`) && get(en, `learn.lesson.${key}`), key);
  }
});

test("删除问答先确认，删除中转圈、不能连点，失败写在确认条里", async () => {
  const panel = await read("components/learn/annotation-panel.tsx");
  assert.match(panel, /onClick=\{\(\) => setConfirmDelete\(true\)\}/);
  assert.match(panel, /variant="destructive"\s+size="sm"\s+loading=\{deleting\}/);
  assert.match(panel, /setDeleteError\(failed \?\? ""\)/);
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(between(lesson, "const handleDeleteSession", "const handleSubmitFeedback"), /return report\(err\);/);
});

test("生成下一篇：顶上写已等多久，正文末尾一条吸底的状态行写当前阶段；aria-busy 不包住状态行", async () => {
  const feedback = await read("components/learn/lesson-feedback.tsx");
  const card = feedback.slice(feedback.indexOf("export const GeneratingCard"));
  assert.match(card, /const waited = useWaited\(startedAt\);/);
  assert.match(card, /settled === content\s*\?\s*t\("lesson\.next\.saving"\)/);
  assert.match(card, /role="status"\s+className="sticky bottom-4/);
  assert.doesNotMatch(card.slice(0, card.indexOf("<Markdown")), /<section[^>]*aria-busy/);
  for (const key of ["planning", "writing", "saving"]) {
    assert.ok(get(zh, `learn.lesson.next.${key}`) && get(en, `learn.lesson.next.${key}`), key);
  }
});

test("PDF 加载中是 A4 骨架页 + 转圈，失败给「重试」", async () => {
  const pdf = await read("components/learn/pdf-viewer.tsx");
  assert.match(pdf, /aspect-\[210\/297\]/);
  assert.match(pdf, /onClick=\{\(\) => setAttempt\(\(n\) => n \+ 1\)\}/);
  assert.equal(get(zh, "learn.pdf.loading"), "正在加载 PDF…");
});

test("按钮的等待态：保存反馈、标记已读、教学反馈记录、生成失败后的重试都用 Button loading；课文页这几个文件里没有自己写的边框转圈", async () => {
  const feedback = await read("components/learn/lesson-feedback.tsx");
  assert.match(feedback, /loading=\{saving\}/);
  assert.match(feedback, /loading=\{marking\}/);
  const teaching = await read("components/learn/teaching-feedback.tsx");
  assert.match(teaching, /loading=\{busy\?\.id === item\.id && busy\.resolve\}/);
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /loading=\{checkingNext\}/);
  for (const file of ["lesson.tsx", "annotation-panel.tsx", "lesson-feedback.tsx", "pdf-viewer.tsx", "teaching-feedback.tsx"]) {
    assert.doesNotMatch(await read(`components/learn/${file}`), /animate-spin/, file);
  }
  for (const key of ["composerPlaceholder", "followUpPlaceholder", "answering", "marking", "feedback.saving"]) {
    assert.doesNotMatch(get(zh, `learn.lesson.${key}`), /\.\.\./, key);
    assert.doesNotMatch(get(en, `learn.lesson.${key}`), /\.\.\./, key);
  }
});
