import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const { savedAnswer } = await import("../src/lib/learn/lesson-chat.ts");

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("连接断了以后读回来的对话：最后是这次的问题和回答才换上；同一个问题以前问过，要多出一次才算这次的", () => {
  const before = [{ role: "user", content: "复利是什么？" }, { role: "assistant", content: "利滚利。" }];
  const asked = { role: "user", content: "举个例子？" };
  const full = [...before, asked, { role: "assistant", content: "本金 100，年利率 10%，两年后是 121。" }];
  assert.deepEqual(savedAnswer(full, "举个例子？", before), full);
  assert.equal(savedAnswer(before, "举个例子？", before), undefined, "后端还没存好");
  assert.equal(savedAnswer([...before, asked], "举个例子？", before), undefined, "只存了问题、还没有回答");
  // 又问了一遍以前问过的：读回来的还是旧的那一对，不能拿旧回答当这次的
  assert.equal(savedAnswer(before, "复利是什么？", before), undefined);
  const again = [...before, { role: "user", content: "复利是什么？" }, { role: "assistant", content: "再讲一遍：利滚利。" }];
  assert.deepEqual(savedAnswer(again, "复利是什么？", before), again);
});

test("对话存在后端：打开一篇读库里的；提问只交这次的问题；连接断了过一会儿读回完整回答；清空走后端", async () => {
  const hook = await read("components/learn/use-lesson-chat.ts");
  assert.match(hook, /await getLessonChat\(courseId, lessonNum\)/);
  assert.match(hook, /const saved = done \? undefined : savedAnswer\(messages, question, before\);/);
  assert.match(hook, /askAboutLesson\(\s*courseId, lessonNum, \{ question, anchor: anchor\(\) \}/);
  assert.match(hook, /clearLessonChat\(courseId, lessonNum\)/);
  assert.doesNotMatch(hook, /localStorage|saveChat/);
  // 读回来之前已经问了（或回答已经写完换上了）：不拿读回来的盖掉
  assert.match(hook, /if \(routeRef\.current !== route \|\| touchedRef\.current\) return;\n\s*setTurns\(\[\.\.\.messages, \.\.\.asked\(\)\]\);/);
});

test("入口：桌面在右栏最上面，手机右下角悬浮；有卡片、抽屉开着或在改文件时不出现，PDF 篇让出缩放按钮", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /<LessonChatEntry variant="rail" onOpen=\{openChat\} started=\{chat\.turns\.length > 0\} \/>/);
  assert.match(lesson, /\{!panelOpen && !editing && !showMobileNav && \(\s*<LessonChatEntry variant="fab" onOpen=\{openChat\} raised=\{isPdf\} desktop=\{sourceOpen\} \/>/);
  // 划线卡片打开时让给它，收起后回来；换一篇就收起
  assert.match(lesson, /const chatVisible = chatOpen && !composer && !openSessionData && !translation;/);
  assert.match(lesson, /setOpenId\(null\);\n\s*setChatOpen\(false\);/);
  // 「问这篇」在写时不能划线提问，原因写在按钮旁边
  assert.match(lesson, /: chat\.streaming\s*\? t\("lesson\.chatBusy"\)/);
});

test("手机抽屉里从对话开始的滑动只滚对话：滚到头也不带着后面的课文走（键盘开着时也是）", async () => {
  const panel = await read("components/learn/annotation-panel.tsx");
  // 只在抽屉形态（lg 以下）拦住滚动传给页面，桌面右栏的卡片滚到头照常滚页面
  assert.match(panel, /className="min-h-0 flex-1 overflow-y-auto px-4 py-3 max-lg:overscroll-contain"/);
});
