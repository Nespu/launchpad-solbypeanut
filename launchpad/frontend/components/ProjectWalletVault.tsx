'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { Download, ExternalLink, Eye, EyeOff, KeyRound, LockKeyhole, Pencil, Plus, RefreshCw, Send, ShieldAlert, Trash2, UnlockKeyhole, Wallet } from 'lucide-react';
import {
  createWalletVault,
  exportEncryptedWalletVaultBackup,
  getWalletVaultMetadata,
  restoreEncryptedWalletVaultBackup,
  unlockWalletVault,
  type VaultWallet,
  type VaultWalletRole,
  type WalletVaultSession,
} from '../lib/walletVault';
import ProjectWalletTokenDisperse from './ProjectWalletTokenDisperse';
import PumpCreatorFeeManager from './PumpCreatorFeeManager';
import PumpFeeSharingManager from './PumpFeeSharingManager';
import { useWireLocale } from './LocaleProvider';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';

const ROLE_OPTIONS: VaultWalletRole[] = ['dev', 'bundle', 'snipe', 'trading', 'holder'];
const MAX_FUNDING_RECIPIENTS = 10;
const FUNDING_RECEIPT_STORAGE_KEY = 'wire:wallet-funding-receipt:v1';
const FUNDING_HISTORY_STORAGE_KEY = 'wire:wallet-funding-history:v1';
const MAX_FUNDING_HISTORY = 25;

type FundingAllocation = { address: string; label: string; role: VaultWalletRole; lamports: bigint; currentBalance: bigint };
type FundingPreview = {
  sourceAddress: string;
  allocations: FundingAllocation[];
  totalLamports: bigint;
  feeLamports: bigint;
  sourceBalanceLamports: bigint;
  transaction: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
};
type FundingReceipt = {
  signature: string;
  status: 'confirmed' | 'pending' | 'failed';
  sourceAddress: string | null;
  allocations: Array<{ address: string; label: string; role: VaultWalletRole; lamports: string }>;
  totalLamports: string | null;
  feeLamports: string | null;
  createdAt: number | null;
};

type FundingReceiptUpdate = Pick<FundingReceipt, 'signature' | 'status'> & Partial<Omit<FundingReceipt, 'signature' | 'status'>>;

function isPublicAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function isRawLamports(value: unknown, allowZero = false): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,23})$/.test(value)) return false;
  return allowZero || BigInt(value) > 0n;
}

function parseFundingReceipt(value: unknown): FundingReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.signature !== 'string'
    || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature)
    || !['confirmed', 'pending', 'failed'].includes(String(item.status))) return null;

  const hasNoDetails = !('sourceAddress' in item)
    && !('allocations' in item)
    && !('totalLamports' in item)
    && !('feeLamports' in item)
    && !('createdAt' in item);
  if (hasNoDetails) {
    return {
      signature: item.signature,
      status: item.status as FundingReceipt['status'],
      sourceAddress: null,
      allocations: [],
      totalLamports: null,
      feeLamports: null,
      createdAt: null,
    };
  }

  if (!isPublicAddress(item.sourceAddress)
    || !Array.isArray(item.allocations)
    || item.allocations.length < 1
    || item.allocations.length > MAX_FUNDING_RECIPIENTS
    || !isRawLamports(item.totalLamports)
    || !isRawLamports(item.feeLamports, true)
    || !(typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt > 0 && item.createdAt <= 8.64e15)) return null;

  const allocations: FundingReceipt['allocations'] = [];
  const destinationAddresses = new Set<string>();
  for (const value of item.allocations) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allocation = value as Record<string, unknown>;
    if (!isPublicAddress(allocation.address)
      || typeof allocation.label !== 'string'
      || allocation.label.length > 40
      || !ROLE_OPTIONS.includes(allocation.role as VaultWalletRole)
      || !isRawLamports(allocation.lamports)) return null;
    if (destinationAddresses.has(allocation.address)) return null;
    destinationAddresses.add(allocation.address);
    allocations.push({
      address: allocation.address,
      label: allocation.label,
      role: allocation.role as VaultWalletRole,
      lamports: allocation.lamports,
    });
  }

  if (allocations.some((allocation) => allocation.address === item.sourceAddress)) return null;
  const allocationsTotal = allocations.reduce((sum, allocation) => sum + BigInt(allocation.lamports), 0n);
  if (allocationsTotal.toString() !== item.totalLamports) return null;

  return {
    signature: item.signature,
    status: item.status as FundingReceipt['status'],
    sourceAddress: item.sourceAddress as string | null,
    allocations,
    totalLamports: item.totalLamports as string,
    feeLamports: item.feeLamports as string,
    createdAt: item.createdAt as number | null,
  };
}

function parseFundingHistory(value: unknown): FundingReceipt[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const payload = value as Record<string, unknown>;
  if (payload.version !== 1 || !Array.isArray(payload.receipts)) return [];
  return payload.receipts
    .map(parseFundingReceipt)
    .filter((receipt): receipt is FundingReceipt => receipt !== null)
    .slice(0, MAX_FUNDING_HISTORY);
}

function upsertFundingHistory(history: FundingReceipt[], receipt: FundingReceipt): FundingReceipt[] {
  return [receipt, ...history.filter((item) => item.signature !== receipt.signature)]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, MAX_FUNDING_HISTORY);
}

function parseSolToLamports(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(normalized)) throw new Error('Escribe un importe SOL válido con hasta nueve decimales.');
  const [whole, fraction = ''] = normalized.split('.');
  const lamports = BigInt(whole) * BigInt(LAMPORTS_PER_SOL) + BigInt(fraction.padEnd(9, '0') || '0');
  if (lamports <= 0n) throw new Error('Cada wallet debe recibir una cantidad mayor que cero.');
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('El importe supera el límite seguro de una transferencia.');
  return lamports;
}

function formatLamports(value: bigint) {
  const whole = value / BigInt(LAMPORTS_PER_SOL);
  const fraction = (value % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function roleLabel(role: VaultWalletRole, t: (message: string, values?: Record<string, string | number>) => string) {
  return t(role === 'dev' ? 'Dev' : role === 'bundle' ? 'Bundle' : role === 'snipe' ? 'Snipe' : role === 'trading' ? 'Trading' : 'Holder');
}

function userError(error: unknown, t: (message: string, values?: Record<string, string | number>) => string) {
  const message = error instanceof Error ? error.message : '';
  return message ? t(message) : t('No se pudo completar la acción local. Revisa el formato e inténtalo de nuevo.');
}

function fundingError(error: unknown, t: (message: string, values?: Record<string, string | number>) => string) {
  const message = error instanceof Error ? error.message : '';
  const knownErrors = [
    'Escribe un importe SOL válido con hasta nueve decimales.',
    'Cada wallet debe recibir una cantidad mayor que cero.',
    'El importe supera el límite seguro de una transferencia.',
    'Conecta una wallet Solana para financiar wallets de proyecto.',
    'Selecciona al menos una wallet de destino.',
    `Selecciona como máximo ${MAX_FUNDING_RECIPIENTS} wallets por transferencia.`,
    'El total no alcanza para enviar al menos un lamport a cada wallet seleccionada.',
    'La conexión RPC no está en Solana Devnet. Cambia a Devnet y vuelve a revisar la transferencia.',
    'No se pudo estimar la comisión de red. Vuelve a revisar la transferencia.',
    'El saldo de la wallet conectada no alcanza para el importe y la comisión de red.',
    'La wallet conectada cambió. Revisa de nuevo el origen y los importes.',
    'La revisión venció. Vuelve a revisar la transferencia antes de firmar.',
    'La comisión estimada cambió. Revisa la transferencia otra vez antes de firmar.',
    'Rechazaste la firma en tu wallet. No se envió SOL.',
  ];
  if (knownErrors.includes(message)) return t(message);
  if (/reject|declin|cancelled|canceled/i.test(message)) return t('Rechazaste la firma en tu wallet. No se envió SOL.');
  return t('No se pudo preparar la transferencia. Comprueba Devnet y vuelve a intentarlo.');
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function persistFundingReceipt(receipt: FundingReceipt | null) {
  try {
    if (receipt) window.localStorage.setItem(FUNDING_RECEIPT_STORAGE_KEY, JSON.stringify(receipt));
    else window.localStorage.removeItem(FUNDING_RECEIPT_STORAGE_KEY);
  } catch {
    // The signature is public and nonessential; keep the in-memory status if storage is unavailable.
  }
}

function persistFundingHistory(history: FundingReceipt[]) {
  try {
    window.localStorage.setItem(FUNDING_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, receipts: history }));
  } catch {
    // Keep the in-memory history if storage is unavailable.
  }
}

export default function ProjectWalletVault() {
  const { t, locale } = useWireLocale();
  const { connection } = useConnection();
  const { connected, publicKey, sendTransaction } = useWallet();
  const [storageReady, setStorageReady] = useState(false);
  const [vaultExists, setVaultExists] = useState(false);
  const [publicWallets, setPublicWallets] = useState<VaultWallet[]>([]);
  const [session, setSession] = useState<WalletVaultSession | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [walletLabel, setWalletLabel] = useState('');
  const [walletRole, setWalletRole] = useState<VaultWalletRole>('trading');
  const [editingWalletAddress, setEditingWalletAddress] = useState<string | null>(null);
  const [editingWalletLabel, setEditingWalletLabel] = useState('');
  const [editingWalletRole, setEditingWalletRole] = useState<VaultWalletRole>('trading');
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [importAcknowledged, setImportAcknowledged] = useState(false);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activityVersion, setActivityVersion] = useState(0);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [fundingAddresses, setFundingAddresses] = useState<string[]>([]);
  const [fundingMode, setFundingMode] = useState<'equal' | 'custom'>('equal');
  const [fundingTotal, setFundingTotal] = useState('');
  const [fundingCustomAmounts, setFundingCustomAmounts] = useState<Record<string, string>>({});
  const [fundingPreview, setFundingPreview] = useState<FundingPreview | null>(null);
  const [fundingReceipt, setFundingReceipt] = useState<FundingReceipt | null>(null);
  const [fundingHistory, setFundingHistory] = useState<FundingReceipt[]>([]);
  const [fundingReceiptReady, setFundingReceiptReady] = useState(false);
  const [fundingStage, setFundingStage] = useState<'reviewing' | 'signing' | 'confirming' | 'checking' | null>(null);
  const sessionRef = useRef<WalletVaultSession | null>(null);
  const fundingHistoryRef = useRef<FundingReceipt[]>([]);
  const launchFundingParamsHandled = useRef(false);

  const updateFundingReceipt = (receipt: FundingReceiptUpdate | null) => {
    if (!receipt) {
      setFundingReceipt(null);
      persistFundingReceipt(null);
      return;
    }

    const previous = fundingHistoryRef.current.find((item) => item.signature === receipt.signature);
    const next: FundingReceipt = {
      signature: receipt.signature,
      status: receipt.status,
      sourceAddress: receipt.sourceAddress ?? previous?.sourceAddress ?? null,
      allocations: receipt.allocations ?? previous?.allocations ?? [],
      totalLamports: receipt.totalLamports ?? previous?.totalLamports ?? null,
      feeLamports: receipt.feeLamports ?? previous?.feeLamports ?? null,
      createdAt: receipt.createdAt ?? previous?.createdAt ?? null,
    };
    const history = upsertFundingHistory(fundingHistoryRef.current, next);
    fundingHistoryRef.current = history;
    setFundingHistory(history);
    setFundingReceipt(next);
    persistFundingReceipt(next);
    persistFundingHistory(history);
  };

  useEffect(() => {
    let active = true;
    getWalletVaultMetadata()
      .then((metadata) => {
        if (!active) return;
        setVaultExists(metadata.exists);
        setPublicWallets(metadata.wallets);
      })
      .catch((caught: unknown) => {
        if (active) setError(userError(caught, t));
      })
      .finally(() => { if (active) setStorageReady(true); });
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    if (!storageReady || launchFundingParamsHandled.current) return;
    launchFundingParamsHandled.current = true;
    const raw = new URLSearchParams(window.location.search).get('fundingDestinations');
    if (!raw) return;

    const candidates = raw.split(',').map((candidate) => candidate.trim()).filter(Boolean);
    const requested: string[] = [];
    let invalidAddressCount = 0;
    for (const value of candidates.slice(0, MAX_FUNDING_RECIPIENTS)) {
      try {
        const address = new PublicKey(value).toBase58();
        if (address !== value) throw new Error('Non-canonical address');
        if (!requested.includes(address)) requested.push(address);
      } catch {
        invalidAddressCount += 1;
      }
    }
    const available = new Set(publicWallets.map((wallet) => wallet.address));
    const connectedAddress = publicKey?.toBase58();
    const matching = requested.filter((address) => available.has(address) && address !== connectedAddress);
    const missingAddressCount = requested.length - matching.length;
    setFundingAddresses(matching);
    setFundingOpen(true);
    if (invalidAddressCount || missingAddressCount || candidates.length > MAX_FUNDING_RECIPIENTS) {
      setError(t('Algunas wallets seleccionadas ya no están en la bóveda o la dirección no es válida. Revisa los destinos antes de continuar.'));
    } else if (matching.length) {
      setNotice(t('Destinos preseleccionados desde el asistente de lanzamiento. Revisa y cambia los importes antes de firmar.'));
    }
  }, [storageReady, publicWallets, t]);

  useEffect(() => {
    let history: FundingReceipt[] = [];
    let activeReceipt: FundingReceipt | null = null;
    try {
      const savedHistory = window.localStorage.getItem(FUNDING_HISTORY_STORAGE_KEY);
      if (savedHistory) {
        try {
          history = parseFundingHistory(JSON.parse(savedHistory));
          if (!history.length) window.localStorage.removeItem(FUNDING_HISTORY_STORAGE_KEY);
        } catch {
          window.localStorage.removeItem(FUNDING_HISTORY_STORAGE_KEY);
        }
      }

      const savedActive = window.localStorage.getItem(FUNDING_RECEIPT_STORAGE_KEY);
      if (savedActive) {
        try {
          activeReceipt = parseFundingReceipt(JSON.parse(savedActive));
          if (!activeReceipt) window.localStorage.removeItem(FUNDING_RECEIPT_STORAGE_KEY);
          else history = upsertFundingHistory(history, activeReceipt);
        } catch {
          window.localStorage.removeItem(FUNDING_RECEIPT_STORAGE_KEY);
        }
      }
    } catch {
      // The transfer list is best-effort local metadata and never blocks the vault.
    } finally {
      fundingHistoryRef.current = history;
      setFundingHistory(history);
      setFundingReceipt(activeReceipt);
      if (activeReceipt?.status === 'pending') setFundingOpen(true);
      if (history.length) persistFundingHistory(history);
      setFundingReceiptReady(true);
    }
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const sourceAddress = publicKey?.toBase58();
    if (sourceAddress) setFundingAddresses((current) => current.filter((address) => address !== sourceAddress));
  }, [publicKey]);

  useEffect(() => () => sessionRef.current?.lock(), []);

  useEffect(() => {
    if (!session) return;
    let inactivityTimer = 0;
    let hiddenTimer = 0;
    const lock = () => {
      session.lock();
      sessionRef.current = null;
      setSession(null);
      setPassphrase('');
      setPrivateKeyInput('');
      setImportAcknowledged(false);
      setEditingWalletAddress(null);
      setNotice(t('La bóveda se bloqueó automáticamente.'));
    };
    const resetInactivity = () => {
      window.clearTimeout(inactivityTimer);
      inactivityTimer = window.setTimeout(lock, 15 * 60 * 1000);
    };
    const onVisibilityChange = () => {
      window.clearTimeout(hiddenTimer);
      if (document.hidden) hiddenTimer = window.setTimeout(lock, 2 * 60 * 1000);
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
  }, [session, activityVersion, t]);

  const acceptSession = (next: WalletVaultSession) => {
    sessionRef.current?.lock();
    sessionRef.current = next;
    setSession(next);
    setVaultExists(true);
    setPublicWallets(next.wallets);
    setFundingAddresses([]);
    setFundingPreview(null);
    setEditingWalletAddress(null);
    setPassphrase('');
    setConfirmPassphrase('');
    setError('');
    setNotice(t('Bóveda desbloqueada en este navegador.'));
    setActivityVersion((value) => value + 1);
  };

  const handleCreateVault = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (passphrase !== confirmPassphrase) throw new Error('Las contraseñas no coinciden.');
      const next = await createWalletVault(passphrase);
      acceptSession(next);
    } catch (caught) {
      setError(userError(caught, t));
    } finally { setBusy(false); }
  };

  const handleUnlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try { acceptSession(await unlockWalletVault(passphrase)); }
    catch (caught) { setError(userError(caught, t)); }
    finally { setBusy(false); }
  };

  const handleCreateWallet = async () => {
    if (!session) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const label = walletLabel.trim() || t('Wallet {count}', { count: session.wallets.length + 1 });
      await session.createWallet(label, walletRole);
      setPublicWallets(session.wallets);
      setFundingPreview(null);
      setWalletLabel('');
      setNotice(t('Wallet creada y guardada cifrada.'));
      setActivityVersion((value) => value + 1);
    } catch (caught) { setError(userError(caught, t)); }
    finally { setBusy(false); }
  };

  const handleImportWallet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const label = walletLabel.trim() || t('Wallet {count}', { count: session.wallets.length + 1 });
      await session.importWallet(privateKeyInput, label, walletRole);
      setPublicWallets(session.wallets);
      setFundingPreview(null);
      setPrivateKeyInput('');
      setWalletLabel('');
      setImportAcknowledged(false);
      setNotice(t('Wallet importada y guardada cifrada.'));
      setActivityVersion((value) => value + 1);
    } catch (caught) { setError(userError(caught, t)); }
    finally {
      setPrivateKeyInput('');
      setBusy(false);
    }
  };

  const handleRemoveWallet = async (wallet: VaultWallet) => {
    if (!session || !window.confirm(t('Quitar {wallet} de la bóveda? Esto borra su clave local.', { wallet: wallet.label || shortenAddress(wallet.address) }))) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await session.removeWallet(wallet.address);
      setPublicWallets(session.wallets);
      setFundingAddresses((addresses) => addresses.filter((address) => address !== wallet.address));
      setFundingPreview(null);
      setNotice(t('Wallet quitada de la bóveda local.'));
      setActivityVersion((value) => value + 1);
    } catch (caught) { setError(userError(caught, t)); }
    finally { setBusy(false); }
  };

  const handleSaveWalletDetails = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !editingWalletAddress) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await session.updateWallet(editingWalletAddress, {
        label: editingWalletLabel.trim().slice(0, 40),
        role: editingWalletRole,
      });
      setPublicWallets(session.wallets);
      setFundingPreview(null);
      setEditingWalletAddress(null);
      setNotice(t('Wallet actualizada y guardada cifrada.'));
      setActivityVersion((value) => value + 1);
    } catch (caught) {
      setError(userError(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const handleExportBackup = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await exportEncryptedWalletVaultBackup();
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'wire-wallet-vault-encrypted.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(t('Copia cifrada descargada. Guárdala junto con tu contraseña.'));
      setActivityVersion((value) => value + 1);
    } catch (caught) { setError(userError(caught, t)); }
    finally { setBusy(false); }
  };

  const handleRestoreBackup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!backupFile) return;
    if (backupFile.size > 2 * 1024 * 1024) {
      setError(t('El archivo de respaldo supera el tamaño permitido.'));
      return;
    }
    const replace = vaultExists;
    if (replace && !window.confirm(t('Reemplazar la bóveda de este navegador con el respaldo seleccionado?'))) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const serialized = await backupFile.text();
      acceptSession(await restoreEncryptedWalletVaultBackup(serialized, backupPassword, replace));
      setBackupFile(null);
      setBackupPassword('');
      setNotice(t('Respaldo cifrado restaurado.'));
    } catch (caught) { setError(userError(caught, t)); }
    finally { setBusy(false); }
  };

  const handleLock = () => {
    session?.lock();
    sessionRef.current = null;
    setSession(null);
    setPassphrase('');
    setPrivateKeyInput('');
    setImportAcknowledged(false);
    setWalletLabel('');
    setEditingWalletAddress(null);
    setFundingOpen(false);
    setFundingAddresses([]);
    setFundingPreview(null);
    setNotice(t('Bóveda bloqueada.'));
    setError('');
  };

  const wallets = session ? session.wallets : publicWallets;
  const connectedAddress = publicKey?.toBase58() ?? null;
  const fundingPending = fundingReceipt?.status === 'pending';

  const invalidateFundingReview = () => {
    setFundingPreview(null);
    setError('');
    setNotice('');
  };

  const selectedFundingWallets = () => wallets.filter((wallet) =>
    fundingAddresses.includes(wallet.address) && wallet.address !== connectedAddress,
  );

  const toggleFundingWallet = (address: string) => {
    if (fundingReceipt?.status === 'pending') return;
    updateFundingReceipt(null);
    setFundingPreview(null);
    setError('');
    setNotice('');
    if (fundingAddresses.includes(address)) {
      setFundingAddresses((current) => current.filter((item) => item !== address));
      return;
    }
    if (selectedFundingWallets().length >= MAX_FUNDING_RECIPIENTS) {
      setError(t(`Selecciona como máximo ${MAX_FUNDING_RECIPIENTS} wallets por transferencia.`));
      return;
    }
    setFundingAddresses((current) => [...current, address]);
  };

  const getFundingAllocations = (): FundingAllocation[] => {
    if (!connected || !publicKey || !sendTransaction) throw new Error('Conecta una wallet Solana para financiar wallets de proyecto.');
    const destinations = selectedFundingWallets();
    if (!destinations.length) throw new Error('Selecciona al menos una wallet de destino.');
    if (destinations.length > MAX_FUNDING_RECIPIENTS) throw new Error(`Selecciona como máximo ${MAX_FUNDING_RECIPIENTS} wallets por transferencia.`);

    if (fundingMode === 'equal') {
      const totalLamports = parseSolToLamports(fundingTotal);
      const count = BigInt(destinations.length);
      const each = totalLamports / count;
      const remainder = totalLamports % count;
      if (each <= 0n) throw new Error('El total no alcanza para enviar al menos un lamport a cada wallet seleccionada.');
      return destinations.map((wallet, index) => ({
        address: wallet.address,
        label: wallet.label,
        role: wallet.role,
        lamports: each + (BigInt(index) < remainder ? 1n : 0n),
        currentBalance: 0n,
      }));
    }

    return destinations.map((wallet) => ({
      address: wallet.address,
      label: wallet.label,
      role: wallet.role,
      lamports: parseSolToLamports(fundingCustomAmounts[wallet.address] ?? ''),
      currentBalance: 0n,
    }));
  };

  const handleReviewFunding = async () => {
    if (fundingReceipt?.status === 'pending') return;
    setFundingStage('reviewing');
    setFundingPreview(null);
    updateFundingReceipt(null);
    setError('');
    setNotice('');
    try {
      if (!connected || !publicKey || !sendTransaction) throw new Error('Conecta una wallet Solana para financiar wallets de proyecto.');
      const sourceAddress = publicKey.toBase58();
      const allocations = getFundingAllocations();
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error('La conexión RPC no está en Solana Devnet. Cambia a Devnet y vuelve a revisar la transferencia.');

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      for (const allocation of allocations) {
        transaction.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(allocation.address),
          lamports: Number(allocation.lamports),
        }));
      }
      const feeQuote = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
      if (feeQuote.value === null) throw new Error('No se pudo estimar la comisión de red. Vuelve a revisar la transferencia.');
      const sourceBalanceLamports = BigInt(await connection.getBalance(publicKey, 'confirmed'));
      const destinationInfos = await connection.getMultipleAccountsInfo(
        allocations.map((allocation) => new PublicKey(allocation.address)),
        'confirmed',
      );
      const preparedAllocations = allocations.map((allocation, index) => ({
        ...allocation,
        currentBalance: BigInt(destinationInfos[index]?.lamports ?? 0),
      }));
      const totalLamports = preparedAllocations.reduce((total, allocation) => total + allocation.lamports, 0n);
      const feeLamports = BigInt(feeQuote.value);
      if (totalLamports + feeLamports > sourceBalanceLamports) throw new Error('El saldo de la wallet conectada no alcanza para el importe y la comisión de red.');

      setFundingPreview({
        sourceAddress,
        allocations: preparedAllocations,
        totalLamports,
        feeLamports,
        sourceBalanceLamports,
        transaction,
        blockhash,
        lastValidBlockHeight,
      });
      setNotice(t('Revisa el total y cada destino. No se enviará nada hasta que apruebes la solicitud en tu wallet.'));
    } catch (caught) {
      setError(fundingError(caught, t));
    } finally {
      setFundingStage(null);
    }
  };

  const handleSendFunding = async () => {
    const preview = fundingPreview;
    if (!preview || !connected || !publicKey || !sendTransaction) return;
    let submittedSignature: string | null = null;
    let submittedReceipt: FundingReceipt | null = null;
    setFundingStage('signing');
    setError('');
    setNotice('');
    try {
      if (publicKey.toBase58() !== preview.sourceAddress) throw new Error('La wallet conectada cambió. Revisa de nuevo el origen y los importes.');
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('La conexión RPC no está en Solana Devnet. Cambia a Devnet y vuelve a revisar la transferencia.');
      const currentHeight = await connection.getBlockHeight('confirmed');
      if (currentHeight > preview.lastValidBlockHeight) throw new Error('La revisión venció. Vuelve a revisar la transferencia antes de firmar.');
      const [feeQuote, sourceBalance] = await Promise.all([
        connection.getFeeForMessage(preview.transaction.compileMessage(), 'confirmed'),
        connection.getBalance(publicKey, 'confirmed'),
      ]);
      if (feeQuote.value === null) throw new Error('No se pudo estimar la comisión de red. Vuelve a revisar la transferencia.');
      if (BigInt(feeQuote.value) !== preview.feeLamports) throw new Error('La comisión estimada cambió. Revisa la transferencia otra vez antes de firmar.');
      if (BigInt(sourceBalance) < preview.totalLamports + preview.feeLamports) throw new Error('El saldo de la wallet conectada no alcanza para el importe y la comisión de red.');

      setFundingStage('signing');
      submittedSignature = await sendTransaction(preview.transaction, connection, {
        preflightCommitment: 'confirmed',
        maxRetries: 0,
      });
      submittedReceipt = {
        signature: submittedSignature,
        status: 'pending',
        sourceAddress: preview.sourceAddress,
        allocations: preview.allocations.map((allocation) => ({
          address: allocation.address,
          label: allocation.label,
          role: allocation.role,
          lamports: allocation.lamports.toString(),
        })),
        totalLamports: preview.totalLamports.toString(),
        feeLamports: preview.feeLamports.toString(),
        createdAt: Date.now(),
      };
      updateFundingReceipt(submittedReceipt);
      setFundingStage('confirming');
      const confirmation = await connection.confirmTransaction({
        signature: submittedSignature,
        blockhash: preview.blockhash,
        lastValidBlockHeight: preview.lastValidBlockHeight,
      }, 'confirmed');
      if (confirmation.value.err) {
        if (submittedReceipt) updateFundingReceipt({ ...submittedReceipt, status: 'failed' });
        setError(t('Solana rechazó la transferencia. Revisa el estado en Explorer antes de volver a intentarlo.'));
      } else {
        if (submittedReceipt) updateFundingReceipt({ ...submittedReceipt, status: 'confirmed' });
        setNotice(t('La transferencia quedó confirmada en Devnet.'));
      }
    } catch (caught) {
      if (submittedSignature && submittedReceipt) {
        updateFundingReceipt({ ...submittedReceipt, status: 'pending' });
        setNotice(t('La transacción se envió, pero aún no se pudo confirmar. Consulta su estado antes de volver a intentarlo.'));
      } else {
        setError(fundingError(caught, t));
      }
    } finally {
      setFundingStage(null);
    }
  };

  const handleRefreshFundingStatus = async () => {
    if (!fundingReceipt) return;
    setFundingStage('checking');
    setError('');
    setNotice('');
    try {
      const result = await connection.getSignatureStatuses([fundingReceipt.signature], { searchTransactionHistory: true });
      const status = result.value[0];
      if (!status) {
        setNotice(t('La transacción todavía no aparece en el historial de Devnet. No vuelvas a enviarla todavía.'));
      } else if (status.err) {
        updateFundingReceipt({ ...fundingReceipt, status: 'failed' });
        setError(t('Solana rechazó la transferencia. Revisa el estado en Explorer antes de volver a intentarlo.'));
      } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || status.confirmations === null) {
        updateFundingReceipt({ ...fundingReceipt, status: 'confirmed' });
        setNotice(t('La transferencia quedó confirmada en Devnet.'));
      } else {
        setNotice(t('La transferencia sigue procesándose en Devnet.'));
      }
    } catch {
      setError(t('No se pudo actualizar el estado. Inténtalo de nuevo en unos segundos.'));
    } finally {
      setFundingStage(null);
    }
  };

  return (
    <section className="wire-panel mb-8 p-4 sm:p-5" aria-labelledby="project-wallet-vault-title">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2">
            <LockKeyhole size={18} className="text-[var(--wire-green)]" aria-hidden="true" />
            <h2 id="project-wallet-vault-title" className="font-display text-xl font-semibold tracking-tight sm:text-2xl">{t('Bóveda de wallets de proyecto')}</h2>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{t('Prepara y organiza wallets para futuras operaciones de lanzamiento. Las claves se cifran y permanecen en este navegador; para financiar, Wire solo usa la wallet conectada.')}</p>
        </div>
        {session && <button type="button" onClick={handleLock} disabled={busy || fundingStage !== null} className="wire-button wire-button-secondary min-h-11 px-3 text-sm"><LockKeyhole size={14} aria-hidden="true" />{t('Bloquear')}</button>}
      </header>

      <div className="mt-4 flex gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3 text-sm leading-relaxed text-[var(--muted)]">
        <ShieldAlert size={17} className="mt-0.5 shrink-0 text-[var(--wire-green)]" aria-hidden="true" />
        <p>{t('Usa una contraseña larga y guarda una copia cifrada. Wire no puede recuperar la contraseña. Una clave Solana sirve tanto en Devnet como en Mainnet: usa wallets dedicadas a pruebas y nunca pegues la frase de recuperación de Phantom. El cifrado protege los datos guardados; mientras está desbloqueada, la clave vive temporalmente en la memoria del navegador.')}</p>
      </div>

      {!storageReady ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-[var(--muted)]" role="status"><span className="wire-loading-mark" aria-hidden="true" />{t('Cargando bóveda local…')}</p>
      ) : !session ? (
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.72fr)]">
          <form onSubmit={vaultExists ? handleUnlock : handleCreateVault} className="grid content-start gap-3">
            <h3 className="font-semibold">{vaultExists ? t('Desbloquea tu bóveda') : t('Crea una bóveda local')}</h3>
            <label className="grid gap-1.5 text-xs text-[var(--muted)]">
              {t('Contraseña de la bóveda')}
              <span className="flex gap-2">
                <input type={showPassword ? 'text' : 'password'} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required minLength={12} maxLength={256} autoComplete={vaultExists ? 'current-password' : 'new-password'} className="wire-input min-h-11 w-full" />
                <button type="button" onClick={() => setShowPassword((value) => !value)} className="wire-button wire-button-secondary min-h-11 w-11 p-0" aria-label={showPassword ? t('Ocultar contraseña') : t('Mostrar contraseña')}>{showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}</button>
              </span>
            </label>
            {!vaultExists && <label className="grid gap-1.5 text-xs text-[var(--muted)]">{t('Confirma la contraseña')}<input type={showPassword ? 'text' : 'password'} value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} required minLength={12} maxLength={256} autoComplete="new-password" className="wire-input min-h-11 w-full" /></label>}
            {!vaultExists && <p className="text-xs text-[var(--muted)]">{t('Mínimo 12 caracteres. La bóveda usa cifrado local y no sincroniza claves con el servidor.')}</p>}
            <button type="submit" disabled={busy || !passphrase || (!vaultExists && !confirmPassphrase)} className="wire-button wire-button-primary min-h-11 justify-center">
              {busy ? <span className="wire-loading-mark" aria-hidden="true" /> : vaultExists ? <UnlockKeyhole size={15} aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
              {busy ? t('Procesando…') : vaultExists ? t('Desbloquear bóveda') : t('Crear bóveda')}
            </button>
          </form>

          <form onSubmit={handleRestoreBackup} className="grid content-start gap-3 border-t border-[var(--line)] pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <h3 className="font-semibold">{t('Restaurar copia cifrada')}</h3>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Elige un respaldo de Wire y escribe la contraseña que lo cifró. La restauración verifica el archivo antes de guardarlo.')}</p>
            <label className="grid gap-1.5 text-xs text-[var(--muted)]">{t('Archivo de respaldo')}<input type="file" accept=".json,application/json" onChange={(event) => setBackupFile(event.target.files?.[0] ?? null)} className="wire-input min-h-11 w-full p-2 text-xs" /></label>
            <label className="grid gap-1.5 text-xs text-[var(--muted)]">{t('Contraseña de la copia')}<input type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} autoComplete="current-password" className="wire-input min-h-11 w-full" /></label>
            <button type="submit" disabled={busy || !backupFile || !backupPassword} className="wire-button wire-button-secondary min-h-11 justify-center"><Download size={14} aria-hidden="true" />{t('Restaurar respaldo')}</button>
          </form>
        </div>
      ) : (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Wallet size={15} className="text-[var(--wire-green)]" aria-hidden="true" />{t('Wallets guardadas: {count}/{max}', { count: wallets.length, max: 100 })}</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => { setFundingOpen((open) => !open); setFundingPreview(null); setError(''); setNotice(''); }} disabled={fundingStage !== null} aria-expanded={fundingOpen} className="wire-button wire-button-secondary min-h-11 px-3 text-sm"><Send size={14} aria-hidden="true" />{fundingOpen ? t('Cerrar financiación') : t('Financiar wallets')}</button>
              <button type="button" onClick={handleExportBackup} disabled={busy || fundingStage !== null} className="wire-button wire-button-secondary min-h-11 px-3 text-sm"><Download size={14} aria-hidden="true" />{t('Descargar copia cifrada')}</button>
            </div>
          </div>

          {fundingOpen && (
            <div className="mt-4 grid gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4" aria-labelledby="project-wallet-funding-title">
              <div>
                <h3 id="project-wallet-funding-title" className="font-semibold">{t('Financia tus wallets de proyecto')}</h3>
                <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">{t('Envía SOL desde la wallet conectada a un máximo de 10 wallets de esta bóveda en una transferencia Devnet. Cada envío requiere revisar el desglose y aprobarlo en Phantom. Financiar wallets es independiente de comprar tokens o crear volumen.')}</p>
              </div>

              <div className="rounded-lg border border-[var(--line)] p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{t('Wallet de origen')}</p>
                {connected && connectedAddress ? (
                  <code className="mt-1 block break-all font-mono text-xs">{connectedAddress}</code>
                ) : (
                <p className="mt-1 text-[var(--muted)]">{t('Conecta una wallet Solana para elegir el origen de SOL.')}</p>
                )}
                {connectedAddress && wallets.some((wallet) => wallet.address === connectedAddress) && <p className="mt-1 text-xs text-[var(--muted)]">{t('La wallet conectada también está en tu bóveda; no puede ser destino de sí misma.')}</p>}
              </div>

              <fieldset disabled={!fundingReceiptReady || fundingPending || fundingStage !== null} className="grid gap-3 disabled:opacity-70">
                <legend className="text-sm font-semibold">{t('Wallets de destino')} · {selectedFundingWallets().length}/{MAX_FUNDING_RECIPIENTS}</legend>
                {wallets.length ? (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {wallets.map((wallet) => {
                      const isSource = wallet.address === connectedAddress;
                      const isSelected = fundingAddresses.includes(wallet.address) && !isSource;
                      const atLimit = selectedFundingWallets().length >= MAX_FUNDING_RECIPIENTS;
                      return (
                        <li key={wallet.address}>
                          <label className={`flex min-h-14 items-start gap-3 rounded-lg border border-[var(--line)] p-3 ${isSource ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-[var(--wire-green)]'}`}>
                            <input type="checkbox" checked={isSelected} disabled={isSource || (atLimit && !isSelected)} onChange={() => toggleFundingWallet(wallet.address)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--wire-green)]" />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{wallet.label || t('Wallet sin nombre')}<span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-[var(--muted)]">{isSource ? t('Origen') : roleLabel(wallet.role, t)}</span></span>
                              <code className="mt-1 block truncate text-xs text-[var(--muted)]">{shortenAddress(wallet.address)}</code>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="rounded-lg border border-dashed border-[var(--line)] p-3 text-sm text-[var(--muted)]">{t('Crea o importa wallets en la bóveda para añadir destinos.')}</p>
                )}

                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <label className="grid gap-1.5 text-sm">
                    {t('Distribución')}
                    <select value={fundingMode} onChange={(event) => { setFundingMode(event.target.value as 'equal' | 'custom'); invalidateFundingReview(); updateFundingReceipt(null); }} className="wire-input min-h-11 w-full">
                      <option value="equal">{t('Dividir el total en partes iguales')}</option>
                      <option value="custom">{t('Definir SOL por wallet')}</option>
                    </select>
                  </label>
                  {fundingMode === 'equal' && (
                    <div className="grid gap-1.5 text-sm"><label htmlFor="project-wallet-funding-total">{t('Total a enviar (SOL)')}</label><input id="project-wallet-funding-total" inputMode="decimal" autoComplete="off" value={fundingTotal} onChange={(event) => { setFundingTotal(event.target.value); invalidateFundingReview(); updateFundingReceipt(null); }} placeholder="0.00" className="wire-input min-h-11 w-full font-mono" /><p className="text-xs text-[var(--muted)]">{t('Si la división deja lamports sobrantes, se asignan a las primeras wallets de la lista.')}</p></div>
                  )}
                </div>

                {fundingMode === 'custom' && selectedFundingWallets().length > 0 && (
                  <div className="grid gap-2">
                    <p className="text-sm font-medium">{t('Importe por destino')}</p>
                    {selectedFundingWallets().map((wallet) => (
                      <label key={wallet.address} className="grid gap-2 rounded-lg border border-[var(--line)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.5fr)] sm:items-center">
                        <span className="min-w-0"><span className="block truncate text-sm font-medium">{wallet.label || t('Wallet sin nombre')}</span><code className="block truncate text-xs text-[var(--muted)]">{shortenAddress(wallet.address)}</code></span>
                        <span className="flex items-center gap-2"><input inputMode="decimal" autoComplete="off" value={fundingCustomAmounts[wallet.address] ?? ''} onChange={(event) => { setFundingCustomAmounts((amounts) => ({ ...amounts, [wallet.address]: event.target.value })); invalidateFundingReview(); updateFundingReceipt(null); }} placeholder="0.00" className="wire-input min-h-11 min-w-0 w-full font-mono" /><span className="text-xs text-[var(--muted)]">SOL</span></span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              <p className="text-xs leading-relaxed text-[var(--muted)]">{t('La transacción solo contiene transferencias SOL de la wallet conectada. Las claves guardadas en esta bóveda no firman ni se envían al servidor.')}</p>

              {fundingPreview && (
                <div className="grid gap-3 rounded-lg border border-[var(--wire-green)]/40 bg-[var(--surface)] p-3" aria-live="polite">
                  <h4 className="font-semibold">{t('Revisa antes de abrir tu wallet')}</h4>
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div><dt className="text-xs text-[var(--muted)]">{t('Origen')}</dt><dd className="break-all font-mono text-xs">{fundingPreview.sourceAddress}</dd></div>
                    <div><dt className="text-xs text-[var(--muted)]">{t('Saldo de origen')}</dt><dd className="font-mono">{formatLamports(fundingPreview.sourceBalanceLamports)} SOL</dd></div>
                    <div><dt className="text-xs text-[var(--muted)]">{t('Total transferido')}</dt><dd className="font-mono">{formatLamports(fundingPreview.totalLamports)} SOL</dd></div>
                    <div><dt className="text-xs text-[var(--muted)]">{t('Comisión de red estimada')}</dt><dd className="font-mono">{formatLamports(fundingPreview.feeLamports)} SOL</dd></div>
                    <div><dt className="text-xs text-[var(--muted)]">{t('Saldo restante estimado')}</dt><dd className="font-mono">{formatLamports(fundingPreview.sourceBalanceLamports - fundingPreview.totalLamports - fundingPreview.feeLamports)} SOL</dd></div>
                  </dl>
                  <ul className="grid gap-2 border-t border-[var(--line)] pt-3">
                    {fundingPreview.allocations.map((allocation) => (
                      <li key={allocation.address} className="grid gap-1 rounded-lg border border-[var(--line)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <span className="min-w-0"><span className="block text-sm font-medium">{allocation.label || t('Wallet sin nombre')} · {roleLabel(allocation.role, t)}</span><code className="block break-all text-xs text-[var(--muted)]">{allocation.address}</code><span className="mt-1 block text-xs text-[var(--muted)]">{t('Saldo actual')}: {formatLamports(allocation.currentBalance)} SOL → {t('Después')}: {formatLamports(allocation.currentBalance + allocation.lamports)} SOL</span></span>
                        <span className="font-mono text-sm font-semibold">+{formatLamports(allocation.lamports)} SOL</span>
                      </li>
                    ))}
                  </ul>
                  {!fundingReceipt && <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={handleSendFunding} disabled={fundingStage !== null || !connected || connectedAddress !== fundingPreview.sourceAddress} className="wire-button wire-button-primary min-h-11 justify-center">{fundingStage === 'signing' || fundingStage === 'confirming' ? <span className="wire-loading-mark" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}{fundingStage === 'confirming' ? t('Esperando confirmación…') : t('Revisar y firmar en tu wallet')}</button>
                    <button type="button" onClick={() => { setFundingPreview(null); updateFundingReceipt(null); setNotice(''); }} disabled={fundingStage !== null} className="wire-button wire-button-secondary min-h-11 px-4">{t('Editar importes')}</button>
                  </div>}
                </div>
              )}

              {!fundingReceipt && (
                <button type="button" onClick={handleReviewFunding} disabled={!fundingReceiptReady || fundingPending || fundingStage !== null || !connected || !selectedFundingWallets().length} className="wire-button wire-button-primary min-h-11 justify-center">
                  {fundingStage === 'reviewing' ? <span className="wire-loading-mark" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{t('Preparar desglose y comisión')}
                </button>
              )}

              {fundingReceipt && (
                <div className="grid gap-3 rounded-lg border border-[var(--line)] p-3" role="status" aria-live="polite">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`text-sm font-semibold ${fundingReceipt.status === 'confirmed' ? 'text-[var(--wire-green)]' : fundingReceipt.status === 'failed' ? 'text-[var(--danger,#ff8b8b)]' : 'text-[var(--muted)]'}`}>
                      {fundingReceipt.status === 'confirmed' ? t('Confirmada en Devnet') : fundingReceipt.status === 'failed' ? t('Falló en Devnet') : t('Pendiente de confirmación en Devnet')}
                    </span>
                    <div className="flex gap-2">
                      <a href={`https://explorer.solana.com/tx/${fundingReceipt.signature}?cluster=devnet`} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-sm"><ExternalLink size={13} aria-hidden="true" />{t('Ver transacción')}</a>
                      {fundingReceipt.status === 'pending' && <button type="button" onClick={handleRefreshFundingStatus} disabled={fundingStage !== null} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">{fundingStage === 'checking' ? <span className="wire-loading-mark" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}{t('Actualizar estado')}</button>}
                    </div>
                  </div>
                  <code className="break-all text-xs text-[var(--muted)]">{fundingReceipt.signature}</code>
                  {fundingReceipt.status === 'pending' && <p className="text-xs leading-relaxed text-[var(--muted)]">{t('No vuelvas a firmar esta transferencia mientras esté pendiente. Consulta Explorer o actualiza el estado para evitar un envío duplicado.')}</p>}
                  {fundingReceipt.status !== 'pending' && <button type="button" onClick={() => { updateFundingReceipt(null); setFundingPreview(null); setNotice(''); setError(''); }} className="wire-button wire-button-secondary min-h-11 justify-center">{t('Preparar otra transferencia')}</button>}
                </div>
              )}

              {fundingHistory.length > 0 && (
                <section className="grid gap-3 border-t border-[var(--line)] pt-4" aria-labelledby="project-wallet-funding-history-title">
                  <div>
                    <h4 id="project-wallet-funding-history-title" className="font-semibold">{t('Historial de financiación')}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Se guarda solo en este navegador. Incluye direcciones públicas y movimientos de SOL; nunca contiene claves privadas.')}</p>
                  </div>
                  <ol className="grid gap-3">
                    {fundingHistory.map((receipt) => {
                      const dateLabel = receipt.createdAt === null
                        ? t('Fecha no disponible')
                        : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(receipt.createdAt);
                      return (
                        <li key={receipt.signature} className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={'text-sm font-semibold ' + (receipt.status === 'confirmed' ? 'text-[var(--wire-green)]' : receipt.status === 'failed' ? 'text-[var(--danger,#ff8b8b)]' : 'text-[var(--muted)]')}>
                              {receipt.status === 'confirmed' ? t('Confirmada en Devnet') : receipt.status === 'failed' ? t('Falló en Devnet') : t('Pendiente de confirmación en Devnet')}
                            </span>
                            <time className="text-xs text-[var(--muted)]" dateTime={receipt.createdAt === null ? undefined : new Date(receipt.createdAt).toISOString()}>{dateLabel}</time>
                          </div>
                          {receipt.sourceAddress && (
                            <dl className="grid gap-2 text-xs sm:grid-cols-3">
                              <div><dt className="text-[var(--muted)]">{t('Origen')}</dt><dd className="mt-1 break-all font-mono">{receipt.sourceAddress}</dd></div>
                              <div><dt className="text-[var(--muted)]">{t('Total transferido')}</dt><dd className="mt-1 font-mono">{formatLamports(BigInt(receipt.totalLamports ?? '0'))} SOL</dd></div>
                              <div><dt className="text-[var(--muted)]">{t('Comisión de red estimada')}</dt><dd className="mt-1 font-mono">{formatLamports(BigInt(receipt.feeLamports ?? '0'))} SOL</dd></div>
                            </dl>
                          )}
                          {receipt.allocations.length > 0 ? (
                            <ul className="grid gap-2 border-t border-[var(--line)] pt-3 sm:grid-cols-2">
                              {receipt.allocations.map((allocation) => (
                                <li key={[receipt.signature, allocation.address].join(':')} className="grid gap-1 rounded-md border border-[var(--line)] p-2">
                                  <span className="text-xs font-medium">{allocation.label || t('Wallet sin nombre')} · {roleLabel(allocation.role, t)}</span>
                                  <code className="break-all text-[11px] text-[var(--muted)]">{allocation.address}</code>
                                  <span className="font-mono text-xs">+{formatLamports(BigInt(allocation.lamports))} SOL</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Transferencia anterior: solo se guardaron firma y estado; sus detalles de origen y destino no estaban disponibles.')}</p>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3">
                            <code className="min-w-0 break-all text-[11px] text-[var(--muted)]">{receipt.signature}</code>
                            <a href={'https://explorer.solana.com/tx/' + encodeURIComponent(receipt.signature) + '?cluster=devnet'} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs"><ExternalLink size={12} aria-hidden="true" />{t('Ver transacción')}</a>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              )}
            </div>
          )}

          <div className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.45fr)_auto] sm:items-end">
            <label className="grid gap-1.5 text-xs text-[var(--muted)]">{t('Nombre (opcional)')}<input value={walletLabel} onChange={(event) => setWalletLabel(event.target.value)} maxLength={40} autoComplete="off" className="wire-input min-h-11 w-full" placeholder={t('Ejemplo: Wallet de pruebas')} /></label>
            <label className="grid gap-1.5 text-xs text-[var(--muted)]">{t('Rol')}<select value={walletRole} onChange={(event) => setWalletRole(event.target.value as VaultWalletRole)} className="wire-input min-h-11 w-full">{ROLE_OPTIONS.map((role) => <option key={role} value={role}>{roleLabel(role, t)}</option>)}</select></label>
            <button type="button" onClick={handleCreateWallet} disabled={busy || wallets.length >= 100} className="wire-button wire-button-primary min-h-11"><Plus size={15} aria-hidden="true" />{t('Crear wallet')}</button>
          </div>

          <details className="border-t border-[var(--line)] py-3">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{t('Importar clave privada')}</summary>
            <form onSubmit={handleImportWallet} className="grid gap-3 pt-2">
              <label className="grid gap-1.5 text-xs text-[var(--muted)]">{t('Clave Solana base58 o JSON de 64 bytes')}<input type="password" value={privateKeyInput} onChange={(event) => setPrivateKeyInput(event.target.value)} required autoComplete="new-password" autoCapitalize="off" spellCheck={false} className="wire-input min-h-11 w-full font-mono text-xs" /></label>
              <label className="flex items-start gap-2 text-xs leading-relaxed text-[var(--muted)]"><input type="checkbox" checked={importAcknowledged} onChange={(event) => setImportAcknowledged(event.target.checked)} className="mt-0.5 accent-[var(--wire-green)]" /><span>{t('Confirmo que controlo esta clave, que es de una wallet de pruebas y que no estoy pegando una frase de recuperación.')}</span></label>
              <button type="submit" disabled={busy || !privateKeyInput || !importAcknowledged} className="wire-button wire-button-secondary min-h-11 justify-self-start"><KeyRound size={14} aria-hidden="true" />{t('Importar a la bóveda')}</button>
            </form>
          </details>

          {wallets.length ? (
            <ul className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
              {wallets.map((wallet) => (
                <li key={wallet.address} className="flex flex-wrap items-center gap-3 py-3">
                  {editingWalletAddress === wallet.address ? (
                    <form onSubmit={handleSaveWalletDetails} className="grid w-full gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.5fr)_auto] sm:items-end">
                      <label htmlFor={`project-wallet-edit-label-${wallet.address}`} className="grid min-w-0 gap-1.5 text-xs text-[var(--muted)]">
                        {t('Nombre (opcional)')}
                        <input id={`project-wallet-edit-label-${wallet.address}`} value={editingWalletLabel} onChange={(event) => setEditingWalletLabel(event.target.value)} maxLength={40} autoComplete="off" className="wire-input min-h-11 w-full" />
                      </label>
                      <label htmlFor={`project-wallet-edit-role-${wallet.address}`} className="grid gap-1.5 text-xs text-[var(--muted)]">
                        {t('Rol')}
                        <select id={`project-wallet-edit-role-${wallet.address}`} value={editingWalletRole} onChange={(event) => setEditingWalletRole(event.target.value as VaultWalletRole)} className="wire-input min-h-11 w-full">
                          {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{roleLabel(role, t)}</option>)}
                        </select>
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={busy} className="wire-button wire-button-primary min-h-11 px-3 text-xs">{t('Guardar cambios')}</button>
                        <button type="button" disabled={busy} onClick={() => setEditingWalletAddress(null)} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Cancelar')}</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[var(--wire-green)]"><Wallet size={15} aria-hidden="true" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{wallet.label || t('Wallet sin nombre')}</p>
                        <code className="block truncate text-xs text-[var(--muted)]">{shortenAddress(wallet.address)}</code>
                      </div>
                      <span className="rounded-full border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--muted)]">{roleLabel(wallet.role, t)}</span>
                      <button
                        type="button"
                        onClick={() => { setEditingWalletAddress(wallet.address); setEditingWalletLabel(wallet.label); setEditingWalletRole(wallet.role); setError(''); setNotice(''); }}
                        disabled={busy || !session}
                        title={!session ? t('Desbloquea la bóveda para editar wallets.') : undefined}
                        className="wire-button wire-button-secondary min-h-11 px-3 text-xs"
                        aria-label={t('Editar {wallet}', { wallet: wallet.label || shortenAddress(wallet.address) })}
                      ><Pencil size={14} aria-hidden="true" />{t('Editar')}</button>
                      <button type="button" onClick={() => handleRemoveWallet(wallet)} disabled={busy} className="wire-button wire-button-quiet min-h-11 min-w-11 p-0" aria-label={t('Quitar {wallet} de la bóveda', { wallet: wallet.label || shortenAddress(wallet.address) })}><Trash2 size={15} aria-hidden="true" /></button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="wire-empty-state mt-2"><h3>{t('Todavía no hay wallets de proyecto')}</h3><p>{t('Crea una wallet nueva para pruebas o importa una clave que controles.')}</p></div>
          )}
          {session && <ProjectWalletTokenDisperse wallets={wallets} session={session} onWalletsChange={setPublicWallets} />}
        </div>
      )}

      {(error || notice) && <p className={`mt-4 text-sm ${error ? 'text-[var(--danger,#ff8b8b)]' : 'text-[var(--wire-green)]'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error || notice}</p>}
      <PumpCreatorFeeManager wallets={wallets} session={session} connectedAddress={connectedAddress} />
      <PumpFeeSharingManager wallets={wallets} session={session} connectedAddress={connectedAddress} />
    </section>
  );
}
