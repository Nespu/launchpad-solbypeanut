'use client';

import { useWireLocale } from './LocaleProvider';

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useWireLocale();

  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={t('language.label')}>
      <button
        type="button"
        aria-pressed={locale === 'es'}
        onClick={() => setLocale('es')}
        className="wire-button wire-button-quiet min-h-11 px-3 text-xs aria-pressed:text-[var(--wire-green)]"
      >
        {t('language.spanish')}
      </button>
      <span aria-hidden="true" className="text-[var(--muted)]">·</span>
      <button
        type="button"
        aria-pressed={locale === 'en'}
        onClick={() => setLocale('en')}
        className="wire-button wire-button-quiet min-h-11 px-3 text-xs aria-pressed:text-[var(--wire-green)]"
      >
        {t('language.english')}
      </button>
    </div>
  );
}
