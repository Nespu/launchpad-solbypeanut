'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Transaction, Connection } from '@solana/web3.js';

interface WithdrawLiquidityProps {
  poolAddress: string;
  onBack: () => void;
}

export default function WithdrawLiquidity({ poolAddress, onBack }: WithdrawLiquidityProps) {
  const { publicKey, signTransaction } = useWallet();

  const [rawBalance, setRawBalance] = useState('0');
  const [uiBalance, setUiBalance] = useState(0);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [percent, setPercent] = useState(50);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    txId: string;
    userAmountSol: number;
    platformFeeSol: number;
  } | null>(null);

  // FIX (08/10): esta función se saca del useEffect para poder llamarla
  // de nuevo después de un retiro exitoso, no solo al montar el componente.
  const fetchBalance = useCallback(() => {
    if (!publicKey) return;
    setLoadingBalance(true);
    return fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/lp-balance?userWallet=${publicKey.toBase58()}&poolAddress=${poolAddress}`
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setRawBalance(data.rawBalance);
          setUiBalance(data.uiBalance);
        } else {
          setError(data.error || 'No se pudo leer el balance de LP');
        }
      })
      .catch(() => setError('No se pudo leer el balance de LP'))
      .finally(() => setLoadingBalance(false));
  }, [publicKey, poolAddress]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  const rawAmountToWithdraw = (() => {
    try {
      const total = BigInt(rawBalance);
      return ((total * BigInt(percent)) / BigInt(100)).toString();
    } catch {
      return '0';
    }
  })();

  const uiAmountToWithdraw = (uiBalance * percent) / 100;

  const handleWithdraw = async () => {
    if (!publicKey || !signTransaction) {
      setError('Please connect your wallet first');
      return;
    }
    if (rawAmountToWithdraw === '0') {
      setError('No tenes LP tokens para retirar en este pool');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const createRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/withdraw-liquidity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userWallet: publicKey.toBase58(),
          poolAddress,
          lpTokenAmount: rawAmountToWithdraw,
        }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Failed to prepare withdrawal');

      const rpcConn = new Connection(
        process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com'
      );

      const { blockhash } = await rpcConn.getLatestBlockhash();
      const tx = Transaction.from(Buffer.from(createData.transaction, 'base64'));
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signedTx = await signTransaction(tx);

      const sig = await rpcConn.sendRawTransaction(signedTx.serialize());
      await rpcConn.confirmTransaction(sig, 'confirmed');

      setResult({
        txId: sig,
        userAmountSol: createData.userAmountSol,
        platformFeeSol: createData.platformFeeSol,
      });

      // FIX (08/10): refrescar el balance de LP real después de un retiro
      // exitoso, para que el próximo retiro no use el número viejo.
      setPercent(0);
      await fetchBalance();
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const openExplorer = () => {
    if (!result) return;
    window.open('https://explorer.solana.com/tx/' + result.txId + '?cluster=devnet', '_blank');
  };

  return (
    <div className="max-w-xl mx-auto">
      <button onClick={onBack} className="text-sm text-[var(--muted)] mb-5 flex items-center gap-1">
        {'<-'} Volver
      </button>

      <div className="text-xs font-mono mb-1" style={{ color: 'var(--wire-green)' }}>STAGE 4 - RETIRO</div>
      <h2 className="font-display text-2xl mb-2">Retira liquidez</h2>
      <p className="text-sm text-[var(--muted)] mb-6">
        90% vuelve a tu wallet, 10% queda como fee de la plataforma. Se calcula sobre el valor real del pool.
      </p>

      <div className="glass-card rounded-2xl p-6 space-y-5">
        <div className="wire-input rounded-lg p-2.5 text-[11px] font-mono text-[var(--muted)] break-all">
          Pool: {poolAddress}
        </div>

        {loadingBalance ? (
          <div className="text-sm text-[var(--muted)]">Leyendo tu balance de LP...</div>
        ) : (
          <>
            <div className="text-sm text-[var(--muted)]">
              Tu balance: <span className="font-mono text-[var(--text)]">{uiBalance}</span> LP tokens
            </div>

            <div>
              <div className="flex justify-between items-baseline mb-2">
                <label className="text-sm text-[var(--muted)]">Cuanto queres retirar</label>
                <span className="font-display text-2xl">{percent}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={95}
                step={1}
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
                className="w-full"
                style={{ accentColor: 'var(--wire-green)' }}
              />
              <div className="flex justify-between text-[11px] text-[var(--muted)] mt-1">
                <span>0%</span>
                <span>95% (max)</span>
              </div>
              <div className="flex gap-2 mt-3">
                {[25, 50, 75, 95].map((p) => (
                  <button
                    key={p}
                    onClick={() => setPercent(p)}
                    className="flex-1 py-1.5 rounded-md text-xs wire-input"
                    style={{
                      borderColor: percent === p ? 'var(--wire-green)' : 'var(--line)',
                      color: percent === p ? 'var(--wire-green)' : 'var(--muted)',
                    }}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>

            <div className="wire-input rounded-lg p-3 text-sm font-mono">
              Vas a retirar: {uiAmountToWithdraw.toFixed(4)} LP tokens
            </div>
          </>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm p-3 rounded-lg">
            {error}
          </div>
        )}

        <button
          onClick={handleWithdraw}
          disabled={loading || loadingBalance || percent === 0}
          className="w-full py-3 rounded-lg font-display font-medium text-sm disabled:opacity-60"
          style={{ background: 'var(--wire-green)', color: '#0a1006' }}
        >
          {loading ? 'Retirando...' : 'Withdraw Liquidity'}
        </button>

        {result && (
          <div className="text-sm space-y-1" style={{ color: 'var(--success)' }}>
            <div>Retiro exitoso</div>
            <div className="font-mono text-xs">Recibiste: {result.userAmountSol.toFixed(4)} SOL</div>
            <div className="font-mono text-xs">Fee plataforma: {result.platformFeeSol.toFixed(4)} SOL</div>
            <button onClick={openExplorer} className="underline" style={{ color: 'var(--success)' }}>
              Ver transaccion
            </button>
          </div>
        )}
      </div>
    </div>
  );
}