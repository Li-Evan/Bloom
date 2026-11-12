import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  appendRun, finishRun, livePage, readRuns, registerPage, startRun, stopRun, subscribeRuns,
} from "../src/lib/learn/running.ts";

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("还在写的记在页面外面：开始马上刷新；收字、写完都攒到下一帧，页面每帧最多刷新一次", async () => {
  let notified = 0;
  const unsubscribe = subscribeRuns(() => notified++);
  const owner = {};
  let stopped = 0;
  const key = startRun({ route: "7/3", kind: "translate", owner, place: { original_text: "gradient", position_start: 4, position_end: 12, anchor_top: 80, pdf_position: null }, stop: () => stopped++ });
  assert.equal(notified, 1);
  const before = readRuns();
  appendRun(key, "梯");
  appendRun(key, "度");
  // 快照换了（useSyncExternalStore 认得出变化），通知攒到下一帧
  assert.notEqual(readRuns(), before);
  assert.equal(readRuns().find((run) => run.key === key).text, "梯度");
  assert.equal(notified, 1);
  await wait(40);
  assert.equal(notified, 2);
  stopRun(key);
  assert.equal(stopped, 1);
  finishRun(key);
  // 登记马上撤掉（页面换上结果时读到的就是撤掉之后的），通知等下一帧
  assert.equal(readRuns().some((run) => run.key === key), false);
  assert.equal(notified, 2);
  await wait(40);
  assert.equal(notified, 3);
  // 写完之后再来的字、再停、再写完都不出错，也不再通知
  appendRun(key, "x");
  stopRun(key);
  finishRun(key);
  await wait(40);
  assert.equal(notified, 3);
  assert.equal(stopped, 1);
  unsubscribe();
});

test("写完交给那时挂着这一篇的页面：换篇时旧页面撤掉登记，回来新挂上的页面接手；旧页面晚撤也不会把新页面的登记撤掉", () => {
  const oldPage = { name: "old" };
  const newPage = { name: "new" };
  const leaveOld = registerPage("7/3", "lesson", () => oldPage);
  assert.equal(livePage("7/3", "lesson"), oldPage);
  assert.equal(livePage("7/3", "chat"), undefined);
  assert.equal(livePage("7/4", "lesson"), undefined);
  leaveOld();
  assert.equal(livePage("7/3", "lesson"), undefined, "离开这一篇：写完的结果没有页面要换");
  const leaveNew = registerPage("7/3", "lesson", () => newPage);
  leaveOld();
  assert.equal(livePage("7/3", "lesson"), newPage);
  leaveNew();
  assert.equal(livePage("7/3", "lesson"), undefined);
});

test("划线翻译开始了就写完：收起卡片、换卡片、新选一段、换一篇都不打断，几段可以同时在翻，结果交给那时挂着这一篇的页面", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const api = await read("lib/learn/api.ts");
  assert.doesNotMatch(lesson, /translateAbortRef/);
  assert.match(lesson, /function closeTranslation\(\) \{\s*setTranslation\(null\);\s*\}/);
  // 请求不带 signal：没有谁能把它断掉
  const create = api.slice(api.indexOf("export async function createTranslation"), api.indexOf("export const deleteTranslation"));
  assert.doesNotMatch(create, /signal/);
  const start = lesson.slice(lesson.indexOf("const startTranslation"), lesson.indexOf("const translationFinished"));
  assert.match(start, /const key = startRun\(\{ route, kind: "translate", place, owner: runOwner \}\);/);
  assert.match(start, /pageAt\(route\)\.translationFinished\(key, place, outcome\);\s*finishRun\(key\);/);
  // 同一处还在翻：打开那一条，不再翻一遍
  assert.match(start, /const running = translateRuns\.find\(\(run\) => samePlace\(place\)\(run\.place!\)\);/);
  // 还在翻的也画虚线、放圆点（圆点在闪），点开接着看
  assert.match(lesson, /\.\.\.translateRuns\.map\(\(run\) => \(\{ \.\.\.run\.place!, id: `\$\{TRANSLATION_PREFIX\}\$\{run\.key\}`, comment: "", messages: \[\] \}\)\)/);
  assert.match(lesson, /running && "motion-safe:animate-pulse"/);
  // 卡片收起后没翻成：屏幕底部说一声
  assert.match(lesson, /setSelectionNote\(t\("lesson\.translateFailedAway"/);
  for (const lang of ["zh", "en"]) {
    const messages = JSON.parse(await read(`i18n/messages/${lang}.json`));
    assert.ok(messages.learn.lesson.translateFailedAway.includes("{text}"), lang);
    assert.ok(messages.learn.lesson.translateDropped, lang);
  }
});

test("划线提问 / 追问：换到别的一篇再回来，新挂上的页面接着显示写到哪儿了、能停止，写完的结果照样换上", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  const create = lesson.slice(lesson.indexOf("const handleCreateSession"), lesson.indexOf("const handleFollowUp"));
  const follow = lesson.slice(lesson.indexOf("const handleFollowUp"), lesson.indexOf("const handleStopStreaming"));
  for (const handler of [create, follow]) {
    // 换问答的几样都换到那时挂着这一篇的页面上
    assert.match(handler, /= pageAt\(route\);/);
    assert.match(handler, /stop: \(\) => controller\.abort\(\) \}\);/);
    assert.match(handler, /appendStreamText\(chunk\);\s*appendRun\(runKey, chunk\);/);
    assert.match(handler, /finally \{\s*finishRun\(runKey\);/);
  }
  // 存好的换上：列表取回来时已经有了就不重复
  assert.match(create, /setSessions\(\(prev\) => swapSession\(prev, tempId, saved\)\);/);
  // 问答列表还没取回来时交来的改动排着，取回来之后接着换上
  assert.match(lesson, /setSessions: \(value\) => \(detailsReadyRef\.current \? setSessions\(value\) : queuedSessionsRef\.current\.push\(value\)\)/);
  assert.match(lesson, /for \(const value of queuedSessionsRef\.current\.splice\(0\)\) setSessions\(value\);/);
  assert.match(lesson, /useEffect\(\(\) => registerPage\(highlightRoute, "lesson", \(\) => pageRef\.current\), \[highlightRoute\]\);/);
  // 回来后照着登记显示、停止停的是原来那个请求
  assert.match(lesson, /const adoptedQa = runs\.find\(\(run\) => run\.route === highlightRoute && run\.owner !== runOwner/);
  assert.match(lesson, /const streamText = adoptedQa \? adoptedQa\.text : ownStreamText;/);
  assert.match(lesson, /stopRun\(adoptedQa\.key\);/);
});

test("「问这篇」换到别的一篇也不断开：回来接着显示问题和写到哪儿了，写完换上", async () => {
  const hook = await read("components/learn/use-lesson-chat.ts");
  const api = await read("lib/learn/api.ts");
  assert.doesNotMatch(hook, /abort/i);
  const ask = api.slice(api.indexOf("export async function askAboutLesson"), api.indexOf("// 会话内追问"));
  assert.doesNotMatch(ask, /signal/);
  assert.match(hook, /useEffect\(\(\) => registerPage\(route, "chat", \(\) => pageRef\.current\), \[route\]\);/);
  assert.match(hook, /const key = startRun\(\{ route, kind: "chat", owner, question \}\);/);
  assert.match(hook, /page\(\)\?\.setTurns\(\[\.\.\.asked, \{ role: "assistant", content: answer/);
  assert.match(hook, /streaming: streaming \|\| Boolean\(adopted\),\s*streamText: adopted \? adopted\.text : streamText,/);
  // 回来时还在写的那一条：别再问、别清空
  assert.match(hook, /if \(!question \|\| busyRef\.current \|\| adopted\) return;/);
  assert.match(hook, /if \(busyRef\.current \|\| adopted\) return;/);
});
