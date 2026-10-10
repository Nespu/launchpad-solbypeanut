'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Transaction, Connection } from '@solana/web3.js';
import WithdrawLiquidity from './WithdrawLiquidity';

interface PoolCreateProps {
  mintAddress: string;
  tokenSymbol: string;
  defaultTokenAmount: string;
  defaultSolAmount: string;
  onBack: () => void;
}

export default function PoolCreate({
  mintAddress,
  tokenSymbol,
  defaultTokenAmount,
  defaultSolAmount,
  onBack,
}: PoolCreateProps) {
  const { publicKey, signTransaction } = useWallet();

  const [tokenAmount, setTokenAmount] = useState(defaultTokenAmount);
  const [solAmount, setSolAmount] = useState(defaultSolAmount);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [poolResult, setPoolResult] = useState<{ txId: string; poolId: string } | null>(null);
  const [goToWithdraw, setGoToWithdraw] = useState(false);
  const [existingPool, setExistingPool] = useState<string | null>(null);
  const [checkingPool, setCheckingPool] = useState(true);
  const [poolCheckFailed, setPoolCheckFailed] = useState(false);
  const [poolCheckAttempt, setPoolCheckAttempt] = useState(0);


  useEffect(() => {
    let active = true;

    const checkExistingPool = async () => {
      if (!publicKey) {
        setCheckingPool(false);
        return;
      }

      setCheckingPool(true);
      setPoolCheckFailed(false);
      try {
        const response = await fetch(
          (process.env.NEXT_PUBLIC_API_URL || '') +
            '/api/my-pools?userWallet=' +
            encodeURIComponent(publicKey.toBase58())
        );
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'No se pudo comprobar si el token ya tiene una pool');
        }

        const pool = data.pools.find((item: { mintAddress: string; poolAddress: string }) =>
          item.mintAddress === mintAddress
        );
        if (active && pool) setExistingPool(pool.poolAddress);
      } catch {
        if (active) setPoolCheckFailed(true);
      } finally {
        if (active) setCheckingPool(false);
      }
    };

    checkExistingPool();
    return () => {
      active = false;
    };
  }, [mintAddress, publicKey, poolCheckAttempt]);
  const handleCreatePool = async () => {
    if (!publicKey || !signTransaction) {
      setError('Please connect your wallet first');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const tokenAmountRaw = (BigInt(tokenAmount) * BigInt(1e9)).toString();

      const createRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/create-pool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userWallet: publicKey.toBase58(),
          mintAddress,
          tokenAmount: tokenAmountRaw,
          solAmount: Number(solAmount),
        }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Failed to prepare pool creation');

      const rpcConn = new Connection(
        process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com'
      );

      const { blockhash } = await rpcConn.getLatestBlockhash();
      const tx = Transaction.from(Buffer.from(createData.transaction, 'base64'));
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signedTx = await signTransaction(tx);

      const submitRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/submit-pool-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signedTransaction: signedTx.serialize().toString('base64'),
          userWallet: publicKey.toBase58(),
          mintAddress,
          poolAddress: createData.poolId,
        }),
      });
      const submitData = await submitRes.json();
      if (!submitData.success) {
        throw new Error(submitData.error || 'Pool transaction submission failed');
      }

      setPoolResult({ txId: submitData.txId, poolId: submitData.poolId });
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const openExplorer = () => {
    if (!poolResult) return;
    window.open(
      'https://explorer.solana.com/tx/' + poolResult.txId + '?cluster=devnet',
      '_blank'
    );
  };

  if ((poolResult || existingPool) && goToWithdraw) {
    return (
      <WithdrawLiquidity
        poolAddress={poolResult?.poolId || existingPool!}
        onBack={() => setGoToWithdraw(false)}
      />
    );
  }

  if (checkingPool) {
    return (
      <div className="max-w-xl mx-auto">
        <button onClick={onBack} className="text-sm text-[var(--muted)] mb-5 flex items-center gap-1">
          {'<-'} Volver
        </button>
        <div className="glass-card rounded-2xl p-6 text-sm text-[var(--muted)]">
          Comprobando si el token ya tiene una pool...
        </div>
      </div>
    );
  }

  if (poolCheckFailed) {
    return (
      <div className="max-w-xl mx-auto">
        <button onClick={onBack} className="text-sm text-[var(--muted)] mb-5 flex items-center gap-1">
          {'<-'} Volver
        </button>
        <div className="glass-card rounded-2xl p-6 space-y-3">
          <div className="text-sm text-red-400">
            No se pudo comprobar si ya existe una pool. Reintenta antes de crear otra.
          </div>
          <button
            onClick={() => setPoolCheckAttempt((attempt) => attempt + 1)}
            className="w-full py-2.5 rounded-lg text-sm wire-input"
          >
            Reintentar comprobación
          </button>
        </div>
      </div>
    );
  }

  if (existingPool) {
    return (
      <div className="max-w-xl mx-auto">
        <button onClick={onBack} className="text-sm text-[var(--muted)] mb-5 flex items-center gap-1">
          {'<-'} Volver
        </button>
        <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>
          STAGE 2 - LIQUIDEZ
        </div>
        <h2 className="font-display text-2xl mb-2">Pool existente</h2>
        <p className="text-sm text-[var(--muted)] mb-6">
          {tokenSymbol || 'Este token'} ya tiene una pool creada.
        </p>
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <div className="wire-input rounded-lg p-2.5 text-[11px] font-mono text-[var(--muted)] break-all">
            Pool: {existingPool}
          </div>
          <button
            onClick={() => setGoToWithdraw(true)}
            className="w-full py-2.5 rounded-lg font-medium text-sm"
            style={{ background: 'var(--wire-violet)', color: '#fff' }}
          >
            Withdraw Liquidity
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto">
      <button onClick={onBack} className="text-sm text-[var(--muted)] mb-5 flex items-center gap-1">
        {'<-'} Volver
      </button>

      <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>STAGE 2 - LIQUIDEZ</div>
      <h2 className="font-display text-2xl mb-2">Crea el pool en Raydium</h2>
      <p className="text-sm text-[var(--muted)] mb-6">
        Definí cuánto supply y cuánto SOL entran al pool. Esto es lo que hace que {tokenSymbol || 'tu token'} sea tradeable.
      </p>

      <div className="glass-card rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="wire-input flex-1 rounded-lg px-3 py-2.5 text-sm font-mono">{tokenSymbol || 'TOKEN'}</div>
          <span className="text-[var(--muted)]">+</span>
          <div className="wire-input flex-1 rounded-lg px-3 py-2.5 text-sm font-mono">SOL</div>
        </div>

        <div>
          <label className="text-sm text-[var(--muted)] block mb-1">Cantidad de {tokenSymbol || 'token'}</label>
          <input
            value={tokenAmount}
            onChange={(e) => setTokenAmount(e.target.value)}
            className="wire-input w-full rounded-lg p-2.5 text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-sm text-[var(--muted)] block mb-1">
            Cantidad de SOL (0.2 SOL reservado para fees)
          </label>
          <input
            value={solAmount}
            onChange={(e) => setSolAmount(e.target.value)}
            className="wire-input w-full rounded-lg p-2.5 text-sm font-mono"
          />
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm p-3 rounded-lg">
            {error}
          </div>
        )}

        <button
          onClick={handleCreatePool}
          disabled={loading}
          className="w-full py-3 rounded-lg font-display font-medium text-sm disabled:opacity-60"
          style={{ background: 'var(--wire-green)', color: '#0a1006' }}
        >
          {loading ? 'Creando pool...' : 'Create Pool'}
        </button>

        {poolResult && (
          <div className="text-sm space-y-2">
            <div style={{ color: 'var(--success)' }}>
              Pool creado con exito -{' '}
              <button onClick={openExplorer} className="underline" style={{ color: 'var(--success)' }}>
                Ver transaccion
              </button>
            </div>
            <button
              onClick={() => setGoToWithdraw(true)}
              className="w-full py-2.5 rounded-lg font-medium text-sm"
              style={{ background: 'var(--wire-violet)', color: '#fff' }}
            >
              Withdraw Liquidity
            </button>
          </div>
        )}
      </div>
    </div>
  );
}