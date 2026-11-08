'use client';

import Link from 'next/link';
import { BookOpen, ShieldCheck } from 'lucide-react';
import LanguageSwitcher from './LanguageSwitcher';
import { useWireLocale } from './LocaleProvider';

export default function AppFooter() {
  const { t } = useWireLocale();

  return (
    <footer className="border-t border-white/10 px-4 py-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 text-xs text-[var(--muted)] md:flex-row md:items-center md:justify-between">
        <p className="max-w-2xl leading-relaxed">{t('footer.risk')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <LanguageSwitcher />
          <Link href="/seguridad#guia-rapida" className="wire-button wire-button-secondary min-h-11 shrink-0 px-3 text-xs">
            <BookOpen size={15} aria-hidden="true" />{t('footer.guide')}
          </Link>
          <Link href="/seguridad" className="wire-button wire-button-secondary min-h-11 shrink-0 px-3 text-xs">
            <ShieldCheck size={15} aria-hidden="true" />{t('footer.security')}
          </Link>
        </div>
      </div>
    </footer>
  );
}
