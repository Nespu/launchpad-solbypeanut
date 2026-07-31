'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Transaction, Connection } from '@solana/web3.js';

export default function TokenForm() {
  const { publicKey, signTransaction } = useWallet();

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [totalSupply, setTotalSupply] = useState('1000000000');
  const [liquiditySol, setLiquiditySol] = useState('1');
  const [imageBase64, setImageBase64] = useState<string | undefined>(undefined);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successTx, setSuccessTx] = useState<string | null>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImageBase64(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!publicKey || !signTransaction) {
      setError('Please connect your wallet first');
      return;
    }
    if (!name || !symbol || !totalSupply || !liquiditySol) {
      setError('Please fill in all required fields');
      return;
    }

    setLoading(true);
    setError('');
    setSuccessTx(null);

    try {
      const createRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/create-token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userWallet: publicKey.toBase58(),
            name,
            symbol,
            description,
            imageBase64,
            totalSupply: Number(totalSupply),
            liquiditySol: Number(liquiditySol),
          }),
        }
      );

      const createData = await createRes.json();
      if (!createData.success) {
        throw new Error(createData.error || 'Failed to prepare token creation');
      }

      const rpcConn = new Connection(
        process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com'
      );
      const { blockhash } = await rpcConn.getLatestBlockhash();

      const tx = Transaction.from(Buffer.from(createData.transaction, 'base64'));
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
            mintAddress: createData.mintAddress,
          }),
        }
      );

      const submitData = await submitRes.json();
      if (!submitData.success) {
        throw new Error(submitData.error || 'Transaction submission failed');
      }

      setSuccessTx(submitData.txId);
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="glass-card p-6 rounded-2xl space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-gray-400 block mb-1">Token name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Doge Killer"
            className="w-full bg-[#121017] border border-[#232028] rounded-lg p-2 text-white"
          />
        </div>
        <div>
          <label className="text-sm text-gray-400 block mb-1">Symbol</label>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="DOGEK"
            maxLength={10}
            className="w-full bg-[#121017] border border-[#232028] rounded-lg p-2 text-white"
          />
        </div>
      </div>

      <div>
        <label className="text-sm text-gray-400 block mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What's this token about?"
          className="w-full bg-[#121017] border border-[#232028] rounded-lg p-2 text-white"
          rows={2}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-gray-400 block mb-1">Total supply</label>
          <input
            type="number"
            value={totalSupply}
            onChange={(e) => setTotalSupply(e.target.value)}
            className="w-full bg-[#121017] border border-[#232028] rounded-lg p-2 text-white"
          />
        </div>
        <div>
          <label className="text-sm text-gray-400 block mb-1">Initial liquidity (SOL)</label>
          <input
            type="number"
            step="0.1"
            value={liquiditySol}
            onChange={(e) => setLiquiditySol(e.target.value)}
            className="w-full bg-[#121017] border border-[#232028] rounded-lg p-2 text-white"
          />
        </div>
      </div>

      <div>
        <label className="text-sm text-gray-400 block mb-1">Token image</label>
        <input type="file" accept="image/*" onChange={handleImageChange} className="text-sm text-gray-400" />
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm p-3 rounded-lg">
          {error}
        </div>
      )}

      {successTx && (
        <div className="bg-green-500/10 border border-green-500/20 text-green-400 text-sm p-3 rounded-lg">
          Token created! TX: {successTx}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 px-4 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Creating...' : 'Create Token'}
      </button>
    </form>
  );
}
