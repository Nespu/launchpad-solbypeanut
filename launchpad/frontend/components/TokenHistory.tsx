'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import Link from 'next/link';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useWalletIdentity } from './WalletIdentityProvider';
import { userFacingError } from './toastEvents';
import { useWireLocale } from './LocaleProvider';
import { getWalletVaultMetadata, type VaultWallet } from '../lib/walletVault';
import {
  calculateRecordedSwapResults,
  classifyTokenMovement,
  getOwnedTokenDeltas,
  type TokenMovementKind,
  type WalletSwapActivity,
  type WalletTokenMovement,
} from '../lib/tokenHistoryAnalytics';
import {
  readWalletTransferBasis,
  upsertWalletTransferBasis,
  walletTransferBasisTransferKey,
  writeWalletTransferBasis,
  type StoredWalletTransferBasisLot,
} from '../lib/walletTransferBasis';
import { getWalletHistorySourceAddresses, getWalletOwnedTokenAccountSources, mergeWalletHistorySignatures, takeWalletHistorySignaturePage } from '../lib/walletHistorySignatureScan';
import { aggregateParsedTokenBalances, type ParsedTokenBalance } from '../lib/tokenBalanceSnapshot';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';
import { isWalletActivityCoveragePartial } from '../lib/walletActivityCoverage';
import { comparePortfolioExitToFifo, isPortfolioActivityComplete } from '../lib/portfolioPnlComparison';
import {
  getTrackedRaydiumPoolAddressesInTransaction,
  matchTrackedRaydiumLpMovements,
  scanTrackedRaydiumLpPositions,
  type ResolvedRaydiumLpPool,
  type WalletLpPositionScan,
} from '../lib/walletLpPositions';

type WalletTokenActivity = {
  mintAddress: string;
  name: string;
  symbol: string;
  imageUrl: string;
  poolAddress: string | null;
  poolQuoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  bondingCurveAddress: string | null;
  status: string;
  createdAt: string;
  txHash: string;
};

type WalletWithdrawalActivity = {
  id: string;
  poolAddress: string;
  lpTokenAmount: number;
  userAmountLamports: string | null;
  platformFeeLamports: string | null;
  quoteAmountRaw: string | null;
  platformFeeRaw: string | null;
  quoteMint: string;
  quoteDecimals: number;
  userAmount: number;
  platformFee: number;
  status: string;
  txHash: string | null;
  createdAt: string;
};

type WalletHistory = {
  tokens: WalletTokenActivity[];
  withdrawals: WalletWithdrawalActivity[];
  swaps: WalletSwapActivity[];
  swapsHasMore: boolean;
  swapsUnavailable: boolean;
  withdrawalsUnavailable: boolean;
  withdrawalAmountsApproximate: boolean;
};

type RecentChainSignature = {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  detailsRequested: boolean;
  tokenDeltas: { mintAddress: string; decimals: number | null; amountRaw: string; counterpartyAddress: string | null }[] | null;
  tokenMovementKind: TokenMovementKind | null;
  trackedLiquidityPoolMovements: ResolvedRaydiumLpPool[];
};

type SignatureScanCandidate = {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err: unknown;
};

type SignatureScanCursor = {
  address: string;
  before: string | null;
  hasMore: boolean;
};

type CurrentTokenBalanceSnapshot = {
  walletAddress: string;
  balancesByMint: Map<string, ParsedTokenBalance>;
  solLamports: string;
  fetchedAt: number;
};

type CurrentWalletLpSnapshot = WalletLpPositionScan & {
  walletAddress: string;
  fetchedAt: number;
};

type PortfolioExitQuote = {
  quoteMint: string;
  quoteSymbol: 'SOL' | 'USDC';
  amountOut: string;
  amountOutRaw: string;
  quoteDecimals: number;
  minimumAmountOut: string;
  estimatedPoolFee: string;
  priceImpactPercent: string | null;
  poolAddress: string;
  venue: 'RAYDIUM' | 'PUMP_FUN' | 'PUMP_SWAP';
};

type PortfolioExitEstimate = {
  amountRaw: string;
  tokenDecimals: number;
  quotedAt: string;
  quotes: PortfolioExitQuote[];
  coverageIncomplete: boolean;
  searchedQuoteAssets: { quoteSymbol: 'SOL' | 'USDC'; hasIndexedCandidate: boolean }[];
};

type PortfolioExitEstimateState = {
  status: 'loading' | 'ready' | 'error';
  estimate?: PortfolioExitEstimate;
  error?: string;
};

function tokenMovementKindLabel(kind: TokenMovementKind | null, isTrackedLiquidityMovement = false) {
  if (isTrackedLiquidityMovement) return 'Movimiento de liquidez Raydium en pool registrada';
  if (kind === 'transfer') return 'Transferencia SPL identificada';
  if (kind === 'mint') return 'Acuñación SPL identificada';
  if (kind === 'burn') return 'Quema SPL identificada';
  if (kind === 'other') return 'Instrucciones mixtas o no clasificadas';
  return 'Tipo de movimiento no disponible';
}

type ExternalSwapVerificationStatus = 'checking' | 'imported' | 'pending' | 'notVerified';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_RECENT_CHAIN_SIGNATURES = 100;
const MAX_CHAIN_DETAIL_BATCH_SIZE = 25;
const MAX_SIGNATURE_SCAN_CONCURRENCY = 5;

function formatRawTokenAmount(rawAmount: string, decimals: number, locale: 'es' | 'en') {
  return formatRawAmount(rawAmount, decimals, locale);
}

function formatRawAmount(rawAmount: string, decimals: number, locale: 'es' | 'en') {
  const raw = BigInt(rawAmount);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const numberLocale = locale === 'es' ? 'es-419' : 'en-US';
  const wholeText = new Intl.NumberFormat(numberLocale).format(whole);
  const decimal = new Intl.NumberFormat(numberLocale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return `${negative ? '-' : ''}${fraction ? `${wholeText}${decimal}${fraction}` : wholeText}`;
}

function formatDecimalAmount(value: string, decimals: number, locale: 'es' | 'en') {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const fraction = match[2] ?? '';
  const raw = BigInt(match[1]) * (10n ** BigInt(decimals))
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return formatRawAmount(raw.toString(), decimals, locale);
}

const STATUS_LABELS: Record<string, string> = {
  created: 'Token creado',
  completed: 'Completado',
  processing: 'Procesando',
  pending: 'Pendiente',
  failed: 'Fallido',
  cancelled: 'Cancelado',
  expired: 'Expirado sin confirmar',
  expired_unverified: 'Sin confirmación verificable',
};

function statusLabel(status: string, translate: (key: string) => string) {
  return translate(STATUS_LABELS[status] ?? status);
}

function explorerAddress(address: string) {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
}

function shortenAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function explorerTransaction(signature: string) {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function formatSol(amount: number, locale: 'es' | 'en') {
  return new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(amount);
}

function formatSolLamports(lamports: string | null, fallback: number, locale: 'es' | 'en') {
  if (lamports === null) return formatSol(fallback, locale);

  try {
    const raw = BigInt(lamports);
    const negative = raw < BigInt(0);
    const absolute = negative ? -raw : raw;
    const whole = absolute / BigInt(1_000_000_000);
    const fraction = (absolute % BigInt(1_000_000_000)).toString().padStart(9, '0').replace(/0+$/, '').padEnd(4, '0');
    const numberLocale = locale === 'es' ? 'es-419' : 'en-US';
    const wholeText = new Intl.NumberFormat(numberLocale).format(whole);
    const decimal = new Intl.NumberFormat(numberLocale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
    return `${negative ? '-' : ''}${wholeText}${decimal}${fraction}`;
  } catch {
    return formatSol(fallback, locale);
  }
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function TokenHistory() {
  const { locale, t } = useWireLocale();
  const translateRef = useRef(t);
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const currentWalletAddressRef = useRef<string | null>(null);
  currentWalletAddressRef.current = publicKey?.toBase58() ?? null;
  const { identifiedWallet } = useWalletIdentity();
  const [history, setHistory] = useState<WalletHistory>({ tokens: [], withdrawals: [], swaps: [], swapsHasMore: false, swapsUnavailable: false, withdrawalsUnavailable: false, withdrawalAmountsApproximate: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [olderSwapsLoading, setOlderSwapsLoading] = useState(false);
  const [olderSwapsError, setOlderSwapsError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [focusedDate, setFocusedDate] = useState(() => localDateKey(new Date()));
  const calendarDayRefs = useRef(new Map<string, HTMLButtonElement>());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showCancelledAttempts, setShowCancelledAttempts] = useState(false);
  const [chainSignatures, setChainSignatures] = useState<RecentChainSignature[]>([]);
  const [chainSignaturesWallet, setChainSignaturesWallet] = useState('');
  const [chainSignatureSourceCount, setChainSignatureSourceCount] = useState(0);
  const [chainSignaturesLoading, setChainSignaturesLoading] = useState(false);
  const [chainSignaturesFetched, setChainSignaturesFetched] = useState(false);
  const [chainHasMore, setChainHasMore] = useState(false);
  const [chainSignaturesError, setChainSignaturesError] = useState('');
  const [chainDetailsUnavailable, setChainDetailsUnavailable] = useState(false);
  const [chainHistoryCoveragePartial, setChainHistoryCoveragePartial] = useState(false);
  const [currentTokenBalanceSnapshot, setCurrentTokenBalanceSnapshot] = useState<CurrentTokenBalanceSnapshot | null>(null);
  const [currentTokenBalancesLoading, setCurrentTokenBalancesLoading] = useState(false);
  const [currentTokenBalancesError, setCurrentTokenBalancesError] = useState('');
  const [currentWalletLpSnapshot, setCurrentWalletLpSnapshot] = useState<CurrentWalletLpSnapshot | null>(null);
  const [portfolioExitEstimates, setPortfolioExitEstimates] = useState<Record<string, PortfolioExitEstimateState>>({});
  const portfolioExitInFlightRef = useRef(new Set<string>());
  const chainSignatureCursorsRef = useRef<SignatureScanCursor[]>([]);
  const chainSignatureBacklogRef = useRef<SignatureScanCandidate[]>([]);
  const chainSignatureTrackedMintsRef = useRef(new Set<string>());
  const [externalSwapVerification, setExternalSwapVerification] = useState<Record<string, ExternalSwapVerificationStatus>>({});
  const externalSwapVerificationInFlightRef = useRef(new Set<string>());
  const [vaultWallets, setVaultWallets] = useState<VaultWallet[]>([]);
  const [associatedWalletAddresses, setAssociatedWalletAddresses] = useState<string[]>([]);
  const [associatedWalletFor, setAssociatedWalletFor] = useState('');
  const [transferBasisRecords, setTransferBasisRecords] = useState<StoredWalletTransferBasisLot[]>([]);
  const [transferBasisStorageReady, setTransferBasisStorageReady] = useState(false);
  const [transferBasisStorageWarning, setTransferBasisStorageWarning] = useState(false);
  const identified = Boolean(publicKey && identifiedWallet === publicKey.toBase58());

  useEffect(() => {
    let active = true;
    getWalletVaultMetadata()
      .then((metadata) => { if (active) setVaultWallets(metadata.wallets); })
      .catch(() => { if (active) setVaultWallets([]); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const walletAddress = publicKey?.toBase58();
    setAssociatedWalletFor('');
    setTransferBasisStorageReady(false);
    setTransferBasisRecords(readWalletTransferBasis());
    if (!walletAddress) {
      setAssociatedWalletAddresses([]);
      setAssociatedWalletFor('');
      setTransferBasisStorageReady(true);
      return;
    }

    const available = new Set(vaultWallets.map((wallet) => wallet.address).filter((address) => address !== walletAddress));
    try {
      const saved = window.localStorage.getItem(`wire:history-basis-wallets:v1:${walletAddress}`);
      const parsed: unknown = saved ? JSON.parse(saved) : [];
      setAssociatedWalletAddresses(Array.isArray(parsed)
        ? [...new Set(parsed.filter((address): address is string => typeof address === 'string' && available.has(address)))]
        : []);
    } catch {
      setAssociatedWalletAddresses([]);
    }
    setAssociatedWalletFor(walletAddress);
    setTransferBasisStorageReady(true);
  }, [publicKey, vaultWallets]);

  const currentWalletAddress = publicKey?.toBase58() ?? '';
  const activeAssociatedWalletAddresses = associatedWalletFor === currentWalletAddress
    ? associatedWalletAddresses
    : [];

  useEffect(() => {
    setChainSignatures([]);
    setChainSignaturesWallet('');
    setChainSignatureSourceCount(0);
    setChainSignaturesFetched(false);
    setChainHasMore(false);
    setChainSignaturesError('');
    setChainDetailsUnavailable(false);
    setChainHistoryCoveragePartial(false);
    setCurrentTokenBalanceSnapshot(null);
    setCurrentTokenBalancesError('');
    setPortfolioExitEstimates({});
    portfolioExitInFlightRef.current.clear();
    chainSignatureCursorsRef.current = [];
    chainSignatureBacklogRef.current = [];
    chainSignatureTrackedMintsRef.current.clear();
    setExternalSwapVerification({});
    externalSwapVerificationInFlightRef.current.clear();
  }, [publicKey?.toBase58()]);

  useEffect(() => { translateRef.current = t; }, [t]);

  useEffect(() => {
    const refresh = () => setRefreshVersion((version) => version + 1);
    window.addEventListener('wire:wallet-history-updated', refresh);
    return () => window.removeEventListener('wire:wallet-history-updated', refresh);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!identified) {
      setHistory({ tokens: [], withdrawals: [], swaps: [], swapsHasMore: false, swapsUnavailable: false, withdrawalsUnavailable: false, withdrawalAmountsApproximate: false });
      setError('');
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setError('');
    fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/wallet-history`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo cargar el historial.');
        return {
          tokens: data.tokens as WalletTokenActivity[],
          withdrawals: data.withdrawals as WalletWithdrawalActivity[],
          swaps: data.swaps as WalletSwapActivity[],
          swapsHasMore: data.swapsHasMore === true,
          swapsUnavailable: data.swapsUnavailable === true,
          withdrawalsUnavailable: data.withdrawalsUnavailable === true,
          withdrawalAmountsApproximate: data.withdrawalAmountsApproximate === true,
        };
      })
      .then((data) => { if (active) setHistory(data); })
      .catch((caught: unknown) => {
        if (active && !(caught instanceof Error && caught.name === 'AbortError')) {
          const message = userFacingError(caught, translateRef.current('No se pudo cargar el historial.'), translateRef.current);
          setError(message);
        }
      })
      .finally(() => { if (active) setLoading(false); });

    return () => {
      active = false;
      controller.abort();
    };
  }, [identified, identifiedWallet, refreshVersion]);

  const loadOlderRecordedSwaps = async () => {
    if (!identified || !history.swapsHasMore || olderSwapsLoading) return;
    const lastSwap = history.swaps[history.swaps.length - 1];
    if (!lastSwap) return;
    const walletAddress = publicKey?.toBase58();
    if (!walletAddress) return;
    setOlderSwapsLoading(true);
    setOlderSwapsError('');
    const cursor = new URLSearchParams({ beforeSlot: lastSwap.slot, beforeSignature: lastSwap.signature });
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/wallet-history?${cursor.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron cargar swaps anteriores.');
      if (data.swapsUnavailable === true) throw new Error(t('No se pudieron cargar swaps anteriores.'));
      if (currentWalletAddressRef.current !== walletAddress) return;
      const olderSwaps = data.swaps as WalletSwapActivity[];
      setHistory((current) => {
        const knownSignatures = new Set(current.swaps.map((swap) => swap.signature));
        return {
          ...current,
          swaps: [...current.swaps, ...olderSwaps.filter((swap) => !knownSignatures.has(swap.signature))],
          swapsHasMore: data.swapsHasMore === true,
          swapsUnavailable: data.swapsUnavailable === true,
          withdrawalsUnavailable: data.withdrawalsUnavailable === true,
          withdrawalAmountsApproximate: data.withdrawalAmountsApproximate === true,
        };
      });
    } catch (caught) {
      if (currentWalletAddressRef.current === walletAddress) {
        setOlderSwapsError(userFacingError(caught, t('No se pudieron cargar swaps anteriores.'), t));
      }
    } finally {
      setOlderSwapsLoading(false);
    }
  };

  const activity = useMemo(() => [
    ...history.tokens.map((token) => ({ type: 'token' as const, date: token.createdAt, token })),
    ...history.withdrawals.map((withdrawal) => ({ type: 'withdrawal' as const, date: withdrawal.createdAt, withdrawal })),
    ...history.swaps.map((swap) => ({ type: 'swap' as const, date: swap.blockTime ?? swap.createdAt, swap })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()), [history]);

  const tokenMovementCounts = useMemo(() => {
    if (!identified || chainSignaturesWallet !== identifiedWallet) {
      return { unrecordedTokenMovementCount: 0, recognizedTokenMovementCount: 0, unclassifiedTokenMovementCount: 0 };
    }
    const loadedSwapSignatures = new Set(history.swaps.map((swap) => swap.signature));
    const unrecorded = chainSignatures.filter((item) =>
      !item.failed
      && item.detailsRequested
      && Boolean(item.tokenDeltas?.length)
      && !loadedSwapSignatures.has(item.signature),
    ).length;
    const recognized = chainSignatures.filter((item) =>
      !item.failed
      && item.detailsRequested
      && Boolean(item.tokenDeltas?.length)
      && !loadedSwapSignatures.has(item.signature)
      && (item.tokenMovementKind === 'transfer' || item.tokenMovementKind === 'mint' || item.tokenMovementKind === 'burn'
        || (item.trackedLiquidityPoolMovements?.length ?? 0) > 0),
    ).length;
    return {
      unrecordedTokenMovementCount: unrecorded,
      recognizedTokenMovementCount: recognized,
      unclassifiedTokenMovementCount: unrecorded - recognized,
    };
  }, [chainSignatures, chainSignaturesWallet, history.swaps, identified, identifiedWallet]);
  const { unrecordedTokenMovementCount, recognizedTokenMovementCount, unclassifiedTokenMovementCount } = tokenMovementCounts;

  const externalActivityIncomplete = useMemo(() => {
    if (!identified) return false;
    if (!chainSignaturesFetched || chainSignaturesWallet !== identifiedWallet) return true;
    return Boolean(chainSignaturesError)
      || chainHistoryCoveragePartial
      || chainHasMore
      || chainDetailsUnavailable
      || chainSignatures.some((item) => !item.failed && (!item.detailsRequested || item.tokenDeltas === null))
      || unrecordedTokenMovementCount > 0;
  }, [chainDetailsUnavailable, chainHasMore, chainHistoryCoveragePartial, chainSignatures, chainSignaturesError, chainSignaturesFetched, chainSignaturesWallet, identified, identifiedWallet, unrecordedTokenMovementCount]);
  const externalActivityNeedsScan = identified && (!chainSignaturesFetched || chainSignaturesWallet !== identifiedWallet);
  const transferBasisHistoryComplete = identified
    && chainSignaturesFetched
    && chainSignaturesWallet === identifiedWallet
    && !chainHasMore
    && !chainDetailsUnavailable
    && !chainSignaturesError
    && chainSignatures.every((item) => item.failed || (item.detailsRequested && item.tokenDeltas !== null))
    && !history.swapsUnavailable
    && !history.swapsHasMore
    && unclassifiedTokenMovementCount === 0;

  const externalTokenMovements = useMemo<WalletTokenMovement[]>(() => {
    if (!identified || chainSignaturesWallet !== identifiedWallet) return [];
    const loadedSwapSignatures = new Set(history.swaps.map((swap) => swap.signature));
    return chainSignatures.flatMap((item) => {
      const isSimpleMovement = item.tokenMovementKind === 'transfer' || item.tokenMovementKind === 'mint' || item.tokenMovementKind === 'burn';
      const liquidityPools = item.trackedLiquidityPoolMovements ?? [];
      if (item.failed || !item.detailsRequested || !item.tokenDeltas?.length || loadedSwapSignatures.has(item.signature)
        || (!isSimpleMovement && liquidityPools.length === 0)) return [];
      const liquidityAssetMints = new Set(liquidityPools.flatMap((pool) => [pool.lpMint, pool.tokenMint, pool.quoteMint]));
      return item.tokenDeltas
        .filter((delta) => isSimpleMovement || liquidityAssetMints.has(delta.mintAddress))
        .map((delta) => {
          const liquidityPool = liquidityPools.find((pool) => liquidityAssetMints.has(delta.mintAddress));
          const quoteDecimals = liquidityPool
            ? liquidityPool.quoteMint === SOL_MINT ? 9 : 6
            : undefined;
          return {
            signature: item.signature,
            slot: String(item.slot),
            blockTime: item.blockTime,
            mintAddress: delta.mintAddress,
            decimals: delta.decimals,
            amountRaw: delta.amountRaw,
            kind: isSimpleMovement ? item.tokenMovementKind as Exclude<TokenMovementKind, 'other'> : 'transfer',
            counterpartyAddress: isSimpleMovement ? delta.counterpartyAddress : null,
            ...(liquidityPool ? { quoteMint: liquidityPool.quoteMint, quoteDecimals } : {}),
          };
        });
    });
  }, [chainSignatures, chainSignaturesWallet, history.swaps, identified, identifiedWallet]);

  const incomingBasisMovements = useMemo<WalletTokenMovement[]>(() => {
    if (!currentWalletAddress || !activeAssociatedWalletAddresses.length) return [];
    const grouped = new Map<string, StoredWalletTransferBasisLot[]>();
    for (const basis of transferBasisRecords) {
      if (basis.destinationWalletAddress !== currentWalletAddress
        || !activeAssociatedWalletAddresses.includes(basis.sourceWalletAddress)) continue;
      const key = walletTransferBasisTransferKey(basis);
      const records = grouped.get(key) ?? [];
      records.push(basis);
      grouped.set(key, records);
    }
    return [...grouped.values()].flatMap((records) => {
      const first = records[0];
      if (!first || records.some((record) => record.slot !== first.slot || record.blockTime !== first.blockTime
        || record.transferAmountRaw !== first.transferAmountRaw)) return [];
      const knownTokens = records.reduce((sum, record) => sum + BigInt(record.tokenAmountRaw), 0n);
      if (knownTokens > BigInt(first.transferAmountRaw)) return [];
      const decimals = history.swaps.find((swap) => swap.mintAddress === first.mintAddress)?.tokenDecimals ?? null;
      return [{
        signature: first.signature,
        slot: first.slot,
        blockTime: first.blockTime,
        mintAddress: first.mintAddress,
        decimals,
        amountRaw: first.transferAmountRaw,
        kind: 'transfer' as const,
        counterpartyAddress: first.sourceWalletAddress,
      }];
    });
  }, [currentWalletAddress, activeAssociatedWalletAddresses, transferBasisRecords, history.swaps]);

  const fifoTokenMovements = useMemo(() => {
    const movementKeys = new Set(externalTokenMovements.map((movement) => `${movement.signature}:${movement.mintAddress}`));
    return [
      ...externalTokenMovements,
      ...incomingBasisMovements.filter((movement) => !movementKeys.has(`${movement.signature}:${movement.mintAddress}`)),
    ];
  }, [externalTokenMovements, incomingBasisMovements]);

  const recordedSwapResults = useMemo(
    () => calculateRecordedSwapResults(
      history.swaps,
      fifoTokenMovements,
      history.swapsUnavailable || history.swapsHasMore,
      externalActivityIncomplete,
      {
        currentWalletAddress: currentWalletAddress || undefined,
        associatedWalletAddresses: activeAssociatedWalletAddresses,
        incomingTransferBasis: transferBasisRecords,
        allowTransferBasisExport: transferBasisHistoryComplete,
      },
    ),
    [history.swaps, fifoTokenMovements, history.swapsUnavailable, history.swapsHasMore, externalActivityIncomplete, currentWalletAddress, activeAssociatedWalletAddresses, transferBasisRecords, transferBasisHistoryComplete],
  );

  useEffect(() => {
    if (!identified || !transferBasisStorageReady || !activeAssociatedWalletAddresses.length) return;
    const additions = recordedSwapResults.transferBasisLots.filter((lot) => activeAssociatedWalletAddresses.includes(lot.destinationWalletAddress));
    const replaceKeys = recordedSwapResults.transferBasisTransferKeys;
    if (!additions.length && !replaceKeys.length) return;
    const next = upsertWalletTransferBasis(transferBasisRecords, additions, replaceKeys);
    if (JSON.stringify(next) === JSON.stringify(transferBasisRecords)) return;
    if (writeWalletTransferBasis(next)) {
      setTransferBasisRecords(next);
      setTransferBasisStorageWarning(false);
    } else {
      setTransferBasisStorageWarning(true);
    }
  }, [identified, transferBasisStorageReady, activeAssociatedWalletAddresses, recordedSwapResults.transferBasisLots, recordedSwapResults.transferBasisTransferKeys, transferBasisRecords]);

  const toggleAssociatedWallet = (address: string, checked: boolean) => {
    if (!currentWalletAddress || associatedWalletFor !== currentWalletAddress || address === currentWalletAddress
      || !vaultWallets.some((wallet) => wallet.address === address)) return;
    const next = checked
      ? [...new Set([...activeAssociatedWalletAddresses, address])]
      : activeAssociatedWalletAddresses.filter((candidate) => candidate !== address);
    setAssociatedWalletAddresses(next);
    try {
      window.localStorage.setItem(`wire:history-basis-wallets:v1:${currentWalletAddress}`, JSON.stringify(next));
      setTransferBasisStorageWarning(false);
    } catch {
      setTransferBasisStorageWarning(true);
    }
  };

  const summary = useMemo(() => ({
    tokens: history.tokens.length,
    pools: new Set([
      ...history.tokens.map((token) => token.launchPlatform === 'PUMP_FUN' ? token.bondingCurveAddress : token.poolAddress),
      ...history.withdrawals.filter((withdrawal) => withdrawal.status !== 'cancelled').map((withdrawal) => withdrawal.poolAddress),
    ].filter((address): address is string => Boolean(address && address !== 'pending'))).size,
    withdrawals: history.withdrawals.filter((withdrawal) => withdrawal.status !== 'cancelled').length,
    swaps: history.swaps.length,
    ...recordedSwapResults,
    ...tokenMovementCounts,
    externalActivityIncomplete,
    externalActivityNeedsScan,
    swapFlowLamports: (() => {
      let netFlow = 0n;
      for (const swap of history.swaps) {
        if (swap.quoteMint !== 'So11111111111111111111111111111111111111112') continue;
        if (swap.solAmountLamports === null || swap.networkFeeLamports === null) continue;
        try {
          const amount = BigInt(swap.solAmountLamports);
          const networkFee = BigInt(swap.networkFeeLamports);
          netFlow += swap.side === 'sell' ? amount - networkFee : -amount - networkFee;
        } catch {
          // Skip malformed historical values; the partial-data note below covers them.
        }
      }
      return netFlow.toString();
    })(),
    swapFlowIncomplete: history.swapsUnavailable || history.swapsHasMore || history.swaps.some(
      (swap) => swap.quoteAmountRaw === null || swap.networkFeeLamports === null
        || !/^\d+$/.test(swap.quoteAmountRaw) || !/^\d+$/.test(swap.networkFeeLamports),
    ),
    swapsUnavailable: history.swapsUnavailable,
  }), [history, recordedSwapResults, tokenMovementCounts, externalActivityIncomplete, externalActivityNeedsScan]);

  const loadCurrentTokenBalances = async () => {
    if (!publicKey || !identified || currentTokenBalancesLoading) return;
    const walletAddress = publicKey.toBase58();
    setCurrentTokenBalancesLoading(true);
    setCurrentTokenBalancesError('');
    setCurrentWalletLpSnapshot(null);
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));

      const results = await Promise.allSettled([
        connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
        connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
        connection.getBalance(publicKey, 'confirmed'),
      ]);
      const [splResult, token2022Result, solResult] = results;
      if (!splResult || splResult.status !== 'fulfilled'
        || !token2022Result || token2022Result.status !== 'fulfilled'
        || !solResult || solResult.status !== 'fulfilled') {
        throw new Error(t('No se pudieron consultar los balances actuales de esta wallet.'));
      }
      const solBalanceLamports = solResult.value;
      if (!Number.isSafeInteger(solBalanceLamports) || solBalanceLamports < 0) {
        throw new Error(t('No se pudieron consultar los balances actuales de esta wallet.'));
      }
      if (currentWalletAddressRef.current !== walletAddress) return;

      const accountGroups: unknown[][] = [
        splResult.value.value as unknown as unknown[],
        token2022Result.value.value as unknown as unknown[],
      ];
      let balances: Map<string, ParsedTokenBalance>;
      try {
        balances = aggregateParsedTokenBalances(accountGroups);
      } catch {
        throw new Error(t('No se pudieron interpretar todas las cuentas de tokens de esta wallet.'));
      }

      if (currentWalletAddressRef.current !== walletAddress) return;
      setCurrentTokenBalanceSnapshot({
        walletAddress,
        balancesByMint: balances,
        solLamports: String(solBalanceLamports),
        fetchedAt: Date.now(),
      });

      const trackedRaydiumPools = history.tokens
        .filter((token) => token.launchPlatform === 'RAYDIUM' && token.poolAddress && token.poolAddress !== 'pending')
        .map((token) => ({
          poolAddress: token.poolAddress,
          mintAddress: token.mintAddress,
          quoteMint: token.poolQuoteMint,
          symbol: token.symbol,
          launchPlatform: token.launchPlatform,
        }));
      try {
        const lpScan = await scanTrackedRaydiumLpPositions({
          walletAddress,
          apiBase: process.env.NEXT_PUBLIC_API_URL || '',
          pools: trackedRaydiumPools,
          concurrency: 4,
        });
        if (currentWalletAddressRef.current !== walletAddress) return;
        setCurrentWalletLpSnapshot({ ...lpScan, walletAddress, fetchedAt: Date.now() });
      } catch {
        if (currentWalletAddressRef.current !== walletAddress) return;
        setCurrentWalletLpSnapshot({
          positionsByMint: new Map(),
          trackedPoolsByMint: new Map(),
          poolsChecked: 0,
          poolsFailed: trackedRaydiumPools.length,
          walletAddress,
          fetchedAt: Date.now(),
        });
      }
    } catch (caught) {
      if (currentWalletAddressRef.current === walletAddress) {
        setCurrentTokenBalancesError(userFacingError(caught, t('No se pudieron consultar los balances actuales de esta wallet.'), t));
      }
    } finally {
      setCurrentTokenBalancesLoading(false);
    }
  };

  const loadPortfolioExitEstimate = async (mintAddress: string, amountRaw: string) => {
    const walletAddress = currentWalletAddress;
    const requestKey = `${walletAddress}:${mintAddress}`;
    if (!walletAddress || !/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n || portfolioExitInFlightRef.current.has(requestKey)) return;
    portfolioExitInFlightRef.current.add(requestKey);
    setPortfolioExitEstimates((current) => ({ ...current, [mintAddress]: { status: 'loading' } }));
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/swap/portfolio-quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify({ mintAddress, amountRaw }),
      });
      const data = await response.json().catch(() => null) as (PortfolioExitEstimate & { success?: unknown; error?: unknown }) | null;
      if (currentWalletAddressRef.current !== walletAddress) return;
      if (!response.ok || data?.success !== true || !Array.isArray(data.quotes) || !Array.isArray(data.searchedQuoteAssets)) {
        throw new Error(typeof data?.error === 'string' ? data.error : t('No se pudo cotizar la salida de este token.'));
      }
      setPortfolioExitEstimates((current) => ({
        ...current,
        [mintAddress]: { status: 'ready', estimate: data },
      }));
    } catch (caught) {
      if (currentWalletAddressRef.current === walletAddress) {
        setPortfolioExitEstimates((current) => ({
          ...current,
          [mintAddress]: { status: 'error', error: userFacingError(caught, t('No se pudo cotizar la salida de este token.'), t) },
        }));
      }
    } finally {
      portfolioExitInFlightRef.current.delete(requestKey);
    }
  };

  const wireSignatures = useMemo(() => new Set([
    ...history.swaps.map((swap) => swap.signature),
    ...history.tokens.map((token) => token.txHash),
    ...history.withdrawals.map((withdrawal) => withdrawal.txHash),
  ].filter((signature): signature is string => Boolean(signature))), [history]);

  const registeredTokensByMint = useMemo(
    () => new Map(history.tokens.map((token) => [token.mintAddress, token])),
    [history.tokens],
  );
  const openPositionBasesByMint = useMemo(
    () => new Map(summary.openPositionBases.map((position) => [position.mintAddress, position])),
    [summary.openPositionBases],
  );
  const currentBalanceSnapshot = currentTokenBalanceSnapshot?.walletAddress === currentWalletAddress
    ? currentTokenBalanceSnapshot
    : null;
  const currentWalletLpPositions = currentWalletLpSnapshot?.walletAddress === currentWalletAddress
    ? currentWalletLpSnapshot
    : null;
  const currentPortfolioRows = useMemo(() => {
    if (!currentBalanceSnapshot) return [];
    const mints = new Set([...currentBalanceSnapshot.balancesByMint.entries()]
      .filter(([, balance]) => /^\d+$/.test(balance.amountRaw) && BigInt(balance.amountRaw) > 0n)
      .map(([mintAddress]) => mintAddress));
    for (const position of summary.openPositionBases) mints.add(position.mintAddress);
    return [...mints].sort((left, right) => left.localeCompare(right)).map((mintAddress) => {
      const position = openPositionBasesByMint.get(mintAddress) ?? null;
      return {
        mintAddress,
        balance: currentBalanceSnapshot.balancesByMint.get(mintAddress) ?? {
          amountRaw: '0',
          decimals: position?.tokenDecimals ?? null,
        },
        position,
      };
    });
  }, [currentBalanceSnapshot, openPositionBasesByMint, summary.openPositionBases]);

  const activityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    activity.forEach((item) => {
      if (item.type === 'withdrawal' && item.withdrawal.status === 'cancelled') return;
      const key = localDateKey(new Date(item.date));
      counts[key] = (counts[key] ?? 0) + 1;
    });
    return counts;
  }, [activity]);

  const calendarDates = useMemo(() => {
    const offset = (calendarMonth.getDay() + 6) % 7;
    const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    const weekCount = Math.ceil((offset + daysInMonth) / 7);
    const firstVisible = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1 - offset);
    return Array.from({ length: weekCount * 7 }, (_, index) => new Date(
      firstVisible.getFullYear(),
      firstVisible.getMonth(),
      firstVisible.getDate() + index,
    ));
  }, [calendarMonth]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const monday = new Date(2024, 0, 1 + index);
    return new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { weekday: 'short' }).format(monday);
  }), [locale]);

  const visibleActivity = useMemo(
    () => selectedDate ? activity.filter((item) => localDateKey(new Date(item.date)) === selectedDate) : activity,
    [activity, selectedDate],
  );
  const cancelledAttemptsCount = history.withdrawals.filter((withdrawal) => withdrawal.status === 'cancelled').length;
  const displayedActivity = showCancelledAttempts
    ? visibleActivity
    : visibleActivity.filter((item) => item.type !== 'withdrawal' || item.withdrawal.status !== 'cancelled');
  const countedActivity = activity.length - cancelledAttemptsCount;
  const todayKey = localDateKey(new Date());

  const changeCalendarMonth = (offset: number) => {
    const nextMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
    setCalendarMonth(nextMonth);
    setFocusedDate(localDateKey(nextMonth));
    setSelectedDate(null);
  };

  const loadRecentChainSignatures = async (loadOlder = false) => {
    if (!publicKey || !identified || chainSignaturesLoading) return;
    const walletAddress = publicKey.toBase58();
    setChainSignaturesLoading(true);
    setChainSignaturesError('');
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error(t('La conexión RPC no está en Solana Devnet.'));

      let scanIncomplete = false;
      let nextCursors = loadOlder ? [...chainSignatureCursorsRef.current] : [];
      let nextBacklog = loadOlder ? [...chainSignatureBacklogRef.current] : [];
      const nextTrackedMints = loadOlder ? new Set(chainSignatureTrackedMintsRef.current) : new Set<string>();
      for (const swap of history.swaps) nextTrackedMints.add(swap.mintAddress);
      let signatures: SignatureScanCandidate[];

      if (loadOlder && nextBacklog.length > 0) {
        const batch = takeWalletHistorySignaturePage(nextBacklog, MAX_RECENT_CHAIN_SIGNATURES);
        signatures = batch.page;
        nextBacklog = batch.remaining;
      } else {
        const pages: SignatureScanCandidate[][] = [];
        const knownSignatures = loadOlder ? new Set(chainSignatures.map((item) => item.signature)) : new Set<string>();
        let requestCursors: SignatureScanCursor[];

        if (loadOlder) {
          requestCursors = nextCursors.filter((cursor) => cursor.hasMore);
        } else {
          const tokenAccountSources: { address: string; mintAddress: string }[] = [];
          const tokenAccountResults = await Promise.allSettled(
            [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
              connection.getParsedTokenAccountsByOwner(publicKey, { programId }, 'confirmed'),
            ),
          );
          for (const result of tokenAccountResults) {
            if (result.status === 'rejected') {
              scanIncomplete = true;
              continue;
            }
            for (const tokenAccount of result.value.value) {
              const data = tokenAccount.account.data;
              if (!data || typeof data !== 'object' || !('parsed' in data)) continue;
              const parsedData = data as unknown as { parsed?: { info?: { mint?: unknown } } };
              const mintAddress = parsedData.parsed?.info?.mint;
              if (typeof mintAddress === 'string') {
                tokenAccountSources.push({ address: tokenAccount.pubkey.toBase58(), mintAddress });
                nextTrackedMints.add(mintAddress);
              }
            }
          }
          requestCursors = getWalletHistorySourceAddresses(walletAddress, tokenAccountSources, nextTrackedMints)
            .map((address) => ({ address, before: null, hasMore: true }));
          nextCursors = requestCursors;
        }

        const cursorMap = new Map(nextCursors.map((cursor) => [cursor.address, cursor]));
        for (let start = 0; start < requestCursors.length; start += MAX_SIGNATURE_SCAN_CONCURRENCY) {
          const batch = requestCursors.slice(start, start + MAX_SIGNATURE_SCAN_CONCURRENCY);
          const results = await Promise.allSettled(batch.map((cursor) =>
            connection.getSignaturesForAddress(new PublicKey(cursor.address), {
              limit: MAX_RECENT_CHAIN_SIGNATURES,
              ...(cursor.before ? { before: cursor.before } : {}),
            }, 'confirmed'),
          ));
          results.forEach((result, index) => {
            const cursor = batch[index];
            if (result.status === 'rejected' || !cursor) {
              scanIncomplete = true;
              return;
            }
            pages.push(result.value);
            const lastSignature = result.value[result.value.length - 1]?.signature ?? cursor.before;
            cursorMap.set(cursor.address, {
              address: cursor.address,
              before: lastSignature,
              hasMore: result.value.length === MAX_RECENT_CHAIN_SIGNATURES,
            });
          });
        }
        nextCursors = [...cursorMap.values()];
        const merged = mergeWalletHistorySignatures(pages, knownSignatures);
        const batch = takeWalletHistorySignaturePage(merged, MAX_RECENT_CHAIN_SIGNATURES);
        signatures = batch.page;
        nextBacklog = batch.remaining;
      }

      let parsedTransactions: Awaited<ReturnType<typeof connection.getParsedTransactions>> = [];
      let detailsUnavailable = false;
      if (signatures.length > 0) {
        parsedTransactions = signatures.map(() => null);
        for (let start = 0; start < signatures.length; start += MAX_CHAIN_DETAIL_BATCH_SIZE) {
          const batch = signatures.slice(start, start + MAX_CHAIN_DETAIL_BATCH_SIZE);
          try {
            const transactions = await connection.getParsedTransactions(
              batch.map((item) => item.signature),
              { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
            );
            batch.forEach((_, index) => {
              const transaction = transactions[index];
              if (!transaction) detailsUnavailable = true;
              if (start + index < parsedTransactions.length) {
                parsedTransactions[start + index] = transaction ?? null;
              }
            });
          } catch {
            detailsUnavailable = true;
          }
        }
      }
      const discoveredSources = parsedTransactions.flatMap((transaction) =>
        getWalletOwnedTokenAccountSources(transaction, walletAddress, nextTrackedMints),
      );
      if (discoveredSources.length > 0) {
        const cursorMap = new Map(nextCursors.map((cursor) => [cursor.address, cursor]));
        for (const source of discoveredSources) {
          if (!cursorMap.has(source.address)) {
            cursorMap.set(source.address, { address: source.address, before: null, hasMore: true });
          }
        }
        nextCursors = [...cursorMap.values()];
      }
      const trackedRaydiumPools = history.tokens
        .filter((token) => token.launchPlatform === 'RAYDIUM' && token.poolAddress && token.poolAddress !== 'pending')
        .map((token) => ({
          poolAddress: token.poolAddress,
          mintAddress: token.mintAddress,
          quoteMint: token.poolQuoteMint,
          symbol: token.symbol,
          launchPlatform: token.launchPlatform,
        }));
      const candidatePoolAddresses = new Set(parsedTransactions.flatMap((transaction, index) =>
        transaction && signatures[index]?.err === null
          ? getTrackedRaydiumPoolAddressesInTransaction(transaction, trackedRaydiumPools)
          : [],
      ));
      const candidatePools = trackedRaydiumPools.filter((pool) => pool.poolAddress && candidatePoolAddresses.has(pool.poolAddress));
      const resolvedPoolsByAddress = new Map<string, ResolvedRaydiumLpPool>();
      for (const pool of currentWalletLpSnapshot?.walletAddress === walletAddress
        ? currentWalletLpSnapshot.trackedPoolsByMint.values()
        : []) {
        if (candidatePoolAddresses.has(pool.poolAddress)) resolvedPoolsByAddress.set(pool.poolAddress, pool);
      }
      const missingCandidatePools = candidatePools.filter((pool) => !resolvedPoolsByAddress.has(pool.poolAddress ?? ''));
      if (missingCandidatePools.length > 0) {
        try {
          const lpScan = await scanTrackedRaydiumLpPositions({
            walletAddress,
            apiBase: process.env.NEXT_PUBLIC_API_URL || '',
            pools: missingCandidatePools,
            concurrency: 4,
          });
          for (const pool of lpScan.trackedPoolsByMint.values()) {
            if (candidatePoolAddresses.has(pool.poolAddress)) resolvedPoolsByAddress.set(pool.poolAddress, pool);
          }
        } catch {
          // Keep the activity unclassified if the API cannot verify the pool's LP mint.
        }
      }
      const resolvedTrackedPools = [...resolvedPoolsByAddress.values()];
      if (currentWalletAddressRef.current !== walletAddress) return;
      const rows = signatures.map((item, index) => {
        const transaction = parsedTransactions[index];
        const tokenDeltas = getOwnedTokenDeltas(transaction, walletAddress);
        const trackedLiquidityPoolMovements = transaction && item.err === null && tokenDeltas?.length
          ? matchTrackedRaydiumLpMovements({ transaction, tokenDeltas, pools: resolvedTrackedPools })
          : [];
        return {
          signature: item.signature,
          slot: item.slot,
          blockTime: item.blockTime ?? null,
          failed: item.err !== null,
          detailsRequested: index < signatures.length,
          tokenDeltas,
          tokenMovementKind: tokenDeltas?.length ? classifyTokenMovement(transaction) : null,
          trackedLiquidityPoolMovements,
        };
      });
      chainSignatureCursorsRef.current = nextCursors;
      chainSignatureBacklogRef.current = nextBacklog;
      chainSignatureTrackedMintsRef.current = nextTrackedMints;
      setChainSignatures((current) => loadOlder
        ? [...current, ...rows.filter((item) => !current.some((existing) => existing.signature === item.signature))]
        : rows);
      setChainSignaturesWallet(walletAddress);
      setChainSignatureSourceCount(nextCursors.length);
      setChainSignaturesFetched(true);
      const hasMoreActivity = nextBacklog.length > 0 || nextCursors.some((cursor) => cursor.hasMore);
      setChainHistoryCoveragePartial(isWalletActivityCoveragePartial({
        signatureBacklogCount: nextBacklog.length,
        sourceHasMore: nextCursors.some((cursor) => cursor.hasMore),
        signatureScanIncomplete: scanIncomplete,
        transactionDetailsUnavailable: detailsUnavailable,
      }));
      setChainHasMore(hasMoreActivity);
      setChainDetailsUnavailable((current) => loadOlder
        ? current || scanIncomplete || detailsUnavailable
        : scanIncomplete || detailsUnavailable);
    } catch (caught) {
      if (currentWalletAddressRef.current !== walletAddress) return;
      const message = userFacingError(caught, t('No se pudo consultar la actividad reciente en Devnet.'), t);
      setChainSignaturesError(message);
    } finally {
      setChainSignaturesLoading(false);
    }
  };

  const verifyExternalSwap = async (item: RecentChainSignature, mintAddress: string, side: 'buy' | 'sell') => {
    if (!publicKey || !identified || chainSignaturesWallet !== publicKey.toBase58() || item.failed) return;
    const walletAddress = publicKey.toBase58();
    const verificationKey = `${item.signature}:${mintAddress}`;
    if (externalSwapVerificationInFlightRef.current.has(verificationKey)
      || externalSwapVerification[verificationKey] === 'checking'
      || externalSwapVerification[verificationKey] === 'imported') return;
    externalSwapVerificationInFlightRef.current.add(verificationKey);
    setExternalSwapVerification((current) => ({ ...current, [verificationKey]: 'checking' }));
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/swap/record`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userWallet: walletAddress, mintAddress, side, signature: item.signature }),
      });
      const result = await response.json().catch(() => null) as { success?: unknown; recorded?: unknown; pending?: unknown } | null;
      if (currentWalletAddressRef.current !== walletAddress) return;
      if (response.status === 202 && result?.pending === true) {
        setExternalSwapVerification((current) => ({ ...current, [verificationKey]: 'pending' }));
        return;
      }
      if (!response.ok || result?.success !== true || result.recorded !== true) {
        setExternalSwapVerification((current) => ({ ...current, [verificationKey]: 'notVerified' }));
        return;
      }
      if (currentWalletAddressRef.current !== walletAddress) return;
      setExternalSwapVerification((current) => ({ ...current, [verificationKey]: 'imported' }));
      setRefreshVersion((version) => version + 1);
    } catch {
      if (currentWalletAddressRef.current === walletAddress) {
        setExternalSwapVerification((current) => ({ ...current, [verificationKey]: 'notVerified' }));
      }
    } finally {
      externalSwapVerificationInFlightRef.current.delete(verificationKey);
    }
  };

  const handleCalendarKeyDown = (date: Date, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextDate: Date | null = null;
    switch (event.key) {
      case 'ArrowLeft': nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1); break;
      case 'ArrowRight': nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1); break;
      case 'ArrowUp': nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 7); break;
      case 'ArrowDown': nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7); break;
      case 'Home': nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7)); break;
      case 'End': nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + (6 - ((date.getDay() + 6) % 7))); break;
      case 'PageUp':
      case 'PageDown': {
        const monthOffset = (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1);
        const targetMonth = new Date(date.getFullYear(), date.getMonth() + monthOffset, 1);
        const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
        nextDate = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(date.getDate(), lastDay));
        break;
      }
      default: return;
    }

    event.preventDefault();
    const nextKey = localDateKey(nextDate);
    setFocusedDate(nextKey);
    setCalendarMonth(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    window.requestAnimationFrame(() => calendarDayRefs.current.get(nextKey)?.focus());
  };

  return (
    <>
    <section className="wire-history-section" aria-labelledby="wallet-history-title">
      <div className="mb-5">
        <p className="wire-kicker mb-2"><span className="wire-status-dot" aria-hidden="true" />{t('HISTORIAL · DEVNET')}</p>
        <h2 id="wallet-history-title" className="font-display text-2xl font-semibold">{t('Actividad de wallet')}</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">{t('Tokens registrados, pools, retiros y swaps verificados en Solana Devnet.')}</p>
        {history.swapsUnavailable && <p role="status" className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">{t('El historial de swaps no está disponible ahora; sí se muestran los tokens y retiros registrados.')}</p>}
        {history.withdrawalsUnavailable && <p role="status" className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">{t('El historial de retiros no está disponible ahora; se muestran los demás registros que sí cargaron.')}</p>}
        {history.withdrawalAmountsApproximate && <p role="status" className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">{t('Algunas columnas nuevas aún no están disponibles; los importes de retiro se muestran con la precisión guardada originalmente.')}</p>}
      </div>

      {identified && (
        <section className="wire-panel mb-4 rounded-2xl p-4 sm:p-5" aria-labelledby="wallet-current-balances-title">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 id="wallet-current-balances-title" className="font-display text-base font-semibold">{t('Balances actuales de la wallet')}</h3>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">{t('Consulta manual de solo lectura en Solana Devnet. Lee el SOL nativo y suma las cuentas SPL y Token-2022 abiertas de esta wallet. No incluye valor de mercado.')}</p>
            </div>
            <button type="button" onClick={() => void loadCurrentTokenBalances()} disabled={currentTokenBalancesLoading} className="wire-button wire-button-secondary min-h-11 shrink-0">
              {currentTokenBalancesLoading ? t('Actualizando balances…') : currentBalanceSnapshot ? t('Actualizar balance on-chain') : t('Consultar balance on-chain')}
            </button>
          </div>
          {currentTokenBalancesError && <p role="alert" className="mt-3 text-sm text-rose-300">{currentTokenBalancesError}</p>}
          {!currentBalanceSnapshot && !currentTokenBalancesError && <p className="mt-3 text-xs text-[var(--muted)]">{t('La consulta empieza solo cuando pulsas el botón; requiere una wallet conectada e identificada.')}</p>}
          {currentBalanceSnapshot && (
            <div className="mt-4 border-t border-[var(--line)] pt-3">
              <p role="status" className="text-xs text-[var(--muted)]">
                {t('Balances consultados en Devnet')}: {new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(currentBalanceSnapshot.fetchedAt))}. {t('Un saldo cero solo se muestra después de completar las tres consultas de RPC.')}
              </p>
              {currentWalletLpPositions && (currentWalletLpPositions.poolsChecked > 0 || currentWalletLpPositions.poolsFailed > 0) && (
                <p role="status" className={`mt-2 text-xs ${currentWalletLpPositions.poolsFailed > 0 ? 'text-amber-300' : 'text-[var(--muted)]'}`}>
                  {t('Saldos LP consultados en pools registradas')}: {currentWalletLpPositions.poolsChecked}. {t('Resultados LP sin confirmar')}: {currentWalletLpPositions.poolsFailed}.
                </p>
              )}
              <ul className="mt-3 grid gap-2">
                  <li className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{t('SOL nativo')}</span>
                      <span className="font-mono text-xs text-[var(--muted)]">SOL</span>
                    </div>
                    <dl className="mt-3 grid gap-2 text-xs">
                      <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Balance nativo actual')}</dt><dd className="text-right font-mono tabular-nums">{formatRawAmount(currentBalanceSnapshot.solLamports, 9, locale)} SOL</dd></div>
                    </dl>
                  </li>
                  {currentPortfolioRows.map(({ mintAddress, balance, position }) => {
                    const token = registeredTokensByMint.get(mintAddress);
                    const lpPosition = currentWalletLpPositions?.positionsByMint.get(mintAddress) ?? null;
                    const matchesLpPosition = Boolean(lpPosition
                      && balance.amountRaw === lpPosition.rawBalance
                      && balance.decimals === lpPosition.decimals);
                    const estimateState = portfolioExitEstimates[mintAddress];
                    const estimate = estimateState?.estimate?.amountRaw === balance.amountRaw ? estimateState.estimate : null;
                    const amountLabel = (rawAmount: string, decimals: number | null) => decimals === null
                      ? `${rawAmount} ${t('unidades mínimas')}`
                      : formatRawTokenAmount(rawAmount, decimals, locale);
                    const currentAmountLabel = amountLabel(balance.amountRaw, balance.decimals);
                    const decimalsMatch = Boolean(position && position.tokenDecimals !== null && balance.decimals === position.tokenDecimals);
                    const balanceDifference = decimalsMatch && position
                      ? (BigInt(balance.amountRaw) - BigInt(position.reconstructedTokenAmountRaw)).toString()
                      : null;
                    const quoteSymbol = position?.quoteMint === SOL_MINT ? 'SOL' : 'USDC';
                    return (
                      <li key={mintAddress} className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">{matchesLpPosition && lpPosition ? t('LP de {symbol}', { symbol: lpPosition.tokenSymbol }) : token?.symbol || t('Token')}</span>
                          <a href={explorerAddress(mintAddress)} target="_blank" rel="noreferrer" className="break-all font-mono text-[10px] text-[var(--muted)] underline">{shortenAddress(mintAddress)}</a>
                        </div>
                        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                          <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Balance actual on-chain')}</dt><dd className="text-right font-mono tabular-nums">{currentAmountLabel}</dd></div>
                          {position && !matchesLpPosition ? (
                            <>
                              <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Cantidad reconstruida')}</dt><dd className="text-right font-mono tabular-nums">{amountLabel(position.reconstructedTokenAmountRaw, position.tokenDecimals)}</dd></div>
                              <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Diferencia vs. reconstruido')}</dt><dd className="text-right font-mono tabular-nums">{balanceDifference === null ? t('No comparable: decimales desconocidos o distintos.') : amountLabel(balanceDifference, position.tokenDecimals)}</dd></div>
                              <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Costo FIFO remanente')}</dt><dd className="text-right font-mono tabular-nums">{formatRawAmount(position.knownCostBasisRaw, position.quoteDecimals, locale)} {quoteSymbol}</dd></div>
                            </>
                          ) : null}
                        </dl>
                        {matchesLpPosition && lpPosition && (
                          <div className="mt-3 border-t border-[var(--line)] pt-3">
                            <p className="text-xs font-semibold">{t('Token de posición de liquidez')}</p>
                            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Balance LP confirmado para la pool registrada de {symbol}. Las cantidades de abajo se estiman en proporción a las reservas y al supply LP actual; no son valor de mercado ni costo FIFO.', { symbol: lpPosition.tokenSymbol })}</p>
                            {lpPosition.positionEstimate ? (
                              <>
                                <p className="mt-3 text-xs font-semibold">{t('Cantidades subyacentes estimadas')}</p>
                                <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                                  {lpPosition.positionEstimate.assets.map((asset) => (
                                    <div key={asset.mintAddress} className="flex min-w-0 justify-between gap-3">
                                      <dt className="min-w-0 text-[var(--muted)]">
                                        <a href={explorerAddress(asset.mintAddress)} target="_blank" rel="noreferrer" className="underline underline-offset-4">{asset.symbol}</a>
                                      </dt>
                                      <dd className="shrink-0 text-right font-mono tabular-nums">{formatRawTokenAmount(asset.amountRaw, asset.decimals, locale)} {asset.symbol}</dd>
                                    </div>
                                  ))}
                                </dl>
                                <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{t('Estimación pro rata con reservas y supply LP actuales. No garantiza la cantidad que recibirás al retirar; las comisiones y cambios posteriores pueden reducirla.')}</p>
                              </>
                            ) : (
                              <p role="status" className="mt-2 text-xs text-amber-300">{t('No se pudieron estimar las reservas subyacentes; el saldo LP sí coincide con la pool.')}</p>
                            )}
                            <a href={explorerAddress(lpPosition.poolAddress)} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs underline underline-offset-4">{t('Ver pool registrada')}: {shortenAddress(lpPosition.poolAddress)}</a>
                          </div>
                        )}
                        {position?.incomplete && !matchesLpPosition && <p className="mt-2 text-xs text-amber-300" role="status">{t('Parcial: falta historial o hay movimientos ambiguos para este token.')}</p>}
                        {!position && !matchesLpPosition && <p className="mt-2 text-xs text-amber-300" role="status">{t('El historial cargado no ofrece una base FIFO comparable para este mint.')}</p>}
                        {!matchesLpPosition && (
                          <div className="mt-3 border-t border-[var(--line)] pt-3">
                              <button
                                type="button"
                                onClick={() => void loadPortfolioExitEstimate(mintAddress, balance.amountRaw)}
                                disabled={balance.decimals === null || BigInt(balance.amountRaw) <= 0n || estimateState?.status === 'loading'}
                                className="wire-button wire-button-secondary min-h-10"
                              >
                                {estimateState?.status === 'loading' ? t('Cotizando salida…') : t('Cotizar salida completa')}
                              </button>
                              <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{t('Busca mercados Pump.fun/PumpSwap y pools Raydium CPMM de Devnet contra SOL o USDC. Wire calcula cotizaciones con estado on-chain actual. Es solo una estimación: no prepara, firma ni envía una venta; el precio cambia y la tarifa de red no está incluida.')}</p>
                              {estimateState?.status === 'error' && <p role="alert" className="mt-2 text-xs text-rose-300">{estimateState.error}</p>}
                              {estimateState?.status === 'ready' && estimate && (
                            <div className="mt-3 rounded-lg border border-[var(--line)] p-3">
                              <p className="text-xs font-semibold">{t('Salida estimada del balance completo')}</p>
                              <p className="mt-1 text-[11px] text-[var(--muted)]">{t('Cotización leída en Devnet')}: {new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(estimate.quotedAt))}</p>
                              {estimate.quotes.length ? (
                                <ul className="mt-3 grid gap-2">
                                  {estimate.quotes.map((quote) => {
                                    const comparison = comparePortfolioExitToFifo({
                                      currentBalanceRaw: balance.amountRaw,
                                      currentBalanceDecimals: balance.decimals,
                                      position,
                                      quote,
                                      activityComplete: isPortfolioActivityComplete({
                                        externalActivityIncomplete: summary.externalActivityIncomplete,
                                        swapsUnavailable: history.swapsUnavailable,
                                        swapsHasMore: history.swapsHasMore,
                                        withdrawalsUnavailable: history.withdrawalsUnavailable,
                                        withdrawalAmountsApproximate: history.withdrawalAmountsApproximate,
                                      }),
                                    });
                                    return (
                                      <li key={`${quote.venue}:${quote.poolAddress}`} className="rounded-lg bg-[var(--surface-2)] p-3">
                                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                                        <span className="text-xs text-[var(--muted)]">{t('Cotización aproximada en')} {quote.quoteSymbol}</span>
                                        <span className="font-mono text-sm font-semibold tabular-nums">{formatDecimalAmount(quote.amountOut, quote.quoteDecimals, locale)} {quote.quoteSymbol}</span>
                                      </div>
                                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--muted)]">
                                        <span>{t('Impacto de precio estimado')}: {quote.priceImpactPercent === null ? '—' : `${quote.priceImpactPercent}%`}</span>
                                        <a href={explorerAddress(quote.poolAddress)} target="_blank" rel="noreferrer" className="underline">{t(quote.venue === 'PUMP_FUN' ? 'Curva Pump.fun' : quote.venue === 'PUMP_SWAP' ? 'Pool PumpSwap' : 'Pool Raydium CPMM')} · {shortenAddress(quote.poolAddress)}</a>
                                      </div>
                                      {comparison.status === 'comparable' ? (
                                        <p className={`mt-2 text-xs ${BigInt(comparison.differenceRaw) >= 0n ? 'text-[var(--wire-green)]' : 'text-rose-300'}`}>
                                          {t('Diferencia bruta estimada vs. costo FIFO')}: {BigInt(comparison.differenceRaw) > 0n ? '+' : ''}{formatRawAmount(comparison.differenceRaw, comparison.quoteDecimals, locale)} {quote.quoteSymbol}. {t('Antes de fees de red; no garantiza venta.')}
                                        </p>
                                      ) : (
                                        <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{t('No se compara contra FIFO: el balance, costo o cobertura de actividad no coinciden con seguridad.')}</p>
                                      )}
                                      </li>
                                    );
                                  })}
                                </ul>
                              ) : (
                                <p role="status" className="mt-2 text-xs text-[var(--muted)]">{t('No se encontró una cotización disponible en los mercados compatibles de Devnet.')}</p>
                              )}
                              {estimate.coverageIncomplete && <p role="status" className="mt-2 text-xs text-amber-300">{t('Búsqueda parcial: el índice de pools no respondió por completo o quedaron candidatos sin consultar.')}</p>}
                            </div>
                              )}
                          </div>
                        )}
                      </li>
                    );
                  })}
              </ul>
              {currentPortfolioRows.length === 0 && currentBalanceSnapshot.solLamports === '0' && <p className="mt-3 rounded-lg border border-[var(--line)] p-3 text-sm text-[var(--muted)]">{t('No hay balances de tokens abiertos ni SOL nativo en esta wallet.')}</p>}
            </div>
          )}
        </section>
      )}

      {!publicKey ? (
        <div className="wire-empty-state"><h3>{t('Conecta tu wallet')}</h3><p>{t('Conecta una wallet Solana para consultar la actividad.')}</p></div>
      ) : !identified ? (
        <div className="wire-empty-state"><h3>{t('Inicia sesión para ver tu actividad')}</h3><p>{t('Tener la wallet conectada no inicia sesión en Wire. Abre el panel Wallet y pulsa «Iniciar sesión con firma»; es una firma gratuita, no envía SOL. Después aparecerán aquí los tokens, pools y retiros de esta dirección.')}</p></div>
      ) : loading ? (
        <div className="wire-empty-state" role="status"><span className="wire-loading-mark" aria-hidden="true" /><h3>{t('Cargando actividad')}</h3></div>
      ) : error ? (
        <div role="alert" className="wire-empty-state wire-empty-error">
          <h3>{t('No se pudo cargar el historial')}</h3>
          <p>{error}</p>
          <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} className="wire-button wire-button-secondary mt-2">{t('Reintentar')}</button>
        </div>
      ) : activity.length === 0 ? (
        <div className="wire-empty-state"><h3>{t('Aún no hay actividad')}</h3><p>{t('Los tokens, retiros y swaps que realices aparecerán aquí.')}</p></div>
      ) : (
        <div className="space-y-4">
          <section className="wire-panel rounded-2xl p-4 sm:p-5" aria-labelledby="activity-summary-title">
            <h3 id="activity-summary-title" className="font-display text-base font-semibold">{t('Resumen de actividad registrada')}</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">{t('Conteos de registros asociados a esta wallet; no son balances ni resultados de trading.')}</p>
            <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-5">
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <dt className="text-xs text-[var(--muted)]">{t('Tokens registrados')}</dt>
                <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(summary.tokens)}</dd>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <dt className="text-xs text-[var(--muted)]">{t('Mercados asociados')}</dt>
                <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(summary.pools)}</dd>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <dt className="text-xs text-[var(--muted)]">{t('Retiros registrados')}</dt>
                <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(summary.withdrawals)}</dd>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <dt className="text-xs text-[var(--muted)]">{t('Swaps verificados')}</dt>
                <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(summary.swaps)}</dd>
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <dt className="text-xs text-[var(--muted)]">{t('Flujo neto de swaps')}</dt>
                <dd className="mt-1 break-words font-mono text-lg font-semibold tabular-nums">
                  {formatSolLamports(summary.swapFlowLamports, 0, locale)} SOL
                </dd>
                <p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
                  {t('Solo flujo neto en SOL de swaps registrados por Wire: ventas menos compras y fees de red. No es PnL; excluye pares USDC, transferencias y tokens que sigan en la wallet.')}
                </p>
                {summary.swapFlowIncomplete && (
                  <p className="mt-2 text-[10px] leading-4 text-amber-300" role="status">
                    {t(summary.swapsUnavailable ? 'Parcial: no se pudo cargar el historial de swaps.' : history.swapsHasMore ? 'Hay swaps anteriores. Carga más historial para completar el flujo de SOL.' : 'Parcial: hay swaps anteriores sin importe SOL o fee de red verificados.')}
                  </p>
                )}
              </div>
            </dl>
            {history.swapsHasMore && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
                <p className="text-xs text-[var(--muted)]">{t('Hay swaps anteriores en el historial.')}</p>
                <button type="button" onClick={() => void loadOlderRecordedSwaps()} disabled={olderSwapsLoading} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
                  {olderSwapsLoading ? t('Cargando swaps anteriores…') : t('Cargar swaps anteriores')}
                </button>
                {olderSwapsError && <p role="alert" className="w-full text-xs text-[var(--danger)]">{olderSwapsError}</p>}
              </div>
            )}
            {(summary.swaps > 0 || summary.swapsUnavailable || history.swapsHasMore || summary.unrecordedTokenMovementCount > 0 || summary.externalActivityIncomplete) && (
              <div className="mt-4 flex flex-col gap-3 border-t border-[var(--line)] pt-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-2xl">
                  <h4 className="text-sm font-semibold">{t('Resultado realizado estimado')}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                    {t('Estimación FIFO de swaps confirmados en mercados compatibles, incluidos los externos que importes tras verificarlos. Si marcas wallets de tu bóveda, Wire puede trasladar el costo conocido entre ellas para transferencias SPL simples cuando coinciden la firma, el mint, la cantidad y los deltas opuestos. Las transferencias no vinculadas, mercados no compatibles y el valor actual de tokens retenidos quedan fuera; las fees de red aparecen aparte.')}
                  </p>
                  {summary.realizedHistoryIncomplete && (
                    <p role="status" className="mt-2 text-xs text-amber-300">
                      {t(history.swapsHasMore
                        ? 'Carga swaps anteriores para completar este cálculo.'
                        : summary.externalActivityNeedsScan
                          ? chainSignaturesError
                            ? 'No se pudo consultar la actividad on-chain. Reintenta para comprobar si faltan operaciones externas.'
                            : 'Consulta la actividad on-chain para revisar posibles swaps externos y movimientos no registrados por Wire. El resultado FIFO puede estar incompleto.'
                          : chainHasMore
                            ? 'Hay más firmas en Devnet; carga firmas anteriores para revisar la actividad más antigua.'
                          : summary.externalActivityIncomplete
                          ? 'La actividad on-chain sigue incompleta: pueden faltar cuentas SPL cerradas, detalles de firmas o movimientos no importados; el resultado FIFO puede estar incompleto.'
                          : 'Hay datos faltantes o ambiguos en el historial; el resultado puede estar incompleto.')}
                    </p>
                  )}
                  {summary.unclassifiedTokenMovementCount > 0 && (
                    <p role="status" className="mt-2 text-xs text-amber-300">
                      {summary.unclassifiedTokenMovementCount === 1
                        ? t('Una transacción analizada con detalle muestra cambios netos de tokens que faltan en los swaps cargados. Verifica si es un swap; carga historial anterior si corresponde. No se incluye en este PnL.')
                        : t('Entre las transacciones analizadas con detalle, {count} muestran cambios netos de tokens que faltan en los swaps cargados. Verifica si son swaps; carga historial anterior si corresponde. No se incluyen en este PnL.', { count: summary.unclassifiedTokenMovementCount })}
                    </p>
                  )}
                  {summary.recognizedTokenMovementCount > 0 && (
                    <p role="status" className="mt-2 text-xs text-amber-300">
                      {t('Se detectaron {count} transacciones SPL de transferencia, acuñación o quema sin registro de swap. Las transferencias solo conservan costo FIFO si marcas la otra wallet de la bóveda y Wire verifica deltas opuestos en la misma firma. Las demás transferencias, acuñaciones, quemas y mercados no compatibles mantienen costo desconocido; el PnL sigue parcial.', { count: summary.recognizedTokenMovementCount })}
                    </p>
                  )}
                </div>
                <div className="grid gap-2 sm:min-w-64">
                  {summary.realizedSwapGroups.length > 0 ? (
                    <ul className="grid gap-1.5">
                      {summary.realizedSwapGroups.map((group) => {
                        const symbol = group.quoteMint === SOL_MINT ? 'SOL' : 'USDC';
                        const realized = BigInt(group.realizedRaw);
                        const resultColor = realized > 0n ? 'text-[var(--wire-green)]' : realized < 0n ? 'text-rose-300' : '';
                        return (
                          <li key={group.quoteMint} className="flex items-baseline justify-between gap-4 text-sm">
                            <span className="text-[var(--muted)]">{t('Realizado en {asset}', { asset: symbol })}</span>
                            <span className={`font-mono font-semibold tabular-nums ${resultColor}`}>
                              {group.salesWithBasis > 0 ? `${group.incomplete ? '≈ ' : ''}${formatRawAmount(group.realizedRaw, group.quoteDecimals, locale)} ${symbol}` : <span title={t('Sin ventas con costo base registrado')} aria-label={t('Sin ventas con costo base registrado')}>—</span>}
                              {group.incomplete && group.salesWithBasis > 0 && <span className="ml-1 text-xs text-amber-300">{t('Parcial')}</span>}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-sm text-[var(--muted)]">{t('No hay datos suficientes para estimar el resultado.')}</p>
                  )}
                  <p className="text-xs text-[var(--muted)]">
                    {t('Comisiones de red registradas')}: {summary.networkFeeIncomplete ? '≥ ' : ''}{formatSolLamports(summary.networkFeeLamports, 0, locale)} SOL
                    {summary.networkFeeIncomplete && <span className="ml-1 text-amber-300">{t('Parcial')}</span>}
                  </p>
                  {summary.openPositionBases.length > 0 && (
                    <details className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
                        <span>{t('Inventario FIFO reconstruido')}</span>
                        <span className="font-mono text-xs text-[var(--muted)]">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(summary.openPositionBases.length)}</span>
                      </summary>
                      <div className="mt-2 border-t border-[var(--line)] pt-3">
                        <p className="text-xs leading-relaxed text-[var(--muted)]">
                          {t('Estimación calculada desde swaps y movimientos detectados; no confirma el saldo actual ni incluye valor de mercado.')}
                        </p>
                        <ul className="mt-3 grid gap-2">
                          {summary.openPositionBases.map((position) => {
                            const token = registeredTokensByMint.get(position.mintAddress);
                            const amountLabel = (rawAmount: string) => position.tokenDecimals === null
                              ? `${rawAmount} ${t('unidades mínimas')}`
                              : formatRawTokenAmount(rawAmount, position.tokenDecimals, locale);
                            const quoteSymbol = position.quoteMint === SOL_MINT ? 'SOL' : 'USDC';
                            return (
                              <li key={`${position.mintAddress}:${position.quoteMint}`} className="rounded-lg border border-[var(--line)] p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-semibold">{token?.symbol || t('Token')}</span>
                                  <a href={explorerAddress(position.mintAddress)} target="_blank" rel="noreferrer" className="break-all font-mono text-[10px] text-[var(--muted)] underline">{shortenAddress(position.mintAddress)}</a>
                                </div>
                                <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                                  <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Cantidad reconstruida')}</dt><dd className="text-right font-mono tabular-nums">{amountLabel(position.reconstructedTokenAmountRaw)}</dd></div>
                                  <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Cantidad con costo conocido')}</dt><dd className="text-right font-mono tabular-nums">{amountLabel(position.knownTokenAmountRaw)}</dd></div>
                                  <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Costo FIFO remanente')}</dt><dd className="text-right font-mono tabular-nums">{formatRawAmount(position.knownCostBasisRaw, position.quoteDecimals, locale)} {quoteSymbol}</dd></div>
                                  <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">{t('Cantidad sin costo conocido')}</dt><dd className="text-right font-mono tabular-nums">{amountLabel(position.unknownTokenAmountRaw)}</dd></div>
                                </dl>
                                {position.incomplete && <p className="mt-2 text-xs text-amber-300" role="status">{t('Parcial: falta historial o hay movimientos ambiguos para este token.')}</p>}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </details>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="wire-panel rounded-2xl p-4 sm:p-5" aria-labelledby="activity-calendar-title">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="wire-kicker mb-1"><CalendarDays size={13} aria-hidden="true" />{t('HISTORIAL · DEVNET')}</p>
                <h3 id="activity-calendar-title" className="font-display text-lg font-semibold">{t('Calendario de actividad')}</h3>
              </div>
              <div className="flex items-center justify-between gap-2 sm:justify-end">
                <button type="button" onClick={() => changeCalendarMonth(-1)} className="wire-button wire-button-secondary min-h-11 min-w-11 p-0" aria-label={t('Mes anterior')}>
                  <ChevronLeft size={17} aria-hidden="true" />
                </button>
                <span className="min-w-32 text-center text-sm font-semibold capitalize" aria-live="polite">
                  {new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { month: 'long', year: 'numeric' }).format(calendarMonth)}
                </span>
                <button type="button" onClick={() => changeCalendarMonth(1)} className="wire-button wire-button-secondary min-h-11 min-w-11 p-0" aria-label={t('Mes siguiente')}>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div role="grid" className="grid grid-cols-7 gap-1 text-center" aria-label={t('Calendario mensual de actividad')}>
              <div role="row" className="contents">
                {weekDays.map((day, index) => (
                  <span key={`${day}-${index}`} role="columnheader" className="py-2 text-[10px] font-semibold uppercase text-[var(--muted)]">{day}</span>
                ))}
              </div>
              {Array.from({ length: calendarDates.length / 7 }, (_, weekIndex) => (
                <div role="row" className="contents" key={`week-${weekIndex}`}>
                  {calendarDates.slice(weekIndex * 7, weekIndex * 7 + 7).map((date) => {
                    const key = localDateKey(date);
                    const inMonth = date.getMonth() === calendarMonth.getMonth();
                    const count = activityCounts[key] ?? 0;
                    const selected = selectedDate === key;
                    const fullDate = new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'full' }).format(date);
                    return (
                      <div key={key} role="gridcell" aria-selected={inMonth ? selected : undefined} className="min-w-0">
                        <button
                          ref={(node) => {
                            if (node) calendarDayRefs.current.set(key, node);
                            else calendarDayRefs.current.delete(key);
                          }}
                          type="button"
                          disabled={!inMonth}
                          onClick={() => {
                            setFocusedDate(key);
                            setSelectedDate(selected ? null : key);
                          }}
                          onKeyDown={(event) => handleCalendarKeyDown(date, event)}
                          tabIndex={inMonth && focusedDate === key ? 0 : -1}
                          aria-current={todayKey === key ? 'date' : undefined}
                          aria-label={t('{date}, {count} actividades', { date: fullDate, count })}
                          className={`relative flex min-h-11 w-full min-w-0 flex-col items-center justify-center rounded-lg text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wire-green)] disabled:cursor-default ${!inMonth ? 'text-transparent' : selected ? 'bg-[var(--wire-green)] font-bold text-[#091108]' : count ? 'bg-[var(--surface-2)] text-white hover:border hover:border-[var(--wire-green)]' : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'}`}
                        >
                          {date.getDate()}
                          {inMonth && count > 0 && <span className={`mt-0.5 h-1 w-1 rounded-full ${selected ? 'bg-[#091108]' : 'bg-[var(--wire-green)]'}`} aria-hidden="true" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3 text-xs">
              <span className="text-[var(--muted)]">
                {selectedDate
                  ? t('{count} actividades el {date}', { count: visibleActivity.filter((item) => item.type !== 'withdrawal' || item.withdrawal.status !== 'cancelled').length, date: new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'medium' }).format(new Date(`${selectedDate}T12:00:00`)) })
                  : t('{count} actividades en total', { count: countedActivity })}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {cancelledAttemptsCount > 0 && <button type="button" aria-expanded={showCancelledAttempts} onClick={() => setShowCancelledAttempts((shown) => !shown)} className="wire-button wire-button-quiet min-h-11 px-2 text-xs">{showCancelledAttempts ? t('Ocultar intentos cancelados') : t('Mostrar intentos cancelados ({count})', { count: cancelledAttemptsCount })}</button>}
                {selectedDate && <button type="button" onClick={() => setSelectedDate(null)} className="wire-button wire-button-quiet min-h-11 px-2 text-xs">{t('Mostrar toda la actividad')}</button>}
              </div>
            </div>
          </section>

          {displayedActivity.length === 0 ? (
            <div className="wire-empty-state" role="status"><h3>{t('No hay actividad en esta fecha')}</h3><p>{t('Elige otro día o muestra toda tu actividad.')}</p></div>
          ) : displayedActivity.map((item) => item.type === 'token' ? (
            <article key={`token-${item.token.mintAddress}`} className="wire-history-card">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                {item.token.imageUrl ? <img src={item.token.imageUrl} alt={item.token.name} className="h-12 w-12 rounded-full object-cover" /> : null}
                <div className="min-w-0 flex-1">
                  <h3 className="break-words font-display font-semibold">{item.token.name} ({item.token.symbol})</h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {t('Token creado')} · {item.token.launchPlatform === 'PUMP_FUN' ? t('Curva asociada') : item.token.poolAddress && item.token.poolAddress !== 'pending' ? t('Pool asociada') : t('Sin pool')} · {statusLabel(item.token.status, t)} · {new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.date))}
                  </p>
                  <p className="mt-2 break-all font-mono text-[10px] text-[var(--muted)]">{t('Dirección mint')}: {item.token.mintAddress}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/token/${item.token.mintAddress}`} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Detalles')}</Link>
                  <a href={explorerAddress(item.token.mintAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Ver en Explorer')}</a>
                  {item.token.txHash && <a href={explorerTransaction(item.token.txHash)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Tx token')}</a>}
                  {item.token.launchPlatform === 'PUMP_FUN' && item.token.bondingCurveAddress ? <a href={explorerAddress(item.token.bondingCurveAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Ver bonding curve')}</a> : item.token.poolAddress && item.token.poolAddress !== 'pending' ? <a href={explorerAddress(item.token.poolAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Ver pool')}</a> : null}
                </div>
              </div>
            </article>
          ) : item.type === 'withdrawal' ? (
            <article key={`withdrawal-${item.withdrawal.id}`} className="wire-history-card">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{t('Retiro de liquidez')}</h3>
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[var(--muted)]">{statusLabel(item.withdrawal.status, t)}</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.date))}</p>
                  <p className="mt-2 font-mono text-xs">
                    {item.withdrawal.status === 'cancelled' ? t('Retiro cancelado antes de firmar') : t('Estimación neta tras el fee')}
                    {item.withdrawal.status !== 'cancelled' && item.withdrawal.quoteAmountRaw !== null && item.withdrawal.platformFeeRaw !== null ? (
                      <> {formatRawAmount((BigInt(item.withdrawal.quoteAmountRaw) - BigInt(item.withdrawal.platformFeeRaw)).toString(), item.withdrawal.quoteDecimals, locale)} {item.withdrawal.quoteMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC'}<span className="text-[var(--muted)]"> · {t('Fee')} {formatRawAmount(item.withdrawal.platformFeeRaw, item.withdrawal.quoteDecimals, locale)} {item.withdrawal.quoteMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC'}</span></>
                    ) : item.withdrawal.status !== 'cancelled' ? (
                      <> {formatSolLamports(item.withdrawal.userAmountLamports, item.withdrawal.userAmount, locale)} SOL<span className="text-[var(--muted)]"> · {t('Fee')} {formatSolLamports(item.withdrawal.platformFeeLamports, item.withdrawal.platformFee, locale)} SOL</span></>
                    ) : null}
                  </p>
                  <p className="mt-2 break-all font-mono text-[10px] text-[var(--muted)]">{t('Dirección de la pool')}: {item.withdrawal.poolAddress}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={explorerAddress(item.withdrawal.poolAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Ver pool')}</a>
                  {item.withdrawal.txHash && <a href={explorerTransaction(item.withdrawal.txHash)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Transacción')}</a>}
                </div>
              </div>
            </article>
          ) : (
            <article key={`swap-${item.swap.signature}`} className="wire-history-card">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{t(item.swap.side === 'buy' ? 'Compra verificada' : 'Venta verificada')}</h3>
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[var(--muted)]">{t(item.swap.venue === 'PUMP_FUN' ? 'Pump.fun' : item.swap.venue === 'PUMP_SWAP' ? 'PumpSwap' : item.swap.venue === 'RAYDIUM_CLMM' ? 'Raydium CLMM' : item.swap.venue === 'RAYDIUM_AMM_STABLE' ? 'Raydium Stable AMM' : item.swap.venue === 'RAYDIUM_AMM_V4' ? 'Raydium AMM V4' : 'Raydium CPMM')}</span>
                    {!registeredTokensByMint.has(item.swap.mintAddress) && <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[var(--muted)]">{t('Sin detalle local')}</span>}
                    <span className="rounded-full border border-[var(--wire-green)]/30 px-2 py-0.5 text-[10px] text-[var(--wire-green)]">{t('Confirmada en Solana')}</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.date))} · {t('Slot')} {item.swap.slot}</p>
                  <p className="mt-2 font-mono text-sm font-semibold">
                    {t(item.swap.side === 'buy' ? 'Recibiste {amount} tokens' : 'Entregaste {amount} tokens', { amount: formatRawTokenAmount(item.swap.tokenAmountRaw, item.swap.tokenDecimals, locale) })}
                  </p>
                  {item.swap.quoteAmountRaw !== null ? (
                    <p className="mt-1 font-mono text-xs text-[var(--muted)]">
                      {t(item.swap.side === 'buy' ? 'Gastaste {amount} {asset}' : 'Recibiste {amount} {asset}', {
                        amount: formatRawAmount(item.swap.quoteAmountRaw, item.swap.quoteDecimals, locale),
                        asset: item.swap.quoteMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC',
                      })}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-[var(--muted)]">{t('El monto de cotización no está disponible para este registro histórico.')}</p>
                  )}
                  {item.swap.networkFeeLamports !== null && <p className="mt-1 text-xs text-[var(--muted)]">{t('Fee de red')}: {formatSolLamports(item.swap.networkFeeLamports, 0, locale)} SOL</p>}
                  <p className="mt-2 break-all font-mono text-[10px] text-[var(--muted)]">{t('Dirección mint')}: {item.swap.mintAddress}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {registeredTokensByMint.has(item.swap.mintAddress)
                    ? <Link href={`/token/${item.swap.mintAddress}`} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Detalles')}</Link>
                    : <a href={explorerAddress(item.swap.mintAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Ver token en Explorer')}</a>}
                  <a href={explorerAddress(item.swap.poolAddress)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t(item.swap.venue === 'PUMP_FUN' ? 'Ver bonding curve' : 'Ver pool')}</a>
                  <a href={explorerTransaction(item.swap.signature)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Transacción')}</a>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
    {identified && (
      <section className="wire-history-section mt-6" aria-labelledby="chain-activity-title">
        <div className="wire-panel rounded-2xl p-4 sm:p-5">
          {vaultWallets.some((wallet) => wallet.address !== publicKey?.toBase58()) && (
            <fieldset className="mb-5 rounded-xl border border-[var(--line)] bg-black/10 p-3 sm:p-4">
              <legend className="px-1 text-sm font-semibold">{t('Asocia wallets de la bóveda para conservar costo FIFO')}</legend>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                {t('Marca solo wallets tuyas. Wire solo traslada el costo FIFO conocido cuando la firma, el mint, el slot, la cantidad y los deltas opuestos confirman una transferencia SPL simple. La selección y los lotes se guardan en este navegador; no se leen claves privadas ni se envían al backend.')}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-amber-300">
                {t('La estimación sigue parcial: RPC puede omitir historiales antiguos o cuentas SPL cerradas, y este escaneo cubre los mints con swaps cargados. Revisa el historial antes de usar el costo transferido.')}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {vaultWallets.filter((wallet) => wallet.address !== publicKey?.toBase58()).map((wallet) => (
                  <label key={wallet.address} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--wire-green)]"
                  checked={activeAssociatedWalletAddresses.includes(wallet.address)}
                  disabled={associatedWalletFor !== currentWalletAddress}
                      onChange={(event) => toggleAssociatedWallet(wallet.address, event.currentTarget.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-semibold">{wallet.label} · {t(wallet.role === 'dev' ? 'Dev' : wallet.role === 'bundle' ? 'Bundle' : wallet.role === 'snipe' ? 'Snipe' : wallet.role === 'trading' ? 'Trading' : 'Holder')}</span>
                      <span className="block break-all font-mono text-[10px] text-[var(--muted)]">{wallet.address}</span>
                    </span>
                  </label>
                ))}
              </div>
              {transferBasisStorageWarning && <p className="mt-3 text-xs text-amber-300" role="status">{t('El navegador no pudo guardar la selección o el costo transferido. La actividad sigue visible, pero el costo entre wallets no se conservará.')}</p>}
            </fieldset>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <h2 id="chain-activity-title" className="font-display text-lg font-semibold">{t('Firmas recientes en Solana Devnet')}</h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Consulta firmas públicas en páginas de hasta {count}. Wire revisa la wallet, todas sus cuentas SPL/Token-2022 abiertas y las ATA canónicas de sus mints y de los swaps cargados, solicita detalles en grupos de hasta 25 y elimina firmas duplicadas. Muestra los cambios netos de tokens que RPC atribuye a la wallet. Puede identificar transferencias simples, acuñaciones o quemas; si marcas otra wallet de la bóveda y coinciden la firma, el mint, la cantidad y los deltas, conserva localmente el costo FIFO conocido. En pools Raydium registradas también incorpora cambios coincidentes de LP y de sus activos al inventario, pero su costo queda desconocido y el PnL parcial hasta reconstruir esa base. No decide automáticamente si otras instrucciones son swaps. Puedes pedir la verificación de swaps compatibles de Devnet; solo agrega operaciones confirmadas.', { count: MAX_RECENT_CHAIN_SIGNATURES })}</p>
            </div>
            <button type="button" onClick={() => void loadRecentChainSignatures()} disabled={chainSignaturesLoading} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
              {chainSignaturesLoading ? t('Consultando Devnet…') : chainSignaturesFetched ? t('Actualizar firmas') : t('Consultar actividad on-chain')}
            </button>
          </div>
          {chainSignaturesError && <p className="mt-3 text-sm text-[var(--danger)]" role="alert">{chainSignaturesError}</p>}
          {chainDetailsUnavailable && <p className="mt-3 text-xs text-amber-300" role="status">{t('El RPC devolvió las firmas, pero no pudo cargar algunos detalles de transacción.')}</p>}
          {chainSignaturesFetched && chainSignaturesWallet === publicKey?.toBase58() && (
            <>
            <p className="mt-3 text-xs text-[var(--muted)]" role="status">{t('Se consultaron {sources} direcciones de wallet y cuentas de tokens; se cargaron {count} firmas únicas.', { count: chainSignatures.length, sources: chainSignatureSourceCount })}</p>
            {chainSignatures.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-[var(--line)] p-4 text-sm text-[var(--muted)]">{t('No se encontraron firmas recientes para esta wallet.')}</p>
            ) : (
              <ol className="mt-4 grid gap-2" aria-label={t('Firmas recientes en Solana Devnet')}>
                {chainSignatures.map((item) => {
                  const registered = wireSignatures.has(item.signature);
                  const date = item.blockTime === null ? null : new Date(item.blockTime * 1000);
                  return (
                    <li key={item.signature} className="grid gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${item.failed ? 'border-rose-400/30 text-rose-300' : 'border-[var(--wire-green)]/30 text-[var(--wire-green)]'}`}>{t(item.failed ? 'Fallida en Devnet' : 'Confirmada en Devnet')}</span>
                          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[var(--muted)]">{t(registered ? 'Coincide con registro de Wire' : 'Sin coincidencia en historial Wire')}</span>
                          <span className="text-[10px] text-[var(--muted)]">{t('Slot')} {item.slot}</span>
                        </div>
                        <p className="mt-2 break-all font-mono text-[10px] text-[var(--muted)]">{item.signature}</p>
                        <p className="mt-1 text-xs text-[var(--muted)]">{date ? new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : t('Fecha no disponible en RPC')}</p>
                        {item.detailsRequested && item.tokenDeltas && item.tokenDeltas.length > 0 ? (
                          <div className="mt-3 rounded-lg border border-white/10 p-2.5">
                            <p className="text-[10px] font-semibold text-[var(--muted)]">{t('Cambios netos de tokens atribuidos por RPC')}</p>
                            <p className="mt-1 text-[10px] text-[var(--muted)]">{t('Tipo de movimiento detectado')}: {t(tokenMovementKindLabel(item.tokenMovementKind, (item.trackedLiquidityPoolMovements?.length ?? 0) > 0))}</p>
                            {item.trackedLiquidityPoolMovements?.map((pool) => (
                              <a key={pool.poolAddress} href={explorerAddress(pool.poolAddress)} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-[10px] text-[var(--wire-green)] underline underline-offset-2">
                                {t('Pool Raydium reconocida')}: {shortenAddress(pool.poolAddress)}
                              </a>
                            ))}
                            <ul className="mt-1 grid gap-1">
                              {item.tokenDeltas.map((delta) => {
                                const registeredToken = registeredTokensByMint.get(delta.mintAddress);
                                const verificationKey = `${item.signature}:${delta.mintAddress}`;
                                const verificationStatus = externalSwapVerification[verificationKey];
                                let side: 'buy' | 'sell' | null = null;
                                try {
                                  const deltaRaw = BigInt(delta.amountRaw);
                                  side = deltaRaw > 0n ? 'buy' : deltaRaw < 0n ? 'sell' : null;
                                } catch {
                                  side = null;
                                }
                                const marketReady = registeredToken && (registeredToken.launchPlatform === 'PUMP_FUN'
                                  ? Boolean(registeredToken.bondingCurveAddress)
                                  : Boolean(registeredToken.poolAddress && registeredToken.poolAddress !== 'pending'));
                                const canVerify = Boolean(side && !item.failed && identified && !wireSignatures.has(item.signature)
                                  && (!registeredToken || marketReady));
                                return (
                                  <li key={delta.mintAddress} className="grid gap-1 text-xs">
                                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                                      <span>{t('Cambio neto')}: <strong className="font-mono">{delta.decimals === null ? `${delta.amountRaw} ${t('unidades mínimas')}` : formatRawTokenAmount(delta.amountRaw, delta.decimals, locale)}</strong></span>
                                      <a href={explorerAddress(delta.mintAddress)} target="_blank" rel="noreferrer" className="break-all font-mono text-[10px] text-[var(--muted)] underline">{delta.mintAddress}</a>
                                    </div>
                                    {delta.counterpartyAddress && item.tokenMovementKind === 'transfer' && (
                                      <p className="break-all text-[10px] text-[var(--muted)]">
                                        {t('Otra wallet identificada por los deltas de esta firma')}: <span className="font-mono">{delta.counterpartyAddress}</span>.{' '}
                                        {activeAssociatedWalletAddresses.includes(delta.counterpartyAddress)
                                          ? t('La relación está seleccionada en este navegador; el costo FIFO conocido puede acompañar esta transferencia.')
                                          : t('No está asociada; esta transferencia conserva el estado de costo desconocido.')}
                                      </p>
                                    )}
                                    {canVerify && side && (
                                      <div className="mt-1 rounded-lg border border-[var(--line)] bg-black/10 p-2.5">
                                        <p className="text-[10px] text-[var(--muted)]">{registeredToken
                                          ? t('Token tuyo creado en Wire: {symbol}. Wire comprobará el mercado, la firma y los cambios de balance antes de agregarlo. Esta acción no firma ni envía transacciones.', { symbol: registeredToken.symbol })
                                          : t('Sin detalle local para este token. Wire comprobará si esta firma corresponde a una operación confirmada en un mercado compatible de Devnet. No firma ni envía transacciones.')}</p>
                                        {verificationStatus === 'imported' ? (
                                          <p className="mt-2 text-xs text-[var(--wire-green)]" role="status">{t('Swap verificado e importado al historial.')}</p>
                                        ) : (
                                          <button
                                            type="button"
                                            onClick={() => void verifyExternalSwap(item, delta.mintAddress, side)}
                                            disabled={verificationStatus === 'checking'}
                                            className="wire-button wire-button-secondary mt-2 min-h-11 px-3 text-xs"
                                          >
                                            {verificationStatus === 'checking' ? t('Verificando swap…') : side === 'buy' ? t('Verificar e importar compra') : t('Verificar e importar venta')}
                                          </button>
                                        )}
                                        {verificationStatus === 'pending' && <p className="mt-2 text-xs text-amber-300" role="status">{t('La firma está confirmada, pero el RPC aún no permite verificar el swap. Puedes reintentarlo.')}</p>}
                                        {verificationStatus === 'notVerified' && <p className="mt-2 text-xs text-amber-300" role="status">{t('Wire no pudo verificar esta firma como swap de un mercado compatible. No se agregó al historial.')}</p>}
                                      </div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ) : item.detailsRequested ? (
                          <p className="mt-2 text-[10px] text-[var(--muted)]">{item.tokenDeltas === null ? t('El RPC no devolvió detalles parseados de esta transacción.') : t('El RPC no reportó cambios netos SPL atribuidos a esta wallet.')}</p>
                        ) : (
                          <p className="mt-2 text-[10px] text-[var(--muted)]">{t('No se consultaron detalles de esta transacción.')}</p>
                        )}
                      </div>
                      <a href={explorerTransaction(item.signature)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Ver transacción')}</a>
                    </li>
                  );
                })}
              </ol>
            )}
            </>
          )}
          {chainSignaturesFetched && chainSignaturesWallet === publicKey?.toBase58() && chainHasMore && (
            <button type="button" onClick={() => {
              void loadRecentChainSignatures(true);
            }} disabled={chainSignaturesLoading} className="wire-button wire-button-secondary mt-4 min-h-11 px-3 text-sm">
              {chainSignaturesLoading ? t('Consultando Devnet…') : t('Cargar firmas anteriores')}
            </button>
          )}
          {chainSignaturesFetched && (Boolean(error) || history.swapsUnavailable || history.withdrawalsUnavailable) && (
            <p className="mt-3 text-xs text-amber-300" role="status">{t('Alguna parte del historial local no cargó; una firma sin coincidencia podría pertenecer a una operación de Wire.')}</p>
          )}
        </div>
      </section>
    )}
    </>
  );
}
