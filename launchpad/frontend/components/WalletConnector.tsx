'use client';

import dynamic from 'next/dynamic';
import { WalletModalButton } from '@solana/wallet-adapter-react-ui';

const walletButtonClass = '!bg-purple-600 hover:!bg-purple-700 !rounded-lg !h-10 !text-sm';

const WalletMultiButton = dynamic(
  () =>
    import('@solana/wallet-adapter-react-ui').then(
      (mod) => mod.WalletMultiButton
    ),
  {
    ssr: false,
    loading: () => (
      <WalletModalButton
        style={{
          backgroundColor: '#9333ea',
          borderRadius: '0.5rem',
          height: '2.5rem',
          fontSize: '0.875rem',
        }}
      >
        Conectar wallet
      </WalletModalButton>
    ),
  }
);

export default function WalletConnector() {
  return (
    <div className="flex items-center gap-2">
      <WalletMultiButton className={walletButtonClass} />
    </div>
  );
}
