'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { ExternalLink, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  getWalletVaultMetadata,
  unlockWalletVault,
  type VaultWallet,
  type WalletVaultSession,
} from '../lib/walletVault';
import { takeProjectWalletLaunchSelection } from '../lib/projectWalletLaunchSelection';
import {
  canReQuoteFailedProjectSwap,
  canContinueTimedBuyAfterFailure,
  DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS,
  isProjectSwapQuote,
  isProjectMarketWatchQuote,
  MAX_TIMED_BUY_CONSECUTIVE_ERRORS,
  MIN_TIMED_BUY_CONSECUTIVE_ERRORS,
  parseProjectWalletSwapTask,
  projectWalletSwapTaskStorageKey,
  serializeProjectWalletSwapTask,
  type ProjectSwapQuote as SwapQuote,
  type ProjectSwapSide as SwapSide,
  type ProjectSwapTaskRunStatus,
  type ProjectSwapTaskRow as BatchRow,
} from '../lib/projectWalletSwapTask';
import { chooseTimedBuyDelaySeconds, MAX_TIMED_BUY_DELAY_SECONDS } from '../lib/timedBuyDelay';
import {
  isMarketLaunchFeeReserveWithinCap,
  isMarketLaunchTriggerExpired,
  marketLaunchPlanFingerprint,
  MARKET_LAUNCH_FEE_RESERVE_PER_WALLET_LAMPORTS,
  MARKET_LAUNCH_TRIGGER_POLL_INTERVAL_MS,
  MARKET_LAUNCH_TRIGGER_TTL_MS,
} from '../lib/marketLaunchTrigger';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';
import { useWireLocale } from './LocaleProvider';
import { userFacingError } from './toastEvents';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const MAX_BATCH_WALLETS = 10;
const MAX_SAVED_PRESETS = 25;
const SWAP_PRESETS_STORAGE_KEY = 'wire:project-wallet-swap-presets:v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const explorerTransaction = (signature: string) => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;

type ProjectSwapPreset = {
  id: string;
  name: string;
  mintAddress: string;
  quoteMint: string;
  side: SwapSide;
  slippageBps: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  maxConsecutiveErrors: number;
  walletAddresses: string[];
  amounts: Record<string, string>;
  maxTotalSpend?: string;
  updatedAt: number;
};

function isValidAmount(value: string, decimals: number) {
  return new RegExp(`^(?:\\d{1,20})(?:\\.\\d{1,${decimals}})?$`).test(value.trim()) && /[1-9]/.test(value);
}

function matchesReviewedQuote(reviewed: SwapQuote, prepared: SwapQuote): boolean {
  return reviewed.venue === prepared.venue
    && reviewed.poolAddress === prepared.poolAddress
    && reviewed.side === prepared.side
    && reviewed.inputMint === prepared.inputMint
    && reviewed.outputMint === prepared.outputMint
    && reviewed.inputSymbol === prepared.inputSymbol
    && reviewed.outputSymbol === prepared.outputSymbol
    && reviewed.quoteMint === prepared.quoteMint
    && reviewed.quoteDecimals === prepared.quoteDecimals
    && reviewed.amountIn === prepared.amountIn
    && reviewed.amountOut === prepared.amountOut
    && reviewed.minimumAmountOut === prepared.minimumAmountOut
    && reviewed.maximumAmountIn === prepared.maximumAmountIn
    && reviewed.estimatedPoolFee === prepared.estimatedPoolFee
    && reviewed.priceImpactPercent === prepared.priceImpactPercent
    && reviewed.slippageBps === prepared.slippageBps
    && reviewed.network === prepared.network;
}

async function hashMessage(message: Uint8Array) {
  const bytes = message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseSolLamports(amount: string) {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole || '0') * 1_000_000_000n + BigInt(fraction.padEnd(9, '0') || '0');
}

function parseDecimalRaw(value: string, decimals: number) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function sameRawAmount(left: string, right: string, decimals: number) {
  const pattern = new RegExp(`^\\d{1,20}(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(left.trim()) || !pattern.test(right.trim())) return false;
  try { return parseDecimalRaw(left.trim(), decimals) === parseDecimalRaw(right.trim(), decimals); }
  catch { return false; }
}

function formatDecimalRaw(value: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function sumSelectedAmounts(addresses: string[], amounts: Record<string, string>, decimals: number) {
  return addresses.reduce((sum, address) => {
    const amount = amounts[address] ?? '';
    return isValidAmount(amount, decimals) ? sum + parseDecimalRaw(amount.trim(), decimals) : sum;
  }, 0n);
}

function sumMaximumSpend(rows: BatchRow[], decimals: number, quoteOverrides = new Map<string, SwapQuote>()) {
  return rows.reduce((sum, row) => {
    if (row.status === 'cancelled') return sum;
    const quote = quoteOverrides.get(row.wallet.address) ?? row.quote;
    const spend = row.status === 'confirmed' ? row.amountIn : quote.maximumAmountIn ?? row.amountIn;
    return sum + parseDecimalRaw(spend, decimals);
  }, 0n);
}

function parseProjectSwapPresets(value: string | null): ProjectSwapPreset[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate): ProjectSwapPreset[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const preset = candidate as Partial<ProjectSwapPreset>;
      const legacyDelay = (candidate as { delaySeconds?: unknown }).delaySeconds;
      const hasLegacyDelay = Object.prototype.hasOwnProperty.call(candidate, 'delaySeconds');
      if (hasLegacyDelay && typeof legacyDelay !== 'number') return [];
      const delayMinSeconds = preset.delayMinSeconds ?? (typeof legacyDelay === 'number' ? legacyDelay : 0);
      const delayMaxSeconds = preset.delayMaxSeconds ?? (typeof legacyDelay === 'number' ? legacyDelay : 0);
      const maxConsecutiveErrors = preset.maxConsecutiveErrors ?? DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS;
      if (typeof preset.id !== 'string' || !preset.id || preset.id.length > 80 || typeof preset.name !== 'string' || !preset.name.trim() || preset.name.length > 40
        || typeof preset.mintAddress !== 'string' || typeof preset.quoteMint !== 'string'
        || (preset.side !== 'buy' && preset.side !== 'sell') || ![50, 100, 200, 500].includes(preset.slippageBps ?? -1)
        || !Number.isInteger(delayMinSeconds) || !Number.isInteger(delayMaxSeconds)
        || !Number.isInteger(maxConsecutiveErrors) || maxConsecutiveErrors < MIN_TIMED_BUY_CONSECUTIVE_ERRORS || maxConsecutiveErrors > MAX_TIMED_BUY_CONSECUTIVE_ERRORS
        || delayMinSeconds < 0 || delayMaxSeconds > MAX_TIMED_BUY_DELAY_SECONDS || delayMinSeconds > delayMaxSeconds
        || (preset.maxTotalSpend !== undefined && (typeof preset.maxTotalSpend !== 'string' || preset.maxTotalSpend.length > 40 || !/^\d{1,20}(?:\.\d{1,18})?$/.test(preset.maxTotalSpend)))
        || !Array.isArray(preset.walletAddresses) || preset.walletAddresses.length < 1 || preset.walletAddresses.length > MAX_BATCH_WALLETS
        || !preset.amounts || typeof preset.amounts !== 'object' || typeof preset.updatedAt !== 'number' || !Number.isSafeInteger(preset.updatedAt)) return [];
      try {
        if (new PublicKey(preset.mintAddress).toBase58() !== preset.mintAddress
          || new PublicKey(preset.quoteMint).toBase58() !== preset.quoteMint) return [];
        const walletAddresses = preset.walletAddresses.map((address) => {
          if (typeof address !== 'string' || new PublicKey(address).toBase58() !== address) throw new Error();
          return address;
        });
        if (new Set(walletAddresses).size !== walletAddresses.length) return [];
        const amounts: Record<string, string> = {};
        for (const address of walletAddresses) {
          const amount = (preset.amounts as Record<string, unknown>)[address];
          if (typeof amount !== 'string' || amount.length > 40 || !/^\d{1,20}(?:\.\d{1,18})?$/.test(amount)) return [];
          amounts[address] = amount;
        }
        return [{
          id: preset.id,
          name: preset.name.trim(),
          mintAddress: preset.mintAddress,
          quoteMint: preset.quoteMint,
          side: preset.side,
          slippageBps: preset.slippageBps as number,
          delayMinSeconds,
          delayMaxSeconds,
          maxConsecutiveErrors,
          walletAddresses,
          amounts,
          ...(typeof preset.maxTotalSpend === 'string' ? { maxTotalSpend: preset.maxTotalSpend } : {}),
          updatedAt: preset.updatedAt,
        }];
      } catch { return []; }
    }).slice(-MAX_SAVED_PRESETS);
  } catch { return []; }
}

async function ensureTokenBalance(
  connection: Connection,
  wallet: string,
  mintAddress: string,
  amount: string,
) {
  const response = await connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mintAddress) }, 'confirmed');
  let balance = 0n;
  let decimals: number | null = null;
  for (const entry of response.value) {
    const info = entry.account.data.parsed.info as { tokenAmount?: { amount?: unknown; decimals?: unknown } };
    const tokenAmount = info?.tokenAmount;
    if (!tokenAmount || typeof tokenAmount.amount !== 'string' || !Number.isInteger(tokenAmount.decimals)) continue;
    if (decimals !== null && decimals !== tokenAmount.decimals) throw new Error('Las cuentas de token devuelven una precisión inconsistente.');
    decimals = tokenAmount.decimals as number;
    balance += BigInt(tokenAmount.amount);
  }
  if (decimals === null || !isValidAmount(amount, decimals) || balance < parseDecimalRaw(amount, decimals)) {
    throw new Error('El saldo del token no alcanza para el importe seleccionado.');
  }
}

export default function ProjectWalletSwapPanel({
  mintAddress,
  tokenSymbol,
  quoteMint,
  launchPlatform,
}: {
  mintAddress: string;
  tokenSymbol: string;
  quoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
}) {
  const { t } = useWireLocale();
  const { connection } = useConnection();
  const [wallets, setWallets] = useState<VaultWallet[]>([]);
  const [vaultExists, setVaultExists] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [session, setSession] = useState<WalletVaultSession | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [side, setSide] = useState<SwapSide>('buy');
  const [slippageBps, setSlippageBps] = useState(100);
  const [delayMinSeconds, setDelayMinSeconds] = useState(0);
  const [delayMaxSeconds, setDelayMaxSeconds] = useState(0);
  const [maxConsecutiveErrors, setMaxConsecutiveErrors] = useState(DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS);
  const [consecutiveErrorCount, setConsecutiveErrorCount] = useState(0);
  const [maxTotalSpend, setMaxTotalSpend] = useState('');
  const [delayRemaining, setDelayRemaining] = useState(0);
  const [delayUntil, setDelayUntil] = useState<number | null>(null);
  const [presets, setPresets] = useState<ProjectSwapPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<BatchRow[]>([]);
  const [runStatus, setRunStatus] = useState<ProjectSwapTaskRunStatus>('ready');
  const [taskHydratedFor, setTaskHydratedFor] = useState('');
  const [taskPersistenceWarning, setTaskPersistenceWarning] = useState(false);
  const [working, setWorking] = useState(false);
  const [timedBuyArmed, setTimedBuyArmed] = useState(false);
  const [timedBuyAcknowledged, setTimedBuyAcknowledged] = useState(false);
  const [timedBuyRunNonce, setTimedBuyRunNonce] = useState(0);
  const [stopRequested, setStopRequested] = useState(false);
  const [marketWatchStatus, setMarketWatchStatus] = useState<'idle' | 'watching' | 'ready'>('idle');
  const [marketWatchQuote, setMarketWatchQuote] = useState<SwapQuote | null>(null);
  const [marketWatchError, setMarketWatchError] = useState('');
  const [marketWatchNote, setMarketWatchNote] = useState('');
  const [marketWatchLoading, setMarketWatchLoading] = useState(false);
  const [marketWatchRefresh, setMarketWatchRefresh] = useState(0);
  const [prepareWhenMarketReady, setPrepareWhenMarketReady] = useState(false);
  const [marketLaunchTriggerArmed, setMarketLaunchTriggerArmed] = useState(false);
  const [marketLaunchTriggerAcknowledged, setMarketLaunchTriggerAcknowledged] = useState(false);
  const [marketLaunchTriggerAuthorizedPlan, setMarketLaunchTriggerAuthorizedPlan] = useState('');
  const [marketLaunchTriggerExpiresAt, setMarketLaunchTriggerExpiresAt] = useState<number | null>(null);
  const [marketLaunchTriggerSecondsRemaining, setMarketLaunchTriggerSecondsRemaining] = useState(0);
  const prepareReviewStartedRef = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const launchPanelRef = useRef<HTMLDetailsElement>(null);
  const sessionRef = useRef<WalletVaultSession | null>(null);
  const activeWalletRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);
  const timedBuyArmedRef = useRef(false);
  const timedBuyRunInFlightRef = useRef(false);
  const marketTriggeredTimedBuysRef = useRef(false);
  const consecutiveErrorCountRef = useRef(0);
  const taskStorageKey = projectWalletSwapTaskStorageKey(mintAddress, quoteMint, launchPlatform);
  const taskHydrationContext = `${taskStorageKey}:${wallets.map(({ address, label, role }) => `${address}:${label}:${role}`).sort().join(',')}`;
  const marketWatchAmountIn = quoteMint === SOL_MINT ? '0.01' : '1';
  const marketLaunchTriggerPlanFingerprint = marketLaunchPlanFingerprint({
    mintAddress,
    quoteMint,
    launchPlatform,
    side,
    selected,
    amounts,
    maxTotalSpend,
    slippageBps,
    delayMinSeconds,
    delayMaxSeconds,
    maxConsecutiveErrors,
  });
  const marketLaunchTriggerPlanAuthorized = marketLaunchTriggerAcknowledged
    && marketLaunchTriggerAuthorizedPlan === marketLaunchTriggerPlanFingerprint;
  const changeTimedBuyArmed = (armed: boolean) => {
    timedBuyArmedRef.current = armed;
    if (!armed) marketTriggeredTimedBuysRef.current = false;
    setTimedBuyArmed(armed);
  };

  const cancelMarketLaunchTrigger = useCallback((message?: string) => {
    setMarketLaunchTriggerArmed(false);
    setMarketLaunchTriggerAcknowledged(false);
    setMarketLaunchTriggerAuthorizedPlan('');
    setMarketLaunchTriggerExpiresAt(null);
    setMarketLaunchTriggerSecondsRemaining(0);
    setPrepareWhenMarketReady(false);
    prepareReviewStartedRef.current = false;
    setMarketWatchStatus('idle');
    setMarketWatchQuote(null);
    setMarketWatchNote('');
    setMarketWatchError('');
    if (message) setMessage(t(message));
  }, [t]);

  const armMarketLaunchTrigger = () => {
    const validDelay = Number.isInteger(delayMinSeconds) && Number.isInteger(delayMaxSeconds)
      && delayMinSeconds >= 0 && delayMaxSeconds <= MAX_TIMED_BUY_DELAY_SECONDS && delayMinSeconds <= delayMaxSeconds;
    if (!autoPrepareAllowed || side !== 'buy' || !marketLaunchTriggerPlanAuthorized || !validDelay) {
      setError(t('Completa y revisa el plan, el presupuesto y la pausa antes de armar el disparador.'));
      return;
    }
    const expiresAt = Date.now() + MARKET_LAUNCH_TRIGGER_TTL_MS;
    prepareReviewStartedRef.current = false;
    setError('');
    setMessage('');
    setTimedBuyAcknowledged(false);
    setMarketLaunchTriggerExpiresAt(expiresAt);
    setMarketLaunchTriggerSecondsRemaining(Math.ceil(MARKET_LAUNCH_TRIGGER_TTL_MS / 1000));
    setMarketLaunchTriggerArmed(true);
    setMarketWatchQuote(null);
    setMarketWatchError('');
    setMarketWatchNote('');
    setPrepareWhenMarketReady(false);
    setMarketWatchStatus('watching');
  };

  useEffect(() => {
    if (marketLaunchTriggerAcknowledged && marketLaunchTriggerAuthorizedPlan !== marketLaunchTriggerPlanFingerprint) {
      setMarketLaunchTriggerAcknowledged(false);
      setMarketLaunchTriggerAuthorizedPlan('');
    }
  }, [marketLaunchTriggerAcknowledged, marketLaunchTriggerAuthorizedPlan, marketLaunchTriggerPlanFingerprint]);

  useEffect(() => {
    if (!marketLaunchTriggerArmed || marketLaunchTriggerExpiresAt === null) return;
    const updateExpiry = () => {
      if (isMarketLaunchTriggerExpired(marketLaunchTriggerExpiresAt, Date.now())) {
        cancelMarketLaunchTrigger('El disparador venció después de 15 minutos. No se enviaron compras.');
        return;
      }
      setMarketLaunchTriggerSecondsRemaining(Math.ceil((marketLaunchTriggerExpiresAt - Date.now()) / 1000));
    };
    updateExpiry();
    const interval = window.setInterval(updateExpiry, 1000);
    return () => window.clearInterval(interval);
  }, [marketLaunchTriggerArmed, marketLaunchTriggerExpiresAt, cancelMarketLaunchTrigger]);

  useEffect(() => {
    if (!marketLaunchTriggerArmed) return;
    const cancelWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        cancelMarketLaunchTrigger('El disparador se canceló al ocultar la página. No se enviaron compras.');
      }
    };
    document.addEventListener('visibilitychange', cancelWhenHidden);
    return () => document.removeEventListener('visibilitychange', cancelWhenHidden);
  }, [marketLaunchTriggerArmed, cancelMarketLaunchTrigger]);

  useEffect(() => {
    if (marketLaunchTriggerArmed && (!session || session.isLocked)) {
      cancelMarketLaunchTrigger('El disparador se canceló porque la bóveda se bloqueó. No se enviaron compras.');
    }
  }, [marketLaunchTriggerArmed, session, cancelMarketLaunchTrigger]);

  const chooseDelayForNextWallet = () => {
    const random = new Uint32Array(1);
    window.crypto.getRandomValues(random);
    return chooseTimedBuyDelaySeconds(delayMinSeconds, delayMaxSeconds, random[0] / 0x1_0000_0000);
  };

  useEffect(() => {
    if (marketWatchStatus !== 'watching' || side !== 'buy') {
      setMarketWatchLoading(false);
      return;
    }
    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    const checkMarket = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      setMarketWatchLoading(true);
      try {
        const query = new URLSearchParams({
          mintAddress,
          side: 'buy',
          amountIn: marketWatchAmountIn,
          slippageBps: '100',
        });
        const response = await fetch(`${API_URL}/api/swap/quote?${query}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json();
        if (response.status === 409) {
          if (active) {
            setMarketWatchNote(t('Todavía no hay un mercado que cotice; se volverá a comprobar en 30 segundos.'));
            setMarketWatchError('');
          }
          return;
        }
        if (!response.ok || !data.success) {
          throw new Error(data.error || t('No se pudo comprobar el mercado.'));
        }
        if (!isProjectMarketWatchQuote(data.quote, {
          mintAddress,
          quoteMint,
          launchPlatform,
          amountIn: marketWatchAmountIn,
          slippageBps: 100,
        })) {
          throw new Error(t('La cotización del mercado no coincide con este token de Devnet.'));
        }
        if (active) {
          setMarketWatchQuote(data.quote);
          setMarketWatchStatus('ready');
          setMarketWatchNote('');
          setMarketWatchError('');
        }
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        setMarketWatchError(userFacingError(caught, t('No se pudo comprobar el mercado.'), t));
      } finally {
        inFlight = false;
        if (active) setMarketWatchLoading(false);
      }
    };

    void checkMarket();
    const interval = window.setInterval(() => {
      void checkMarket();
    }, marketLaunchTriggerArmed ? MARKET_LAUNCH_TRIGGER_POLL_INTERVAL_MS : 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkMarket();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [marketWatchStatus, marketWatchRefresh, mintAddress, quoteMint, launchPlatform, marketWatchAmountIn, side, marketLaunchTriggerArmed, t]);

  useEffect(() => {
    setMarketWatchStatus('idle');
    setMarketWatchQuote(null);
    setMarketWatchError('');
    setMarketWatchNote('');
    setPrepareWhenMarketReady(false);
  }, [mintAddress, quoteMint, launchPlatform]);

  useEffect(() => {
    let active = true;
    getWalletVaultMetadata().then((metadata) => {
      if (!active) return;
      setVaultExists(metadata.exists);
      setWallets(metadata.wallets);
    }).catch(() => {
      if (active) setError(t('No se pudo consultar la bóveda en este navegador.'));
    }).finally(() => { if (active) setMetadataReady(true); });
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    if (!metadataReady || !vaultExists) return;
    const queuedSelection = takeProjectWalletLaunchSelection(mintAddress);
    if (!queuedSelection || queuedSelection.walletAddresses.length === 0) return;
    const available = new Set(wallets.map((wallet) => wallet.address));
    const selectedAddresses = queuedSelection.walletAddresses.filter((address) => available.has(address)).slice(0, MAX_BATCH_WALLETS);
    setSelected(selectedAddresses);
    setAmounts(Object.fromEntries(Object.entries(queuedSelection.buyAmounts).filter(([address]) => selectedAddresses.includes(address))));
    setSide('buy');
    setDelayMinSeconds(queuedSelection.buyDelaySeconds);
    setDelayMaxSeconds(queuedSelection.buyDelaySeconds);
    setMaxConsecutiveErrors(DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS);
    setSlippageBps(queuedSelection.buySlippageBps);
    if (launchPanelRef.current) launchPanelRef.current.open = true;
    if (selectedAddresses.length < queuedSelection.walletAddresses.length) {
      setError(t('Algunas wallets preseleccionadas ya no están en el vault; revisa la selección antes de continuar.'));
    }
  }, [metadataReady, vaultExists, wallets, mintAddress, t]);

  useEffect(() => {
    if (!metadataReady || !vaultExists || taskHydratedFor === taskHydrationContext) return;
    const hadPreviousTaskContext = taskHydratedFor !== '';
    try {
      const raw = window.localStorage.getItem(taskStorageKey);
      const task = parseProjectWalletSwapTask(raw, { mintAddress, quoteMint, launchPlatform, wallets });
      if (raw && !task) window.localStorage.removeItem(taskStorageKey);
      if (task) {
        setRunStatus(task.runStatus ?? 'ready');
        setSide(task.side);
        setSlippageBps(task.slippageBps);
        setDelayMinSeconds(task.delayMinSeconds);
        setDelayMaxSeconds(task.delayMaxSeconds);
        setMaxConsecutiveErrors(task.maxConsecutiveErrors);
        setDelayUntil(task.delayUntil ?? null);
        setDelayRemaining(task.delayUntil ? Math.max(0, Math.ceil((task.delayUntil - Date.now()) / 1000)) : 0);
        setMaxTotalSpend(task.maxTotalSpend);
        setSelected(task.selected);
        setAmounts(task.amounts);
        setBatch(task.rows);
        setMessage(t('Se recuperó una secuencia. Las firmas pendientes requieren verificación en Devnet y cada cotización se vuelve a comprobar antes de aprobar.'));
        if (launchPanelRef.current) launchPanelRef.current.open = true;
      } else {
        setRunStatus('ready');
        setBatch([]);
        setDelayUntil(null);
        setDelayRemaining(0);
        if (hadPreviousTaskContext) {
          setSide('buy');
          setSlippageBps(100);
          setDelayMinSeconds(0);
          setDelayMaxSeconds(0);
          setMaxConsecutiveErrors(DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS);
          setMaxTotalSpend('');
          setSelected([]);
          setAmounts({});
        }
      }
      setTaskPersistenceWarning(false);
    } catch {
      setTaskPersistenceWarning(true);
      setRunStatus('ready');
      setBatch([]);
      setDelayUntil(null);
      setDelayRemaining(0);
    } finally {
      setTaskHydratedFor(taskHydrationContext);
    }
  }, [metadataReady, vaultExists, taskHydratedFor, taskHydrationContext, taskStorageKey, mintAddress, quoteMint, launchPlatform, wallets, t]);

  useEffect(() => {
    if (!metadataReady || !vaultExists || taskHydratedFor !== taskHydrationContext) return;
    try {
      if (batch.length === 0) {
        window.localStorage.removeItem(taskStorageKey);
      } else {
        window.localStorage.setItem(taskStorageKey, serializeProjectWalletSwapTask({
          runStatus,
          side,
          slippageBps,
          delayMinSeconds,
          delayMaxSeconds,
          maxConsecutiveErrors,
          delayUntil,
          maxTotalSpend,
          selected,
          amounts,
          rows: batch,
        }, { mintAddress, quoteMint, launchPlatform }));
      }
      setTaskPersistenceWarning(false);
    } catch {
      setTaskPersistenceWarning(true);
    }
  }, [metadataReady, vaultExists, taskHydratedFor, taskHydrationContext, taskStorageKey, batch, runStatus, side, slippageBps, delayMinSeconds, delayMaxSeconds, maxConsecutiveErrors, delayUntil, maxTotalSpend, selected, amounts, mintAddress, quoteMint, launchPlatform]);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => () => {
    if (timedBuyArmedRef.current) stopRequestedRef.current = true;
    timedBuyArmedRef.current = false;
    marketTriggeredTimedBuysRef.current = false;
    sessionRef.current?.lock();
  }, []);

  useEffect(() => {
    try { setPresets(parseProjectSwapPresets(window.localStorage.getItem(SWAP_PRESETS_STORAGE_KEY))); }
    catch { setPresets([]); }
  }, []);

  useEffect(() => {
    if (!session) return;
    let inactivityTimer = 0;
    let hiddenTimer = 0;
    const lock = () => {
      if (timedBuyArmedRef.current) {
        stopRequestedRef.current = true;
        changeTimedBuyArmed(false);
        setRunStatus('paused');
        setTimedBuyAcknowledged(false);
      }
      marketTriggeredTimedBuysRef.current = false;
      session.lock();
      sessionRef.current = null;
      setSession(null);
      setPassphrase('');
      setMessage(t('La bóveda se bloqueó automáticamente.'));
    };
    const resetInactivity = () => {
      window.clearTimeout(inactivityTimer);
      inactivityTimer = window.setTimeout(lock, 5 * 60 * 1000);
    };
    const onVisibilityChange = () => {
      window.clearTimeout(hiddenTimer);
      if (document.hidden) {
        if (marketTriggeredTimedBuysRef.current && timedBuyArmedRef.current) {
          stopRequestedRef.current = true;
          changeTimedBuyArmed(false);
          setRunStatus('paused');
          setTimedBuyAcknowledged(false);
          marketTriggeredTimedBuysRef.current = false;
          setDelayUntil(null);
          setDelayRemaining(0);
          setMessage(t('La página se ocultó. Timed Buys no continuará con otra wallet; una transacción ya enviada sigue su curso.'));
        }
        hiddenTimer = window.setTimeout(lock, 60 * 1000);
      }
      else resetInactivity();
    };
    resetInactivity();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pointerdown', resetInactivity, { passive: true });
    window.addEventListener('keydown', resetInactivity);
    return () => {
      window.clearTimeout(inactivityTimer);
      window.clearTimeout(hiddenTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pointerdown', resetInactivity);
      window.removeEventListener('keydown', resetInactivity);
    };
  }, [session, t]);

  useEffect(() => {
    if (taskHydratedFor !== taskHydrationContext) return;
    if (!delayUntil) {
      setDelayRemaining(0);
      return;
    }
    const updateRemaining = () => {
      const remaining = Math.max(0, Math.ceil((delayUntil - Date.now()) / 1000));
      setDelayRemaining(remaining);
      if (remaining === 0) setDelayUntil(null);
    };
    updateRemaining();
    if (delayUntil <= Date.now()) return;
    const timer = window.setTimeout(() => {
      const remaining = Math.max(0, Math.ceil((delayUntil - Date.now()) / 1000));
      setDelayRemaining(remaining);
      if (remaining === 0) setDelayUntil(null);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [taskHydratedFor, taskHydrationContext, delayUntil, delayRemaining]);

  const handleUnlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setWorking(true);
    try {
      const nextSession = await unlockWalletVault(passphrase);
      sessionRef.current?.lock();
      sessionRef.current = nextSession;
      setSession(nextSession);
      setWallets(nextSession.wallets);
      setPassphrase('');
      setMessage(t('Bóveda desbloqueada solo en este navegador.'));
    } catch {
      setError(t('No se pudo desbloquear la bóveda. Revisa la contraseña e inténtalo de nuevo.'));
    } finally { setWorking(false); }
  };

  const toggleWallet = (address: string) => {
    changeTimedBuyArmed(false);
    setTimedBuyAcknowledged(false);
    stopRequestedRef.current = true;
    consecutiveErrorCountRef.current = 0;
    setConsecutiveErrorCount(0);
    setError('');
    setRunStatus('ready');
    setBatch([]);
    setDelayUntil(null);
    setDelayRemaining(0);
    setPrepareWhenMarketReady(false);
    if (selected.includes(address)) setSelected(selected.filter((item) => item !== address));
    else if (selected.length >= MAX_BATCH_WALLETS) setError(t('Puedes seleccionar hasta {count} wallets por secuencia.', { count: MAX_BATCH_WALLETS }));
    else setSelected([...selected, address]);
  };

  const reviewBatch = async () => {
    if (!session || working) return;
    changeTimedBuyArmed(false);
    setTimedBuyAcknowledged(false);
    stopRequestedRef.current = true;
    setError('');
    setMessage('');
    consecutiveErrorCountRef.current = 0;
    setConsecutiveErrorCount(0);
    setDelayUntil(null);
    setDelayRemaining(0);
    setBatch([]);
    if (!Number.isInteger(delayMinSeconds) || !Number.isInteger(delayMaxSeconds)
      || delayMinSeconds < 0 || delayMaxSeconds > MAX_TIMED_BUY_DELAY_SECONDS || delayMinSeconds > delayMaxSeconds) {
      setError(t('Elige un intervalo válido entre 0 y 30 segundos.'));
      return;
    }
    if (!Number.isInteger(maxConsecutiveErrors)
      || maxConsecutiveErrors < MIN_TIMED_BUY_CONSECUTIVE_ERRORS
      || maxConsecutiveErrors > MAX_TIMED_BUY_CONSECUTIVE_ERRORS) {
      setError(t('Elige un límite válido de 1 a 5 fallos consecutivos.'));
      return;
    }
    const selectedWallets = selected.map((address) => wallets.find((wallet) => wallet.address === address)).filter((wallet): wallet is VaultWallet => Boolean(wallet));
    if (!selectedWallets.length) { setError(t('Selecciona al menos una wallet del vault.')); return; }
    const decimals = side === 'buy' ? (quoteMint === SOL_MINT ? 9 : 6) : launchPlatform === 'PUMP_FUN' ? 6 : 9;
    if (selectedWallets.some((wallet) => !isValidAmount(amounts[wallet.address] ?? '', decimals))) {
      setError(t('Completa un importe válido para cada wallet seleccionada.'));
      return;
    }
    const budgetDecimals = quoteMint === SOL_MINT ? 9 : 6;
    if (side === 'buy') {
      if (!isValidAmount(maxTotalSpend, budgetDecimals)) {
        setError(t('Escribe un límite máximo de compra total válido.'));
        return;
      }
      if (sumSelectedAmounts(selectedWallets.map((wallet) => wallet.address), amounts, budgetDecimals)
        > parseDecimalRaw(maxTotalSpend.trim(), budgetDecimals)) {
        setError(t('El importe indicado supera el presupuesto máximo total.'));
        return;
      }
    }

    setWorking(true);
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error('La conexión RPC no está en Solana Devnet.');
      const rows = await Promise.all(selectedWallets.map(async (wallet) => {
        const amountIn = amounts[wallet.address].trim();
        if (side === 'sell') await ensureTokenBalance(connection, wallet.address, mintAddress, amountIn);
        const response = await fetch(`${API_URL}/api/swap/prepare-project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userWallet: wallet.address, mintAddress, side, amountIn, slippageBps }),
        });
        const data = await response.json();
        if (!response.ok || !data.success || !isProjectSwapQuote(data.quote) || typeof data.transaction !== 'string') throw new Error(data.error || t('No se pudo cotizar la wallet {wallet}.', { wallet: wallet.label || wallet.address.slice(0, 8) }));
        const quote = data.quote;
        const expectedInputMint = side === 'buy' ? quoteMint : mintAddress;
        const expectedOutputMint = side === 'buy' ? mintAddress : quoteMint;
        if (quote.side !== side || quote.quoteMint !== quoteMint || quote.slippageBps !== slippageBps
          || quote.quoteDecimals !== (quoteMint === SOL_MINT ? 9 : 6)
          || quote.inputMint !== expectedInputMint || quote.outputMint !== expectedOutputMint || !sameRawAmount(quote.amountIn, amountIn, decimals)) {
          throw new Error(t('La cotización de una wallet no coincide con el par o deslizamiento seleccionado.'));
        }
        if (side === 'buy' && quote.maximumAmountIn !== null && !isValidAmount(quote.maximumAmountIn, budgetDecimals)) {
          throw new Error(t('La cotización devolvió un límite de gasto no válido.'));
        }
        if (side === 'buy' && quoteMint !== SOL_MINT) {
          await ensureTokenBalance(connection, wallet.address, quoteMint, quote.maximumAmountIn ?? amountIn);
        }
        const previewTransaction = Transaction.from(Buffer.from(data.transaction, 'base64'));
        const walletKey = new PublicKey(wallet.address);
        const messageHash = await hashMessage(previewTransaction.compileMessage().serialize());
        if (!previewTransaction.feePayer?.equals(walletKey) || messageHash !== data.transactionMessageHash) {
          throw new Error(t('La transacción preparada no coincide con la revisión de {wallet}.', { wallet: wallet.label || wallet.address.slice(0, 8) }));
        }
        const requiredSigners = previewTransaction.compileMessage().accountKeys.slice(0, previewTransaction.compileMessage().header.numRequiredSignatures);
        if (requiredSigners.length !== 1 || !requiredSigners[0].equals(walletKey)) {
          throw new Error(t('La transacción requiere firmantes adicionales; Wire la detuvo por seguridad.'));
        }
        const fee = await connection.getFeeForMessage(previewTransaction.compileMessage(), 'confirmed');
        if (fee.value === null) throw new Error(t('No se pudo estimar la comisión de red de {wallet}.', { wallet: wallet.label || wallet.address.slice(0, 8) }));
        const balance = await connection.getBalance(new PublicKey(wallet.address), 'confirmed');
        const feeReserve = BigInt(fee.value) + 10_000_000n;
        if (BigInt(balance) < feeReserve) throw new Error(t('La wallet {wallet} necesita SOL para la comisión estimada y las cuentas.', { wallet: wallet.label || wallet.address.slice(0, 8) }));
        if (side === 'buy' && quoteMint === SOL_MINT && BigInt(balance) < parseSolLamports(quote.maximumAmountIn ?? amountIn) + feeReserve) {
          throw new Error(t('El saldo SOL de {wallet} no alcanza para el importe y una reserva de comisiones.', { wallet: wallet.label || wallet.address.slice(0, 8) }));
        }
        return { wallet, amountIn, quote, networkFeeLamports: String(fee.value), status: 'reviewed' as const };
      }));
      if (side === 'buy') {
        const maximumTotalRaw = rows.reduce((sum, row) => sum + parseDecimalRaw(row.quote.maximumAmountIn ?? row.amountIn, budgetDecimals), 0n);
        const limitRaw = parseDecimalRaw(maxTotalSpend.trim(), budgetDecimals);
        if (maximumTotalRaw > limitRaw) {
          throw new Error(t('La cotización combinada de {amount} {asset} supera el límite de {limit} {asset}.', {
            amount: formatDecimalRaw(maximumTotalRaw, budgetDecimals),
            limit: maxTotalSpend.trim(),
            asset: quoteMint === SOL_MINT ? 'SOL' : 'USDC',
          }));
        }
      }
      setBatch(rows);
      setRunStatus('ready');
      setMessage(t('Revisa cada wallet, el importe, el mínimo recibido y el impacto antes de iniciar la secuencia.'));
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : '';
      if (marketLaunchTriggerArmed) cancelMarketLaunchTrigger('No se pudo revisar la secuencia del disparador. Se canceló sin enviar compras.');
      setError(raw ? t(raw) : t('No se pudo preparar la revisión. Comprueba Devnet e inténtalo de nuevo.'));
    } finally { setWorking(false); }
  };

  const reviewBatchRef = useRef(reviewBatch);
  reviewBatchRef.current = reviewBatch;

  useEffect(() => {
    if (marketWatchStatus !== 'ready' || (!prepareWhenMarketReady && !marketLaunchTriggerArmed) || prepareReviewStartedRef.current) return;
    prepareReviewStartedRef.current = true;
    setPrepareWhenMarketReady(false);
    void reviewBatchRef.current();
  }, [marketWatchStatus, prepareWhenMarketReady, marketLaunchTriggerArmed]);

  const executeNextWallet = async () => {
    if (!session || working || !batch.length || batch.some((row) => row.blockedByBudget)) return;
    const nextIndex = batch.findIndex((row) => row.status === 'reviewed');
    if (nextIndex < 0 || batch.some((row) => row.status === 'pending') || delayRemaining > 0) return;
    stopRequestedRef.current = false;
    setStopRequested(false);
    setWorking(true);
    setError('');
    setMessage('');
    let sentThisWallet = false;
    let stoppedByUser = false;
    let stoppedForReview = false;
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error('La conexión RPC no está en Solana Devnet.');
      // A click authorizes only the named wallet. The next wallet needs a new click.
      for (let index = nextIndex; index <= nextIndex; index += 1) {
        const row = batch[index];
        if (row.status !== 'reviewed') break;
        if (stopRequestedRef.current) {
          stoppedByUser = true;
          setMessage(t('Operación detenida antes del envío.'));
          break;
        }
        activeWalletRef.current = row.wallet.address;
        if (side === 'sell') await ensureTokenBalance(connection, row.wallet.address, mintAddress, row.amountIn);
        setMessage(t('Preparando wallet {wallet} ({current}/{total})…', {
          wallet: row.wallet.label || row.wallet.address.slice(0, 8), current: index + 1, total: batch.length,
        }));
        const response = await fetch(`${API_URL}/api/swap/prepare-project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userWallet: row.wallet.address, mintAddress, side, amountIn: row.amountIn, slippageBps }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || t('No se pudo preparar la wallet {wallet}.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
        if (!isProjectSwapQuote(data.quote) || typeof data.transaction !== 'string' || typeof data.transactionMessageHash !== 'string'
          || !/^[a-f0-9]{64}$/.test(data.transactionMessageHash)
          || !Number.isSafeInteger(data.lastValidBlockHeight) || data.lastValidBlockHeight <= 0) {
          throw new Error(t('El servidor devolvió una transacción incompleta. Vuelve a revisar la secuencia.'));
        }
        const freshQuote = data.quote;
        if (side === 'buy' && freshQuote.maximumAmountIn !== null && !isValidAmount(freshQuote.maximumAmountIn, budgetDecimals)) {
          throw new Error(t('La cotización devolvió un límite de gasto no válido.'));
        }
        const expectedInputMint = side === 'buy' ? quoteMint : mintAddress;
        const expectedOutputMint = side === 'buy' ? mintAddress : quoteMint;
        const amountDecimals = side === 'buy' ? (quoteMint === SOL_MINT ? 9 : 6) : launchPlatform === 'PUMP_FUN' ? 6 : 9;
        if (freshQuote.side !== side || freshQuote.quoteMint !== quoteMint || freshQuote.slippageBps !== slippageBps
          || freshQuote.quoteDecimals !== (quoteMint === SOL_MINT ? 9 : 6)
          || freshQuote.inputMint !== expectedInputMint || freshQuote.outputMint !== expectedOutputMint
          || !sameRawAmount(freshQuote.amountIn, row.amountIn, amountDecimals)) {
          throw new Error(t('La cotización preparada no coincide con el par seleccionado.'));
        }
        if (side === 'buy' && quoteMint !== SOL_MINT) {
          await ensureTokenBalance(connection, row.wallet.address, quoteMint, freshQuote.maximumAmountIn ?? row.amountIn);
        }
        const tx = Transaction.from(Buffer.from(data.transaction, 'base64'));
        const walletKey = new PublicKey(row.wallet.address);
        const blockhash = tx.recentBlockhash;
        if (!tx.feePayer?.equals(walletKey) || !blockhash) throw new Error(t('La transacción preparada no corresponde a {wallet}.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
        const messageHash = await hashMessage(tx.compileMessage().serialize());
        if (messageHash !== data.transactionMessageHash) throw new Error(t('La transacción recibida no coincide con la preparada. No se firmará.'));
        const requiredSigners = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures);
        if (requiredSigners.length !== 1 || !requiredSigners[0].equals(walletKey)) {
          throw new Error(t('La transacción requiere firmantes adicionales; Wire la detuvo por seguridad.'));
        }
        if (!matchesReviewedQuote(row.quote, freshQuote)) {
          changeTimedBuyArmed(false);
          setTimedBuyAcknowledged(false);
          const refreshedFee = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
          if (refreshedFee.value === null) throw new Error(t('No se pudo estimar la comisión de red de {wallet}.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
          const updatedMaximumTotal = side === 'buy'
            ? sumMaximumSpend(batch, budgetDecimals, new Map([[row.wallet.address, freshQuote]]))
            : 0n;
          const exceedsBudget = side === 'buy' && updatedMaximumTotal > parseDecimalRaw(maxTotalSpend.trim(), budgetDecimals);
          setBatch((current) => current.map((item, rowIndex) => rowIndex === index ? {
            ...item,
            quote: freshQuote,
            networkFeeLamports: String(refreshedFee.value),
            status: 'reviewed',
            blockedByBudget: exceedsBudget,
            detail: exceedsBudget ? t('La cotización actual supera el presupuesto máximo total.') : undefined,
          } : item));
          if (exceedsBudget) {
          setMessage(t('La cotización de {wallet} llevaría el total a {amount} {asset}, por encima del límite de {limit} {asset}. Detuvimos Timed Buys; vuelve a revisar la secuencia antes de continuar.', {
              wallet: row.wallet.label || row.wallet.address.slice(0, 8),
              amount: formatDecimalRaw(updatedMaximumTotal, budgetDecimals),
              limit: maxTotalSpend.trim(),
              asset: quoteMint === SOL_MINT ? 'SOL' : 'USDC',
            }));
            stoppedForReview = true;
            break;
          }
          setMessage(t('El mercado cambió antes de firmar {wallet}. Timed Buys se detuvo; vuelve a revisar la secuencia con la cotización actualizada.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
          stoppedForReview = true;
          break;
        }
        if (stopRequestedRef.current) {
          stoppedByUser = true;
          setMessage(t('Operación detenida antes del envío.'));
          break;
        }

        setMessage(t('Firmando localmente con {wallet}…', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
        const signed = await session.signTransaction(row.wallet.address, tx);
        if (await hashMessage(signed.compileMessage().serialize()) !== messageHash) throw new Error(t('El mensaje cambió al firmar. No se enviará la transacción.'));
        if (stopRequestedRef.current) {
          stoppedByUser = true;
          setMessage(t('Operación detenida antes del envío.'));
          break;
        }

        const fee = await connection.getFeeForMessage(signed.compileMessage(), 'confirmed');
        const balance = await connection.getBalance(walletKey, 'confirmed');
        const maximumSolSpend = side === 'buy' && quoteMint === SOL_MINT
          ? parseSolLamports(freshQuote.maximumAmountIn ?? row.amountIn)
          : 0n;
        if (fee.value === null || BigInt(balance) < BigInt(fee.value) + 2_000_000n + maximumSolSpend) {
          throw new Error(t('El saldo de {wallet} no alcanza para la comisión de red.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
        }
        if (stopRequestedRef.current) {
          stoppedByUser = true;
          setMessage(t('Operación detenida antes del envío.'));
          break;
        }
        const walletSignature = signed.signatures.find((item) => item.publicKey.equals(walletKey))?.signature;
        if (!walletSignature) throw new Error(t('No se pudo preparar la firma local de {wallet}.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
        const signature = bs58.encode(walletSignature);
        const pendingBatch: BatchRow[] = batch.map((item, rowIndex) => rowIndex === index ? {
          ...item,
          status: 'pending' as const,
          signature,
          detail: t('Envío iniciado; verifica Explorer antes de volver a intentar esta wallet.'),
        } : item);
        try {
          if (taskHydratedFor !== taskHydrationContext) throw new Error('Storage context is not ready.');
          window.localStorage.setItem(taskStorageKey, serializeProjectWalletSwapTask({
            runStatus: 'running',
            side,
            slippageBps,
            delayMinSeconds,
            delayMaxSeconds,
            maxConsecutiveErrors,
            delayUntil,
            maxTotalSpend,
            selected,
            amounts,
            rows: pendingBatch,
          }, { mintAddress, quoteMint, launchPlatform }));
          setTaskPersistenceWarning(false);
        } catch {
          setTaskPersistenceWarning(true);
          throw new Error(t('No se pudo guardar el estado local antes del envío. No se envió la transacción.'));
        }
        setBatch(pendingBatch);
        setMessage(t('Enviando la transacción de {wallet} a Devnet…', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
        const sentSignature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
        if (sentSignature !== signature) throw new Error(t('La firma enviada no coincide con la firma local. Revisa Explorer antes de continuar.'));
        const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight: data.lastValidBlockHeight }, 'confirmed');
        if (confirmation.value.err) {
          setBatch((current) => current.map((item, rowIndex) => rowIndex === index ? {
            ...item,
            status: 'failed',
            signature,
            detail: t('Fallo confirmado en Devnet. Esta wallet no se reintentó automáticamente.'),
          } : item));
          if (timedBuyArmedRef.current) {
            const nextConsecutiveFailures = consecutiveErrorCountRef.current + 1;
            consecutiveErrorCountRef.current = nextConsecutiveFailures;
            setConsecutiveErrorCount(nextConsecutiveFailures);
            const hasNextReviewedWallet = batch.slice(index + 1).some((item) => item.status === 'reviewed');
            if (canContinueTimedBuyAfterFailure(nextConsecutiveFailures, maxConsecutiveErrors, hasNextReviewedWallet)) {
              const delaySeconds = chooseDelayForNextWallet();
              if (delaySeconds > 0) {
                setDelayUntil(Date.now() + delaySeconds * 1000);
                setDelayRemaining(delaySeconds);
              } else {
                setDelayUntil(null);
                setDelayRemaining(0);
              }
              setMessage(t('La wallet {wallet} falló con resultado confirmado. Se omitió; la secuencia sigue con la siguiente y se detendrá al llegar a {count} fallos consecutivos.', {
                wallet: row.wallet.label || row.wallet.address.slice(0, 8), count: maxConsecutiveErrors,
              }));
              break;
            }
            if (nextConsecutiveFailures >= maxConsecutiveErrors) {
              throw new Error(t('Timed Buys se detuvo tras {count} fallos consecutivos confirmados.', { count: maxConsecutiveErrors }));
            }
            break;
          }
          throw new Error(t('La transacción de {wallet} falló. Se detuvo la secuencia.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
        }
        let historyPending = false;
        try {
          const recordResponse = await fetch(`${API_URL}/api/swap/record-project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userWallet: row.wallet.address, mintAddress, side, signature }),
          });
          const recordData = await recordResponse.json();
          historyPending = !recordResponse.ok || !recordData.success || recordData.recorded !== true;
        } catch { historyPending = true; }
        setBatch((current) => current.map((item, rowIndex) => rowIndex === index ? {
          ...item,
          status: 'confirmed',
          signature,
          historyPending,
          detail: historyPending ? t('Confirmada; el registro del historial sigue pendiente.') : t('Confirmada y verificada en Devnet.'),
        } : item));
        if (timedBuyArmedRef.current) {
          consecutiveErrorCountRef.current = 0;
          setConsecutiveErrorCount(0);
        }
        window.dispatchEvent(new Event('wire:wallet-history-updated'));
        sentThisWallet = true;
        const hasNextWallet = batch.slice(index + 1).some((item) => item.status === 'reviewed');
        if (hasNextWallet && side === 'buy' && !stopRequestedRef.current) {
          const delaySeconds = chooseDelayForNextWallet();
          if (delaySeconds > 0) {
            setDelayUntil(Date.now() + delaySeconds * 1000);
            setDelayRemaining(delaySeconds);
          } else {
            setDelayUntil(null);
            setDelayRemaining(0);
          }
        }
      }
      if (session.isLocked) throw new Error(t('La bóveda se bloqueó durante la secuencia. Desbloquéala y revisa el estado antes de continuar.'));
      if (!stoppedByUser && !stoppedForReview && sentThisWallet) {
        const hasNextWallet = batch.some((row, index) => index > nextIndex && row.status === 'reviewed');
        setMessage(t(hasNextWallet
          ? 'Operación confirmada. Revisa la siguiente wallet antes de aprobarla.'
          : 'Todas las operaciones revisadas terminaron. Comprueba el estado antes de preparar otra secuencia.'));
      }
    } catch (caught) {
      changeTimedBuyArmed(false);
      setRunStatus('failed');
      marketTriggeredTimedBuysRef.current = false;
      setTimedBuyAcknowledged(false);
      const raw = caught instanceof Error ? caught.message : '';
      setError(raw ? t(raw) : t('No se pudo completar la secuencia. Comprueba Explorer antes de reintentar.'));
      const activeAddress = activeWalletRef.current;
      if (activeAddress) setBatch((current) => current.map((row) => row.wallet.address === activeAddress && row.status === 'reviewed'
        ? { ...row, status: 'failed', detail: raw ? t(raw) : t('La secuencia se detuvo en esta wallet.') }
        : row));
    } finally {
      activeWalletRef.current = null;
      setStopRequested(false);
      setWorking(false);
      if (timedBuyRunInFlightRef.current) setTimedBuyRunNonce((value) => value + 1);
    }
  };

  useEffect(() => {
    if (!timedBuyArmed) return;
    if (!session || session.isLocked) {
      changeTimedBuyArmed(false);
      setRunStatus('paused');
      marketTriggeredTimedBuysRef.current = false;
      setTimedBuyAcknowledged(false);
      stopRequestedRef.current = true;
      setMessage(t('La secuencia Timed Buys se detuvo porque la bóveda ya no está desbloqueada.'));
      return;
    }
    if (working || delayRemaining > 0 || timedBuyRunInFlightRef.current) return;
    const unresolvedFailure = batch.some((row) => row.status === 'failed' && !row.signature);
    if (batch.some((row) => row.status === 'pending' || row.blockedByBudget) || unresolvedFailure
      || consecutiveErrorCount >= maxConsecutiveErrors) {
      changeTimedBuyArmed(false);
      setRunStatus(unresolvedFailure ? 'failed' : 'paused');
      marketTriggeredTimedBuysRef.current = false;
      setTimedBuyAcknowledged(false);
      setMessage(t('Timed Buys se detuvo. Verifica la firma o revisa de nuevo las wallets antes de continuar.'));
      return;
    }
    if (!batch.some((row) => row.status === 'reviewed')) {
      changeTimedBuyArmed(false);
      setRunStatus(batch.some((row) => row.status === 'failed') ? 'failed' : 'completed');
      marketTriggeredTimedBuysRef.current = false;
      setTimedBuyAcknowledged(false);
      setMessage(t(batch.some((row) => row.status === 'failed')
        ? 'Timed Buys terminó con wallets fallidas. Revisa la firma y re-cotiza cada wallet antes de aprobar un posible reintento.'
        : 'Timed Buys terminó. Todas las compras revisadas ya están confirmadas o canceladas.'));
      return;
    }
    timedBuyRunInFlightRef.current = true;
    void executeNextWallet().finally(() => { timedBuyRunInFlightRef.current = false; });
  }, [timedBuyArmed, session, working, delayRemaining, batch, consecutiveErrorCount, maxConsecutiveErrors, timedBuyRunNonce, t]);

  const startTimedBuys = useCallback((fromMarketLaunchTrigger = false) => {
    const authorized = fromMarketLaunchTrigger
      ? marketLaunchTriggerArmed && marketLaunchTriggerPlanAuthorized
      : timedBuyAcknowledged;
    if (side !== 'buy' || !session || session.isLocked || working || !authorized
      || !batch.some((row) => row.status === 'reviewed')
      || batch.some((row) => row.status === 'pending' || row.blockedByBudget || (row.status === 'failed' && !row.signature))) return false;
    stopRequestedRef.current = false;
    setStopRequested(false);
    setError('');
    setRunStatus('running');
    consecutiveErrorCountRef.current = 0;
    setConsecutiveErrorCount(0);
    if (fromMarketLaunchTrigger) cancelMarketLaunchTrigger();
    marketTriggeredTimedBuysRef.current = fromMarketLaunchTrigger;
    setMessage(t(fromMarketLaunchTrigger
      ? 'El mercado apareció y la secuencia autorizada inició en Devnet.'
      : 'Timed Buys iniciado en Devnet. Wire procesará solo esta secuencia revisada mientras la bóveda siga desbloqueada.'));
    timedBuyArmedRef.current = true;
    setTimedBuyArmed(true);
    return true;
  }, [side, session, working, marketLaunchTriggerArmed, marketLaunchTriggerPlanAuthorized, timedBuyAcknowledged, batch, maxConsecutiveErrors, cancelMarketLaunchTrigger, t]);

  useEffect(() => {
    if (!marketLaunchTriggerArmed || working || batch.length === 0) return;
    if (isMarketLaunchTriggerExpired(marketLaunchTriggerExpiresAt, Date.now())) {
      cancelMarketLaunchTrigger('El disparador venció antes de completar la revisión. No se enviaron compras.');
      return;
    }
    const exactWalletSetReviewed = batch.length === selected.length
      && batch.every((row) => selected.includes(row.wallet.address) && row.status === 'reviewed' && !row.blockedByBudget);
    if (!exactWalletSetReviewed) {
      cancelMarketLaunchTrigger('La revisión no coincide con la lista autorizada. No se enviaron compras; revisa la secuencia manualmente.');
      return;
    }
    if (!isMarketLaunchFeeReserveWithinCap(batch.map((row) => row.networkFeeLamports))) {
      cancelMarketLaunchTrigger('La comisión y reserva de cuentas exceden 0.02 SOL por wallet. No se enviaron compras; revisa la secuencia manualmente.');
      return;
    }
    if (!startTimedBuys(true)) {
      cancelMarketLaunchTrigger('No se pudo iniciar la secuencia autorizada. No se enviaron compras.');
    }
  }, [marketLaunchTriggerArmed, marketLaunchTriggerExpiresAt, working, batch, selected, startTimedBuys, cancelMarketLaunchTrigger]);

  const stopTimedBuys = () => {
    if (timedBuyArmed) setRunStatus('paused');
    stopRequestedRef.current = true;
    setStopRequested(true);
    changeTimedBuyArmed(false);
    marketTriggeredTimedBuysRef.current = false;
    setTimedBuyAcknowledged(false);
    setDelayUntil(null);
    setDelayRemaining(0);
    setMessage(t(working
      ? 'Se detendrán las compras futuras después de resolver la operación actual. Una transacción enviada no se puede cancelar.'
      : 'Timed Buys detenido. No se enviarán más compras.'));
  };

  const reQuoteFailedWallet = async (row: BatchRow) => {
    if (!session || working || !canReQuoteFailedProjectSwap(row.status, batch.some((item) => item.status === 'pending'))) return;
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error('La conexión RPC no está en Solana Devnet.');
      if (side === 'sell') await ensureTokenBalance(connection, row.wallet.address, mintAddress, row.amountIn);
      const response = await fetch(`${API_URL}/api/swap/prepare-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userWallet: row.wallet.address, mintAddress, side, amountIn: row.amountIn, slippageBps }),
      });
      const data = await response.json();
      if (!response.ok || !data.success || !isProjectSwapQuote(data.quote) || typeof data.transaction !== 'string'
        || typeof data.transactionMessageHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.transactionMessageHash)
        || !Number.isSafeInteger(data.lastValidBlockHeight) || data.lastValidBlockHeight <= 0) {
        throw new Error(data.error || t('No se pudo preparar la nueva cotización de {wallet}.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
      }

      const quote = data.quote;
      const budgetDecimals = quoteMint === SOL_MINT ? 9 : 6;
      if (side === 'buy' && quote.maximumAmountIn !== null && !isValidAmount(quote.maximumAmountIn, budgetDecimals)) {
        throw new Error(t('La cotización devolvió un límite de gasto no válido.'));
      }
      const expectedInputMint = side === 'buy' ? quoteMint : mintAddress;
      const expectedOutputMint = side === 'buy' ? mintAddress : quoteMint;
      const amountDecimals = side === 'buy' ? (quoteMint === SOL_MINT ? 9 : 6) : launchPlatform === 'PUMP_FUN' ? 6 : 9;
      if (quote.side !== side || quote.quoteMint !== quoteMint || quote.slippageBps !== slippageBps
        || quote.quoteDecimals !== (quoteMint === SOL_MINT ? 9 : 6)
        || quote.inputMint !== expectedInputMint || quote.outputMint !== expectedOutputMint
        || !sameRawAmount(quote.amountIn, row.amountIn, amountDecimals)) {
        throw new Error(t('La nueva cotización de {wallet} no coincide con el par y el importe revisados.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
      }
      if (side === 'buy' && quoteMint !== SOL_MINT) {
        await ensureTokenBalance(connection, row.wallet.address, quoteMint, quote.maximumAmountIn ?? row.amountIn);
      }

      const tx = Transaction.from(Buffer.from(data.transaction, 'base64'));
      const walletKey = new PublicKey(row.wallet.address);
      const messageHash = await hashMessage(tx.compileMessage().serialize());
      if (!tx.feePayer?.equals(walletKey) || messageHash !== data.transactionMessageHash) {
        throw new Error(t('La transacción re-preparada no coincide con la wallet {wallet}.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
      }
      const requiredSigners = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures);
      if (requiredSigners.length !== 1 || !requiredSigners[0].equals(walletKey)) {
        throw new Error(t('La transacción requiere firmantes adicionales; Wire la detuvo por seguridad.'));
      }
      const fee = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
      if (fee.value === null) throw new Error(t('No se pudo estimar la comisión de red de {wallet}.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
      const balance = await connection.getBalance(walletKey, 'confirmed');
      const feeReserve = BigInt(fee.value) + 10_000_000n;
      if (BigInt(balance) < feeReserve || (side === 'buy' && quoteMint === SOL_MINT && BigInt(balance) < parseSolLamports(quote.maximumAmountIn ?? row.amountIn) + feeReserve)) {
        throw new Error(t('El saldo de {wallet} no alcanza para el importe y las comisiones estimadas.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) }));
      }
      const updatedMaximumTotal = side === 'buy'
        ? sumMaximumSpend(batch, budgetDecimals, new Map([[row.wallet.address, quote]]))
        : 0n;
      const exceedsBudget = side === 'buy' && updatedMaximumTotal > parseDecimalRaw(maxTotalSpend.trim(), budgetDecimals);

      setBatch((current) => current.map((item) => {
        if (item.wallet.address !== row.wallet.address) return item;
        const { signature: failedSignature, ...withoutCurrentSignature } = item;
        const previousSignature = failedSignature ?? item.previousSignature;
        return {
          ...withoutCurrentSignature,
          ...(previousSignature ? { previousSignature } : {}),
          quote,
          networkFeeLamports: String(fee.value),
          status: 'reviewed',
          blockedByBudget: exceedsBudget,
          detail: exceedsBudget ? t('La cotización actual supera el presupuesto máximo total.') : undefined,
        };
      }));
      setMessage(exceedsBudget
        ? t('La re-cotización de {wallet} supera el límite máximo total. Restablece la revisión y ajusta los importes o el presupuesto.', { wallet: row.wallet.label || row.wallet.address.slice(0, 8) })
        : t('Wallet re-cotizada. Revisa el importe, el mercado y las comisiones antes de aprobar el reintento.'));
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : '';
      setError(raw ? t(raw) : t('No se pudo preparar la nueva cotización. Inténtalo de nuevo.'));
    } finally {
      setWorking(false);
    }
  };

  const retryHistoryRecord = async (row: BatchRow) => {
    if (!row.signature || working) return;
    setWorking(true);
    setError('');
    try {
      const response = await fetch(`${API_URL}/api/swap/record-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userWallet: row.wallet.address, mintAddress, side, signature: row.signature }),
      });
      const data = await response.json();
      if (!response.ok || !data.success || data.recorded !== true) throw new Error(data.error || t('Solana todavía no ha completado el registro del historial.'));
      setBatch((current) => current.map((item) => item.wallet.address === row.wallet.address ? { ...item, historyPending: false, detail: t('Confirmada y verificada en Devnet.') } : item));
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : '';
      setError(raw ? t(raw) : t('El historial sigue pendiente. Inténtalo de nuevo más tarde.'));
    } finally { setWorking(false); }
  };

  const verifyPendingSignature = async (row: BatchRow) => {
    if (!row.signature || row.status !== 'pending' || working) return;
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const response = await connection.getSignatureStatuses([row.signature], { searchTransactionHistory: true });
      const status = response.value[0];
      if (!status) {
        setMessage(t('No se encontró confirmación para esta firma en Devnet. Wire no la reenviará; consulta Explorer y vuelve a verificar más tarde.'));
        return;
      }
      if (status.err) {
        setBatch((current) => current.map((item) => item.wallet.address === row.wallet.address ? {
          ...item,
          status: 'failed',
          detail: t('Solana marcó la transacción como fallida.'),
        } : item));
        setMessage(t('La transacción falló en Devnet. Revisa la firma antes de preparar otra operación.'));
        return;
      }
      const confirmed = status.confirmationStatus === 'confirmed'
        || status.confirmationStatus === 'finalized'
        || status.confirmations === null
        || (status.confirmations ?? 0) > 0;
      if (!confirmed) {
        setMessage(t('La firma aún no tiene confirmación en Devnet. Wire no la reenviará; vuelve a verificar más tarde.'));
        return;
      }

      let historyPending = false;
      try {
        const recordResponse = await fetch(`${API_URL}/api/swap/record-project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userWallet: row.wallet.address, mintAddress, side, signature: row.signature }),
        });
        const recordData = await recordResponse.json();
        historyPending = !recordResponse.ok || !recordData.success || recordData.recorded !== true;
      } catch { historyPending = true; }
      setBatch((current) => current.map((item) => item.wallet.address === row.wallet.address ? {
        ...item,
        status: 'confirmed',
        historyPending,
        detail: historyPending ? t('Confirmada; el registro del historial sigue pendiente.') : t('Confirmada y verificada en Devnet.'),
      } : item));
      window.dispatchEvent(new Event('wire:wallet-history-updated'));
      if (side === 'buy' && batch.some((item) => item.wallet.address !== row.wallet.address && item.status === 'reviewed')) {
        const delaySeconds = chooseDelayForNextWallet();
        setDelayUntil(delaySeconds ? Date.now() + delaySeconds * 1000 : null);
        setDelayRemaining(delaySeconds);
      }
      setMessage(t(historyPending ? 'Swap confirmado; el historial sigue pendiente.' : 'Swap confirmado y guardado en el historial.'));
    } catch {
      setError(t('No se pudo consultar la firma en Devnet. Inténtalo más tarde.'));
    } finally { setWorking(false); }
  };

  const resetBatch = () => {
    changeTimedBuyArmed(false);
    setTimedBuyAcknowledged(false);
    stopRequestedRef.current = true;
    if (batch.some((row) => row.status === 'pending')) {
      setError(t('Hay una transacción sin estado final. Verifica su firma en Explorer antes de borrar esta revisión.'));
      return;
    }
    if (batch.some((row) => row.status === 'confirmed')
      && !window.confirm(t('Ya se confirmaron operaciones de esta secuencia. ¿Quieres cerrar su revisión y preparar otra?'))) return;
    setBatch([]);
    setError('');
    setMessage('');
    setDelayUntil(null);
    setDelayRemaining(0);
  };

  const cancelUnsentWallets = () => {
    if (working) return;
    const unsentCount = batch.filter((row) => row.status === 'reviewed').length;
    if (!unsentCount) return;
    if (taskHydratedFor !== taskHydrationContext) {
      setError(t('No se puede confirmar el estado de la secuencia en el navegador. No se cancelaron las revisiones.'));
      return;
    }
    const cancelledRows = batch.map((row) => row.status === 'reviewed'
      ? { ...row, status: 'cancelled' as const, detail: 'Cancelada antes de firmar. No se envió ninguna transacción.' }
      : row);
    try {
      window.localStorage.setItem(taskStorageKey, serializeProjectWalletSwapTask({
        runStatus: 'stopped',
        side,
        slippageBps,
        delayMinSeconds,
        delayMaxSeconds,
        maxConsecutiveErrors,
        delayUntil: null,
        maxTotalSpend,
        selected,
        amounts,
        rows: cancelledRows,
      }, { mintAddress, quoteMint, launchPlatform }));
      setTaskPersistenceWarning(false);
    } catch {
      setError(t('No se pudo guardar la cancelación. Las revisiones siguen activas; inténtalo de nuevo antes de salir.'));
      return;
    }
    setRunStatus('stopped');
    setBatch(cancelledRows);
    setDelayUntil(null);
    setDelayRemaining(0);
    setError('');
    const hasPendingSignature = cancelledRows.some((row) => row.status === 'pending');
    setMessage(t(hasPendingSignature
      ? 'Se cancelaron {count} wallets sin enviar. Las operaciones con firma se conservan para verificación y no pueden retirarse de Solana.'
      : 'Se cancelaron {count} wallets sin enviar. No se creó ninguna firma nueva.', { count: unsentCount }));
  };

  const toggleLock = () => {
    changeTimedBuyArmed(false);
    setTimedBuyAcknowledged(false);
    stopRequestedRef.current = true;
    setPrepareWhenMarketReady(false);
    session?.lock();
    sessionRef.current = null;
    setSession(null);
    setPassphrase('');
    setMessage(t('Bóveda bloqueada.'));
  };

  const savePreset = () => {
    if (!session || !presetName.trim() || selected.length === 0 || selected.length > MAX_BATCH_WALLETS) {
      setError(t('Escribe un nombre y selecciona al menos una wallet para guardar el preset.'));
      return;
    }
    const decimals = side === 'buy' ? (quoteMint === SOL_MINT ? 9 : 6) : launchPlatform === 'PUMP_FUN' ? 6 : 9;
    if (selected.some((address) => !isValidAmount(amounts[address] ?? '', decimals))) {
      setError(t('Completa un importe válido para cada wallet seleccionada.'));
      return;
    }
    const budgetDecimals = quoteMint === SOL_MINT ? 9 : 6;
    if (side === 'buy' && !isValidAmount(maxTotalSpend, budgetDecimals)) {
      setError(t('Escribe un límite máximo de compra total válido.'));
      return;
    }
    if (side === 'buy' && sumSelectedAmounts(selected, amounts, budgetDecimals) > parseDecimalRaw(maxTotalSpend.trim(), budgetDecimals)) {
      setError(t('El importe indicado supera el presupuesto máximo total.'));
      return;
    }
    const normalizedName = presetName.trim().slice(0, 40);
    const existing = presets.find((preset) => preset.mintAddress === mintAddress && preset.quoteMint === quoteMint && preset.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
    const preset: ProjectSwapPreset = {
      id: existing?.id ?? window.crypto.randomUUID(),
      name: normalizedName,
      mintAddress,
      quoteMint,
      side,
      slippageBps,
      delayMinSeconds: side === 'buy' ? delayMinSeconds : 0,
      delayMaxSeconds: side === 'buy' ? delayMaxSeconds : 0,
      maxConsecutiveErrors: side === 'buy' ? maxConsecutiveErrors : DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS,
      walletAddresses: [...selected],
      amounts: Object.fromEntries(selected.map((address) => [address, amounts[address].trim()])),
      ...(side === 'buy' ? { maxTotalSpend: maxTotalSpend.trim() } : {}),
      updatedAt: Date.now(),
    };
    const next = [...presets.filter((item) => item.id !== preset.id), preset].slice(-MAX_SAVED_PRESETS);
    try {
      window.localStorage.setItem(SWAP_PRESETS_STORAGE_KEY, JSON.stringify(next));
      setPresets(next);
      setSelectedPresetId(preset.id);
      setPresetName(normalizedName);
      setError('');
      setMessage(t('Preset guardado en este navegador. Conserva las claves cifradas en la bóveda.'));
    } catch {
      setError(t('No se pudo guardar el preset en el almacenamiento de este navegador.'));
    }
  };

  const loadPreset = () => {
    const preset = presets.find((item) => item.id === selectedPresetId);
    if (!preset) return;
    const available = new Set(wallets.map((wallet) => wallet.address));
    if (preset.walletAddresses.some((address) => !available.has(address))) {
      setError(t('El preset tiene wallets que ya no están en la bóveda. Revisa la selección antes de continuar.'));
      return;
    }
    setSelected(preset.walletAddresses);
    setAmounts(preset.amounts);
    setSide(preset.side);
    setSlippageBps(preset.slippageBps);
    setDelayMinSeconds(preset.delayMinSeconds);
    setDelayMaxSeconds(preset.delayMaxSeconds);
    setMaxConsecutiveErrors(preset.maxConsecutiveErrors);
    changeTimedBuyArmed(false);
    setTimedBuyAcknowledged(false);
    const budgetDecimals = quoteMint === SOL_MINT ? 9 : 6;
    const legacyBudgetIsValid = preset.walletAddresses.every((address) => isValidAmount(preset.amounts[address] ?? '', budgetDecimals));
    const legacyBudget = legacyBudgetIsValid
      ? formatDecimalRaw(sumSelectedAmounts(preset.walletAddresses, preset.amounts, budgetDecimals), budgetDecimals)
      : '';
    setMaxTotalSpend(preset.side === 'buy'
      ? preset.maxTotalSpend && isValidAmount(preset.maxTotalSpend, budgetDecimals) ? preset.maxTotalSpend : legacyBudget
      : '');
    setPresetName(preset.name);
    setError('');
    setMessage(t('Preset cargado. Revisa cada wallet y cotiza antes de operar.'));
  };

  const deletePreset = () => {
    const next = presets.filter((preset) => preset.id !== selectedPresetId);
    try {
      window.localStorage.setItem(SWAP_PRESETS_STORAGE_KEY, JSON.stringify(next));
      setPresets(next);
      setSelectedPresetId('');
      setPresetName('');
      setError('');
      setMessage(t('Preset eliminado de este navegador.'));
    } catch { setError(t('No se pudo actualizar el almacenamiento de presets.')); }
  };

  const activeBatch = batch.filter((row) => row.status !== 'cancelled');
  const batchTotals = activeBatch.length ? {
    amountIn: formatDecimalRaw(activeBatch.reduce((sum, row) => sum + parseDecimalRaw(row.amountIn, 18), 0n), 18),
    maximumIn: formatDecimalRaw(sumMaximumSpend(activeBatch, 18), 18),
    minimumOut: formatDecimalRaw(activeBatch.reduce((sum, row) => sum + parseDecimalRaw(row.quote.minimumAmountOut, 18), 0n), 18),
    poolFee: formatDecimalRaw(activeBatch.reduce((sum, row) => sum + parseDecimalRaw(row.quote.estimatedPoolFee, 18), 0n), 18),
    networkFeeLamports: activeBatch.reduce((sum, row) => sum + BigInt(row.networkFeeLamports), 0n),
  } : null;
  const activeVenue = activeBatch[0]?.quote.venue ?? (launchPlatform === 'PUMP_FUN' ? 'PUMP_FUN' : 'RAYDIUM');
  const nextWalletToApprove = batch.find((row) => row.status === 'reviewed');
  const pendingWallet = batch.find((row) => row.status === 'pending');
  const marketFeeLabel = activeVenue === 'PUMP_SWAP'
    ? 'Fees totales estimados de PumpSwap'
    : activeVenue === 'PUMP_FUN' ? 'Fees totales estimados de Pump.fun' : 'Fee total estimado del pool';
  const operationFeeLabel = activeVenue === 'PUMP_SWAP'
    ? 'Fees estimados de PumpSwap'
    : activeVenue === 'PUMP_FUN' ? 'Fees estimados de Pump.fun' : 'Fee estimado del pool';
  const marketWatchVenue = marketWatchQuote?.venue === 'PUMP_FUN'
    ? t('Pump.fun · bonding curve')
    : marketWatchQuote?.venue === 'PUMP_SWAP'
      ? t('PumpSwap')
      : marketWatchQuote?.venue === 'RAYDIUM'
        ? t('Raydium CPMM')
        : '';
  const marketChangedHelp = 'Son estimaciones con la cotización actual. Cada wallet requiere una aprobación nueva; si cambia el mercado, revisa la cotización actualizada antes de aprobar.';
  const budgetDecimals = quoteMint === SOL_MINT ? 9 : 6;
  const selectedBuyTotalRaw = side === 'buy' ? sumSelectedAmounts(selected, amounts, budgetDecimals) : 0n;
  const selectedBuyAmountsValid = selected.length > 0 && selected.every((address) => isValidAmount(amounts[address] ?? '', budgetDecimals));
  const buyBudgetInvalid = side === 'buy' && !isValidAmount(maxTotalSpend, budgetDecimals);
  const selectedBuyTotalExceedsBudget = side === 'buy' && !buyBudgetInvalid
    && selectedBuyTotalRaw > parseDecimalRaw(maxTotalSpend.trim(), budgetDecimals);
  const selectedAmountDecimals = side === 'buy' ? budgetDecimals : launchPlatform === 'PUMP_FUN' ? 6 : 9;
  const selectedBatchAmountsValid = selected.length > 0
    && selected.every((address) => isValidAmount(amounts[address] ?? '', selectedAmountDecimals));
  const autoPrepareAllowed = Boolean(session && selectedBatchAmountsValid
    && !(side === 'buy' && (buyBudgetInvalid || selectedBuyTotalExceedsBudget))
    && !working && batch.length === 0);
  const marketLaunchTriggerAllowed = autoPrepareAllowed
    && Number.isInteger(delayMinSeconds) && Number.isInteger(delayMaxSeconds)
    && delayMinSeconds >= 0 && delayMaxSeconds <= MAX_TIMED_BUY_DELAY_SECONDS && delayMinSeconds <= delayMaxSeconds;
  const marketLaunchFeeReserveSol = formatDecimalRaw(
    BigInt(selected.length) * MARKET_LAUNCH_FEE_RESERVE_PER_WALLET_LAMPORTS,
    9,
  );

  return (
    <details ref={launchPanelRef} className="wire-panel mt-4 rounded-2xl p-5 sm:p-6">
      <summary className="cursor-pointer list-none font-display text-lg font-semibold marker:hidden">{t('Operar con wallets de proyecto')}</summary>
      <div className="mt-3 grid gap-4">
        <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Cada clic aprueba solo la operación de una wallet identificada abajo. Las demás esperan una aprobación nueva. Las transacciones son independientes y no atómicas; las compras propias no representan demanda de terceros ni garantizan volumen o precio.')}</p>
        <p className="text-xs leading-relaxed text-[var(--muted)]">{t('La revisión se conserva en este navegador. Las claves privadas nunca se guardan con la secuencia.')}</p>
        {side === 'buy' && (
          <div className="border-t border-[var(--line)] pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-2xl">
                <h3 className="text-sm font-semibold">{t('Vigilar disponibilidad del mercado')}</h3>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                  {t('Wire consulta una cotización de referencia de {amount} {asset} en Devnet cada 30 segundos mientras esta sección está abierta. No compra ni firma. Cuando haya cotización, puedes preparar la secuencia y revisar cada wallet manualmente.', {
                    amount: marketWatchAmountIn,
                    asset: quoteMint === SOL_MINT ? 'SOL' : 'USDC',
                  })}
                </p>
                <label className="mt-3 flex max-w-2xl items-start gap-2 text-xs leading-relaxed text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={prepareWhenMarketReady}
                    onChange={(event) => {
                      if (event.target.checked && !autoPrepareAllowed) {
                        setError(t('Desbloquea el vault, selecciona wallets y completa los importes y el presupuesto antes de activar esta opción.'));
                        return;
                      }
                      if (event.target.checked) prepareReviewStartedRef.current = false;
                      setError('');
                      setPrepareWhenMarketReady(event.target.checked);
                    }}
                    disabled={working || batch.length > 0 || marketLaunchTriggerArmed}
                    className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block font-medium">{t('Preparar la revisión cuando aparezca el mercado')}</span>
                    <span className="mt-0.5 block text-[var(--muted)]">{t('Wire volverá a cotizar cada wallet y mostrará el resumen. No firmará ni enviará; tendrás que revisar y aprobar cada wallet.')}</span>
                  </span>
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {marketWatchStatus === 'watching' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setMarketWatchRefresh((value) => value + 1)}
                      disabled={marketWatchLoading}
                      className="wire-button wire-button-secondary min-h-11 px-3 text-xs disabled:opacity-60"
                    >
                      <RefreshCw size={14} aria-hidden="true" className={marketWatchLoading ? 'animate-spin' : ''} />
                      {t('Comprobar ahora')}
                    </button>
                    <button
                      type="button"
                      onClick={() => marketLaunchTriggerArmed
                        ? cancelMarketLaunchTrigger('Disparador de compra cancelado. No se enviaron compras.')
                        : (setMarketWatchStatus('idle'), setMarketWatchQuote(null), setMarketWatchError(''), setMarketWatchNote(''), setPrepareWhenMarketReady(false))}
                      className="wire-button wire-button-quiet min-h-11 px-3 text-xs"
                    >
                      {t(marketLaunchTriggerArmed ? 'Cancelar disparador' : 'Detener vigilancia')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setMarketWatchError('');
                      setMarketWatchNote('');
                      setMarketWatchQuote(null);
                      setMarketWatchStatus('watching');
                    }}
                    disabled={working || batch.length > 0 || marketLaunchTriggerArmed}
                    className="wire-button wire-button-secondary min-h-11 px-3 text-xs disabled:opacity-60"
                  >
                    {marketWatchStatus === 'ready' ? t('Vigilar otra vez') : t('Vigilar mercado')}
                  </button>
                )}
              </div>
            </div>
            {marketWatchStatus === 'watching' ? (
              <p className="mt-2 text-xs text-[var(--muted)]" role="status">
                {marketWatchLoading
                  ? t('Consultando el mercado…')
                  : marketWatchNote || t('Esperando una cotización de compra válida en Devnet…')}
              </p>
            ) : null}
            {marketWatchStatus === 'ready' && marketWatchQuote ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3 text-xs" role="status">
                <div>
                  <p className="font-semibold text-[var(--success)]">{t('Mercado disponible. La cotización no reserva precio; prepara la secuencia y revisa cada firma.')}</p>
                  <p className="mt-1 font-mono text-[var(--muted)]">
                    {marketWatchQuote.amountIn} {marketWatchQuote.inputSymbol} → {marketWatchQuote.amountOut} {marketWatchQuote.outputSymbol} · {marketWatchVenue}
                  </p>
                </div>
                <a
                  href={`https://explorer.solana.com/address/${encodeURIComponent(marketWatchQuote.poolAddress)}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                  className="wire-button wire-button-quiet min-h-11 px-2 text-xs"
                >
                  {t('Ver mercado en Explorer')} <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
            ) : null}
            {marketWatchError ? <p className="mt-2 text-xs text-[var(--danger)]" role="alert">{marketWatchError}</p> : null}
          </div>
        )}
        {taskPersistenceWarning && <p className="text-xs text-amber-300" role="status">{t('No se pudo guardar la revisión en este navegador. Mantén esta página abierta para conservarla.')}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/wallets" className="wire-button wire-button-secondary min-h-11 px-3 text-sm">{t('Gestionar wallets del vault')} <ExternalLink size={13} aria-hidden="true" /></Link>
          {session && <button type="button" onClick={toggleLock} disabled={working} className="wire-button wire-button-quiet min-h-11 px-3 text-sm"><LockKeyhole size={14} aria-hidden="true" />{t('Bloquear vault')}</button>}
        </div>
        {!metadataReady ? <p className="text-sm text-[var(--muted)]">{t('Cargando wallets…')}</p>
          : !vaultExists ? <p className="rounded-lg border border-dashed border-[var(--line)] p-3 text-sm text-[var(--muted)]">{t('Crea primero el vault de wallets de proyecto para usar esta función.')}</p>
            : !session ? (
              <form onSubmit={handleUnlock} className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
                <label className="grid gap-1.5 text-sm">{t('Contraseña del vault')}<input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required autoComplete="current-password" className="wire-input min-h-11 w-full" /></label>
                <button type="submit" disabled={working || !passphrase} className="wire-button wire-button-primary min-h-11 justify-center"><ShieldCheck size={15} aria-hidden="true" />{t('Desbloquear solo para esta sesión')}</button>
              </form>
            ) : !wallets.length ? <p className="text-sm text-[var(--muted)]">{t('El vault todavía no contiene wallets.')}</p>
              : (
                <div className="grid gap-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm">{t('Operación')}<select value={side} onChange={(event) => { setSide(event.target.value as SwapSide); if (event.target.value !== 'buy') { setMarketWatchStatus('idle'); setMarketWatchQuote(null); setMarketWatchError(''); setMarketWatchNote(''); setPrepareWhenMarketReady(false); } resetBatch(); }} disabled={working || batch.length > 0 || marketLaunchTriggerArmed} className="wire-input min-h-11 w-full"><option value="buy">{t('Comprar {symbol}', { symbol: tokenSymbol })}</option><option value="sell">{t('Vender {symbol}', { symbol: tokenSymbol })}</option></select></label>
                    <div className="grid gap-1.5 text-sm"><span>{t('Deslizamiento por operación')}</span><div className="flex flex-wrap gap-2">{[50, 100, 200, 500].map((bps) => <button key={bps} type="button" disabled={working || batch.length > 0 || marketLaunchTriggerArmed} aria-pressed={slippageBps === bps} onClick={() => { setSlippageBps(bps); resetBatch(); }} className={`wire-button min-h-11 px-3 text-xs ${slippageBps === bps ? 'wire-button-primary' : 'wire-button-secondary'}`}>{(bps / 100).toFixed(2)}%</button>)}</div></div>
                  </div>
                  {side === 'buy' && <div className="grid gap-2 sm:max-w-md">
                    <span className="text-sm font-medium">{t('Intervalo aleatorio de Timed Buys')}</span>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="grid gap-1 text-xs text-[var(--muted)]">{t('Mínimo (segundos)')}<input type="number" min={0} max={MAX_TIMED_BUY_DELAY_SECONDS} step={1} value={delayMinSeconds} onChange={(event) => setDelayMinSeconds(Number(event.target.value))} disabled={working || batch.length > 0 || marketLaunchTriggerArmed} className="wire-input min-h-11 w-full" /></label>
                      <label className="grid gap-1 text-xs text-[var(--muted)]">{t('Máximo (segundos)')}<input type="number" min={0} max={MAX_TIMED_BUY_DELAY_SECONDS} step={1} value={delayMaxSeconds} onChange={(event) => setDelayMaxSeconds(Number(event.target.value))} disabled={working || batch.length > 0 || marketLaunchTriggerArmed} className="wire-input min-h-11 w-full" /></label>
                    </div>
                    <p className="text-xs text-[var(--muted)]">{t('Tras cada compra confirmada, Wire elige un intervalo entero dentro de este rango (0–30 s). Al revisar la secuencia aún no se firma ni se envía nada.')}</p>
                    <label htmlFor="project-wallet-max-consecutive-errors" className="grid gap-1 text-xs text-[var(--muted)]">{t('Fallos confirmados seguidos antes de detener')}
                      <select id="project-wallet-max-consecutive-errors" aria-describedby="project-wallet-consecutive-failure-help" value={maxConsecutiveErrors} onChange={(event) => setMaxConsecutiveErrors(Number(event.target.value))} disabled={working || batch.length > 0 || marketLaunchTriggerArmed} className="wire-input min-h-11 w-full">
                        {[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
                      </select>
                    </label>
                    <p id="project-wallet-consecutive-failure-help" className="text-xs text-[var(--muted)]">{t('Solo los fallos confirmados en Solana cuentan. Con límite 1, la secuencia se detiene tras el primer fallo confirmado. Un fallo de conexión, una firma incierta o una wallet pendiente siempre la detienen; la wallet fallida no se reintenta automáticamente.')}</p>
                  </div>}
                  {side === 'buy' && (
                    <div className="grid gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:max-w-xl">
                      <label htmlFor="project-wallet-swap-budget" className="grid gap-1.5 text-sm">
                        {t('Límite máximo de compra total')} · {quoteMint === SOL_MINT ? 'SOL' : 'USDC'}
                        <input
                          id="project-wallet-swap-budget"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={maxTotalSpend}
                          onChange={(event) => setMaxTotalSpend(event.target.value)}
                          placeholder={selectedBuyAmountsValid ? formatDecimalRaw(selectedBuyTotalRaw, budgetDecimals) : '0.00'}
                          disabled={working || batch.length > 0 || marketLaunchTriggerArmed}
                          aria-describedby="project-wallet-swap-budget-help"
                          className="wire-input min-h-11 w-full font-mono"
                        />
                      </label>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p id="project-wallet-swap-budget-help" className="max-w-lg text-xs text-[var(--muted)]">{t('La suma de los máximos cotizados debe quedar dentro de este límite. Las comisiones de red se muestran aparte.')}</p>
                        <button
                          type="button"
                          onClick={() => setMaxTotalSpend(formatDecimalRaw(selectedBuyTotalRaw, budgetDecimals))}
                          disabled={working || batch.length > 0 || marketLaunchTriggerArmed || !selectedBuyAmountsValid}
                          className="wire-button wire-button-secondary min-h-11 px-3 text-xs"
                        >
                          {t('Usar total indicado')}
                        </button>
                      </div>
                      <p className={`text-xs ${selectedBuyTotalExceedsBudget ? 'text-amber-300' : 'text-[var(--muted)]'}`} role={selectedBuyTotalExceedsBudget ? 'status' : undefined}>
                        {t('Total indicado')}: {selectedBuyAmountsValid ? formatDecimalRaw(selectedBuyTotalRaw, budgetDecimals) : '—'} {quoteMint === SOL_MINT ? 'SOL' : 'USDC'}
                        {selectedBuyTotalExceedsBudget && ` · ${t('El importe indicado supera el presupuesto máximo total.')}`}
                        {buyBudgetInvalid && ` · ${t('Escribe un límite máximo de compra total válido.')}`}
                      </p>
                    </div>
                  )}
                  <fieldset className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3" disabled={working || batch.length > 0 || marketLaunchTriggerArmed}>
                    <legend className="px-1 text-sm font-semibold">{t('Presets de esta operación')}</legend>
                    <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Los presets guardan direcciones públicas, montos y preferencias en este navegador; nunca guardan claves. Cargar un preset no firma ni envía operaciones.')}</p>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <label className="grid gap-1.5 text-xs">{t('Preset guardado')}<select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)} className="wire-input min-h-11"><option value="">{t('Selecciona un preset')}</option>{presets.filter((preset) => preset.mintAddress === mintAddress && preset.quoteMint === quoteMint).map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
                      <div className="flex flex-wrap items-end gap-2"><button type="button" onClick={loadPreset} disabled={!selectedPresetId} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Cargar preset')}</button><button type="button" onClick={deletePreset} disabled={!selectedPresetId} className="wire-button wire-button-quiet min-h-11 px-3 text-xs">{t('Eliminar preset')}</button></div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><label className="grid gap-1.5 text-xs">{t('Nombre del preset')}<input value={presetName} onChange={(event) => setPresetName(event.target.value)} maxLength={40} autoComplete="off" className="wire-input min-h-11" placeholder={t('Ejemplo: Compra de prueba')} /></label><button type="button" onClick={savePreset} disabled={!presetName.trim() || !selected.length} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Guardar preset')}</button></div>
                  </fieldset>
                  <p className="text-xs text-[var(--muted)]">{t('Selecciona hasta {count} wallets. Define el importe individual; cada cotización incluye mínimo recibido, fee estimado e impacto.', { count: MAX_BATCH_WALLETS })}</p>
                  <ul className="grid gap-2">
                    {wallets.map((wallet) => {
                      const checked = selected.includes(wallet.address);
                      const quoteDecimals = side === 'buy' ? (quoteMint === SOL_MINT ? 9 : 6) : launchPlatform === 'PUMP_FUN' ? 6 : 9;
                      return (
                        <li key={wallet.address} className="grid gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.55fr)] sm:items-center">
                          <label className="flex min-w-0 items-start gap-3">
                            <input type="checkbox" checked={checked} disabled={working || batch.length > 0 || marketLaunchTriggerArmed || (!checked && selected.length >= MAX_BATCH_WALLETS)} onChange={() => toggleWallet(wallet.address)} className="mt-1 h-4 w-4 accent-[var(--wire-green)]" />
                            <span className="min-w-0"><span className="block truncate text-sm font-semibold">{wallet.label || t('Wallet sin nombre')}</span><code className="block truncate text-xs text-[var(--muted)]">{wallet.address}</code><span className="text-xs text-[var(--muted)]">{t(wallet.role === 'dev' ? 'Dev' : wallet.role === 'bundle' ? 'Bundle' : wallet.role === 'snipe' ? 'Snipe' : wallet.role === 'holder' ? 'Holder' : 'Trading')}</span></span>
                          </label>
                          <label className="flex items-center gap-2 text-xs text-[var(--muted)]">{t('Importe')}<input type="text" inputMode="decimal" autoComplete="off" disabled={working || !checked || batch.length > 0 || marketLaunchTriggerArmed} value={amounts[wallet.address] ?? ''} onChange={(event) => setAmounts((current) => ({ ...current, [wallet.address]: event.target.value }))} placeholder="0.00" className="wire-input min-h-11 min-w-0 flex-1 font-mono" /><span>{side === 'buy' ? (quoteMint === SOL_MINT ? 'SOL' : 'USDC') : tokenSymbol}</span></label>
                          <span className="sr-only">{t('Precisión máxima: {count} decimales.', { count: quoteDecimals })}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {side === 'buy' && <section className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3" aria-labelledby="project-wallet-launch-trigger-title">
                    <div>
                      <h3 id="project-wallet-launch-trigger-title" className="text-sm font-semibold">{t('Compra al abrir el mercado')}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                        {t('Arma un disparador temporal de 15 minutos. Wire consulta el mercado de Devnet cada 5 segundos; cuando hay una cotización válida, prepara e inicia la secuencia sin otra confirmación. El precio, salida y comisión exactos no se conocerán al armarlo; se aplican tu importe, tope total y slippage. Solo funciona con la página visible y la bóveda desbloqueada; ocultar, cerrar, bloquear o recargar cancela el disparador y no se reanuda.')}
                      </p>
                    </div>
                    <p className="text-xs leading-relaxed text-[var(--muted)]">
                      {t('Plan autorizado')}: {selected.length} {t('wallets')} · {t('Tope total')}: {maxTotalSpend || '—'} {quoteMint === SOL_MINT ? 'SOL' : 'USDC'} · {t('Slippage')}: {(slippageBps / 100).toFixed(2)}% · {t('Espera')}: {delayMinSeconds}–{delayMaxSeconds} s · {t('Reserva de comisión y cuentas')}: {marketLaunchFeeReserveSol} SOL · {t('Límite de fallos consecutivos')}: {maxConsecutiveErrors}
                    </p>
                    {!marketLaunchTriggerArmed ? (
                      <>
                        <label className="flex items-start gap-2 text-xs leading-relaxed">
                          <input
                            type="checkbox"
                            checked={marketLaunchTriggerPlanAuthorized}
                            onChange={(event) => {
                              setMarketLaunchTriggerAcknowledged(event.target.checked);
                              setMarketLaunchTriggerAuthorizedPlan(event.target.checked ? marketLaunchTriggerPlanFingerprint : '');
                            }}
                            disabled={!marketLaunchTriggerAllowed || working}
                            className="mt-0.5 size-4 shrink-0 accent-[var(--wire-green)]"
                          />
                          <span>{t('Autorizo compras automáticas solo para las wallets y cantidades visibles, con este tope, slippage y una reserva máxima de 0.02 SOL por wallet. Acepto que Wire enviará tras obtener la cotización, sin otra revisión manual. Mis compras no son demanda de terceros.')}</span>
                        </label>
                        <button
                          type="button"
                          onClick={armMarketLaunchTrigger}
                          disabled={!marketLaunchTriggerAllowed || !marketLaunchTriggerPlanAuthorized || working}
                          className="wire-button wire-button-secondary min-h-11 justify-center"
                        >
                          {t('Armar compra al abrir mercado · 15 min')}
                        </button>
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2" role="status">
                        <p className="text-xs text-[var(--success)]">{t('Disparador activo · vence en {seconds} s', { seconds: marketLaunchTriggerSecondsRemaining })}</p>
                        <button type="button" onClick={() => cancelMarketLaunchTrigger('Disparador de compra cancelado. No se enviaron compras.')} className="wire-button wire-button-quiet min-h-11 px-3 text-xs">
                          {t('Cancelar disparador')}
                        </button>
                      </div>
                    )}
                  </section>}
                  <div className="flex flex-wrap gap-2">
                    {batch.length === 0 ? (
                      <button type="button" onClick={() => void reviewBatch()} disabled={working || marketLaunchTriggerArmed || !selected.length} className="wire-button wire-button-secondary min-h-11 justify-center"><RefreshCw size={14} aria-hidden="true" />{working ? t('Cotizando wallets…') : t('Revisar secuencia')}</button>
                    ) : (
                      <>
                        <button type="button" onClick={() => void executeNextWallet()} disabled={working || timedBuyArmed || Boolean(pendingWallet) || !nextWalletToApprove || delayRemaining > 0 || batch.some((row) => row.blockedByBudget)} className="wire-button wire-button-primary min-h-11 justify-center">{working ? t('Procesando wallet…') : pendingWallet ? t('Verifica primero la firma pendiente') : timedBuyArmed ? t('Timed Buys activo') : batch.some((row) => row.blockedByBudget) ? t('Ajusta el límite y revisa la secuencia') : delayRemaining > 0 ? t('Esperando {seconds} s…', { seconds: delayRemaining }) : nextWalletToApprove ? t('Aprobar operación de {wallet}', { wallet: nextWalletToApprove.wallet.label || nextWalletToApprove.wallet.address.slice(0, 8) }) : t('No hay más operaciones por aprobar')}</button>
                        <button type="button" onClick={resetBatch} disabled={working || batch.some((row) => row.status === 'pending')} className="wire-button wire-button-secondary min-h-11 px-4">{t('Revisar importes otra vez')}</button>
                        {batch.some((row) => row.status === 'reviewed') && <button type="button" onClick={cancelUnsentWallets} disabled={working} className="wire-button wire-button-quiet min-h-11 px-4">{t('Cancelar wallets no enviadas')}</button>}
                      </>
                    )}
                    {(working || timedBuyArmed) && <><button type="button" onClick={() => timedBuyArmed ? stopTimedBuys() : (stopRequestedRef.current = true, setStopRequested(true))} disabled={stopRequested} className="wire-button wire-button-secondary min-h-11 px-4">{t(timedBuyArmed ? 'Pausar Timed Buys' : 'Detener operación')}</button><p className="w-full text-xs text-[var(--muted)]">{t('Detener intenta frenar la operación actual antes del envío. Una transacción enviada no se puede cancelar desde aquí.')}</p></>}
                  </div>
                  {side === 'buy' && batch.length > 0 && <section className="grid gap-3 rounded-xl border border-[var(--wire-green)]/40 bg-[var(--surface)] p-3" aria-labelledby="project-wallet-timed-buy-title">
                    <div><h3 id="project-wallet-timed-buy-title" className="text-sm font-semibold">{t('Timed Buys · autorización para esta secuencia')}</h3><p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Al iniciar, autorizas Wire a firmar localmente y enviar automáticamente las compras revisadas que aparecen abajo, una por una, dentro del límite total mostrado. Solo Devnet y esta página abierta; al recargar no se reanuda. Si cambia una cotización, falla una operación o una firma queda incierta, se detiene.')}</p></div>
                    <ul className="grid gap-1 text-xs">{batch.filter((row) => row.status === 'reviewed').map((row) => <li key={row.wallet.address} className="break-all"><span className="font-semibold">{row.wallet.label || t('Wallet sin nombre')}</span> · {row.amountIn} {row.quote.inputSymbol} · <code className="text-[var(--muted)]">{row.wallet.address}</code></li>)}</ul>
                    <p className="text-xs font-medium">{t('Tope agregado: {amount} {asset} · Slippage: {slippage} · Espera aleatoria: {min}–{max} s', { amount: maxTotalSpend, asset: quoteMint === SOL_MINT ? 'SOL' : 'USDC', slippage: `${(slippageBps / 100).toFixed(2)}%`, min: delayMinSeconds, max: delayMaxSeconds })}</p>
                    <p className="text-xs font-medium">{t('Límite de fallos consecutivos')}: {maxConsecutiveErrors}</p>
                    <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" checked={timedBuyAcknowledged} onChange={(event) => setTimedBuyAcknowledged(event.target.checked)} disabled={working || timedBuyArmed} className="mt-0.5 h-4 w-4 accent-[var(--wire-green)]" /><span>{t('Entiendo que cada wallet hará una compra independiente y autorizo el envío automático de esta lista revisada con el tope indicado. Mis compras no representan demanda de terceros.')}</span></label>
                    <p className="text-xs text-[var(--muted)]">{t('Solo los fallos confirmados en Solana cuentan. Con límite 1, la secuencia se detiene tras el primer fallo confirmado. Un fallo de conexión, una firma incierta o una wallet pendiente siempre la detienen; la wallet fallida no se reintenta automáticamente.')}</p>
                    <div className="flex flex-wrap gap-2">{!timedBuyArmed ? <button type="button" onClick={() => startTimedBuys()} disabled={working || !session || !timedBuyAcknowledged || !batch.some((row) => row.status === 'reviewed') || Boolean(pendingWallet) || batch.some((row) => (row.status === 'failed' && !row.signature) || row.blockedByBudget) || delayMinSeconds > delayMaxSeconds} className="wire-button wire-button-primary min-h-11 justify-center">{t(runStatus === 'paused' ? 'Autorizar y reanudar Timed Buys' : 'Iniciar Timed Buys en Devnet')}</button> : <p role="status" className="self-center text-xs text-[var(--success)]">{t('Timed Buys ejecuta solo la secuencia revisada; puedes detener las compras futuras en cualquier momento.')}</p>}</div>
                  </section>}
                  {batch.length > 0 && <ol className="grid gap-2" aria-label={t('Revisión por wallet')}>
                    {batchTotals && <li className="grid gap-2 rounded-xl border border-[var(--wire-green)]/40 bg-[var(--surface)] p-3">
                      <p className="text-sm font-semibold">{t('Resumen estimado de la secuencia')} · {activeBatch.length} {t('wallets no canceladas')}</p>
                      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                        <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Importe indicado')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{batchTotals.amountIn} {batch[0].quote.inputSymbol}</dd></div>
                        {side === 'buy' && <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Límite máximo de compra total')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{maxTotalSpend} {batch[0].quote.inputSymbol}</dd></div>}
                        {side === 'buy' && <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Máximo total a pagar')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{batchTotals.maximumIn} {batch[0].quote.inputSymbol}</dd></div>}
                        <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Mínimo de salida combinado')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{batchTotals.minimumOut} {batch[0].quote.outputSymbol}</dd></div>
                        <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t(marketFeeLabel)}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{batchTotals.poolFee} {batch[0].quote.inputSymbol}</dd></div>
                        <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Comisiones de red estimadas')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{formatDecimalRaw(batchTotals.networkFeeLamports, 9)} SOL</dd></div>
                        {side === 'buy' && delayMaxSeconds > 0 && <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Espera acumulada estimada')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{Math.max(0, batch.filter((row) => row.status !== 'cancelled').length - 1) * delayMinSeconds}–{Math.max(0, batch.filter((row) => row.status !== 'cancelled').length - 1) * delayMaxSeconds} s</dd></div>}
                      </dl>
                      <p className="text-xs text-[var(--muted)]">{t(marketChangedHelp)}</p>
                    </li>}
                    {batch.map((row, index) => <li key={row.wallet.address} aria-current={row === nextWalletToApprove ? 'step' : undefined} className={`grid gap-2 rounded-xl border bg-[var(--surface)] p-3 ${row.blockedByBudget ? 'border-amber-300/70' : row === nextWalletToApprove ? 'border-[var(--wire-green)]/70' : 'border-[var(--line)]'}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">{index + 1}. {row.wallet.label || t('Wallet sin nombre')} · {row.amountIn} {row.quote.inputSymbol}</span><span className={`text-xs ${row.status === 'confirmed' ? 'text-[var(--success)]' : row.status === 'failed' ? 'text-[var(--danger)]' : row.status === 'pending' || row.blockedByBudget ? 'text-amber-300' : 'text-[var(--muted)]'}`}>{t(row.blockedByBudget ? 'Bloqueada por límite' : row.status === 'confirmed' ? 'Confirmada' : row.status === 'pending' ? 'Pendiente de confirmación' : row.status === 'failed' ? 'Fallida' : row.status === 'cancelled' ? 'Cancelada' : 'Revisada')}</span></div>
                      <code className="break-all text-xs text-[var(--muted)]">{row.wallet.address}</code>
                      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2"><div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Recibes estimado')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{row.quote.amountOut} {row.quote.outputSymbol}</dd></div><div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t(row.quote.side === 'buy' && row.quote.venue !== 'RAYDIUM' ? 'Cantidad objetivo recibida' : 'Mínimo recibido')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{row.quote.minimumAmountOut} {row.quote.outputSymbol}</dd></div>{side === 'buy' && <div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Máximo a pagar')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{row.quote.maximumAmountIn ?? row.amountIn} {row.quote.inputSymbol}</dd></div>}<div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t(operationFeeLabel)}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{row.quote.estimatedPoolFee} {row.quote.inputSymbol}</dd></div><div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Comisión de red estimada')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{formatDecimalRaw(BigInt(row.networkFeeLamports), 9)} SOL</dd></div><div className="flex min-w-0 justify-between gap-2"><dt className="min-w-0 flex-1 text-[var(--muted)]">{t('Impacto de precio (sin fee del pool)')}</dt><dd className="min-w-0 max-w-[60%] text-right font-mono [overflow-wrap:anywhere]">{row.quote.priceImpactPercent === null ? '—' : `${row.quote.priceImpactPercent}%`}</dd></div></dl>
                      {row.detail && <p className="text-xs text-[var(--muted)]">{row.detail}</p>}
                      {row.status === 'failed' && <p className="text-xs text-[var(--muted)]">{t('La operación falló de forma confirmada o no se envió. Re-cotiza esta wallet para revisar un posible reintento; Wire no la reenvía automáticamente.')}</p>}
                      <div className="flex flex-wrap gap-2">{row.signature && <a href={explorerTransaction(row.signature)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 justify-self-start px-3 text-xs">{t(row.status === 'failed' ? 'Ver firma fallida en Explorer' : 'Ver en Explorer')} <ExternalLink size={12} aria-hidden="true" /></a>}{row.previousSignature && <a href={explorerTransaction(row.previousSignature)} target="_blank" rel="noreferrer" className="wire-button wire-button-quiet min-h-11 justify-self-start px-3 text-xs">{t('Ver firma anterior en Explorer')}</a>}{row.status === 'pending' && row.signature && <button type="button" onClick={() => void verifyPendingSignature(row)} disabled={working} className="wire-button wire-button-quiet min-h-11 px-3 text-xs">{t('Verificar estado en Devnet')}</button>}{row.status === 'failed' && <button type="button" onClick={() => void reQuoteFailedWallet(row)} disabled={working || delayRemaining > 0 || batch.some((item) => item.status === 'pending')} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Re-cotizar y revisar reintento')}</button>}{row.historyPending && <button type="button" onClick={() => void retryHistoryRecord(row)} disabled={working} className="wire-button wire-button-quiet min-h-11 px-3 text-xs">{t('Reintentar historial')}</button>}</div>
                    </li>)}
                  </ol>}
                </div>
              )}
        {error && <p className="text-sm text-[var(--danger)]" role="alert">{t(error)}</p>}
        {message && <p className="text-sm text-[var(--muted)]" role="status" aria-live="polite">{t(message)}</p>}
        {delayRemaining > 0 && <p className="text-xs text-[var(--muted)]" role="status" aria-live="polite">{t('Espera restante: {seconds} s', { seconds: delayRemaining })}</p>}
      </div>
    </details>
  );
}
