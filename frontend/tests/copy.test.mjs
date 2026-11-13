import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const [en, zh] = await Promise.all([
  json("i18n/messages/en.json"),
  json("i18n/messages/zh.json"),
]);

test("首页 meta 描述（也是 og/twitter 文案）对三种建课方式都成立，中英文说的是同一件事", () => {
  const e = en.metadata.description;
  const z = zh.metadata.description;
  // 项目文件模式没有大纲、不生成课文：不能只说「写大纲」「一课一课教」而不提它
  assert.match(e, /project files/i);
  assert.match(z, /项目文件/);
  // 两种语言都不夹带对方没有的内容
  for (const [lang, text] of [["en", e], ["zh", z]]) {
    assert.doesNotMatch(text, /syllabus|大纲/, `${lang} 描述不应声称都会写大纲`);
    assert.doesNotMatch(text, /2.?Sigma|布[鲁卢]姆/, `${lang} 描述不带研究背书（只有一边有就不对等）`);
  }
  // 同样的要点：主题或资料 → 一课一课、按反馈；或项目文件 → 对任何一段提问
  assert.match(e, /one lesson at a time/);
  assert.match(z, /一课一课/);
  assert.match(e, /feedback/);
  assert.match(z, /反馈/);
  assert.match(e, /ask about any passage/);
  assert.match(z, /提问/);
});
