'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { notifyToast, userFacingError } from '../../../components/toastEvents';
import WalletAccountPanel from '../../../components/WalletAccountPanel';
import WireHeader from '../../../components/WireHeader';
import LanguageSwitcher from '../../../components/LanguageSwitcher';
import { useWireLocale } from '../../../components/LocaleProvider';
import ShareTokenCard from '../../../components/ShareTokenCard';
import TokenMarketFollow from '../../../components/TokenMarketFollow';
import TokenSwapPanel from '../../../components/TokenSwapPanel';

type TokenDetails = {
  mintAddress: string;
  name: string;
  symbol: string;
  description: string | null;
  imageUrl: string;
  totalSupply: string;
  liquiditySol: number;
  creatorWallet: string;
  createdAt: string;
  txHash: string;
  poolAddress: string | null;
  poolQuoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  bondingCurveAddress: string | null;
  holderReward: boolean;
  status: string;
};

const STATUS_LABELS: Record<string, string> = {
  completed: 'Completado',
  processing: 'Procesando',
  pending: 'Pendiente',
  failed: 'Fallido',
};

const explorerAddress = (address: string) =>
  `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;

export default function TokenDetailsPage() {
  const { locale, t } = useWireLocale();
  const translateRef = useRef(t);
  const params = useParams<{ mintAddress: string }>();
  const mintAddress = params.mintAddress;
  const [token, setToken] = useState<TokenDetails | null>(null);
  const [sellReviewRequest, setSellReviewRequest] = useState<{ amount: string; nonce: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { translateRef.current = t; }, [t]);

  useEffect(() => {
    let active = true;
    setSellReviewRequest(null);

    fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/token/${encodeURIComponent(mintAddress)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'No se pudieron cargar los detalles del token.');
        }
        return data.token as TokenDetails;
      })
      .then((data) => {
        if (active) setToken(data);
      })
      .catch((err: unknown) => {
        if (active) {
          const message = userFacingError(err, translateRef.current('No se pudieron cargar los detalles del token.'), translateRef.current);
          setError(message);
          notifyToast({ title: translateRef.current('No se pudieron cargar los detalles'), message: translateRef.current(message) });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [mintAddress]);

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
            <Link href="/tasks" className="wire-button wire-button-quiet text-sm">{t('Tareas')}</Link>
            <Link href="/manage-liquidity" className="wire-button wire-button-quiet text-sm">
              {t('Administrar liquidez')}
            </Link>
            <Link href="/wallets" className="wire-button wire-button-quiet text-sm">{t('Mis wallets')}</Link>
            <WalletAccountPanel />
          </nav>
        </WireHeader>

        <section className="mx-auto w-full max-w-3xl">
          <Link href="/manage-liquidity" className="wire-button wire-button-quiet mt-2 text-sm">
            ← {t('Volver a administrar liquidez')}
          </Link>

          {loading ? (
            <div className="glass-card mt-6 rounded-2xl p-8 text-sm text-[var(--muted)]">{t('Cargando token...')}</div>
          ) : error ? (
            <div className="glass-card mt-6 rounded-2xl p-8 text-sm text-[var(--muted)]" role="status">{t('No pudimos cargar la ficha de este token. Recarga la página para intentarlo de nuevo.')}</div>
          ) : token ? (
            <article className="wire-token-detail-card mt-6">
              <div className="flex items-center gap-4 mb-6">
                {token.imageUrl ? (
                  <img src={token.imageUrl} alt={token.name} className="h-20 w-20 rounded-2xl border border-[var(--line)] object-cover" />
                ) : null}
                <div className="min-w-0">
                  <div className="wire-kicker mb-2"><span className="wire-status-dot" aria-hidden="true" />{t('TOKEN · DEVNET')}</div>
                  <h2 className="font-display text-2xl font-semibold break-words">{token.name} ({token.symbol})</h2>
                </div>
              </div>

              {token.description ? (
                <p className="text-sm text-[var(--muted)] whitespace-pre-wrap mb-6">{token.description}</p>
              ) : null}

              <ShareTokenCard token={token} />

              <dl className="wire-token-detail-data">
                <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">Mint</dt>
                  <dd className="font-mono break-all">{token.mintAddress}</dd>
                </div>
                <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">Supply</dt>
                  <dd className="font-mono text-right break-all">{token.totalSupply} {token.symbol}</dd>
                </div>
                {token.launchPlatform === 'RAYDIUM' ? <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">{t('SOL configurados al crear el token')}</dt>
                  <dd className="font-mono text-right">{token.liquiditySol} SOL</dd>
                </div> : null}
                <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">{t('Mercado posterior')}</dt>
                  <dd>{token.launchPlatform === 'PUMP_FUN' ? t('Pump.fun → PumpSwap · SOL') : 'Raydium CPMM'}</dd>
                </div>
                {token.launchPlatform === 'PUMP_FUN' && <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">{t('Holder Rewards')}</dt>
                  <dd>{token.holderReward ? t('Recompensas distribuidas automáticamente por Pump') : t('Sin Holder Rewards')}</dd>
                </div>}
                <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">{t('Creador')}</dt>
                  <dd className="font-mono break-all">{token.creatorWallet}</dd>
                </div>
                <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">{t('Creado')}</dt>
                  <dd className="text-right">{new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(token.createdAt))}</dd>
                </div>
                <div className="wire-token-detail-row">
                  <dt className="text-[var(--muted)]">{t('Estado')}</dt>
                  <dd>{t(STATUS_LABELS[token.status] ?? token.status)}</dd>
                </div>
                {token.poolAddress && token.poolAddress !== 'pending' ? (
                  <>
                    <div className="wire-token-detail-row">
                      <dt className="text-[var(--muted)]">{t('Par de cotización')}</dt>
                      <dd>{token.poolQuoteMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC'}</dd>
                    </div>
                    <div className="wire-token-detail-row">
                      <dt className="text-[var(--muted)]">Pool</dt>
                      <dd className="font-mono break-all">{token.poolAddress}</dd>
                    </div>
                  </>
                ) : null}
                {token.launchPlatform === 'PUMP_FUN' && token.bondingCurveAddress ? (
                  <div className="wire-token-detail-row">
                    <dt className="text-[var(--muted)]">{t('Bonding curve')}</dt>
                    <dd className="font-mono break-all">{token.bondingCurveAddress}</dd>
                  </div>
                ) : null}
              </dl>

              <div className="grid gap-3 sm:grid-cols-2 mt-7">
                <a href={explorerAddress(token.mintAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full text-sm">
                  {t('Ver token en Explorer (Devnet)')}
                </a>
                <a href={`https://explorer.solana.com/tx/${encodeURIComponent(token.txHash)}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full text-sm">
                  {t('Ver creación en Explorer')}
                </a>
                {token.poolAddress && token.poolAddress !== 'pending' ? (
                  <a href={explorerAddress(token.poolAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full text-sm sm:col-span-2">
                    {t('Ver pool en Explorer (Devnet)')}
                  </a>
                ) : null}
                {token.launchPlatform === 'PUMP_FUN' && token.bondingCurveAddress ? (
                  <a href={explorerAddress(token.bondingCurveAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full text-sm sm:col-span-2">
                    {t('Ver bonding curve en Explorer')}
                  </a>
                ) : null}
              </div>
              {token.launchPlatform === 'PUMP_FUN' ? (
                <p className="mt-6 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4 text-sm leading-relaxed text-[var(--muted)]">{t('La curva Pump.fun opera hasta graduarse; después, Wire usa PumpSwap automáticamente. Revisa el mercado y la cotización antes de firmar.')}</p>
              ) : null}
              {((token.launchPlatform === 'PUMP_FUN' && token.bondingCurveAddress)
                || (token.launchPlatform === 'RAYDIUM' && token.poolAddress && token.poolAddress !== 'pending')) ? (
                <TokenMarketFollow
                  mintAddress={token.mintAddress}
                  tokenSymbol={token.symbol}
                  quoteMint={token.poolQuoteMint}
                  launchPlatform={token.launchPlatform}
                  onReviewSell={(amount) => setSellReviewRequest((previous) => ({
                    amount,
                    nonce: (previous?.nonce ?? 0) + 1,
                  }))}
                />
              ) : null}
              {(token.launchPlatform === 'PUMP_FUN' && token.bondingCurveAddress)
                || (token.launchPlatform === 'RAYDIUM' && token.poolAddress && token.poolAddress !== 'pending') ? (
                <TokenSwapPanel
                  mintAddress={token.mintAddress}
                  tokenSymbol={token.symbol}
                  quoteMint={token.poolQuoteMint}
                  launchPlatform={token.launchPlatform}
                  reviewSellRequest={sellReviewRequest}
                />
              ) : null}
            </article>
          ) : null}
        </section>
      </div>
    </main>
  );
}
