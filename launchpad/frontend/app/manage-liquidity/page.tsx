'use client';

import Image from 'next/image';
import Link from 'next/link';
import WalletAccountPanel from '../../components/WalletAccountPanel';
import WireHeader from '../../components/WireHeader';
import ManageLiquidity from '../../components/ManageLiquidity';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import { useWireLocale } from '../../components/LocaleProvider';

export default function ManageLiquidityPage() {
  const { t } = useWireLocale();
  return (
    <main className="wire-shell min-h-screen px-4 py-4 sm:px-6 md:px-8 md:py-8">
      <div className="wire-container">
        <WireHeader className="mb-12">
          <Link href="/" className="flex min-h-11 items-center gap-3 rounded-md" aria-label={t('Wire, inicio')}>
            <Image src="/wire-logo-grok.png" alt="Wire" width={34} height={28} />
            <div>
              <h1 className="text-xl font-display font-semibold text-white leading-none">wire</h1>
              <p className="text-xs text-[var(--muted)] mt-1">{t('Launchpad de tokens en Solana')}</p>
            </div>
          </Link>
          <nav className="wire-header-actions" aria-label={t('Navegación principal')}>
            <LanguageSwitcher />
            <Link href="/" className="wire-button wire-button-quiet text-sm">
              {t('Crear token')}
            </Link>
            <Link href="/tasks" className="wire-button wire-button-quiet text-sm">{t('Tareas')}</Link>
            <Link href="/wallets" className="wire-button wire-button-quiet text-sm">{t('Mis wallets')}</Link>
            <WalletAccountPanel />
          </nav>
        </WireHeader>
        <ManageLiquidity />
      </div>
    </main>
  );
}
