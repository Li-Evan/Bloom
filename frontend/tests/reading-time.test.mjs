import assert from 'node:assert/strict';
import { test } from 'node:test';

const { readingMinutes, statesReadingTime } = await import('../src/lib/learn/reading-time.ts');

test('Chinese counts 400 characters a minute and English 240 words a minute, rounded up', () => {
  assert.equal(readingMinutes('系统'.repeat(200)), 1);
  assert.equal(readingMinutes('系统'.repeat(201)), 2);
  assert.equal(readingMinutes('word '.repeat(240)), 1);
  assert.equal(readingMinutes('word '.repeat(241)), 2);
  // 400 字 ≈ 1 分钟 + 240 词 ≈ 1 分钟（和后端 _reading_stats 的同一个例子）
  assert.equal(readingMinutes('系统'.repeat(200) + ' systems thinking'.repeat(120)), 2);
  assert.equal(readingMinutes('短'), 1);
});

test('no text means no estimate', () => {
  assert.equal(readingMinutes(''), 0);
  assert.equal(readingMinutes('# \n\n---\n\n![](https://example.com/a.png)\n<!-- note -->'), 0);
});

test('comments, image links and link targets are not counted, link text is', () => {
  const url = 'https://example.com/' + 'segment/'.repeat(300);
  assert.equal(readingMinutes(`![${'alt '.repeat(300)}](${url})`), 0);
  assert.equal(readingMinutes(`[读这篇](${url}) ${url} <!-- ${'hidden '.repeat(500)} -->`), 1);
  assert.equal(readingMinutes(`[${'word '.repeat(300)}](${url})`), 2);
});

test('a reading time already written in the header is detected', () => {
  assert.ok(statesReadingTime('# 标题\n\n> 难度：入门\n> 预计阅读时间：约 4 分钟\n\n## 正文内容\n\n正文'));
  assert.ok(statesReadingTime('# Title\n\n> Estimated reading time: about 3 min\n\n## Main content\n'));
  assert.ok(statesReadingTime('# 标题\n\n**预计阅读时间：** 二十分钟\n'));
  assert.ok(statesReadingTime('# Title\n\nReading time: 9 min\n'));
});

test('placeholders, files without it and sentences in the body do not count', () => {
  assert.ok(!statesReadingTime('# 原文 · 笔记\n\n> 预计阅读时间：按原文长度而定\n\n## 原文\n\n正文'));
  assert.ok(!statesReadingTime('# 一篇剪藏的文章\n\n正文第一段。'));
  assert.ok(!statesReadingTime('# 标题\n\n## 第一节\n\n阅读时间：每天 30 分钟。'));
  assert.ok(!statesReadingTime(''));
});
