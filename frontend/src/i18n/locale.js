import en from './en.js';

export const STORAGE_KEY = 'bloom.ui.locale';
export const DEFAULT_LOCALE = 'zh-CN';

export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  if (/^zh(?:-|$)/i.test(value)) return 'zh-CN';
  if (/^en(?:-|$)/i.test(value)) return 'en';
  return null;
}

export function detectLocale(saved, languages = []) {
  const stored = normalizeLocale(saved);
  if (stored) return stored;
  for (const language of languages) {
    const supported = normalizeLocale(language);
    if (supported) return supported;
  }
  // With no browser preference retain Chinese; otherwise use English as fallback.
  return languages.length ? 'en' : DEFAULT_LOCALE;
}

// Kept independent of React so detection, persistence and subscriptions can be tested.
export function createLocaleStore(environment = {}) {
  const listeners = new Set();
  const readLocale = () => {
    let saved;
    try { saved = environment.localStorage?.getItem(STORAGE_KEY); } catch { /* storage may be blocked */ }
    const navigator = environment.navigator;
    const languages = navigator?.languages?.length
      ? navigator.languages
      : navigator?.language ? [navigator.language] : [];
    return detectLocale(saved, languages);
  };
  let current = readLocale();
  const update = (next) => {
    if (next === current) return;
    current = next;
    listeners.forEach((listener) => listener());
  };
  const onStorage = (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== environment.localStorage) return;
    } catch { return; }
    update(readLocale());
  };
  return {
    getSnapshot: () => current,
    setLocale(value) {
      const next = normalizeLocale(value);
      if (!next) return;
      // Persist even when the explicit choice matches the detected browser language.
      try { environment.localStorage?.setItem(STORAGE_KEY, next); } catch { /* retain the in-memory choice */ }
      update(next);
    },
    subscribe(listener) {
      if (listeners.size === 0) environment.addEventListener?.('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) environment.removeEventListener?.('storage', onStorage);
      };
    },
  };
}

export function translate(locale, message, values = {}) {
  // Only explicitly supplied UI messages are translated. Never walk lesson/user DOM.
  let template = locale === 'en' && Object.hasOwn(en, message) ? en[message] : message;
  if (template && typeof template === 'object') {
    template = template[new Intl.PluralRules(locale).select(values.count)] || template.other;
  }
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (placeholder, key) => {
    if (!Object.hasOwn(values, key)) return placeholder;
    const value = values[key];
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : String(value);
  });
}

export function translateError(locale, message) {
  if (typeof message !== 'string') return '';
  // Known backend/client messages share the catalog; preserve unknown diagnostic details.
  const match = message.match(/^请求失败 \((\d+)\)$/);
  if (match) return translate(locale, '请求失败 ({status})', { status: match[1] });
  return translate(locale, message);
}

export const localeStore = createLocaleStore(typeof window === 'undefined' ? {} : window);
