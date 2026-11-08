'use client';

import Image from 'next/image';
import Link from 'next/link';
import WalletAccountPanel from '../../components/WalletAccountPanel';
import WireHeader from '../../components/WireHeader';
import ProjectWalletVault from '../../components/ProjectWalletVault';
import WalletAssets from '../../components/WalletAssets';
import TokenHistory from '../../components/TokenHistory';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import { useWireLocale } from '../../components/LocaleProvider';

export default function WalletsPage() {
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
            <Link href="/tasks" className="wire-button wire-button-quiet text-sm">{t('Tareas')}</Link>
            <Link href="/manage-liquidity" className="wire-button wire-button-quiet text-sm">{t('Administrar liquidez')}</Link>
            <WalletAccountPanel />
          </nav>
        </WireHeader>
        <header className="wire-page-heading mb-8">
          <div>
            <p className="wire-kicker">{t('CUENTA · DEVNET')}</p>
            <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('Mis wallets')}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{t('Administra las wallets del proyecto, consulta balances y revisa la actividad registrada.')}</p>
          </div>
        </header>
        <ProjectWalletVault />
        <WalletAssets />
        <TokenHistory />
      </div>
    </main>
  );
}
