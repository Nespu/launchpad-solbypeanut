'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import WalletConnector from '../components/WalletConnector';
import TokenForm from '../components/TokenForm';
import WithdrawModal from '../components/WithdrawModal';

export default function Home() {
  const { connected } = useWallet();
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [selectedPoolAddress, setSelectedPoolAddress] = useState('');
  const [selectedLpAmount, setSelectedLpAmount] = useState(0);

  const openWithdrawModal = (poolAddress: string, lpTokenAmount: number) => {
    setSelectedPoolAddress(poolAddress);
    setSelectedLpAmount(lpTokenAmount);
    setShowWithdrawModal(true);
  };

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-12 py-4 border-b border-white/10">
          <div>
            <h1 className="text-2xl font-bold text-white">Launchpad</h1>
            <p className="text-sm text-gray-400">Create and launch tokens on Solana</p>
          </div>
          <WalletConnector />
        </header>

        <section className="text-center mb-12">
          <h2 className="text-4xl font-bold mb-4 bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            Launch your memecoin in minutes
          </h2>
          <p className="text-gray-400 max-w-2xl mx-auto">
            Connect your wallet, fill in the form, and your token will be ready to trade on Raydium.
            No technical knowledge required.
          </p>
        </section>

        {connected ? (
          <>
            <TokenForm />
            
            <div className="mt-8 text-center">
              <button
                onClick={() => openWithdrawModal('POOL_ADDRESS_EJEMPLO', 1000)}
                className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
              >
                Withdraw Liquidity (Example)
              </button>
              <p className="text-xs text-gray-500 mt-2">
                This is a demo button. Replace with actual pool data.
              </p>
            </div>
          </>
        ) : (
          <div className="glass-card p-12 text-center rounded-2xl">
            <h3 className="text-xl font-semibold mb-3">Connect your wallet to get started</h3>
            <p className="text-gray-400 text-sm mb-6">
              You need a Solana wallet like Phantom or Solflare to create your token.
            </p>
            <WalletConnector />
          </div>
        )}

        <section className="grid md:grid-cols-3 gap-6 mt-16">
          <div className="glass-card p-6 rounded-xl">
            <h3 className="font-semibold mb-2">Instant creation</h3>
            <p className="text-sm text-gray-400">
              Your token is created on the Solana blockchain in seconds.
            </p>
          </div>
          <div className="glass-card p-6 rounded-xl">
            <h3 className="font-semibold mb-2">Raydium listing</h3>
            <p className="text-sm text-gray-400">
              The token is automatically listed on the decentralized exchange.
            </p>
          </div>
          <div className="glass-card p-6 rounded-xl">
            <h3 className="font-semibold mb-2">No hidden fees</h3>
            <p className="text-sm text-gray-400">
              Fixed price per launch, no surprises.
            </p>
          </div>
        </section>
      </div>

      {showWithdrawModal && (
        <WithdrawModal
          isOpen={showWithdrawModal}
          onClose={() => setShowWithdrawModal(false)}
          poolAddress={selectedPoolAddress}
          lpTokenAmount={selectedLpAmount}
          onSuccess={(txHash) => {
            console.log('Withdrawal successful! TX:', txHash);
          }}
        />
      )}
    </main>
  );
}