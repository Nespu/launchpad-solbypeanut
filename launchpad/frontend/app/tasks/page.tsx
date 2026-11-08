'use client';

import Image from 'next/image';
import Link from 'next/link';
import WalletAccountPanel from '../../components/WalletAccountPanel';
import WireHeader from '../../components/WireHeader';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import ProjectWalletTasks from '../../components/ProjectWalletTasks';
import AppFooter from '../../components/AppFooter';
import { useWireLocale } from '../../components/LocaleProvider';

export default function TasksPage() {
  const { t } = useWireLocale();
  return (
    <main className="wire-shell min-h-screen px-4 py-4 sm:px-6 md:px-8 md:py-8">
      <div className="wire-container">
        <WireHeader className="mb-12">
          <Link href="/" className="flex min-h-11 items-center gap-3 rounded-md" aria-label={t('Wire, inicio')}>
            <Image src="/wire-logo-grok.png" alt="Wire" width={34} height={28} />
            <div>
              <h1 className="text-xl font-display font-semibold leading-none text-white">wire</h1>
              <p className="mt-1 text-xs text-[var(--muted)]">{t('Launchpad de tokens en Solana')}</p>
            </div>
          </Link>
          <nav className="wire-header-actions" aria-label={t('Navegación principal')}>
            <LanguageSwitcher />
            <Link href="/wallets" className="wire-button wire-button-quiet text-sm">{t('Mis wallets')}</Link>
            <Link href="/manage-liquidity" className="wire-button wire-button-quiet text-sm">{t('Administrar liquidez')}</Link>
            <WalletAccountPanel />
          </nav>
        </WireHeader>

        <header className="wire-page-heading mb-8">
          <div>
            <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('Tareas')}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{t('Gestiona secuencias de operación de tus wallets de proyecto en Solana Devnet.')}</p>
          </div>
        </header>

        <ProjectWalletTasks />
      </div>
      <AppFooter />
    </main>
  );
}
