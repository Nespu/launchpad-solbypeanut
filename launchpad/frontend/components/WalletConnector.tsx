'use client';

import dynamic from 'next/dynamic';
import { WalletModalButton } from '@solana/wallet-adapter-react-ui';
import { useWireLocale } from './LocaleProvider';

const walletButtonClass = '!bg-[var(--wire-green)] hover:!bg-[#91ff76] !rounded-lg !min-h-[44px] !h-11 !text-sm !font-semibold !text-[#0b140a]';

function WalletConnectorLoading() {
  const { t } = useWireLocale();
  return (
    <WalletModalButton
      style={{
        backgroundColor: 'var(--wire-green)',
        color: '#0b140a',
        borderRadius: '0.5rem',
        minHeight: '2.75rem',
        height: '2.75rem',
        paddingInline: '1rem',
        fontSize: '0.875rem',
      }}
    >
      {t('wallet.action.select')}
    </WalletModalButton>
  );
}

const WalletMultiButton = dynamic(
  () =>
    import('@solana/wallet-adapter-react-ui').then(
      (mod) => mod.BaseWalletMultiButton
    ),
  {
    ssr: false,
    loading: WalletConnectorLoading,
  }
);

export default function WalletConnector() {
  const { t } = useWireLocale();
  const labels = {
    'change-wallet': t('wallet.action.change'),
    connecting: t('wallet.action.connecting'),
    'copy-address': t('wallet.action.copy'),
    copied: t('wallet.action.copied'),
    disconnect: t('wallet.action.disconnect'),
    'has-wallet': t('wallet.action.connect'),
    'no-wallet': t('wallet.action.select'),
  };
  return (
    <div className="flex items-center gap-2">
      <WalletMultiButton className={walletButtonClass} labels={labels} />
    </div>
  );
}
