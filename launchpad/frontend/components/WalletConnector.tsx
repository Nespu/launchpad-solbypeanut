'use client';

import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export default function WalletConnector() {
  return (
    <WalletMultiButton className="!bg-purple-600 hover:!bg-purple-700 !rounded-lg !h-10 !text-sm" />
  );
}
