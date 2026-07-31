'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Transaction, Connection } from '@solana/web3.js';

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  poolAddress: string;
  lpTokenAmount: number;
  onSuccess: (txHash: string) => void;
}

export default function WithdrawModal({
  isOpen,
  onClose,
  poolAddress,
  lpTokenAmount,
  onSuccess,
}: WithdrawModalProps) {
  const { publicKey, signTransaction } = useWallet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const userAmount = lpTokenAmount * 0.9;
  const platformFee = lpTokenAmount * 0.1;

  const handleWithdraw = async () => {
    if (!publicKey || !signTransaction) {
      setError('Please connect your wallet first');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/withdraw-liquidity`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userWallet: publicKey.toBase58(),
            poolAddress,
            lpTokenAmount,
          }),
        }
      );

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to prepare withdrawal');
      }

      // No existe una ruta /api/blockhash en el frontend (Next.js) — pedimos
      // el blockhash directo al RPC de Solana, igual que hace el resto de la app.
      const rpcConn = new Connection(
        process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com'
      );
      const { blockhash } = await rpcConn.getLatestBlockhash();

      const tx = Transaction.from(Buffer.from(data.transaction, 'base64'));
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signedTx = await signTransaction(tx);

      const submitRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/submit-transaction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            signedTransaction: signedTx.serialize().toString('base64'),
          }),
        }
      );

      const submitData = await submitRes.json();
      if (!submitData.success) {
        throw new Error(submitData.error || 'Transaction submission failed');
      }

      onSuccess(submitData.txId);
      onClose();
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D0C11] border border-[#232028] max-w-md w-full p-6 rounded-2xl">
        <h2 className="text-xl font-semibold mb-4 text-white">Withdraw Liquidity</h2>

        <div className="space-y-4 mb-6">
          <div className="bg-[#121017] p-4 rounded-lg space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Total LP Tokens</span>
              <span className="text-white">{lpTokenAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Your Share (90%)</span>
              <span className="text-green-400">{userAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Platform Fee (10%)</span>
              <span className="text-purple-400">{platformFee.toFixed(2)}</span>
            </div>
          </div>

          <div className="text-xs text-gray-500 flex items-start gap-2">
            <span className="text-purple-400">ℹ️</span>
            <p>
              Fee covers the cost of facilitating the withdrawal and maintaining the platform.
              You can also withdraw directly via Raydium with 0% fee.
            </p>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm p-3 rounded-lg">
              {error}
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 px-4 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleWithdraw}
            disabled={loading}
            className="flex-1 py-2 px-4 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Processing...' : 'Confirm Withdrawal'}
          </button>
        </div>
      </div>
    </div>
  );
}