import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import en from '../src/i18n/en.js';
import { createLocaleStore, detectLocale, normalizeLocale, STORAGE_KEY, translate, translateError } from '../src/i18n/locale.js';

function browser(languages = ['en-US'], saved = null) {
  const data = new Map(saved === null ? [] : [[STORAGE_KEY, saved]]);
  const handlers = new Set();
  const localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  return {
    navigator: { languages },
    localStorage,
    handlers,
    addEventListener(type, handler) { assert.equal(type, 'storage'); handlers.add(handler); },
    removeEventListener(type, handler) { assert.equal(type, 'storage'); handlers.delete(handler); },
    storage(value, key = STORAGE_KEY, storageArea = localStorage) {
      if (key === null) data.clear();
      else if (value === null) data.delete(key);
      else data.set(key, value);
      for (const handler of handlers) handler({ key, newValue: value, storageArea });
    },
  };
}

test('normalizes supported regional language tags, not arbitrary prefixes', () => {
  for (const value of ['en', 'en-US', 'EN-gb']) assert.equal(normalizeLocale(value), 'en');
  for (const value of ['zh', 'zh-CN', 'zh-Hant-TW', 'ZH-sg']) assert.equal(normalizeLocale(value), 'zh-CN');
  for (const value of [null, 1, {}, '', 'english', 'en_US', 'zhang', 'fr']) assert.equal(normalizeLocale(value), null);
});

test('saved choice takes precedence over browser languages', () => {
  assert.equal(detectLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(detectLocale('en', ['zh-CN']), 'en');
});

test('uses the first supported browser preference', () => {
  assert.equal(detectLocale(null, ['fr-FR', 'zh-TW', 'en-US']), 'zh-CN');
  assert.equal(detectLocale(null, ['en-GB', 'zh-CN']), 'en');
});

test('unsupported or corrupt saved values fall back safely', () => {
  assert.equal(detectLocale('broken', ['zh-SG']), 'zh-CN');
  assert.equal(detectLocale('fr', ['de-DE']), 'en');
  assert.equal(detectLocale(null, []), 'zh-CN');
});

test('the store works without browser globals', () => {
  const store = createLocaleStore();
  assert.equal(store.getSnapshot(), 'zh-CN');
  const unsubscribe = store.subscribe(() => {});
  store.setLocale('en');
  assert.equal(store.getSnapshot(), 'en');
  unsubscribe();
});

test('uses navigator.language when languages is empty or missing', () => {
  assert.equal(createLocaleStore({ navigator: { language: 'en-GB', languages: [] } }).getSnapshot(), 'en');
  assert.equal(createLocaleStore({ navigator: { language: 'zh-TW' } }).getSnapshot(), 'zh-CN');
});

test('explicit choice persists and survives a new store (page reload)', () => {
  const env = browser();
  const store = createLocaleStore(env);
  store.setLocale('zh-CN');
  assert.equal(env.localStorage.getItem(STORAGE_KEY), 'zh-CN');
  assert.equal(createLocaleStore(env).getSnapshot(), 'zh-CN');
});

test('persists an explicit choice even if it matches the detected language', () => {
  const env = browser();
  createLocaleStore(env).setLocale('en');
  assert.equal(env.localStorage.getItem(STORAGE_KEY), 'en');
});

test('ignores unsupported choices instead of persisting them', () => {
  const env = browser();
  const store = createLocaleStore(env);
  store.setLocale('fr');
  assert.equal(store.getSnapshot(), 'en');
  assert.equal(env.localStorage.getItem(STORAGE_KEY), null);
});

test('blocked localStorage getter still permits in-memory switching', () => {
  const env = { navigator: { languages: ['en'] }, get localStorage() { throw new Error('SecurityError'); } };
  const store = createLocaleStore(env);
  assert.equal(store.getSnapshot(), 'en');
  store.setLocale('zh-CN');
  assert.equal(store.getSnapshot(), 'zh-CN');
});

test('storage quota errors do not prevent the UI updating', () => {
  const env = browser();
  env.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  const store = createLocaleStore(env);
  let updates = 0;
  const stop = store.subscribe(() => updates++);
  store.setLocale('zh-CN');
  assert.equal(store.getSnapshot(), 'zh-CN');
  assert.equal(updates, 1);
  stop();
});

test('subscribers update only on changes and share one cleaned-up storage listener', () => {
  const env = browser();
  const store = createLocaleStore(env);
  const first = [], second = [];
  const stopFirst = store.subscribe(() => first.push(store.getSnapshot()));
  const stopSecond = store.subscribe(() => second.push(store.getSnapshot()));
  assert.equal(env.handlers.size, 1);
  store.setLocale('zh-CN');
  store.setLocale('zh-CN');
  stopFirst();
  store.setLocale('en');
  assert.deepEqual(first, ['zh-CN']);
  assert.deepEqual(second, ['zh-CN', 'en']);
  assert.equal(env.handlers.size, 1);
  stopSecond();
  assert.equal(env.handlers.size, 0);
});

test('cross-tab updates and clearing a saved preference follow browser fallback', () => {
  const env = browser(['en'], 'zh-CN');
  const store = createLocaleStore(env);
  const seen = [];
  const stop = store.subscribe(() => seen.push(store.getSnapshot()));
  env.storage('en');
  env.storage('zh-CN');
  env.storage(null);
  env.storage('zh-CN');
  env.storage(null, null);
  assert.deepEqual(seen, ['en', 'zh-CN', 'en', 'zh-CN', 'en']);
  stop();
});

test('unrelated and session-storage events do not affect the chosen language', () => {
  const env = browser();
  const store = createLocaleStore(env);
  const stop = store.subscribe(() => assert.fail('unrelated storage event'));
  env.storage('zh-CN', 'another-setting');
  env.storage('zh-CN', STORAGE_KEY, {});
  assert.equal(store.getSnapshot(), 'en');
  stop();
});

test('Chinese source wording and English translation both remain available', () => {
  assert.equal(translate('zh-CN', '我的课程'), '我的课程');
  assert.equal(translate('en', '我的课程'), 'My courses');
  assert.equal(translate('zh-CN', '第 {number} 篇', { number: '08' }), '第 08 篇');
  assert.equal(translate('en', '第 {number} 篇', { number: '08' }), 'Lesson 08');
});

test('English counts handle zero, one, many and number formatting', () => {
  assert.equal(translate('en', '{count} 篇', { count: 0 }), '0 lessons');
  assert.equal(translate('en', '{count} 篇', { count: 1 }), '1 lesson');
  assert.equal(translate('en', '{count} 篇', { count: 2 }), '2 lessons');
  assert.equal(translate('en', '已选 {count} 个文件', { count: 1000 }), '1,000 files selected');
  assert.equal(translate('zh-CN', '{count} 篇', { count: 2 }), '2 篇');
});

test('interpolation does not recursively translate user values or interpret replacement tokens', () => {
  const value = '我的课程 <script> $& {message}';
  assert.equal(translate('en', 'PDF 加载失败：{message}', { message: value }), `Unable to load PDF: ${value}`);
  assert.equal(translate('en', 'PDF 加载失败：{message}'), 'Unable to load PDF: {message}');
});

test('unknown strings and prototype property names are preserved', () => {
  for (const text of ['自定义诊断 {id}', 'constructor', '__proto__']) assert.equal(translate('en', text), text);
});

test('known server errors and HTTP fallback are translated without hiding unknown diagnostics', () => {
  assert.equal(translateError('en', '课程不存在'), 'Course not found');
  assert.equal(translateError('en', '请求失败 (502)'), 'Request failed (502)');
  assert.equal(translateError('zh-CN', '请求失败 (502)'), '请求失败 (502)');
  assert.equal(translateError('en', 'Provider detail: 自定义错误'), 'Provider detail: 自定义错误');
  assert.equal(translateError('en', null), '');
});

test('every English entry is nonempty, contains no Chinese, and preserves its placeholders', () => {
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [key, value] of Object.entries(en)) {
    const variants = typeof value === 'string' ? [value] : [value.one, value.other];
    for (const text of variants) {
      assert.ok(typeof text === 'string' && text.length > 0, key);
      assert.doesNotMatch(text, /[\u4e00-\u9fff]/, key);
      assert.deepEqual(placeholders(text), placeholders(key), key);
    }
  }
});

async function uiSources() {
  const result = [];
  for (const dir of ['pages', 'components']) {
    const base = new URL(`../src/${dir}/`, import.meta.url);
    for (const file of await readdir(base)) {
      if (file.endsWith('.jsx')) result.push([file, await readFile(new URL(file, base), 'utf8')]);
    }
  }
  return result;
}

test('all literal UI translation keys and static label arrays have English entries', async () => {
  for (const [file, source] of await uiSources()) {
    for (const match of source.matchAll(/\bt\(['"]([^'"\n]+)['"]/g)) {
      assert.ok(Object.hasOwn(en, match[1]), `${file}: missing ${match[1]}`);
    }
    for (const block of source.matchAll(/const (?:LOADING_MESSAGES|LEARNING_DEPTH_OPTIONS|DEPTH_LABELS|WEEK_LABELS|LANES) = ([\s\S]*?);/g)) {
      for (const match of block[1].matchAll(/['"]([^'"\n]*[\u4e00-\u9fff][^'"\n]*)['"]/g)) {
        assert.ok(Object.hasOwn(en, match[1]), `${file}: missing static label ${match[1]}`);
      }
    }
  }
});

test('UI text and attributes have no untranslated Chinese outside the language name', async () => {
  for (const [file, source] of await uiSources()) {
    const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const textNodes = [...cleaned.matchAll(/>([^<>{}]*[\u4e00-\u9fff][^<>{}]*)</g)];
    for (const match of textNodes) {
      assert.ok(file === 'LanguageSwitcher.jsx' && match[1].trim() === '中文', `${file}: ${match[1]}`);
    }
    assert.doesNotMatch(cleaned, /(?:title|placeholder|aria-label|label)=["'][^"']*[\u4e00-\u9fff]/, file);
    assert.doesNotMatch(cleaned, /toLocaleDateString\(['"]zh/, file);
  }
});

test('language selection is outside the route tree and does not key/remount routes', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /<LanguageSwitcher\s*\/>\s*<Routes>/);
  assert.doesNotMatch(source, /\bkey=/);
});

test('generated Markdown content is not passed through the translation catalog', async () => {
  for (const [file, source] of await uiSources()) {
    assert.doesNotMatch(source, /<Markdown[^>]*>\{(?:t|formatError)\(/, file);
  }
});
