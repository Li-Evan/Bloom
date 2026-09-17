import { useEffect } from 'react';
import { useI18n } from '../i18n/useI18n.js';

export default function LanguageSwitcher() {
  const { locale, t, setLocale } = useI18n();

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t('Bloom 学习系统');
  }, [locale, t]);

  return (
    <div className="bg-stone-900 border-b border-stone-800">
      <div className="max-w-[1200px] mx-auto px-6 py-2 flex justify-end">
        <label className="flex flex-wrap items-center gap-2 text-xs text-stone-300" title={t('只切换界面语言，不翻译课程内容')}>
          {t('界面语言')}
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            className="bg-stone-800 text-white border border-stone-600 rounded-md px-2 py-1 focus:outline-2 focus:outline-emerald-400 cursor-pointer"
          >
            <option value="zh-CN" lang="zh-CN">中文</option>
            <option value="en" lang="en">English</option>
          </select>
        </label>
      </div>
    </div>
  );
}
