'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import TrustRing from './TrustRing';
import PoolCreate from './PoolCreate';

const STEPS = ['Token', 'Supply', 'Seguridad'];
const AUTHORITIES = [
  { key: 'mint', icon: '🔒', name: 'Revoke Mint', desc: 'Nadie podrá acuñar más supply del que existe hoy.' },
  { key: 'freeze', icon: '❄️', name: 'Revoke Freeze', desc: 'Ninguna wallet podrá ser congelada.' },
  { key: 'update', icon: '✏️', name: 'Revoke Update', desc: 'La metadata queda fija para siempre.' },
];

export default function TokenForm() {
  const { publicKey, signTransaction } = useWallet();

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [totalSupply, setTotalSupply] = useState('1000000000');
  const [liquiditySol, setLiquiditySol] = useState('1');
  const [imageBase64, setImageBase64] = useState<string | undefined>(undefined);
  const [imagePreview, setImagePreview] = useState<string | undefined>(undefined);
  const [securityAssets, setSecurityAssets] = useState<string[]>(['mint', 'freeze', 'update']);
  const [showSocials, setShowSocials] = useState(false);
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feeConfig, setFeeConfig] = useState<{ baseFeeSol: number; assetFeeSol: number } | null>(null);
  const [result, setResult] = useState<{ txId: string; mintAddress: string } | null>(null);
  const [goToPool, setGoToPool] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/fee-config`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || cancelled) return;
        setFeeConfig({ baseFeeSol: data.baseFeeSol, assetFeeSol: data.assetFeeSol });
      })
      .catch(() => {
        if (!cancelled) setError('No se pudo cargar el costo de creación. Recarga la página e intenta de nuevo.');
      });
    return () => { cancelled = true; };
  }, []);

  const totalFee = feeConfig ? feeConfig.baseFeeSol + securityAssets.length * feeConfig.assetFeeSol : null;
  const securityFee = feeConfig ? securityAssets.length * feeConfig.assetFeeSol : null;
  const formatSol = (amount: number) => `${amount.toFixed(6).replace(/\.?0+$/, '')} SOL`;

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImageBase64(reader.result as string);
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const toggleAuthority = (key: string) => {
    setSecurityAssets((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const canNext = step === 0 ? name && symbol : step === 1 ? totalSupply && liquiditySol : true;

  const handleSubmit = async () => {
    if (!publicKey || !signTransaction) {
      setError('Please connect your wallet first');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const createRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/create-token`, {
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
          securityAssets,
        }),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Failed to prepare token creation');

      // Esta tx ya viene con feePayer, recentBlockhash, y la firma parcial
      // del mint puestas por el backend — no tocar nada más acá.
      const tx = Transaction.from(Buffer.from(createData.transaction, 'base64'));
      const signedTx = await signTransaction(tx);

      const submitRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/submit-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signedTransaction: signedTx.serialize().toString('base64'),
          mintAddress: createData.mintAddress,
          userWallet: publicKey.toBase58(),
          name,
          symbol,
          description,
          imageUrl: createData.imageUrl,
          totalSupply: Number(totalSupply),
          liquiditySol: Number(liquiditySol),
        }),
      });
      const submitData = await submitRes.json();
      if (!submitData.success) throw new Error(submitData.error || 'Transaction submission failed');

      setResult({ txId: submitData.txId, mintAddress: createData.mintAddress });
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  if (result && goToPool) {
    return (
      <PoolCreate
        mintAddress={result.mintAddress}
        tokenSymbol={symbol}
        defaultTokenAmount={totalSupply}
        defaultSolAmount={liquiditySol}
        onBack={() => setGoToPool(false)}
      />
    );
  }

  return (
    <div className="max-w-xl mx-auto">
      {/* Progreso */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((label, i) => (
          <div key={label} className="flex-1">
            <div
              className="h-1 rounded-full mb-2"
              style={{ background: i <= step ? 'var(--wire-green)' : 'var(--line)' }}
            />
            <span
              className="text-xs font-mono"
              style={{ color: i <= step ? 'var(--text)' : 'var(--muted)' }}
            >
              {label}
            </span>
          </div>
        ))}
      </div>

      <div className="glass-card rounded-2xl p-6">
        {step === 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-[var(--muted)] block mb-1">Nombre</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={32}
                  placeholder="Nutcoin"
                  className="wire-input w-full rounded-lg p-2.5 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--muted)] block mb-1">Símbolo</label>
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  maxLength={8}
                  placeholder="NUT"
                  className="wire-input w-full rounded-lg p-2.5 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-[var(--muted)] block mb-1">Imagen</label>
              <label className="wire-input flex flex-col items-center justify-center gap-2 rounded-xl p-8 text-sm text-[var(--muted)] cursor-pointer border-dashed">
                {imagePreview ? (
                  <img src={imagePreview} alt="preview" className="w-16 h-16 rounded-lg object-cover" />
                ) : (
                  <span>Arrastrá una imagen o hacé click</span>
                )}
                <input type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
              </label>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="text-sm text-[var(--muted)] block mb-1">Descripción</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="¿De qué va tu token?"
                className="wire-input w-full rounded-lg p-2.5 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-[var(--muted)] block mb-1">Total supply</label>
                <input
                  type="number"
                  value={totalSupply}
                  onChange={(e) => setTotalSupply(e.target.value)}
                  className="wire-input w-full rounded-lg p-2.5 text-sm font-mono"
                />
                <div className="text-[11px] text-[var(--muted)] mt-1">1,000M por defecto · 9 decimales</div>
              </div>
              <div>
                <label className="text-sm text-[var(--muted)] block mb-1">Liquidez inicial (SOL)</label>
                <input
                  type="number"
                  step="0.1"
                  value={liquiditySol}
                  onChange={(e) => setLiquiditySol(e.target.value)}
                  className="wire-input w-full rounded-lg p-2.5 text-sm font-mono"
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div className="flex items-center gap-5">
              <TrustRing active={securityAssets.length} />
              <div>
                <div className="text-sm font-semibold mb-1">Anillo de confianza</div>
                <div className="text-xs text-[var(--muted)] leading-relaxed">
                  Cada autoridad revocada suma confianza — es lo primero que revisa un comprador antes de tradear.
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              {AUTHORITIES.map((a) => {
                const on = securityAssets.includes(a.key);
                return (
                  <div
                    key={a.key}
                    onClick={() => toggleAuthority(a.key)}
                    className="rounded-xl p-3 cursor-pointer wire-input"
                    style={{ borderColor: on ? 'var(--wire-green)' : 'var(--line)' }}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span>{a.icon}</span>
                      <span className="text-[10px] font-mono" style={{ color: 'var(--wire-green)' }}>
                        {feeConfig ? (feeConfig.assetFeeSol > 0 ? `+${formatSol(feeConfig.assetFeeSol)}` : 'Sin cargo extra') : 'Cargando…'}
                      </span>
                    </div>
                    <div className="text-xs font-semibold mb-1">{a.name}</div>
                    <div className="text-[10px] text-[var(--muted)] leading-tight mb-2">{a.desc}</div>
                    <div
                      className="text-[10px] text-center py-1 rounded"
                      style={{
                        background: on ? 'var(--wire-green)' : 'var(--line)',
                        color: on ? '#0a1006' : 'var(--muted)',
                      }}
                    >
                      {on ? 'Activado' : 'Desactivado'}
                    </div>
                  </div>
                );
              })}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold">Redes sociales</span>
                <div
                  onClick={() => setShowSocials(!showSocials)}
                  className="w-9 h-5 rounded-full cursor-pointer relative transition-colors"
                  style={{ background: showSocials ? 'var(--wire-violet)' : 'var(--line)' }}
                >
                  <div
                    className="w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all"
                    style={{ left: showSocials ? '18px' : '3px' }}
                  />
                </div>
              </div>
              {showSocials && (
                <div className="space-y-2">
                  <input
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                    placeholder="https://twitter.com/tutoken"
                    className="wire-input w-full rounded-lg p-2.5 text-sm"
                  />
                  <input
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                    placeholder="https://t.me/tutoken"
                    className="wire-input w-full rounded-lg p-2.5 text-sm"
                  />
                </div>
              )}
            </div>

            <section className="rounded-xl p-4 wire-input space-y-3" aria-label="Resumen de costos antes de firmar">
              <h3 className="text-sm font-semibold">Resumen antes de firmar</h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between gap-4 text-[var(--muted)]">
                  <span>Fee base de plataforma</span>
                  <span className="font-mono text-[var(--text)]">{feeConfig ? formatSol(feeConfig.baseFeeSol) : 'Cargando…'}</span>
                </div>
                <div className="flex justify-between gap-4 text-[var(--muted)]">
                  <span>Adicional por seguridad ({securityAssets.length} × {feeConfig ? formatSol(feeConfig.assetFeeSol) : '…'})</span>
                  <span className="font-mono text-[var(--text)]">{securityFee === null ? 'Cargando…' : formatSol(securityFee)}</span>
                </div>
                <div className="flex justify-between gap-4 border-t pt-2 font-semibold" style={{ borderColor: 'var(--line)' }}>
                  <span>Fee total de plataforma</span>
                  <span className="font-mono">{totalFee === null ? 'Cargando…' : formatSol(totalFee)}</span>
                </div>
                <div className="flex justify-between gap-4 text-[var(--muted)]">
                  <span>Liquidez inicial (al crear la pool después)</span>
                  <span className="font-mono">{liquiditySol || '0'} SOL</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                El fee de plataforma se incluye en la transacción de creación del token. La liquidez se aporta después, al crear la pool. La wallet mostrará aparte la comisión de red antes de firmar.
              </p>
            </section>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/20 text-red-400 text-sm p-3 rounded-lg">
            {error}
          </div>
        )}
      </div>

      {/* Navegación + fee */}
      <div className="flex items-center justify-between mt-5">
        <button
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="text-sm text-[var(--muted)] disabled:opacity-30 px-2"
        >
          ← Atrás
        </button>

        <div className="text-right">
          <div className="text-[11px] text-[var(--muted)]">Fee plataforma</div>
          <div className="font-mono text-lg">{totalFee === null ? '—' : `${totalFee.toFixed(6).replace(/\.?0+$/, '')} `}<span className="text-xs text-[var(--muted)]">SOL</span></div>
        </div>

        {step < 2 ? (
          <button
            onClick={() => canNext && setStep((s) => s + 1)}
            disabled={!canNext}
            className="px-6 py-2.5 rounded-lg font-display text-sm font-medium disabled:opacity-40"
            style={{ background: 'var(--wire-green)', color: '#0a1006' }}
          >
            Siguiente →
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={loading || !feeConfig}
            className="px-6 py-2.5 rounded-lg font-display text-sm font-medium disabled:opacity-60"
            style={{ background: 'var(--wire-green)', color: '#0a1006' }}
          >
            {loading ? 'Creando...' : !feeConfig ? 'Cargando costo...' : 'Create Token'}
          </button>
        )}
      </div>

      {/* Modal de éxito */}
      {result && !goToPool && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-5 z-50">
          <div className="glass-card rounded-2xl p-7 max-w-sm w-full bg-[var(--surface)]">
            <div
              className="w-11 h-11 rounded-full flex items-center justify-center text-xl mb-3"
              style={{ background: 'rgba(61,220,132,.12)', color: 'var(--success)' }}
            >
              ✓
            </div>
            <h3 className="font-display text-lg mb-1">Token creado</h3>
            <p className="text-sm text-[var(--muted)] mb-4 leading-relaxed">
              {name} ({symbol}) ya existe en Solana, con metadata on-chain y las autoridades elegidas revocadas.
            </p>
            <div className="wire-input rounded-lg p-2.5 text-[11px] font-mono text-[var(--muted)] break-all mb-4">
              {result.mintAddress}
            </div>
            <button
              onClick={() => setGoToPool(true)}
              className="w-full py-2.5 rounded-lg font-medium text-sm mb-2"
              style={{ background: 'var(--wire-violet)', color: '#fff' }}
            >
              + Create Liquidity Pool
            </button>
            <a
              href={`https://explorer.solana.com/tx/${result.txId}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="block text-center w-full py-2.5 rounded-lg text-sm wire-input mb-2"
            >
              ↗ View on Explorer
            </a>
            <button
              onClick={() => setResult(null)}
              className="w-full py-2 text-sm text-[var(--muted)]"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
