import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE, localeStore, translate, translateError } from './locale.js';

const getServerSnapshot = () => DEFAULT_LOCALE;

export function useI18n() {
  const locale = useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot, getServerSnapshot);
  const t = useCallback((message, values) => translate(locale, message, values), [locale]);
  const formatError = useCallback((message) => translateError(locale, message), [locale]);
  return { locale, t, formatError, setLocale: localeStore.setLocale };
}
