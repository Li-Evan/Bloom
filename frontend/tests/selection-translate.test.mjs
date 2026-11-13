import assert from "node:assert/strict";
import { test } from "node:test";
import { isForeignText } from "../src/lib/learn/language.ts";

test("划线翻译：只有主要不是界面语言写的选区才给「翻译」", () => {
  const zhForeign = [
    "Gradient descent takes a step along the negative gradient.",
    "gradient",
    "Le chat dort sur la table.",
    "Привет, как дела?",
    "안녕하세요 세계",
    "これは日本語の文章です。",
    "The term 梯度 means gradient.",
  ];
  const zhNative = [
    "梯度下降（gradient descent）是一种优化算法。",
    "这个 API 的 rate limit 是每分钟 100 次。",
    "学习率太大时，损失会来回震荡。",
    "2024 — 3.14",
  ];
  for (const text of zhForeign) assert.equal(isForeignText(text, "zh"), true, text);
  for (const text of zhNative) assert.equal(isForeignText(text, "zh"), false, text);

  const enForeign = [
    "梯度下降是一种优化算法。",
    "这是 Python 的写法",
    "これは日本語の文章です。",
    "Привет, как дела?",
    "Me gusta mucho aprender español.",
    "Le chat dort sur la table pendant la nuit.",
    "Die Katze schläft auf dem Tisch.",
    "café",
  ];
  const enNative = [
    "Gradient descent takes a step along the negative gradient.",
    "Attention Is All You Need",
    "Deep Residual Learning for Image Recognition",
    "The term 梯度 means gradient.",
    "learning rate",
    "Stochastic Gradient Descent Algorithm",
    "2024 — 3.14",
  ];
  for (const text of enForeign) assert.equal(isForeignText(text, "en"), true, text);
  for (const text of enNative) assert.equal(isForeignText(text, "en"), false, text);
});

test("划线翻译：前端一次能送的字数和后端 translate.py 的上限一致，超出先提示、不发请求", async () => {
  const { readFile } = await import("node:fs/promises");
  const lesson = await readFile(new URL("../src/components/learn/lesson.tsx", import.meta.url), "utf8");
  const backend = await readFile(new URL("../../backend/app/translate.py", import.meta.url), "utf8");
  assert.equal(lesson.match(/const TRANSLATE_MAX_CHARS = (\d+);/)[1], backend.match(/^MAX_CHARS = (\d+)$/m)[1]);
  assert.match(lesson, /if \(base\.selectedText\.length > TRANSLATE_MAX_CHARS\) \{\s*setSelectionNote/);
});

test("划线翻译的上下文：以选区为中心截一段，空白压成一个空格；找不到选区就从头截", async () => {
  const { contextAround, CONTEXT_SIDE_CHARS } = await import("../src/lib/learn/translation-context.ts");
  const heading = "The Knobs we can Turn\n\nAn agent harness has a lot of knobs: system prompts, tools, hooks.";
  assert.equal(contextAround(heading, "Knobs"), "The Knobs we can Turn An agent harness has a lot of knobs: system prompts, tools, hooks.");
  const long = "a".repeat(5000) + " TARGET " + "b".repeat(5000);
  const around = contextAround(long, "TARGET");
  assert.equal(around.length, CONTEXT_SIDE_CHARS * 2 + "TARGET".length);
  assert.ok(around.includes("TARGET"));
  assert.equal(contextAround("x".repeat(3000), "不在里面").length, CONTEXT_SIDE_CHARS + 4);
  // 加上选区本身（最多 4000 字）也不超过后端收的上下文上限
  const { readFile } = await import("node:fs/promises");
  const backend = await readFile(new URL("../../backend/app/translate.py", import.meta.url), "utf8");
  assert.ok(CONTEXT_SIDE_CHARS * 2 + 4000 <= Number(backend.match(/^CONTEXT_CHARS = (\d+)$/m)[1]));
});

test("划线翻译的开关只管显示：拆出译文后面那句「在这里的意思」，流式写到一半也先拆，老译文整段都是译文", async () => {
  const { splitMeaning } = await import("../src/lib/learn/translation-meaning.ts");
  const full = "监督 Claude 需要恰恰是那些可能因过度使用 AI 而退化的编程技能。\n\n在这里的意思：作者说人要把关 AI，就得保住自己的编程能力。";
  assert.deepEqual(splitMeaning(full), {
    translation: "监督 Claude 需要恰恰是那些可能因过度使用 AI 而退化的编程技能。",
    meaning: "在这里的意思：作者说人要把关 AI，就得保住自己的编程能力。",
  });
  // 逐字流进来的每一步，关着开关时都只露出译文
  const translation = full.split("\n\n")[0];
  for (let i = 1; i <= full.length; i++) assert.ok(translation.startsWith(splitMeaning(full.slice(0, i)).translation), full.slice(0, i));
  assert.equal(splitMeaning("Each step follows the gradient.\n\nIn this context: it means the model updates.").translation, "Each step follows the gradient.");
  // 单词后面再空一行是词根拆解，跟着那句一起收起来；模型漏了那句、只写了词根拆解也收起来
  const word = "难以置信的\n\n在这里的意思：形容好得令人难以相信。\n\n词根拆解：in-（不）+ cred（相信）+ -ible（能…的）→ 不能相信的";
  assert.deepEqual(splitMeaning(word), {
    translation: "难以置信的",
    meaning: "在这里的意思：形容好得令人难以相信。\n\n词根拆解：in-（不）+ cred（相信）+ -ible（能…的）→ 不能相信的",
  });
  for (let i = 1; i <= word.length; i++) assert.ok("难以置信的".startsWith(splitMeaning(word.slice(0, i)).translation), word.slice(0, i));
  assert.equal(splitMeaning("Gradient\n\nWord roots: 梯 (ladder) + 度 (degree) → a measure of slope").translation, "Gradient");
  // 多段译文不会被拆错；老译文没有这句
  assert.equal(splitMeaning("第一段。\n\n第二段。").translation, "第一段。\n\n第二段。");
  assert.deepEqual(splitMeaning("刻意地"), { translation: "刻意地", meaning: "" });
  // 和后端 translate.py 用同一组开头
  const { readFile } = await import("node:fs/promises");
  const backend = await readFile(new URL("../../backend/app/translate.py", import.meta.url), "utf8");
  assert.match(backend, /MEANING_LABELS = \{'zh': '在这里的意思：', 'en': 'In this context:'\}/);
  assert.match(backend, /ROOTS_LABELS = \{'zh': '词根拆解：', 'en': 'Word roots:'\}/);
});
