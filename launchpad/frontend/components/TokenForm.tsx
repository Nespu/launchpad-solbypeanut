'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { ArrowLeft, ArrowRight, Check, ExternalLink, ImagePlus, LockKeyhole, PencilLine, Plus, Snowflake, Trash2, X } from 'lucide-react';
import TrustRing from './TrustRing';
import PoolCreate from './PoolCreate';
import { notifyToast, userFacingError } from './toastEvents';
import { useWireLocale } from './LocaleProvider';
import { markStoredPoolWithoutLp, tokenCreationStorageKey } from '../lib/tokenCreationStorage';
import { checkPreparedBlockhash } from '../lib/blockhashPreflight';
import { queueProjectWalletLaunchSelection } from '../lib/projectWalletLaunchSelection';
import { applyEqualProjectWalletBuyAmount, sumProjectWalletBuyAmounts } from '../lib/projectWalletBuyAllocation';
import { getWalletVaultMetadata, type VaultWallet, type VaultWalletRole } from '../lib/walletVault';
import {
  MAX_TOKEN_LAUNCH_BATCH_DRAFTS,
  readTokenLaunchBatch,
  writeTokenLaunchBatch,
  type TokenLaunchBatchDraft,
  type TokenLaunchBatchSubmission,
} from '../lib/tokenLaunchBatch';

const STEPS = ['Identidad', 'Metadatos', 'Oferta', 'Seguridad', 'Revisión'];
const AUTHORITIES = [
  { key: 'mint', icon: LockKeyhole, name: 'Revocar acuñación', desc: 'Nadie podrá acuñar más tokens.' },
  { key: 'freeze', icon: Snowflake, name: 'Desactivar congelación', desc: 'Ninguna wallet podrá ser congelada.' },
  { key: 'update', icon: PencilLine, name: 'Fijar metadata', desc: 'Los datos del token no podrán cambiar.' },
];

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const LAUNCH_PRESETS_STORAGE_KEY = 'wire:launch-presets:v1';
const MAX_LAUNCH_PRESETS = 20;
const MAX_LAUNCH_WALLETS = 10;
const LAUNCH_BUY_DELAY_OPTIONS = [0, 2, 5, 10, 30] as const;
const LAUNCH_BUY_SLIPPAGE_OPTIONS = [50, 100, 200, 500] as const;
const SECURITY_ASSET_KEYS = ['mint', 'freeze', 'update'];
type LaunchPlatform = 'RAYDIUM' | 'PUMP_FUN';

type LaunchPreset = {
  id: string;
  name: string;
  launchPlatform?: LaunchPlatform;
  totalSupply: string;
  liquiditySol: string;
  securityAssets: string[];
  walletAddresses?: string[];
  walletBuyAmounts?: Record<string, string>;
  buyDelaySeconds?: number;
  buySlippageBps?: number;
};

function isValidLaunchBuyAmount(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 40
    && /^\d{1,20}(?:\.\d{1,9})?$/.test(value.trim())
    && /[1-9]/.test(value);
}

function isLaunchPreset(value: unknown): value is LaunchPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<LaunchPreset>;
  const supply = Number(preset.totalSupply);
  const liquidity = Number(preset.liquiditySol);
  return typeof preset.id === 'string'
    && typeof preset.name === 'string'
    && preset.name.trim().length > 0
    && preset.name.length <= 32
    && (preset.launchPlatform === undefined || preset.launchPlatform === 'RAYDIUM' || preset.launchPlatform === 'PUMP_FUN')
    && typeof preset.totalSupply === 'string'
    && Number.isSafeInteger(supply)
    && supply > 0
    && supply <= 18_446_744_073
    && typeof preset.liquiditySol === 'string'
    && Number.isFinite(liquidity)
    && liquidity > 0
    && Array.isArray(preset.securityAssets)
    && preset.securityAssets.length <= SECURITY_ASSET_KEYS.length
    && preset.securityAssets.every((key) => SECURITY_ASSET_KEYS.includes(key))
    && (preset.walletAddresses === undefined || (
      Array.isArray(preset.walletAddresses)
      && preset.walletAddresses.length <= MAX_LAUNCH_WALLETS
      && preset.walletAddresses.every((address) => {
        if (typeof address !== 'string') return false;
        try { return new PublicKey(address).toBase58() === address; } catch { return false; }
      })
    ))
    && (preset.walletBuyAmounts === undefined || (
      Boolean(preset.walletBuyAmounts)
      && typeof preset.walletBuyAmounts === 'object'
      && !Array.isArray(preset.walletBuyAmounts)
      && Object.entries(preset.walletBuyAmounts).length <= MAX_LAUNCH_WALLETS
      && Object.entries(preset.walletBuyAmounts).every(([address, amount]) =>
        Array.isArray(preset.walletAddresses) && preset.walletAddresses.includes(address) && isValidLaunchBuyAmount(amount),
      )
    ))
    && (preset.buyDelaySeconds === undefined || LAUNCH_BUY_DELAY_OPTIONS.includes(preset.buyDelaySeconds as typeof LAUNCH_BUY_DELAY_OPTIONS[number]))
    && (preset.buySlippageBps === undefined || LAUNCH_BUY_SLIPPAGE_OPTIONS.includes(preset.buySlippageBps as typeof LAUNCH_BUY_SLIPPAGE_OPTIONS[number]));
}

function projectWalletRoleLabel(role: VaultWalletRole, t: (message: string, values?: Record<string, string | number>) => string) {
  return t(role === 'dev' ? 'Dev' : role === 'bundle' ? 'Bundle' : role === 'snipe' ? 'Snipe' : role === 'trading' ? 'Trading' : 'Holder');
}

function readLaunchPresets(): LaunchPreset[] {
  const raw = window.localStorage.getItem(LAUNCH_PRESETS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLaunchPreset).slice(0, MAX_LAUNCH_PRESETS) : [];
  } catch {
    return [];
  }
}

// description e imageUrl no se mandan: el servidor las lee de la metadata
// publicada en IPFS al registrar el token.
type PendingTokenSubmission = TokenLaunchBatchSubmission;

type TokenAttemptOutcome = 'signature_rejected' | 'blockhash_expired' | 'rpc_mismatch' | 'preflight_failed';

function reportTokenAttemptOutcome(attemptId: string, userWallet: string, mintAddress: string, outcome: TokenAttemptOutcome) {
  void fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/token-attempt/outcome`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId, userWallet, mintAddress, outcome }),
  }).catch(() => undefined);
}

type StoredTokenCreation = {
  walletAddress: string;
  txId: string;
  mintAddress: string;
  launchPlatform?: LaunchPlatform;
  bondingCurveAddress?: string;
  name: string;
  symbol: string;
  totalSupply: string;
  liquiditySol: string;
  createdPool: { txId: string; poolId: string } | null;
  launchWalletAddresses?: string[];
  launchWalletBuyAmounts?: Record<string, string>;
  launchWalletBuyDelaySeconds?: number;
  launchWalletBuySlippageBps?: number;
  poolStatus?: 'withdrawn' | 'no-position';
  summaryDismissed?: boolean;
};

function readStoredTokenCreation(walletAddress: string): StoredTokenCreation | null {
  try {
    const raw = window.localStorage.getItem(tokenCreationStorageKey(walletAddress));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredTokenCreation>;
    if (
      value.walletAddress !== walletAddress ||
      typeof value.txId !== 'string' ||
      typeof value.mintAddress !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.symbol !== 'string' ||
      typeof value.totalSupply !== 'string' ||
      typeof value.liquiditySol !== 'string'
    ) return null;
    const launchWalletAddresses = Array.isArray(value.launchWalletAddresses)
      ? Array.from(new Set(value.launchWalletAddresses.filter((address): address is string => {
        if (typeof address !== 'string') return false;
        try { return new PublicKey(address).toBase58() === address; } catch { return false; }
      }))).slice(0, MAX_LAUNCH_WALLETS)
      : [];
    const launchWalletBuyAmounts = value.launchWalletBuyAmounts && typeof value.launchWalletBuyAmounts === 'object'
      ? Object.fromEntries(Object.entries(value.launchWalletBuyAmounts).filter(([address, amount]) =>
        launchWalletAddresses.includes(address) && isValidLaunchBuyAmount(amount),
      ))
      : {};
    return {
      ...value,
      walletAddress,
      launchPlatform: value.launchPlatform === 'PUMP_FUN' ? 'PUMP_FUN' : 'RAYDIUM',
      poolStatus: value.poolStatus === 'withdrawn' || value.poolStatus === 'no-position' ? value.poolStatus : undefined,
      summaryDismissed: value.summaryDismissed === true,
      launchWalletAddresses,
      launchWalletBuyAmounts,
      launchWalletBuyDelaySeconds: LAUNCH_BUY_DELAY_OPTIONS.includes(value.launchWalletBuyDelaySeconds as typeof LAUNCH_BUY_DELAY_OPTIONS[number])
        ? value.launchWalletBuyDelaySeconds
        : 0,
      launchWalletBuySlippageBps: LAUNCH_BUY_SLIPPAGE_OPTIONS.includes(value.launchWalletBuySlippageBps as typeof LAUNCH_BUY_SLIPPAGE_OPTIONS[number])
        ? value.launchWalletBuySlippageBps
        : 100,
      createdPool: value.createdPool && typeof value.createdPool.poolId === 'string' && typeof value.createdPool.txId === 'string'
        ? value.launchPlatform === 'PUMP_FUN' ? null : value.createdPool
        : null,
    } as StoredTokenCreation;
  } catch {
    return null;
  }
}

function writeStoredTokenCreation(value: StoredTokenCreation) {
  try {
    window.localStorage.setItem(tokenCreationStorageKey(value.walletAddress), JSON.stringify(value));
  } catch {
    // The in-memory success state still protects the current page if storage is unavailable.
  }
}

const EXPIRED_TRANSACTION_MESSAGE = 'La transacción expiró. Vuelve a firmar.';

export default function TokenForm() {
  const { publicKey, signTransaction } = useWallet();
  const { locale, t } = useWireLocale();
  const translateRef = useRef(t);
  const successDialogRef = useRef<HTMLDivElement>(null);
  const continuationRef = useRef<HTMLElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { translateRef.current = t; }, [t]);

  const [holderReward, setHolderReward] = useState(false);
  const [holderRewardsStatus, setHolderRewardsStatus] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading');

  const [step, setStep] = useState(0);
  const [launchPlatform, setLaunchPlatform] = useState<LaunchPlatform>('RAYDIUM');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [totalSupply, setTotalSupply] = useState('1000000000');
  const [liquiditySol, setLiquiditySol] = useState('1');
  const [imageBase64, setImageBase64] = useState<string | undefined>(undefined);
  const [imagePreview, setImagePreview] = useState<string | undefined>(undefined);
  const [imageError, setImageError] = useState('');
  const [securityAssets, setSecurityAssets] = useState<string[]>(['mint', 'freeze', 'update']);
  const [launchPresets, setLaunchPresets] = useState<LaunchPreset[]>([]);
  const [presetStorageReady, setPresetStorageReady] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetEditorOpen, setPresetEditorOpen] = useState(false);
  const [presetError, setPresetError] = useState('');
  const [projectWallets, setProjectWallets] = useState<VaultWallet[]>([]);
  const [projectWalletsLoading, setProjectWalletsLoading] = useState(true);
  const [projectWalletsError, setProjectWalletsError] = useState('');
  const [selectedProjectWalletAddresses, setSelectedProjectWalletAddresses] = useState<string[]>([]);
  const [launchWalletBuyAmounts, setLaunchWalletBuyAmounts] = useState<Record<string, string>>({});
  const [equalLaunchBuyAmount, setEqualLaunchBuyAmount] = useState('');
  const [launchBuyAllocationMessage, setLaunchBuyAllocationMessage] = useState('');
  const [launchBuyDelaySeconds, setLaunchBuyDelaySeconds] = useState<number>(0);
  const [launchBuySlippageBps, setLaunchBuySlippageBps] = useState<number>(100);
  const [showSocials, setShowSocials] = useState(false);
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [batchDrafts, setBatchDrafts] = useState<TokenLaunchBatchDraft[]>([]);
  const [batchStorageWallet, setBatchStorageWallet] = useState<string | null>(null);
  const [batchStorageError, setBatchStorageError] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [activeBatchDraftId, setActiveBatchDraftId] = useState<string | null>(null);
  const batchDraftsRef = useRef<TokenLaunchBatchDraft[]>([]);

  const [loading, setLoading] = useState(false);
  const [operationStage, setOperationStage] = useState<'preparing' | 'signature' | 'registering' | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<PendingTokenSubmission | null>(null);
  const [feeConfig, setFeeConfig] = useState<{ baseFeeSol: number; assetFeeSol: number } | null>(null);
  const [result, setResult] = useState<{
    txId: string;
    mintAddress: string;
    walletAddress: string;
    launchPlatform: LaunchPlatform;
    bondingCurveAddress?: string;
    launchWalletAddresses?: string[];
    launchWalletBuyAmounts?: Record<string, string>;
    launchWalletBuyDelaySeconds?: number;
    launchWalletBuySlippageBps?: number;
  } | null>(null);
  const [restoredWallet, setRestoredWallet] = useState<string | null>(null);
  const [goToPool, setGoToPool] = useState(false);
  const [successDismissed, setSuccessDismissed] = useState(false);
  const [summaryDismissed, setSummaryDismissed] = useState(false);
  const [continuationHighlighted, setContinuationHighlighted] = useState(false);
  const [createdPool, setCreatedPool] = useState<{ txId: string; poolId: string } | null>(null);
  const [poolStatus, setPoolStatus] = useState<StoredTokenCreation['poolStatus']>();
  const walletAddress = publicKey?.toBase58() ?? null;
  const isRestoringResult = Boolean(walletAddress && restoredWallet !== walletAddress);

  useEffect(() => {
    let active = true;
    setBatchStorageWallet(null);
    batchDraftsRef.current = [];
    setBatchDrafts([]);
    setActiveBatchDraftId(null);
    setBatchStorageError('');
    if (!walletAddress) return () => { active = false; };

    readTokenLaunchBatch(walletAddress)
      .then(async (savedDrafts) => {
        if (!active) return;
        const savedCreation = readStoredTokenCreation(walletAddress);
        const reconciled = savedDrafts.map((draft) => (
          draft.status === 'pending'
          && draft.pendingSubmission?.mintAddress === savedCreation?.mintAddress
          && savedCreation.txId
            ? { ...draft, status: 'complete' as const, txId: savedCreation.txId, mintAddress: draft.pendingSubmission.mintAddress, pendingSubmission: undefined }
            : draft
        ));
        batchDraftsRef.current = reconciled;
        setBatchDrafts(reconciled);
        setBatchStorageWallet(walletAddress);
        if (reconciled.some((draft, index) => draft !== savedDrafts[index])) {
          try {
            await writeTokenLaunchBatch(walletAddress, reconciled);
          } catch (caught) {
            if (active) setBatchStorageError(userFacingError(caught, translateRef.current('No se pudo actualizar el estado del lote.'), translateRef.current));
          }
        }
      })
      .catch((caught: unknown) => {
        if (active) setBatchStorageError(userFacingError(caught, translateRef.current('No se pudo cargar el lote de lanzamientos.'), translateRef.current));
      });
    return () => { active = false; };
  }, [walletAddress]);

  const activeBatchDraft = batchDrafts.find((draft) => draft.id === activeBatchDraftId) ?? null;

  const persistBatchDrafts = async (nextDrafts: TokenLaunchBatchDraft[]) => {
    if (!walletAddress || batchStorageWallet !== walletAddress) throw new Error(t('Espera a que cargue el lote de esta wallet.'));
    setBatchBusy(true);
    try {
      await writeTokenLaunchBatch(walletAddress, nextDrafts);
      batchDraftsRef.current = nextDrafts;
      setBatchDrafts(nextDrafts);
      setBatchStorageError('');
    } catch (caught) {
      const message = userFacingError(caught, t('No se pudo guardar el lote de lanzamientos.'), t);
      setBatchStorageError(message);
      throw new Error(message);
    } finally {
      setBatchBusy(false);
    }
  };

  const updateBatchDraft = async (draftId: string, update: (draft: TokenLaunchBatchDraft) => TokenLaunchBatchDraft) => {
    const currentDrafts = batchDraftsRef.current;
    const existing = currentDrafts.find((draft) => draft.id === draftId);
    if (!existing) throw new Error(t('No se encontró el borrador del lote.'));
    await persistBatchDrafts(currentDrafts.map((draft) => draft.id === draftId ? update(draft) : draft));
  };

  useEffect(() => {
    if (launchPlatform !== 'PUMP_FUN') return;
    let active = true;
    setHolderRewardsStatus('loading');
    fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/pump/creator-fees/status`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.success !== true || data.network !== 'devnet' || typeof data.holderRewardsEnabled !== 'boolean') {
          throw new Error('Pump status unavailable');
        }
        if (active) {
          setHolderRewardsStatus(data.holderRewardsEnabled ? 'enabled' : 'disabled');
          if (!data.holderRewardsEnabled) setHolderReward(false);
        }
      })
      .catch(() => { if (active) { setHolderRewardsStatus('error'); setHolderReward(false); } });
    return () => { active = false; };
  }, [launchPlatform]);

  useEffect(() => {
    try {
      const savedPresets = readLaunchPresets();
      setLaunchPresets(savedPresets);
      setSelectedPresetId(savedPresets[0]?.id ?? '');
    } catch {
      setLaunchPresets([]);
    } finally {
      setPresetStorageReady(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getWalletVaultMetadata()
      .then((metadata) => { if (active) setProjectWallets(metadata.wallets); })
      .catch((caught: unknown) => {
        if (active) setProjectWalletsError(userFacingError(caught, translateRef.current('No se pudieron cargar las wallets de proyecto.'), translateRef.current));
      })
      .finally(() => { if (active) setProjectWalletsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;

    if (!walletAddress) {
      setRestoredWallet(null);
      return () => { active = false; };
    }

    const restoreCreation = async () => {
      const saved = readStoredTokenCreation(walletAddress);
      if (saved?.createdPool) {
        try {
          const response = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL || ''}/api/lp-balance?userWallet=${encodeURIComponent(walletAddress)}&poolAddress=${encodeURIComponent(saved.createdPool.poolId)}`,
            { cache: 'no-store' },
          );
          const data = await response.json();
          if (active && response.ok && data.success && typeof data.rawBalance === 'string' && BigInt(data.rawBalance) === BigInt(0)) {
            // Zero LP means this wallet has no current position; keep the
            // token and pool metadata as history and avoid offering creation again.
            saved.poolStatus = saved.poolStatus === 'withdrawn' ? 'withdrawn' : 'no-position';
            markStoredPoolWithoutLp(walletAddress, saved.createdPool.poolId);
            try { window.localStorage.setItem(tokenCreationStorageKey(walletAddress), JSON.stringify(saved)); } catch { /* The visible state still reflects the confirmed balance. */ }
          } else if (active && response.ok && data.success && typeof data.rawBalance === 'string' && BigInt(data.rawBalance) > BigInt(0) && saved.poolStatus) {
            // If this wallet later regains LP tokens, reflect its active position again.
            saved.poolStatus = undefined;
            try { window.localStorage.setItem(tokenCreationStorageKey(walletAddress), JSON.stringify(saved)); } catch { /* The refreshed state still applies for this render. */ }
          }
        } catch {
          // If the RPC cannot confirm a zero LP balance, preserve the saved result.
        }
      }

      if (!active) return;
      const fullWithdrawal = saved?.poolStatus === 'withdrawn';
      setLaunchPlatform(saved?.launchPlatform ?? 'RAYDIUM');
      setResult(saved && !fullWithdrawal ? {
        txId: saved.txId,
        mintAddress: saved.mintAddress,
        walletAddress: saved.walletAddress,
        launchPlatform: saved.launchPlatform ?? 'RAYDIUM',
        bondingCurveAddress: saved.bondingCurveAddress,
        launchWalletAddresses: saved.launchWalletAddresses,
        launchWalletBuyAmounts: saved.launchWalletBuyAmounts,
        launchWalletBuyDelaySeconds: saved.launchWalletBuyDelaySeconds,
        launchWalletBuySlippageBps: saved.launchWalletBuySlippageBps,
      } : null);
      setCreatedPool(fullWithdrawal ? null : saved?.createdPool ?? null);
      setPoolStatus(fullWithdrawal ? undefined : saved?.poolStatus);
      setSelectedProjectWalletAddresses((saved?.launchWalletAddresses ?? []).filter((address) => address !== walletAddress));
      setLaunchWalletBuyAmounts(saved?.launchWalletBuyAmounts ?? {});
      setEqualLaunchBuyAmount('');
      setLaunchBuyAllocationMessage('');
      setLaunchBuyDelaySeconds(saved?.launchWalletBuyDelaySeconds ?? 0);
      setLaunchBuySlippageBps(saved?.launchWalletBuySlippageBps ?? 100);
      setSummaryDismissed(saved?.summaryDismissed === true || fullWithdrawal);
      setSuccessDismissed(Boolean(saved));
      setGoToPool(false);
      if (saved && !fullWithdrawal) {
        setName(saved.name);
        setSymbol(saved.symbol);
        setTotalSupply(saved.totalSupply);
        setLiquiditySol(saved.liquiditySol);
      } else if (fullWithdrawal) {
        setStep(0);
        setLaunchPlatform('RAYDIUM');
        setName('');
        setSymbol('');
        setDescription('');
        setTotalSupply('1000000000');
        setLiquiditySol('1');
        setImageBase64(undefined);
        setImagePreview(undefined);
        setImageError('');
        setSecurityAssets(['mint', 'freeze', 'update']);
        setSelectedProjectWalletAddresses([]);
        setLaunchWalletBuyAmounts({});
        setEqualLaunchBuyAmount('');
        setLaunchBuyAllocationMessage('');
        setLaunchBuyDelaySeconds(0);
        setLaunchBuySlippageBps(100);
        setShowSocials(false);
        setTwitter('');
        setTelegram('');
      }
      setRestoredWallet(walletAddress);
    };

    void restoreCreation();
    return () => { active = false; };
  }, [walletAddress]);

  useEffect(() => {
    const refreshStoredCreation = () => {
      if (!walletAddress) return;
      const saved = readStoredTokenCreation(walletAddress);
      if (!saved) return;
      if (saved.poolStatus === 'withdrawn') {
        // A full withdrawal closes this wallet's LP position. Keep the stored
        // mint/pool history, but clear the stale success state from the launch form.
        setResult(null);
        setCreatedPool(null);
        setPoolStatus(undefined);
        setSelectedProjectWalletAddresses([]);
        setLaunchWalletBuyAmounts({});
        setEqualLaunchBuyAmount('');
        setLaunchBuyAllocationMessage('');
        setLaunchBuyDelaySeconds(0);
        setLaunchBuySlippageBps(100);
        setSummaryDismissed(true);
        setSuccessDismissed(true);
        setGoToPool(false);
        setContinuationHighlighted(false);
        setPendingSubmission(null);
        setStep(0);
        setLaunchPlatform('RAYDIUM');
        setName('');
        setSymbol('');
        setDescription('');
        setTotalSupply('1000000000');
        setLiquiditySol('1');
        setImageBase64(undefined);
        setImagePreview(undefined);
        setImageError('');
        setSecurityAssets(['mint', 'freeze', 'update']);
        setShowSocials(false);
        setTwitter('');
        setTelegram('');
        if (imageInputRef.current) imageInputRef.current.value = '';
        return;
      }
      setLaunchPlatform(saved.launchPlatform ?? 'RAYDIUM');
      setResult({
        txId: saved.txId,
        mintAddress: saved.mintAddress,
        walletAddress: saved.walletAddress,
        launchPlatform: saved.launchPlatform ?? 'RAYDIUM',
        bondingCurveAddress: saved.bondingCurveAddress,
        launchWalletAddresses: saved.launchWalletAddresses,
        launchWalletBuyAmounts: saved.launchWalletBuyAmounts,
        launchWalletBuyDelaySeconds: saved.launchWalletBuyDelaySeconds,
        launchWalletBuySlippageBps: saved.launchWalletBuySlippageBps,
      });
      setCreatedPool(saved.createdPool);
      setPoolStatus(saved.poolStatus);
      setSelectedProjectWalletAddresses((saved.launchWalletAddresses ?? []).filter((address) => address !== walletAddress));
      setSummaryDismissed(saved.summaryDismissed === true);
      setSuccessDismissed(true);
    };
    window.addEventListener('wire:token-creation-updated', refreshStoredCreation);
    return () => window.removeEventListener('wire:token-creation-updated', refreshStoredCreation);
  }, [walletAddress]);

  useEffect(() => {
    if (!result || !successDismissed || goToPool) return;
    const continuation = continuationRef.current;
    if (!continuation) return;

    continuation.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    });
    setContinuationHighlighted(true);
    const timeout = window.setTimeout(() => setContinuationHighlighted(false), 2200);
    return () => window.clearTimeout(timeout);
  }, [result, successDismissed, goToPool]);

  useEffect(() => {
    if (!result || goToPool || successDismissed) return;
    const dialog = successDialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = () => Array.from(
      dialog.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])')
    );
    const focusable = getFocusable();
    (focusable[0] ?? dialog).focus();

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSuccessDismissed(true);
        return;
      }
      if (event.key !== 'Tab') return;

      const items = getFocusable();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
        event.preventDefault();
        items[0].focus();
      }
    };

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      document.removeEventListener('keydown', handleDialogKeyDown);
      previousFocus?.focus();
    };
  }, [result, goToPool, successDismissed]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/fee-config`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || cancelled) return;
        setFeeConfig({ baseFeeSol: data.baseFeeSol, assetFeeSol: data.assetFeeSol });
      })
      .catch(() => {
        if (!cancelled) notifyToast({ title: translateRef.current('No se pudo cargar el costo'), message: translateRef.current('Recarga la página e inténtalo de nuevo.') });
      });
    return () => { cancelled = true; };
  }, []);

  const appliesSplSecurity = launchPlatform === 'RAYDIUM';
  const totalFee = feeConfig ? feeConfig.baseFeeSol + (appliesSplSecurity ? securityAssets.length * feeConfig.assetFeeSol : 0) : null;
  const securityFee = feeConfig ? (appliesSplSecurity ? securityAssets.length * feeConfig.assetFeeSol : 0) : null;
  const formatSol = (amount: number) => `${new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US', { maximumFractionDigits: 6 }).format(amount)} SOL`;

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;

    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setImageError(t('La imagen debe ser PNG, JPEG, WebP o GIF.'));
      input.value = '';
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(t('La imagen no puede superar 2 MB.'));
      input.value = '';
      return;
    }

    setImageError('');
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

  const supplyValue = Number(totalSupply);
  const liquidityValue = Number(liquiditySol);
  const launchSettingsValid = launchPlatform === 'PUMP_FUN' || (Number.isSafeInteger(supplyValue)
    && supplyValue > 0
    && supplyValue <= 18_446_744_073
    && Number.isFinite(liquidityValue)
    && liquidityValue > 0);
  const launchBuyAmountsValid = selectedProjectWalletAddresses.every((address) => {
    const amount = launchWalletBuyAmounts[address]?.trim() ?? '';
    return amount === '' || isValidLaunchBuyAmount(amount);
  });
  const plannedBuyWalletAddresses = selectedProjectWalletAddresses.filter((address) => isValidLaunchBuyAmount(launchWalletBuyAmounts[address] ?? ''));
  const plannedBuyTotalSol = sumProjectWalletBuyAmounts(plannedBuyWalletAddresses, launchWalletBuyAmounts);

  const applyEqualLaunchBuyAmount = () => {
    if (!selectedProjectWalletAddresses.length || !isValidLaunchBuyAmount(equalLaunchBuyAmount)) {
      setLaunchBuyAllocationMessage(t('Selecciona wallets e indica un importe positivo de hasta nueve decimales.'));
      return;
    }
    try {
      const allocation = applyEqualProjectWalletBuyAmount(selectedProjectWalletAddresses, equalLaunchBuyAmount);
      setLaunchWalletBuyAmounts((current) => ({ ...current, ...allocation }));
      setLaunchBuyAllocationMessage(t('Importe aplicado a {count} wallets. Puedes personalizar cada importe.', { count: selectedProjectWalletAddresses.length }));
    } catch {
      setLaunchBuyAllocationMessage(t('No se pudo aplicar la distribución. Revisa la selección e inténtalo de nuevo.'));
    }
  };

  const handleSaveLaunchPreset = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = presetName.trim();
    if (!cleanName) {
      setPresetError(t('Escribe un nombre para el preset.'));
      return;
    }
    if (!launchSettingsValid) {
      setPresetError(t('Revisa el supply y la liquidez antes de guardar.'));
      return;
    }
    if (!launchBuyAmountsValid) {
      setPresetError(t('Cada compra prevista debe ser un importe positivo válido de hasta 9 decimales.'));
      return;
    }

    const existing = launchPresets.find((preset) => preset.name.toLowerCase() === cleanName.toLowerCase());
    const preset: LaunchPreset = {
      id: existing?.id ?? window.crypto.randomUUID(),
      name: cleanName.slice(0, 32),
      launchPlatform,
      totalSupply,
      liquiditySol,
      securityAssets: [...securityAssets],
      walletAddresses: Array.from(new Set(selectedProjectWalletAddresses)).slice(0, MAX_LAUNCH_WALLETS),
      walletBuyAmounts: Object.fromEntries(Object.entries(launchWalletBuyAmounts)
        .filter(([address, amount]) => selectedProjectWalletAddresses.includes(address) && isValidLaunchBuyAmount(amount))
        .map(([address, amount]) => [address, amount.trim()])),
      buyDelaySeconds: launchBuyDelaySeconds,
      buySlippageBps: launchBuySlippageBps,
    };
    const next = existing
      ? launchPresets.map((item) => item.id === existing.id ? preset : item)
      : [preset, ...launchPresets];
    if (next.length > MAX_LAUNCH_PRESETS) {
      setPresetError(t('Máximo {count} presets guardados.', { count: MAX_LAUNCH_PRESETS }));
      return;
    }

    try {
      window.localStorage.setItem(LAUNCH_PRESETS_STORAGE_KEY, JSON.stringify(next));
      setLaunchPresets(next);
      setSelectedPresetId(preset.id);
      setPresetName('');
      setPresetError('');
      setPresetEditorOpen(false);
      notifyToast({ title: t('Preset guardado'), message: t('La configuración quedó guardada en este navegador.') });
    } catch {
      setPresetError(t('No se pudo guardar el preset en este navegador.'));
    }
  };

  const handleApplyLaunchPreset = () => {
    const preset = launchPresets.find((item) => item.id === selectedPresetId);
    if (!preset) return;
    setLaunchPlatform(preset.launchPlatform ?? 'RAYDIUM');
    if (preset.launchPlatform !== 'PUMP_FUN') setHolderReward(false);
    setTotalSupply(preset.totalSupply);
    setLiquiditySol(preset.liquiditySol);
    setSecurityAssets([...preset.securityAssets]);
    const selectedAddresses = Array.from(new Set(preset.walletAddresses ?? [])).filter((address) => address !== walletAddress).slice(0, MAX_LAUNCH_WALLETS);
    setSelectedProjectWalletAddresses(selectedAddresses);
    setLaunchWalletBuyAmounts(Object.fromEntries(Object.entries(preset.walletBuyAmounts ?? {}).filter(([address, amount]) =>
      selectedAddresses.includes(address) && isValidLaunchBuyAmount(amount),
    )));
    setEqualLaunchBuyAmount('');
    setLaunchBuyAllocationMessage('');
    setLaunchBuyDelaySeconds(preset.buyDelaySeconds ?? 0);
    setLaunchBuySlippageBps(preset.buySlippageBps ?? 100);
    setStep(2);
    setPresetError('');
    notifyToast({ title: t('Preset aplicado'), message: t('Supply, liquidez, seguridad y plan de compra se actualizaron.') });
  };

  const toggleProjectWallet = (address: string) => {
    if (address === walletAddress) return;
    setLaunchBuyAllocationMessage('');
    if (selectedProjectWalletAddresses.includes(address)) {
      setSelectedProjectWalletAddresses(selectedProjectWalletAddresses.filter((item) => item !== address));
      setLaunchWalletBuyAmounts((current) => {
        const next = { ...current };
        delete next[address];
        return next;
      });
      return;
    }
    if (selectedProjectWalletAddresses.length >= MAX_LAUNCH_WALLETS) {
      notifyToast({ title: t('Límite de wallets alcanzado'), message: t('Selecciona hasta {count} wallets para preparar el lanzamiento.', { count: MAX_LAUNCH_WALLETS }) });
      return;
    }
    setSelectedProjectWalletAddresses([...selectedProjectWalletAddresses, address]);
  };

  const handleDeleteLaunchPreset = () => {
    const next = launchPresets.filter((preset) => preset.id !== selectedPresetId);
    try {
      window.localStorage.setItem(LAUNCH_PRESETS_STORAGE_KEY, JSON.stringify(next));
      setLaunchPresets(next);
      setSelectedPresetId(next[0]?.id ?? '');
      setPresetError('');
    } catch {
      setPresetError(t('No se pudo eliminar el preset en este navegador.'));
    }
  };

  const identityReady = Boolean(name.trim() && symbol.trim() && imageBase64);
  const stepCompletions = [identityReady, true, launchSettingsValid && launchBuyAmountsValid, true, Boolean(result)];
  const canNext = step === 0
    ? identityReady
    : step === 2
      ? launchSettingsValid && launchBuyAmountsValid
      : true;
  const stepBlockReason = step === 0
    ? !name.trim() ? t('Escribe el nombre del token para continuar.') : !symbol.trim() ? t('Escribe el símbolo del token para continuar.') : !imageBase64 ? t('Selecciona una imagen para continuar.') : ''
    : step === 2
      ? launchPlatform === 'RAYDIUM' && (!Number.isSafeInteger(supplyValue) || supplyValue <= 0 || supplyValue > 18_446_744_073)
        ? t('El supply debe ser un entero positivo dentro del límite permitido.')
        : launchPlatform === 'RAYDIUM' && (!Number.isFinite(liquidityValue) || liquidityValue <= 0) ? t('La liquidez inicial debe ser mayor que cero.')
          : !launchBuyAmountsValid ? t('Cada compra prevista debe ser un importe positivo válido de hasta 9 decimales.') : ''
      : '';

  const buildLaunchBatchDraft = (id: string, createdAt: number): TokenLaunchBatchDraft | null => {
    if (!walletAddress || !imageBase64) return null;
    const isPumpLaunch = launchPlatform === 'PUMP_FUN';
    const selectedAddresses = [...selectedProjectWalletAddresses];
    return {
      id,
      createdAt,
      creatorWallet: walletAddress,
      launchPlatform,
      name: name.trim(),
      symbol: symbol.trim(),
      description: description.trim(),
      imageBase64,
      totalSupply: isPumpLaunch ? '1000000000' : totalSupply,
      liquiditySol: isPumpLaunch ? '0' : liquiditySol,
      securityAssets: isPumpLaunch ? [] : [...securityAssets],
      holderReward: isPumpLaunch && holderReward,
      twitter: isPumpLaunch ? twitter.trim() : '',
      telegram: isPumpLaunch ? telegram.trim() : '',
      selectedProjectWalletAddresses: selectedAddresses,
      launchWalletBuyAmounts: Object.fromEntries(Object.entries(launchWalletBuyAmounts)
        .filter(([address, amount]) => selectedAddresses.includes(address) && isValidLaunchBuyAmount(amount))
        .map(([address, amount]) => [address, amount.trim()])),
      launchBuyDelaySeconds,
      launchBuySlippageBps,
      status: 'ready',
    };
  };

  const resetLaunchFields = () => {
    setStep(0);
    setLaunchPlatform('RAYDIUM');
    setName('');
    setSymbol('');
    setDescription('');
    setTotalSupply('1000000000');
    setLiquiditySol('1');
    setImageBase64(undefined);
    setImagePreview(undefined);
    setImageError('');
    setSecurityAssets(['mint', 'freeze', 'update']);
    setSelectedProjectWalletAddresses([]);
    setLaunchWalletBuyAmounts({});
    setEqualLaunchBuyAmount('');
    setLaunchBuyAllocationMessage('');
    setLaunchBuyDelaySeconds(0);
    setLaunchBuySlippageBps(100);
    setHolderReward(false);
    setShowSocials(false);
    setTwitter('');
    setTelegram('');
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const queueCreatedTokenLaunchBuys = () => {
    if (!result) return;
    const buyAmounts = result.launchWalletBuyAmounts ?? {};
    queueProjectWalletLaunchSelection(result.mintAddress, {
      walletAddresses: (result.launchWalletAddresses ?? []).filter((address) => isValidLaunchBuyAmount(buyAmounts[address] ?? '')),
      buyAmounts,
      buyDelaySeconds: result.launchWalletBuyDelaySeconds ?? 0,
      buySlippageBps: result.launchWalletBuySlippageBps ?? 100,
    });
  };

  const handleStageBatchDraft = async () => {
    if (!walletAddress || batchStorageWallet !== walletAddress) {
      setBatchStorageError(t('Conecta tu wallet y espera a que cargue su lote.'));
      return;
    }
    if (result || loading || step !== 4 || !identityReady || !launchSettingsValid || !launchBuyAmountsValid) return;
    const existing = activeBatchDraftId ? batchDrafts.find((draft) => draft.id === activeBatchDraftId) : null;
    if (existing && existing.status !== 'ready') {
      setBatchStorageError(t('Solo puedes editar un borrador que aún no se haya firmado.'));
      return;
    }
    if (!existing && batchDrafts.length >= MAX_TOKEN_LAUNCH_BATCH_DRAFTS) {
      setBatchStorageError(t('El lote llegó al máximo de {count} lanzamientos. Elimina un borrador o uno de los lanzamientos completados.', { count: MAX_TOKEN_LAUNCH_BATCH_DRAFTS }));
      return;
    }
    const id = existing?.id ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const draft = buildLaunchBatchDraft(id, existing?.createdAt ?? Date.now());
    if (!draft) {
      setBatchStorageError(t('Selecciona una imagen y revisa los datos del token antes de guardarlo en el lote.'));
      return;
    }
    const nextDrafts = existing
      ? batchDrafts.map((item) => item.id === existing.id ? draft : item)
      : [...batchDrafts, draft];
    try {
      await persistBatchDrafts(nextDrafts);
      setActiveBatchDraftId(null);
      resetLaunchFields();
      notifyToast({ title: t(existing ? 'Borrador actualizado' : 'Borrador añadido al lote'), message: t('El lanzamiento quedó guardado localmente. Cada token requiere su propia revisión y firma.') });
    } catch (caught) {
      notifyToast({ title: t('No se pudo guardar el borrador'), message: userFacingError(caught, t('Inténtalo de nuevo.'), t) });
    }
  };

  const handleLoadBatchDraft = (draft: TokenLaunchBatchDraft) => {
    if (!walletAddress || draft.creatorWallet !== walletAddress) {
      setBatchStorageError(t('Conecta la wallet que guardó este lote antes de abrir el borrador.'));
      return;
    }
    if (draft.status !== 'ready') return;
    setResult(null);
    setRestoredWallet(walletAddress);
    setGoToPool(false);
    setSuccessDismissed(false);
    setSummaryDismissed(false);
    setCreatedPool(null);
    setPoolStatus(undefined);
    setPendingSubmission(null);
    setLaunchPlatform(draft.launchPlatform);
    setName(draft.name);
    setSymbol(draft.symbol);
    setDescription(draft.description);
    setTotalSupply(draft.totalSupply);
    setLiquiditySol(draft.liquiditySol);
    setImageBase64(draft.imageBase64);
    setImagePreview(draft.imageBase64);
    setImageError('');
    setSecurityAssets([...draft.securityAssets]);
    setHolderReward(draft.holderReward);
    setTwitter(draft.twitter);
    setTelegram(draft.telegram);
    setShowSocials(Boolean(draft.twitter || draft.telegram));
    setSelectedProjectWalletAddresses([...draft.selectedProjectWalletAddresses]);
    setLaunchWalletBuyAmounts({ ...draft.launchWalletBuyAmounts });
    setEqualLaunchBuyAmount('');
    setLaunchBuyAllocationMessage('');
    setLaunchBuyDelaySeconds(draft.launchBuyDelaySeconds);
    setLaunchBuySlippageBps(draft.launchBuySlippageBps);
    setActiveBatchDraftId(draft.id);
    setStep(4);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const handleRemoveBatchDraft = async (draftId: string) => {
    const draft = batchDrafts.find((item) => item.id === draftId);
    if (!draft || draft.status === 'pending') return;
    try {
      await persistBatchDrafts(batchDrafts.filter((item) => item.id !== draftId));
      if (activeBatchDraftId === draftId) setActiveBatchDraftId(null);
    } catch (caught) {
      notifyToast({ title: t('No se pudo eliminar el borrador'), message: userFacingError(caught, t('Inténtalo de nuevo.'), t) });
    }
  };

  const handleRetryBatchDraft = (draft: TokenLaunchBatchDraft) => {
    if (!walletAddress || draft.creatorWallet !== walletAddress) {
      setBatchStorageError(t('Conecta la wallet que preparó esta transacción para reintentar su registro.'));
      return;
    }
    if (draft.status !== 'pending' || !draft.pendingSubmission) return;
    setActiveBatchDraftId(draft.id);
    void handleRetrySubmission(draft.pendingSubmission, draft.id);
  };

  const handleDiscardBatchReview = () => {
    if (!activeBatchDraftId) return;
    setActiveBatchDraftId(null);
    resetLaunchFields();
  };

  const submitSignedTransaction = async (payload: PendingTokenSubmission, batchDraftId?: string | null) => {
    setOperationStage('registering');
    const isPumpLaunch = payload.launchPlatform === 'PUMP_FUN';
    const submitPayload = isPumpLaunch
      ? {
        attemptId: payload.attemptId,
        signedTransaction: payload.signedTransaction,
        mintAddress: payload.mintAddress,
        userWallet: payload.userWallet,
      }
      : payload;
    const submitRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${isPumpLaunch ? '/api/pump/submit-transaction' : '/api/submit-transaction'}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitPayload),
    });
    const submitData = await submitRes.json();
    if (!submitRes.ok || !submitData.success) {
      if (submitData.error === EXPIRED_TRANSACTION_MESSAGE) setPendingSubmission(null);
      const errorId = submitData.errorId ? ` (ID: ${submitData.errorId})` : '';
      throw new Error(`${submitData.error || 'No se pudo registrar el token.'}${errorId}`);
    }

    const batchDraft = batchDraftId ? batchDraftsRef.current.find((draft) => draft.id === batchDraftId) : null;
    const storedResult: StoredTokenCreation = {
      walletAddress: payload.userWallet,
      txId: submitData.txId,
      mintAddress: payload.mintAddress,
      launchPlatform: payload.launchPlatform,
      bondingCurveAddress: typeof submitData.bondingCurveAddress === 'string' ? submitData.bondingCurveAddress : undefined,
      name: payload.name,
      symbol: payload.symbol,
      totalSupply: String(payload.totalSupply),
      liquiditySol: String(payload.liquiditySol),
      createdPool: null,
      launchWalletAddresses: [...(batchDraft?.selectedProjectWalletAddresses ?? selectedProjectWalletAddresses)],
      launchWalletBuyAmounts: Object.fromEntries(Object.entries(batchDraft?.launchWalletBuyAmounts ?? launchWalletBuyAmounts)
        .filter(([address, amount]) => (batchDraft?.selectedProjectWalletAddresses ?? selectedProjectWalletAddresses).includes(address) && isValidLaunchBuyAmount(amount))
        .map(([address, amount]) => [address, amount.trim()])),
      launchWalletBuyDelaySeconds: batchDraft?.launchBuyDelaySeconds ?? launchBuyDelaySeconds,
      launchWalletBuySlippageBps: batchDraft?.launchBuySlippageBps ?? launchBuySlippageBps,
    };
    writeStoredTokenCreation(storedResult);
    setRestoredWallet(payload.userWallet);
    setResult({
      txId: submitData.txId,
      mintAddress: payload.mintAddress,
      walletAddress: payload.userWallet,
      launchPlatform: payload.launchPlatform,
      bondingCurveAddress: storedResult.bondingCurveAddress,
      launchWalletAddresses: storedResult.launchWalletAddresses,
      launchWalletBuyAmounts: storedResult.launchWalletBuyAmounts,
      launchWalletBuyDelaySeconds: storedResult.launchWalletBuyDelaySeconds,
      launchWalletBuySlippageBps: storedResult.launchWalletBuySlippageBps,
    });
    setSuccessDismissed(false);
    setSummaryDismissed(false);
    setCreatedPool(null);
    setPoolStatus(undefined);
    setPendingSubmission(null);
    if (batchDraft) {
      const nextDrafts = batchDraftsRef.current.map((draft) => draft.id === batchDraft.id
        ? { ...draft, status: 'complete' as const, txId: submitData.txId, mintAddress: payload.mintAddress, pendingSubmission: undefined }
        : draft);
      batchDraftsRef.current = nextDrafts;
      setBatchDrafts(nextDrafts);
      setActiveBatchDraftId(null);
      void writeTokenLaunchBatch(payload.userWallet, nextDrafts).then(() => setBatchStorageError('')).catch((caught) => {
        setBatchStorageError(userFacingError(caught, t('El token se creó, pero no se pudo actualizar el estado guardado del lote.'), t));
      });
    }
  };

  const handleRetrySubmission = async (payloadOverride?: PendingTokenSubmission, batchDraftId?: string | null) => {
    const payload = payloadOverride ?? pendingSubmission;
    if (!payload) return;
    setLoading(true);
    setOperationStage('registering');
    try {
      await submitSignedTransaction(payload, batchDraftId ?? activeBatchDraftId);
    } catch (err: any) {
      if (batchDraftId && String(err?.message || '').startsWith(EXPIRED_TRANSACTION_MESSAGE)) {
        try {
          await updateBatchDraft(batchDraftId, (draft) => ({ ...draft, status: 'ready', pendingSubmission: undefined }));
        } catch { /* The on-screen recovery still blocks another batch launch until reload. */ }
      }
      const canRetry = !String(err?.message || '').startsWith(EXPIRED_TRANSACTION_MESSAGE);
      notifyToast({
        title: t('No se pudo registrar el token'),
        message: userFacingError(err, t('Inténtalo de nuevo.'), t),
        action: canRetry ? { label: t('Reintentar registro'), onClick: () => { void handleRetrySubmission(payload, batchDraftId); } } : undefined,
      });
    } finally {
      setLoading(false);
      setOperationStage(null);
    }
  };

  const handleSubmit = async () => {
    if (loading || pendingSubmission || result || isRestoringResult) return;
    if (!publicKey || !signTransaction) {
      notifyToast({ title: t('Conecta tu wallet'), message: t('Conecta una wallet de Solana para crear el token.') });
      return;
    }
    if (activeBatchDraftId && (!activeBatchDraft || activeBatchDraft.status !== 'ready' || activeBatchDraft.creatorWallet !== publicKey.toBase58())) {
      notifyToast({ title: t('Revisa el borrador del lote'), message: t('Este borrador no está listo para firmarse con la wallet conectada. Vuelve a cargarlo desde el lote.') });
      return;
    }
    setLoading(true);
    setOperationStage('preparing');
    let retryPayload: PendingTokenSubmission | null = null;

    try {
      const isPumpLaunch = launchPlatform === 'PUMP_FUN';
      if (activeBatchDraftId) {
        const reviewedDraft = buildLaunchBatchDraft(activeBatchDraftId, activeBatchDraft?.createdAt ?? Date.now());
        if (!reviewedDraft) throw new Error(t('El borrador necesita una imagen y datos válidos antes de preparar la transacción.'));
        await updateBatchDraft(activeBatchDraftId, () => reviewedDraft);
      }
      const createBody = {
        userWallet: publicKey.toBase58(),
        name,
        symbol,
        description,
        imageBase64,
        ...(isPumpLaunch
          ? {
            holderReward,
            ...(twitter.trim() ? { twitter: twitter.trim() } : {}),
            ...(telegram.trim() ? { telegram: telegram.trim() } : {}),
          }
          : {
            totalSupply: Number(totalSupply),
            liquiditySol: Number(liquiditySol),
            securityAssets,
          }),
      };
      const createRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${isPumpLaunch ? '/api/pump/create-token' : '/api/create-token'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Failed to prepare token creation');
      if (typeof createData.attemptId !== 'string') throw new Error('El servidor no devolvió el identificador del intento. Recarga y vuelve a probar.');
      if (!Number.isSafeInteger(createData.lastValidBlockHeight) || createData.lastValidBlockHeight <= 0) {
        reportTokenAttemptOutcome(createData.attemptId, publicKey.toBase58(), createData.mintAddress, 'preflight_failed');
        throw new Error(t('El servidor no devolvió la vigencia de la transacción. Prepara de nuevo el token.'));
      }

      // Esta tx ya viene con feePayer, recentBlockhash, y la firma parcial
      // del mint puestas por el backend — no tocar nada más acá.
      const tx = Transaction.from(Buffer.from(createData.transaction, 'base64'));
      if (!tx.feePayer?.equals(publicKey) || !tx.recentBlockhash) {
        reportTokenAttemptOutcome(createData.attemptId, publicKey.toBase58(), createData.mintAddress, 'preflight_failed');
        throw new Error(t('La transacción preparada no coincide con esta wallet. Vuelve a intentarlo.'));
      }

      let blockhashState: Awaited<ReturnType<typeof checkPreparedBlockhash>>;
      try {
        const rpc = new Connection(process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com');
        blockhashState = await checkPreparedBlockhash(rpc, tx.recentBlockhash, createData.lastValidBlockHeight);
      } catch {
        reportTokenAttemptOutcome(createData.attemptId, publicKey.toBase58(), createData.mintAddress, 'preflight_failed');
        throw new Error(t('No se pudo comprobar la vigencia en Solana. No se solicitó la firma; revisa la conexión a Devnet e inténtalo de nuevo.'));
      }
      if (blockhashState !== 'valid') {
        const expired = blockhashState === 'expired';
        reportTokenAttemptOutcome(
          createData.attemptId,
          publicKey.toBase58(),
          createData.mintAddress,
          expired ? 'blockhash_expired' : 'rpc_mismatch',
        );
        throw new Error(t(expired
          ? 'El blockhash venció antes de abrir tu wallet. No se solicitó la firma. Prepara de nuevo el token.'
          : 'El RPC del navegador no reconoce el blockhash. No se solicitó la firma; comprueba que Wire y Phantom estén en Devnet.'));
      }

      let signedTx: Transaction;
      try {
        setOperationStage('signature');
        signedTx = await signTransaction(tx);
      } catch (signError) {
        reportTokenAttemptOutcome(createData.attemptId, publicKey.toBase58(), createData.mintAddress, 'signature_rejected');
        throw signError;
      }
      setOperationStage('preparing');
      if (!signedTx.feePayer?.equals(publicKey) || signedTx.recentBlockhash !== tx.recentBlockhash) {
        reportTokenAttemptOutcome(createData.attemptId, publicKey.toBase58(), createData.mintAddress, 'preflight_failed');
        throw new Error(t('La wallet modificó la transacción preparada. No se envió.'));
      }
      let signedBlockhashState: Awaited<ReturnType<typeof checkPreparedBlockhash>>;
      try {
        const rpc = new Connection(process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.devnet.solana.com');
        signedBlockhashState = await checkPreparedBlockhash(rpc, signedTx.recentBlockhash, createData.lastValidBlockHeight);
      } catch {
        reportTokenAttemptOutcome(createData.attemptId, publicKey.toBase58(), createData.mintAddress, 'preflight_failed');
        throw new Error(t('No se pudo volver a comprobar la vigencia después de firmar. No se envió el token; vuelve a prepararlo.'));
      }
      if (signedBlockhashState !== 'valid') {
        const expired = signedBlockhashState === 'expired';
        reportTokenAttemptOutcome(
          createData.attemptId,
          publicKey.toBase58(),
          createData.mintAddress,
          expired ? 'blockhash_expired' : 'rpc_mismatch',
        );
        throw new Error(t(expired
          ? 'El blockhash venció mientras revisabas en Phantom. No se envió el token; prepara la operación otra vez.'
          : 'La RPC no confirmó la transacción firmada. No se envió el token; comprueba que Wire y Phantom estén en Devnet.'));
      }
      const payload: PendingTokenSubmission = {
        attemptId: createData.attemptId,
        signedTransaction: signedTx.serialize().toString('base64'),
        mintAddress: createData.mintAddress,
        userWallet: publicKey.toBase58(),
        launchPlatform,
        name,
        symbol,
        totalSupply: isPumpLaunch ? 1_000_000_000 : Number(totalSupply),
        liquiditySol: isPumpLaunch ? 0 : Number(liquiditySol),
      };
      if (activeBatchDraftId) {
        try {
          await updateBatchDraft(activeBatchDraftId, (draft) => ({
            ...draft,
            status: 'pending',
            mintAddress: payload.mintAddress,
            pendingSubmission: payload,
          }));
        } catch (caught) {
          reportTokenAttemptOutcome(payload.attemptId, payload.userWallet, payload.mintAddress, 'preflight_failed');
          setPendingSubmission(null);
          throw new Error(t('No se pudo guardar el borrador firmado de forma local. La transacción no se envió; vuelve a prepararla.'));
        }
      }
      retryPayload = payload;
      setPendingSubmission(payload);
      await submitSignedTransaction(payload, activeBatchDraftId);
    } catch (err: any) {
      const canRetry = !String(err?.message || '').startsWith(EXPIRED_TRANSACTION_MESSAGE);
      const retryCandidate = retryPayload ?? pendingSubmission;
      notifyToast({
        title: t('No se pudo crear el token'),
        message: userFacingError(err, t('Ocurrió un error inesperado. Intenta de nuevo.'), t),
        action: canRetry && retryCandidate ? { label: t('Reintentar registro'), onClick: () => { void handleRetrySubmission(retryCandidate, activeBatchDraftId); } } : undefined,
      });
    } finally {
      setLoading(false);
      setOperationStage(null);
    }
  };

  const handleCreateAnotherToken = () => {
    const previousWallet = result?.walletAddress;
    if (previousWallet) {
      try { window.localStorage.removeItem(tokenCreationStorageKey(previousWallet)); } catch { /* Continue with the in-memory reset. */ }
    }
    setResult(null);
    setGoToPool(false);
    setSuccessDismissed(false);
    setSummaryDismissed(false);
    setContinuationHighlighted(false);
    setCreatedPool(null);
    setPoolStatus(undefined);
    setPendingSubmission(null);
    setStep(0);
    setLaunchPlatform('RAYDIUM');
    setName('');
    setSymbol('');
    setDescription('');
    setTotalSupply('1000000000');
    setLiquiditySol('1');
    setImageBase64(undefined);
    setImagePreview(undefined);
    setImageError('');
    setSecurityAssets(['mint', 'freeze', 'update']);
    setSelectedProjectWalletAddresses([]);
    setLaunchWalletBuyAmounts({});
    setEqualLaunchBuyAmount('');
    setLaunchBuyAllocationMessage('');
    setLaunchBuyDelaySeconds(0);
    setLaunchBuySlippageBps(100);
    setShowSocials(false);
    setTwitter('');
    setTelegram('');
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const handleSummaryVisibilityChange = (dismissed: boolean) => {
    if (result) {
      const saved = readStoredTokenCreation(result.walletAddress);
      if (saved?.mintAddress === result.mintAddress) {
        writeStoredTokenCreation({ ...saved, summaryDismissed: dismissed });
      }
    }
    setSummaryDismissed(dismissed);
  };

  if (result && goToPool && result.launchPlatform === 'RAYDIUM') {
    return (
      <PoolCreate
        mintAddress={result.mintAddress}
        tokenSymbol={symbol}
        defaultTokenAmount={totalSupply}
        defaultSolAmount={liquiditySol}
        onBack={() => setGoToPool(false)}
        onPoolCreated={(pool) => {
          setCreatedPool(pool);
          setPoolStatus(undefined);
          setSuccessDismissed(true);
          const saved = readStoredTokenCreation(result.walletAddress);
          if (saved?.mintAddress === result.mintAddress) writeStoredTokenCreation({ ...saved, createdPool: pool });
        }}
      />
    );
  }

  return (
    <div className="wire-form mx-auto w-full wire-enter">
      <div className="wire-launch-layout">
        <section className="wire-launch-main" aria-label={t('Formulario de creación')}>
      <ol className="wire-form-stepper mb-5 grid grid-cols-5 gap-2 sm:gap-4" aria-label={t('Pasos de creación del token')}>
        {STEPS.map((label, i) => {
          const complete = (i < step && stepCompletions[i]) || (i === 4 && Boolean(result));
          const status = complete ? t('Completado') : i === step ? t('En curso') : t('Pendiente');
          return (
            <li key={label} aria-current={i === step ? 'step' : undefined} aria-label={`${t(label)}: ${status}`} className="wire-form-step min-w-0">
              <div
                className="mb-2 h-1 rounded-full"
                style={{ background: complete || i === step ? 'var(--wire-green)' : 'var(--line)' }}
                aria-hidden="true"
              />
              <div className="flex min-w-0 items-center justify-between gap-1">
                <span className="block truncate font-mono text-xs" style={{ color: complete || i === step ? 'var(--text)' : 'var(--muted)' }}>
                  {t(label)}
                </span>
                {complete && <Check size={14} aria-hidden="true" style={{ color: 'var(--wire-green)' }} />}
              </div>
              <span className="mt-1 block truncate text-[10px]" style={{ color: complete ? 'var(--wire-green)' : 'var(--muted)' }}>
                {status}
              </span>
            </li>
          );
        })}
      </ol>

      {walletAddress && (batchDrafts.length > 0 || batchStorageError || batchStorageWallet !== walletAddress) && (
        <section className="wire-panel mb-4 rounded-2xl p-3 sm:p-4" aria-label={t('Lote de lanzamientos')}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold">{t('Lote de lanzamientos')}</h2>
              <p className="mt-1 max-w-[68ch] text-xs leading-relaxed text-[var(--muted)]">
                {t('Guarda hasta {count} borradores en este navegador. Cada token se prepara, revisa y firma por separado; no se envía automáticamente.', { count: MAX_TOKEN_LAUNCH_BATCH_DRAFTS })}
              </p>
            </div>
            <span className="shrink-0 font-mono text-xs text-[var(--muted)]">{batchDrafts.length} / {MAX_TOKEN_LAUNCH_BATCH_DRAFTS}</span>
          </div>
          {batchStorageWallet !== walletAddress && !batchStorageError && <p className="mt-3 text-xs text-[var(--muted)]" role="status">{t('Cargando borradores guardados…')}</p>}
          {batchDrafts.length > 0 && (
            <ul className="mt-3 divide-y divide-[var(--line)]">
              {batchDrafts.map((draft, index) => (
                <li key={draft.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{index + 1}. {draft.name} <span className="font-mono text-[var(--muted)]">({draft.symbol})</span></p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {draft.launchPlatform === 'PUMP_FUN' ? 'Pump.fun' : 'Raydium CPMM'} · {t(draft.status === 'ready' ? 'Pendiente de revisión' : draft.status === 'pending' ? 'Firmada · registro pendiente' : 'Creado')}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {draft.status === 'ready' && <button type="button" onClick={() => handleLoadBatchDraft(draft)} disabled={batchBusy || loading || batchStorageWallet !== walletAddress || Boolean(activeBatchDraftId && activeBatchDraftId !== draft.id)} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t(activeBatchDraftId === draft.id ? 'Borrador abierto' : 'Revisar borrador')}</button>}
                    {draft.status === 'pending' && draft.pendingSubmission && <button type="button" onClick={() => handleRetryBatchDraft(draft)} disabled={batchBusy || loading || batchStorageWallet !== walletAddress} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Reintentar registro firmado')}</button>}
                    {draft.status === 'complete' && draft.txId && <a href={`https://explorer.solana.com/tx/${draft.txId}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Ver transacción')}</a>}
                    {draft.status !== 'pending' && <button type="button" onClick={() => void handleRemoveBatchDraft(draft.id)} disabled={batchBusy || loading} aria-label={t('Eliminar borrador de {name}', { name: draft.name })} className="wire-button wire-button-quiet min-h-11 px-3 text-xs text-[var(--danger)]">{t('Quitar')}</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {activeBatchDraft && <p className="mt-2 text-xs text-[var(--wire-green)]" role="status">{t('Revisando: {name}. Comprueba los cinco pasos y confirma cada firma en Phantom.', { name: activeBatchDraft.name })}</p>}
          {batchStorageError && <p className="mt-2 text-xs text-[var(--danger,#ff8b8b)]" role="alert">{batchStorageError}</p>}
        </section>
      )}

      <section className="wire-panel mb-4 rounded-2xl p-3 sm:p-4" aria-label={t('Presets de lanzamiento')}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="grid min-w-0 gap-1.5 text-xs text-[var(--muted)]">
            {t('Configuración guardada')}
            <select
              value={selectedPresetId}
              onChange={(event) => { setSelectedPresetId(event.target.value); setPresetError(''); }}
              disabled={!presetStorageReady || launchPresets.length === 0 || loading}
              className="wire-input min-h-11 w-full rounded-lg px-3 py-2.5 text-sm"
            >
              {launchPresets.length === 0 ? <option value="">{t('Aún no hay presets')}</option> : null}
              {launchPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleApplyLaunchPreset} disabled={!selectedPresetId || loading} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
              {t('Aplicar')}
            </button>
            <button type="button" onClick={() => { setPresetEditorOpen((open) => !open); setPresetError(''); }} disabled={loading || !presetStorageReady} aria-expanded={presetEditorOpen} className="wire-button wire-button-primary min-h-11 px-3 text-sm">
              {t('Guardar preset')}
            </button>
            {selectedPresetId && (
              <button type="button" onClick={handleDeleteLaunchPreset} disabled={loading} aria-label={t('Eliminar preset seleccionado')} className="wire-button wire-button-quiet min-h-11 min-w-11 p-0 text-[var(--danger)]">
                <Trash2 size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{t(launchPlatform === 'PUMP_FUN'
          ? 'El preset guarda el destino Pump.fun, las wallets, compras opcionales, pausa y slippage; nombre, imagen y redes se definen para cada token.'
          : 'El preset guarda supply, liquidez, medidas de seguridad, wallets y el plan opcional de compras; nombre, imagen y redes se definen para cada token.')}</p>
        {presetEditorOpen && (
          <form onSubmit={handleSaveLaunchPreset} className="mt-3 grid gap-2 border-t border-[var(--line)] pt-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
            <label className="grid gap-1.5 text-xs text-[var(--muted)]">
              {t('Nombre del preset')}
              <input value={presetName} onChange={(event) => setPresetName(event.target.value)} maxLength={32} autoComplete="off" className="wire-input min-h-11 w-full rounded-lg px-3 text-sm" placeholder={t('Ejemplo: Lanzamiento base')} />
            </label>
            <button type="button" onClick={() => { setPresetEditorOpen(false); setPresetError(''); }} className="wire-button wire-button-quiet min-h-11 px-3 text-sm">{t('Cancelar')}</button>
            <button type="submit" disabled={!presetName.trim()} className="wire-button wire-button-primary min-h-11 px-3 text-sm">{t('Guardar')}</button>
          </form>
        )}
        {presetError && <p className="mt-2 text-sm text-[var(--danger,#ff8b8b)]" role="alert">{presetError}</p>}
      </section>

      <div className="wire-panel wire-form-panel rounded-2xl p-4 sm:p-6">
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <p className="wire-kicker mb-2">{t('01 / IDENTIDAD')}</p>
              <h2 className="font-display text-base font-semibold text-white sm:text-lg">{t('Define tu token')}</h2>
            </div>
            <fieldset disabled={Boolean(result) || loading}>
              <legend className="wire-label">{t('Destino del lanzamiento')}</legend>
              <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={t('Destino del lanzamiento')}>
                {(['RAYDIUM', 'PUMP_FUN'] as const).map((platform) => {
                  const selected = launchPlatform === platform;
                  const label = platform === 'RAYDIUM' ? t('Raydium CPMM') : t('Pump.fun · bonding curve');
                  return (
                    <button
                      key={platform}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => { setLaunchPlatform(platform); if (platform !== 'PUMP_FUN') setHolderReward(false); }}
                      className={`wire-button wire-button-secondary min-h-12 justify-start px-3 text-left${selected ? ' border-[var(--wire-green)] text-[var(--wire-green)]' : ''}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{t(launchPlatform === 'PUMP_FUN'
                ? 'Crear una bonding curve de Pump.fun en Devnet. Este lanzamiento no crea una pool de Raydium.'
                : 'El token se crea primero; después podrás configurar una pool de Raydium CPMM en una transacción separada.')}</p>
              {launchPlatform === 'PUMP_FUN' && (
                <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3">
                  <label className={`flex items-start gap-3 text-sm ${holderRewardsStatus === 'enabled' ? 'cursor-pointer' : 'cursor-not-allowed opacity-75'}`}>
                    <input type="checkbox" checked={holderReward} disabled={holderRewardsStatus !== 'enabled' || loading || Boolean(result)} onChange={(event) => setHolderReward(event.target.checked)} className="mt-0.5 accent-[var(--wire-green)]" />
                    <span><strong className="block text-[var(--text)]">{t('Activar Holder Rewards')}</strong><span className="mt-1 block text-xs leading-relaxed text-[var(--muted)]">{holderRewardsStatus === 'loading' ? t('Consultando disponibilidad actual de Pump en Devnet…') : holderRewardsStatus === 'disabled' ? t('Pump desactivó la creación de monedas Holder Rewards en Devnet. El lanzamiento normal sigue disponible.') : holderRewardsStatus === 'error' ? t('No se pudo comprobar el estado de Pump. Holder Rewards queda desactivado; puedes continuar con el lanzamiento normal.') : t('Pump distribuye automáticamente las recompensas a holders. Esta elección queda fijada al crear el token y no tiene un retiro manual.')}</span></span>
                  </label>
                </div>
              )}
            </fieldset>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="token-name" className="wire-label">{t('Nombre')}</label>
                <input
                  id="token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={32}
                  placeholder="Nutcoin"
                  autoComplete="off"
                  required
                  className="wire-input w-full rounded-lg px-3 py-2.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="token-symbol" className="wire-label">{t('Símbolo')}</label>
                <input
                  id="token-symbol"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  maxLength={8}
                  placeholder="NUT"
                  autoComplete="off"
                  required
                  className="wire-input w-full rounded-lg px-3 py-2.5 text-sm"
                />
              </div>
            </div>
            <div>
              <label htmlFor="token-image" className="wire-label">{t('Imagen del token')}</label>
              <label htmlFor="token-image" className="wire-upload flex min-h-36 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line)] bg-[var(--surface-2)] p-6 text-center text-sm text-[var(--muted)] transition-colors">
                {imagePreview ? (
                  <img src={imagePreview} alt="Vista previa de la imagen del token" className="h-16 w-16 rounded-lg object-cover" />
                ) : (
                  <>
                    <ImagePlus size={22} strokeWidth={1.7} aria-hidden="true" />
                    <span>{t('Selecciona una imagen para tu token')}</span>
                  </>
                )}
                <input
                  id="token-image"
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={handleImageChange}
                  aria-describedby="token-image-help"
                  className="sr-only"
                />
              </label>
              <p id="token-image-help" className="mt-2 text-xs text-[var(--muted)]">{t('PNG, JPEG, WebP o GIF · hasta 2 MB')}</p>
              {imageError && <p className="mt-1 text-sm text-[var(--danger)]" role="alert">{imageError}</p>}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <p className="wire-kicker mb-2">{t('02 / METADATOS')}</p>
              <h2 className="font-display text-base font-semibold text-white sm:text-lg">{t('Presenta tu token')}</h2>
            </div>
            <div>
              <label htmlFor="token-description" className="wire-label">{t('Descripción')}</label>
              <textarea
                id="token-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder={t('¿De qué va tu token?')}
                className="wire-input w-full rounded-lg px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold">{t('Redes sociales')}</h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">{t('Agrega enlaces públicos a tu token.')}</p>
                </div>
                <button type="button" role="switch" aria-checked={showSocials} aria-controls="token-social-fields" aria-label={t('Agregar redes sociales')} onClick={() => setShowSocials(!showSocials)} className="wire-switch" data-checked={showSocials}>
                  <span className="wire-switch-thumb" aria-hidden="true" />
                </button>
              </div>
              {showSocials && (
                <div id="token-social-fields" className="grid gap-4 pt-2 sm:grid-cols-2">
                  <div>
                    <label htmlFor="token-twitter" className="wire-label">X / Twitter</label>
                    <input id="token-twitter" type="url" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://x.com/tutoken" className="wire-input w-full rounded-lg px-3 py-2.5 text-sm" />
                  </div>
                  <div>
                    <label htmlFor="token-telegram" className="wire-label">Telegram</label>
                    <input id="token-telegram" type="url" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/tutoken" className="wire-input w-full rounded-lg px-3 py-2.5 text-sm" />
                  </div>
                </div>
              )}
            </div>
            <p className="rounded-lg border border-[var(--line)] px-3 py-2.5 text-xs leading-relaxed text-[var(--muted)]">{t('La descripción y los enlaces se publican como metadata del token en la red.')}</p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <p className="wire-kicker mb-2">{t('03 / OFERTA')}</p>
              <h2 className="font-display text-base font-semibold text-white sm:text-lg">{t('Oferta y liquidez inicial')}</h2>
            </div>
            {launchPlatform === 'RAYDIUM' ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="token-supply" className="wire-label">{t('Total supply')}</label>
                <input
                  id="token-supply"
                  type="number"
                  min="1"
                  max="18446744073"
                  step="1"
                  value={totalSupply}
                  onChange={(e) => setTotalSupply(e.target.value)}
                  required
                  className="wire-input w-full rounded-lg px-3 py-2.5 text-sm font-mono"
                />
                <p className="mt-2 text-xs text-[var(--muted)]">{t('1,000M por defecto · 9 decimales')}</p>
              </div>
              <div>
                <label htmlFor="token-liquidity" className="wire-label">{t('Liquidez inicial (SOL)')}</label>
                <input
                  id="token-liquidity"
                  type="number"
                  min="0.000000001"
                  step="0.1"
                  value={liquiditySol}
                  onChange={(e) => setLiquiditySol(e.target.value)}
                  required
                  className="wire-input w-full rounded-lg px-3 py-2.5 text-sm font-mono"
                />
                <p className="mt-2 text-xs text-[var(--muted)]">{t('Se aporta después al crear la pool; no forma parte de la creación del token.')}</p>
              </div>
            </div>
            ) : (
              <section className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4" aria-label={t('Supply fijo del programa')}>
                <p className="text-xs text-[var(--muted)]">{t('Supply fijo del programa')}</p>
                <p className="mt-1 font-mono text-lg">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(1_000_000_000)} {symbol || 'TOKEN'}</p>
                <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{t('Pump.fun fija el supply en 1.000.000.000 tokens con 6 decimales. El precio se forma en la curva; no depositas liquidez inicial como en Raydium.')}</p>
              </section>
            )}
            <dl className="grid gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-[var(--muted)]">{t('Red')}</dt><dd className="mt-1 font-semibold">Solana Devnet</dd></div>
              <div><dt className="text-xs text-[var(--muted)]">{t('Estándar')}</dt><dd className="mt-1 font-semibold">{launchPlatform === 'PUMP_FUN' ? 'Token-2022 · 6 decimales' : t('Token SPL · 9 decimales')}</dd></div>
              <div><dt className="text-xs text-[var(--muted)]">{t('Mercado posterior')}</dt><dd className="mt-1 font-semibold">{launchPlatform === 'PUMP_FUN' ? t('Pump.fun → PumpSwap · SOL') : 'Raydium CPMM · SOL'}</dd></div>
            </dl>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t(launchPlatform === 'PUMP_FUN'
              ? 'La curva Pump.fun opera hasta graduarse; después, Wire usa PumpSwap automáticamente. Revisa el mercado y la cotización antes de firmar.'
              : 'Crear el token y crear la pool son dos transacciones distintas. La pool habilita los intercambios y requiere otra firma en Phantom.')}</p>
            <section className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4" aria-labelledby="launch-wallet-selection-title">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 id="launch-wallet-selection-title" className="text-sm font-semibold">{t('Prepara wallets del lanzamiento')}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('La selección se guarda con el token. Wire consultará la curva Pump.fun/PumpSwap o la pool de Raydium según corresponda; cada compra requiere cotización actual y confirmación manual por wallet. Este asistente no envía compras.')}</p>
                </div>
                <span className="rounded-full border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--muted)]">{selectedProjectWalletAddresses.length}/{MAX_LAUNCH_WALLETS}</span>
              </div>
              {projectWalletsLoading ? (
                <p className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]" role="status"><span className="wire-loading-mark" aria-hidden="true" />{t('Cargando wallets de la bóveda…')}</p>
              ) : projectWalletsError ? (
                <p className="mt-3 text-xs text-[var(--danger,#ff8b8b)]" role="alert">{projectWalletsError}</p>
              ) : projectWallets.length ? (
                <>
                <fieldset disabled={loading} className="mt-3 grid gap-2 disabled:opacity-70">
                  <legend className="sr-only">{t('Wallets de proyecto para preparar')}</legend>
                  {projectWallets.map((wallet) => {
                    const selected = selectedProjectWalletAddresses.includes(wallet.address);
                    const isConnectedWallet = wallet.address === walletAddress;
                    const atLimit = selectedProjectWalletAddresses.length >= MAX_LAUNCH_WALLETS;
                    return (
                      <div key={wallet.address} className={`grid gap-2 rounded-lg border border-[var(--line)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.5fr)] ${isConnectedWallet ? 'opacity-60' : ''}`}>
                        <label htmlFor={`launch-wallet-${wallet.address}`} className={`flex min-h-11 min-w-0 items-center gap-3 ${isConnectedWallet ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                          <input id={`launch-wallet-${wallet.address}`} type="checkbox" checked={selected} disabled={isConnectedWallet || (!selected && atLimit)} onChange={() => toggleProjectWallet(wallet.address)} className="h-4 w-4 shrink-0 accent-[var(--wire-green)]" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{wallet.label || t('Wallet sin nombre')}</span>
                            <code className="block truncate text-[10px] text-[var(--muted)]">{wallet.address}</code>
                          </span>
                          <span className="shrink-0 rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--muted)]">{isConnectedWallet ? t('Wallet conectada') : projectWalletRoleLabel(wallet.role, t)}</span>
                        </label>
                        {selected && !isConnectedWallet && (
                          <label className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center gap-2 text-xs text-[var(--muted)]">
                            <span>{t('Compra prevista (opcional)')}</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              autoComplete="off"
                              value={launchWalletBuyAmounts[wallet.address] ?? ''}
                              onChange={(event) => { setLaunchWalletBuyAmounts((current) => ({ ...current, [wallet.address]: event.target.value })); setLaunchBuyAllocationMessage(''); }}
                              placeholder="0.10"
                              aria-label={t('Importe previsto de compra en SOL para {wallet}', { wallet: wallet.label || wallet.address.slice(0, 8) })}
                              aria-invalid={Boolean(launchWalletBuyAmounts[wallet.address]?.trim()) && !isValidLaunchBuyAmount(launchWalletBuyAmounts[wallet.address] ?? '')}
                              className="wire-input min-h-11 min-w-0 px-2 font-mono"
                            />
                            <span>SOL</span>
                          </label>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
                {selectedProjectWalletAddresses.length > 0 && (
                  <div className="mt-3 grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <label htmlFor="launch-equal-buy-amount" className="grid gap-1.5 text-xs text-[var(--muted)]">
                      {t('Importe igual por wallet')} · SOL
                      <input
                        id="launch-equal-buy-amount"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={equalLaunchBuyAmount}
                        onChange={(event) => { setEqualLaunchBuyAmount(event.target.value); setLaunchBuyAllocationMessage(''); }}
                        placeholder="0.10"
                        aria-invalid={Boolean(equalLaunchBuyAmount.trim()) && !isValidLaunchBuyAmount(equalLaunchBuyAmount)}
                        className="wire-input min-h-11 w-full font-mono"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={applyEqualLaunchBuyAmount}
                      disabled={loading || !selectedProjectWalletAddresses.length || !isValidLaunchBuyAmount(equalLaunchBuyAmount)}
                      className="wire-button wire-button-secondary min-h-11 justify-center"
                    >{t('Aplicar a las seleccionadas')}</button>
                    <p className="text-xs leading-relaxed text-[var(--muted)] sm:col-span-2">{t('Copia este importe a cada wallet seleccionada. Después puedes ajustar cada una; aquí no se envía ninguna compra.')}</p>
                    {launchBuyAllocationMessage && <p className="text-xs text-[var(--wire-green)] sm:col-span-2" role="status">{launchBuyAllocationMessage}</p>}
                  </div>
                )}
                {selectedProjectWalletAddresses.some((address) => isValidLaunchBuyAmount(launchWalletBuyAmounts[address] ?? '')) && (
                  <div className="mt-3 grid gap-3 border-t border-[var(--line)] pt-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-xs text-[var(--muted)]">{t('Pausa fija entre compras previstas')}<select value={launchBuyDelaySeconds} onChange={(event) => setLaunchBuyDelaySeconds(Number(event.target.value))} disabled={loading} className="wire-input min-h-11 w-full">{LAUNCH_BUY_DELAY_OPTIONS.map((seconds) => <option value={seconds} key={seconds}>{seconds === 0 ? t('Sin pausa') : t('{seconds} s', { seconds })}</option>)}</select></label>
                    <div className="grid gap-1.5 text-xs text-[var(--muted)]"><span>{t('Slippage previsto')}</span><div className="flex flex-wrap gap-2">{LAUNCH_BUY_SLIPPAGE_OPTIONS.map((bps) => <button key={bps} type="button" disabled={loading} aria-pressed={launchBuySlippageBps === bps} onClick={() => setLaunchBuySlippageBps(bps)} className={`wire-button min-h-11 px-2.5 text-xs ${launchBuySlippageBps === bps ? 'wire-button-primary' : 'wire-button-secondary'}`}>{(bps / 100).toFixed(2)}%</button>)}</div></div>
                    <p className="text-xs leading-relaxed text-[var(--muted)] sm:col-span-2">{t('Las pausas son fijas y solo separan operaciones reales; no simulan actividad. La revisión final y cada firma ocurren en la ficha del token después de crear el mercado.')}</p>
                  </div>
                )}
                </>
              ) : (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-[var(--line)] p-3">
                  <p className="text-xs text-[var(--muted)]">{t('Aún no hay wallets guardadas en la bóveda.')}</p>
                  <Link href="/wallets" target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Abrir Mis wallets')}</Link>
                </div>
              )}
            </section>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <div>
              <p className="wire-kicker mb-2">{t('04 / SEGURIDAD')}</p>
              <h2 className="font-display text-base font-semibold text-white sm:text-lg">{t(launchPlatform === 'PUMP_FUN' ? 'Seguridad gestionada por Pump.fun' : 'Elige las autoridades')}</h2>
            </div>
            {launchPlatform === 'PUMP_FUN' ? (
              <p className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4 text-sm leading-relaxed text-[var(--muted)]">{t('En este destino, Pump.fun controla el mint y las autoridades. Las opciones de seguridad SPL de Wire no se aplican.')}</p>
            ) : (
            <>
            <div className="flex items-center gap-5">
              <TrustRing active={securityAssets.length} />
              <div>
                <div className="text-sm font-semibold mb-1">{t('Controles de seguridad elegidos')}</div>
                <div className="text-xs text-[var(--muted)] leading-relaxed">
                    {t('El indicador muestra cuántas medidas seleccionaste. Revisa cada cambio antes de firmar; quienes evalúen el token podrán comprobar sus autoridades.')}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {AUTHORITIES.map((a) => {
                const on = securityAssets.includes(a.key);
                const AuthorityIcon = a.icon;
                return (
                  <button
                    key={a.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAuthority(a.key)}
                    className="wire-button wire-button-secondary wire-authority-card min-h-[11rem] w-full rounded-xl p-4 text-left"
                    data-selected={on}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <AuthorityIcon size={19} strokeWidth={1.7} aria-hidden="true" />
                      <span className="text-xs font-mono" style={{ color: 'var(--wire-green)' }}>
                        {feeConfig ? (feeConfig.assetFeeSol > 0 ? `+${formatSol(feeConfig.assetFeeSol)}` : t('Sin cargo extra')) : t('Cargando…')}
                      </span>
                    </div>
                    <span className="mb-1 block text-sm font-semibold">{t(a.name)}</span>
                    <span className="mb-3 block text-xs leading-relaxed text-[var(--muted)]">{t(a.desc)}</span>
                    <span
                      className="block rounded-md px-2 py-1.5 text-center text-xs font-medium"
                      style={{
                        background: on ? 'var(--wire-green)' : 'var(--line)',
                        color: on ? '#0a1006' : 'var(--muted)',
                      }}
                    >
                      {on ? t('Activada') : t('Desactivada')}
                    </span>
                  </button>
                );
              })}
            </div>
            </>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <div>
              <p className="wire-kicker mb-2">{t('05 / REVISIÓN')}</p>
              <h2 className="font-display text-base font-semibold text-white sm:text-lg">{t('Revisa y crea el token')}</h2>
            </div>
            <section className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4" aria-label={t('Resumen del lanzamiento')}>
              <div className="flex items-center gap-3">
                {imagePreview ? <img src={imagePreview} alt="" className="h-12 w-12 rounded-lg object-cover" /> : null}
                <div className="min-w-0"><p className="truncate font-semibold">{name || t('Nombre de tu token')}</p><p className="text-sm text-[var(--wire-green)]">{symbol || '—'}</p></div>
              </div>
              <dl className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-[var(--muted)]">{t('Total supply')}</dt><dd className="mt-1 font-mono">{new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US').format(launchPlatform === 'PUMP_FUN' ? 1_000_000_000 : supplyValue || 0)} {symbol}</dd></div>
                {launchPlatform === 'RAYDIUM' ? <div><dt className="text-xs text-[var(--muted)]">{t('Liquidez inicial (SOL)')}</dt><dd className="mt-1 font-mono">{liquiditySol || '0'} SOL</dd></div> : <div><dt className="text-xs text-[var(--muted)]">{t('Decimales')}</dt><dd className="mt-1 font-mono">6 · Token-2022</dd></div>}
                {launchPlatform === 'RAYDIUM' ? <div><dt className="text-xs text-[var(--muted)]">{t('Red y estándar')}</dt><dd className="mt-1">Solana Devnet · {t('Token SPL · 9 decimales')}</dd></div> : null}
                <div><dt className="text-xs text-[var(--muted)]">{t('Mercado posterior')}</dt><dd className="mt-1">{launchPlatform === 'PUMP_FUN' ? t('Pump.fun → PumpSwap · SOL') : 'Raydium CPMM · SOL'}</dd></div>
              </dl>
              <div className="mt-4 border-t border-[var(--line)] pt-3">
                <h3 className="text-xs font-semibold">{t('Wallets seleccionadas')} · {selectedProjectWalletAddresses.length}</h3>
                {selectedProjectWalletAddresses.length ? (
                  <ul className="mt-2 grid gap-2 text-xs text-[var(--muted)]">
                    {selectedProjectWalletAddresses.map((address) => {
                      const wallet = projectWallets.find((item) => item.address === address);
                      const buyAmount = launchWalletBuyAmounts[address]?.trim();
                      const hasPlannedBuy = isValidLaunchBuyAmount(buyAmount);
                      return (
                        <li key={address} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-[var(--line)] px-3 py-2">
                          <span className="min-w-0 truncate">{wallet?.label || address.slice(0, 5) + '…' + address.slice(-5)}{wallet ? ` · ${projectWalletRoleLabel(wallet.role, t)}` : ''}</span>
                          <span className="shrink-0 font-mono text-[var(--text)]">{hasPlannedBuy ? t('Compra prevista: {amount} SOL', { amount: buyAmount }) : t('Solo destino de financiación')}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-[var(--muted)]">{t('No seleccionaste wallets de proyecto para preparar.')}</p>
                )}
                {selectedProjectWalletAddresses.some((address) => isValidLaunchBuyAmount(launchWalletBuyAmounts[address] ?? '')) && (
                  <dl className="mt-3 grid gap-2 border-t border-[var(--line)] pt-3 text-xs sm:grid-cols-2">
                    <div><dt className="text-[var(--muted)]">{t('Pausa entre compras')}</dt><dd className="mt-1 font-mono">{launchBuyDelaySeconds === 0 ? t('Sin pausa') : t('{seconds} s', { seconds: launchBuyDelaySeconds })}</dd></div>
                    <div><dt className="text-[var(--muted)]">{t('Slippage previsto')}</dt><dd className="mt-1 font-mono">{(launchBuySlippageBps / 100).toFixed(2)}%</dd></div>
                    <div className="sm:col-span-2"><dt className="text-[var(--muted)]">{t('Distribución prevista')}</dt><dd className="mt-1 font-mono">{t('Total previsto: {amount} SOL en {count} wallets', { amount: plannedBuyTotalSol, count: plannedBuyWalletAddresses.length })}</dd></div>
                  </dl>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{t(launchPlatform === 'PUMP_FUN'
                  ? 'La selección solo guarda direcciones públicas; no envía SOL. Financia las wallets y revisa cada cotización de la curva Pump.fun o PumpSwap en la ficha del token antes de confirmar.'
                  : 'La selección solo guarda direcciones públicas; no envía SOL. Financia las wallets, crea la pool y revisa cada cotización de Raydium en la ficha del token antes de confirmar.')}</p>
              </div>
              {description.trim() && <p className="mt-4 border-t border-[var(--line)] pt-3 text-xs leading-relaxed text-[var(--muted)]">{description.trim()}</p>}
              {(twitter.trim() || telegram.trim()) && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">{twitter.trim() && <span>X / Twitter: {twitter.trim()}</span>}{telegram.trim() && <span>Telegram: {telegram.trim()}</span>}</div>}
              {launchPlatform === 'RAYDIUM' ? <div className="mt-4 border-t border-[var(--line)] pt-3">
                <h3 className="mb-2 text-xs font-semibold">{t('Autoridades al crear')}</h3>
                <ul className="grid gap-2 text-xs sm:grid-cols-3">
                  {AUTHORITIES.map((authority) => <li key={authority.key} className="flex justify-between gap-2"><span>{t(authority.name)}</span><strong className={securityAssets.includes(authority.key) ? 'text-[var(--wire-green)]' : 'text-[var(--muted)]'}>{securityAssets.includes(authority.key) ? t('Activada') : t('Desactivada')}</strong></li>)}
                </ul>
              </div> : null}
            </section>
            <section className="rounded-xl p-4 wire-input space-y-3" aria-label={t('Resumen de costos antes de firmar')}>
              <h3 className="text-sm font-semibold">{t('Resumen antes de firmar')}</h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between gap-4 text-[var(--muted)]"><span>{t('Fee base de plataforma')}</span><span className="font-mono text-[var(--text)]">{feeConfig ? formatSol(feeConfig.baseFeeSol) : t('Cargando…')}</span></div>
                {launchPlatform === 'RAYDIUM' ? <div className="flex justify-between gap-4 text-[var(--muted)]"><span>{t('Adicional por seguridad')} ({securityAssets.length} × {feeConfig ? formatSol(feeConfig.assetFeeSol) : '…'})</span><span className="font-mono text-[var(--text)]">{securityFee === null ? t('Cargando…') : formatSol(securityFee)}</span></div> : null}
                <div className="flex justify-between gap-4 border-t pt-2 font-semibold" style={{ borderColor: 'var(--line)' }}><span>{t('Fee total de plataforma')}</span><span className="font-mono">{totalFee === null ? t('Cargando…') : formatSol(totalFee)}</span></div>
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--muted)]">{t(launchPlatform === 'PUMP_FUN'
                ? 'La curva Pump.fun opera hasta graduarse; después, Wire usa PumpSwap automáticamente. Revisa el mercado y la cotización antes de firmar.'
                : 'Crear el token y crear la pool son dos transacciones distintas. La pool habilita los intercambios y requiere otra firma en Phantom.')}</p>
              {launchPlatform === 'RAYDIUM' ? <p className="text-[11px] leading-relaxed text-[var(--muted)]">{t('La liquidez se aporta al crear la pool después. Phantom mostrará aparte la comisión de red antes de cada firma.')}</p> : null}
            </section>
            <section className="wire-panel rounded-xl p-4" aria-label={t('Añadir este token al lote')}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{t('Preparar un lote de lanzamientos')}</h3>
                  <p className="mt-1 max-w-[68ch] text-xs leading-relaxed text-[var(--muted)]">{t('Guarda este borrador para crear varios tokens en secuencia. Cada uno vuelve a su revisión y necesita una firma independiente en Phantom.')}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {activeBatchDraft && <button type="button" onClick={handleDiscardBatchReview} disabled={batchBusy || loading} className="wire-button wire-button-quiet min-h-11 px-3 text-sm">{t('Descartar cambios del borrador')}</button>}
                  <button
                    type="button"
                    onClick={() => void handleStageBatchDraft()}
                    disabled={batchBusy || loading || Boolean(result) || !walletAddress || batchStorageWallet !== walletAddress || !identityReady || !launchSettingsValid || (launchPlatform === 'RAYDIUM' && !launchBuyAmountsValid) || (!activeBatchDraft && batchDrafts.length >= MAX_TOKEN_LAUNCH_BATCH_DRAFTS)}
                    className="wire-button wire-button-secondary min-h-11 px-3 text-sm"
                  >
                    {t(activeBatchDraft ? 'Actualizar borrador' : 'Añadir a lanzamientos')}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

      </div>

      {/* Navegación + fee */}
      {loading && operationStage && (
        <div className="wire-panel mt-4 flex items-center gap-3 rounded-xl p-3 text-sm text-[var(--muted)]" role="status" aria-live="polite">
          <span className="wire-loading-mark shrink-0" aria-hidden="true" />
          <span>{t(operationStage === 'preparing' ? 'Preparando la transacción…' : operationStage === 'signature' ? 'Esperando tu firma en la wallet…' : 'Enviando y confirmando en Solana…')}</span>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="wire-button wire-button-quiet w-full justify-start sm:w-auto"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t('Atrás')}
        </button>

        <div className="text-right">
          <div className="text-[11px] text-[var(--muted)]">{t('Fee plataforma')}</div>
          <div className="font-mono text-lg">{totalFee === null ? '—' : `${new Intl.NumberFormat(locale === 'es' ? 'es-419' : 'en-US', { maximumFractionDigits: 6 }).format(totalFee)} `}<span className="text-xs text-[var(--muted)]">SOL</span></div>
        </div>

        {step < 4 ? (
          <button
            type="button"
            onClick={() => canNext && setStep((s) => s + 1)}
            disabled={!canNext}
            className="wire-button wire-button-primary w-full sm:w-auto"
          >
            {t('Siguiente')}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || isRestoringResult || !feeConfig || Boolean(pendingSubmission) || Boolean(result)}
            className="wire-button wire-button-primary w-full sm:w-auto"
          >
            {result ? t('Token creado') : loading ? t('Creando…') : !feeConfig ? t('Cargando costo…') : t('Crear token')}
          </button>
        )}
      </div>
      {step < 4 && stepBlockReason && (
        <p className="mt-2 text-right text-xs text-[var(--muted)]" role="status">{stepBlockReason}</p>
      )}

      {result && successDismissed && !goToPool && !summaryDismissed && (
        <aside
          ref={continuationRef}
          className={`wire-panel wire-continuation-guide mt-4 rounded-xl p-4${continuationHighlighted ? ' is-highlighted' : ''}`}
          aria-label={t('Siguiente paso para tu token')}
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--text)]">{createdPool ? poolStatus === 'withdrawn' ? t('Retiraste el 100% de los tokens LP de esta wallet') : poolStatus === 'no-position' ? t('Pool creada, sin saldo LP en esta wallet') : t('Pool creada correctamente') : result.launchPlatform === 'PUMP_FUN' ? t('Token creado en Pump.fun') : t('Token creado; tu pool sigue pendiente')}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              {createdPool ? poolStatus === 'withdrawn' ? t('La posición LP de esta wallet quedó en cero. La pool sigue existiendo en Solana y su historial está en Administrar liquidez.') : poolStatus === 'no-position' ? t('Esta wallet no tiene una posición LP activa. La pool y sus movimientos siguen en Administrar liquidez.') : t('Puedes volver a ella desde Administrar liquidez.') : result.launchPlatform === 'PUMP_FUN' ? t('La curva Pump.fun opera hasta graduarse; después, Wire usa PumpSwap automáticamente. Revisa el mercado y la cotización antes de firmar.') : t('Para añadir liquidez en Raydium Devnet, continúa con Crear pool.')}
            </p>
            <p className="mt-2 truncate font-mono text-[10px] text-[var(--muted)]">Mint: {result.mintAddress}</p>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {createdPool ? (
              <Link href="/manage-liquidity" className="wire-button wire-button-primary w-full px-3 text-xs sm:w-auto">{t('Administrar liquidez')}</Link>
            ) : result.launchPlatform === 'RAYDIUM' ? (
              <button type="button" onClick={() => setGoToPool(true)} className="wire-button wire-button-primary w-full px-3 text-xs sm:w-auto">
                {t('Crear pool ahora')}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            ) : null}
            <Link
              href={`/token/${result.mintAddress}`}
              onClick={queueCreatedTokenLaunchBuys}
              className="wire-button wire-button-secondary w-full px-3 text-xs sm:w-auto"
            >{t('Ver detalles')}</Link>
            {result.launchWalletAddresses && result.launchWalletAddresses.length > 0 && (
              <Link
                href={`/wallets?fundingDestinations=${encodeURIComponent(result.launchWalletAddresses.join(','))}`}
                className="wire-button wire-button-secondary w-full px-3 text-xs sm:w-auto"
              >
                {t('Preparar wallets seleccionadas')}
              </Link>
            )}
              {createdPool ? (
              <a href={`https://explorer.solana.com/address/${createdPool.poolId}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full px-3 text-xs sm:w-auto">{t('Ver pool en Explorer')}</a>
              ) : result.launchPlatform === 'PUMP_FUN' && result.bondingCurveAddress ? (
                <a href={`https://explorer.solana.com/address/${result.bondingCurveAddress}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full px-3 text-xs sm:w-auto">{t('Ver bonding curve en Explorer')}</a>
              ) : (
              <a href={`https://explorer.solana.com/tx/${result.txId}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary w-full px-3 text-xs sm:w-auto">{t('Ver transacción en Explorer')}</a>
            )}
            <button type="button" onClick={handleCreateAnotherToken} className="wire-button wire-button-quiet w-full px-3 text-xs sm:w-auto">{t('Crear otro token')}</button>
            <button type="button" onClick={() => handleSummaryVisibilityChange(true)} className="wire-button wire-button-quiet w-full px-3 text-xs sm:w-auto">{t('Ocultar resumen')}</button>
          </div>
        </aside>
      )}

      {result && successDismissed && !goToPool && summaryDismissed && (
        <div className="wire-panel mt-4 flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between" role="status">
          <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Resumen oculto. Puedes volver a mostrarlo o iniciar otro token.')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => handleSummaryVisibilityChange(false)} className="wire-button wire-button-secondary px-3 text-xs">{t('Mostrar resumen')}</button>
            <button type="button" onClick={handleCreateAnotherToken} className="wire-button wire-button-quiet px-3 text-xs">{t('Crear otro token')}</button>
          </div>
        </div>
      )}

        </section>
        <aside className="wire-launch-aside" aria-label={t('Vista previa y resumen del lanzamiento')}>
          <section className="wire-launch-preview">
            <div className="wire-launch-preview-top"><span>{t('VISTA PREVIA')}</span><span className="wire-devnet-badge">DEVNET</span></div>
            <div className="wire-launch-coin">
              {imagePreview ? <img src={imagePreview} alt="" /> : <span aria-hidden="true">{(symbol || 'W').slice(0, 1)}</span>}
            </div>
            <h2>{name || t('Nombre de tu token')}</h2>
            <p>{symbol || 'SIMBOLO'}</p>
            <div className="wire-launch-preview-meta"><span>{t('Supply')}</span><strong>{launchPlatform === 'PUMP_FUN' ? '1,000,000,000' : totalSupply || '0'}</strong></div>
          </section>
          <section className="wire-launch-guidance">
            <span className="wire-launch-guidance-index">0{step + 1} / 05</span>
            <h2>{t(['Identidad del token', 'Metadatos públicos', 'Oferta y mercado', 'Seguridad del token', 'Revisa y crea'][step])}</h2>
            <p>{[
              t('Elige un nombre, símbolo e imagen que ayuden a reconocer tu token.'),
              t('Completa la descripción y añade enlaces públicos opcionales.'),
              t(launchPlatform === 'PUMP_FUN' ? 'Pump.fun fija el supply en 1.000.000.000 tokens con 6 decimales. El precio se forma en la curva; no depositas liquidez inicial como en Raydium.' : 'Define el supply y cuánto SOL aportarás cuando configures la pool.'),
              t(launchPlatform === 'PUMP_FUN' ? 'En este destino, Pump.fun controla el mint y las autoridades. Las opciones de seguridad SPL de Wire no se aplican.' : 'Elige qué autoridades conservar o revocar; los cambios quedan en la cadena.'),
              t('Revisa los datos, la red y el fee antes de crear el token.'),
            ][step]}</p>
            <div className="wire-launch-aside-divider" />
            <div className="wire-launch-preview-meta"><span>{t('Fee plataforma')}</span><strong>{totalFee === null ? t('Cargando…') : formatSol(totalFee)}</strong></div>
            <div className="wire-launch-preview-meta"><span>{t('Red')}</span><strong>Solana Devnet</strong></div>
          </section>
        </aside>
      </div>
      {/* Modal de éxito */}
      {result && !successDismissed && !goToPool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div
            ref={successDialogRef}
            className="wire-panel wire-dialog-enter w-full max-w-md rounded-2xl p-5 sm:p-7"
            role="dialog"
            aria-modal="true"
            aria-labelledby="token-created-title"
            aria-describedby="token-created-description"
            tabIndex={-1}
          >
            <div className="mb-2 flex justify-end">
              <button type="button" onClick={() => setSuccessDismissed(true)} className="wire-button wire-button-quiet h-10 w-10 p-0" aria-label={t('Cerrar y continuar después')}>
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <div
              className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]"
              aria-hidden="true"
            >
              <Check size={21} strokeWidth={2} />
            </div>
            <h2 id="token-created-title" className="mb-2 font-display text-lg font-semibold">{t('Token creado')}</h2>
            <p id="token-created-description" className="mb-4 text-sm leading-relaxed text-[var(--muted)]">
              {result.launchPlatform === 'PUMP_FUN'
                ? t('La curva Pump.fun opera hasta graduarse; después, Wire usa PumpSwap automáticamente. Revisa el mercado y la cotización antes de firmar.')
                : t('success.tokenCreated', { name, symbol })}
            </p>
            <div className="wire-input mb-4 break-all rounded-lg p-3 font-mono text-xs text-[var(--text)]">
              {result.mintAddress}
            </div>
            {result.launchPlatform === 'RAYDIUM' ? <button
              type="button"
              onClick={() => setGoToPool(true)}
              className="wire-button mb-2 w-full border border-transparent bg-[var(--wire-violet)] text-white"
            >
              <Plus size={16} aria-hidden="true" />
              {t('Crear pool de liquidez')}
            </button> : null}
            <Link
              href={`/token/${result.mintAddress}`}
              onClick={queueCreatedTokenLaunchBuys}
              className="wire-button wire-button-secondary mb-2 w-full"
            >
              {t('Ver detalles del token')}
            </Link>
            <a
              href={`https://explorer.solana.com/tx/${result.txId}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="wire-button wire-button-secondary mb-2 w-full"
            >
              {t('Ver transacción en Explorer')}
              <ExternalLink size={15} aria-hidden="true" />
            </a>
            <p className="mt-2 text-center text-xs text-[var(--muted)]">{t(result.launchPlatform === 'PUMP_FUN'
              ? 'La curva Pump.fun opera hasta graduarse; después, Wire usa PumpSwap automáticamente. Revisa el mercado y la cotización antes de firmar.'
              : 'La pool crea el mercado de intercambio en Raydium Devnet.')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
