'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  calculateEpochFee,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithFeeAndTransferHookInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
} from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { ParsedAccountData, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { ExternalLink, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { MAX_WALLETS, type VaultWallet, type WalletVaultSession } from '../lib/walletVault';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';
import { useWireLocale } from './LocaleProvider';

const STORAGE_KEY = 'wire:token-disperse:v1';
const MAX_RECIPIENTS = 50;
const MAX_RECIPIENTS_PER_BATCH = 4;
const MAX_HISTORY = 50;
const MAX_PACKET_BYTES = 1232;

type SourceTokenAccount = { address: string; amountRaw: string };
type SourceToken = {
  key: string;
  mint: string;
  programId: string;
  decimals: number;
  amountRaw: string;
  accounts: SourceTokenAccount[];
};
type RecipientInput = { address: string; amountRaw: string };
type TransferAllocation = { sourceAddress: string; amountRaw: string; feeRaw: string };
type PlannedRecipient = RecipientInput & { feeRaw: string; netRaw: string; allocations: TransferAllocation[]; solFundingLamports?: string };
type PlannedBatch = {
  index: number;
  recipientIndexes: number[];
  instructionFingerprint: string;
  feeLamports: number;
  ataRentLamports: number;
  fundingLamports?: string;
};
type DispersePlan = {
  version: 1;
  sourceType: 'vault' | 'connected';
  sourceAddress: string;
  mint: string;
  programId: string;
  decimals: number;
  recipients: PlannedRecipient[];
  expectedBalances: Record<string, string>;
  batches: PlannedBatch[];
  currentBatch: number;
  interBatchDelaySeconds?: number;
  interBatchJitterSeconds?: number;
  nextBatchReadyAt?: number | null;
  consecutiveFailures?: number;
  maxConfirmedFailures?: number;
  status: 'ready' | 'pending' | 'complete' | 'failed';
  pendingSignature: string | null;
};
type DisperseReceipt = {
  signature: string;
  status: 'pending' | 'confirmed' | 'failed';
  sourceAddress: string;
  mint: string;
  decimals: number;
  batchIndex: number;
  batchCount: number;
  recipients: Array<{ address: string; amountRaw: string; netRaw: string; solFundingLamports?: string }>;
  feeLamports: number;
  ataRentLamports: number;
  createdAt: number;
};
type SavedState = { version: 1; active: DispersePlan | null; history: DisperseReceipt[] };

const TOKEN_PROGRAM_OPTIONS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

function shorten(address: string) {
  return `${address.slice(0, 5)}…${address.slice(-5)}`;
}

function parseAmount(value: string, decimals: number) {
  const normalized = value.trim();
  const pattern = decimals === 0 ? /^\d{1,30}$/ : new RegExp(`^\\d{1,30}(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(normalized)) throw new Error('Escribe un importe positivo con hasta {decimals} decimales.');
  const [whole, fraction = ''] = normalized.split('.');
  const raw = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (raw <= 0n || raw > 18446744073709551615n) throw new Error('Cada importe debe ser mayor que cero y caber en una transferencia SPL.');
  return raw;
}

function parseSolLamports(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,20}(?:\.\d{1,9})?$/.test(normalized)) throw new Error('Escribe un importe SOL válido con hasta 9 decimales.');
  const [whole, fraction = ''] = normalized.split('.');
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0') || '0');
  if (lamports > 18_446_744_073_709_551_615n) throw new Error('El importe SOL supera el máximo de una transferencia.');
  return lamports;
}

function formatSolLamports(lamports: bigint) {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatAmount(raw: string | bigint, decimals: number, locale: 'es' | 'en') {
  const amount = typeof raw === 'bigint' ? raw : BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const language = locale === 'es' ? 'es-419' : 'en-US';
  const wholeText = new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(whole);
  if (!fraction) return wholeText;
  const separator = new Intl.NumberFormat(language).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return `${wholeText}${separator}${fraction}`;
}

function formatEditableAmount(raw: string, decimals: number) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parsePercentBasisPoints(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Usa un porcentaje entre 0.01 y 100, con hasta 2 decimales.');
  const [whole, fraction = ''] = normalized.split('.');
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 1 || basisPoints > 10_000) throw new Error('Usa un porcentaje entre 0.01 y 100, con hasta 2 decimales.');
  return basisPoints;
}

function randomIntegerInclusive(minimum: number, maximum: number) {
  const range = maximum - minimum + 1;
  const uint32Range = 0x1_0000_0000;
  const limit = Math.floor(uint32Range / range) * range;
  const value = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(value); } while (value[0] >= limit);
  return minimum + (value[0] % range);
}

function scheduleNextBatch(plan: DispersePlan, nextBatch: number) {
  if (nextBatch >= plan.batches.length) return null;
  const delaySeconds = plan.interBatchDelaySeconds ?? 0;
  const jitterSeconds = plan.interBatchJitterSeconds ?? 0;
  let randomizedSeconds = 0;
  if (jitterSeconds > 0) {
    try { randomizedSeconds = randomIntegerInclusive(0, jitterSeconds); }
    catch { randomizedSeconds = Math.floor(Math.random() * (jitterSeconds + 1)); }
  }
  const waitSeconds = delaySeconds + randomizedSeconds;
  return waitSeconds > 0 ? Date.now() + waitSeconds * 1000 : null;
}

function advanceAfterConfirmedFailure(plan: DispersePlan) {
  const consecutiveFailures = (plan.consecutiveFailures ?? 0) + 1;
  const maxConfirmedFailures = plan.maxConfirmedFailures ?? 0;
  if (consecutiveFailures > maxConfirmedFailures) {
    return {
      plan: { ...plan, consecutiveFailures, status: 'failed' as const, pendingSignature: null, nextBatchReadyAt: null },
      skipped: false,
      hasNext: false,
    };
  }
  const nextBatch = plan.currentBatch + 1;
  const hasNext = nextBatch < plan.batches.length;
  return {
    plan: {
      ...plan,
      currentBatch: nextBatch,
      consecutiveFailures,
      status: hasNext ? 'ready' as const : 'failed' as const,
      pendingSignature: null,
      nextBatchReadyAt: hasNext ? scheduleNextBatch(plan, nextBatch) : null,
    },
    skipped: true,
    hasNext,
  };
}

function parseAllocationAddresses(input: string, sourceAddress: string, t: (key: string, values?: Record<string, string | number>) => string) {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error(t('Añade al menos un destinatario.'));
  if (lines.length > MAX_RECIPIENTS) throw new Error(t('Máximo {count} destinatarios por distribución.', { count: MAX_RECIPIENTS }));
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const fields = line.split(/[\t,; ]+/).filter(Boolean);
    if (fields.length > 2) throw new Error(t('Línea {line}: usa dirección, importe.', { line: index + 1 }));
    let address: string;
    try { address = new PublicKey(fields[0]).toBase58(); } catch { throw new Error(t('Línea {line}: la dirección Solana no es válida.', { line: index + 1 })); }
    if (address === sourceAddress) throw new Error(t('La wallet de origen no puede aparecer como destinatario.'));
    if (seen.has(address)) throw new Error(t('Hay una dirección repetida en la lista.'));
    seen.add(address);
    return address;
  });
}

function parseRecipients(input: string, decimals: number, sourceAddress: string, t: (key: string, values?: Record<string, string | number>) => string): RecipientInput[] {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error(t('Añade al menos un destinatario.'));
  if (lines.length > MAX_RECIPIENTS) throw new Error(t('Máximo {count} destinatarios por distribución.', { count: MAX_RECIPIENTS }));
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const fields = line.split(/[\t,; ]+/).filter(Boolean);
    if (fields.length !== 2) throw new Error(t('Línea {line}: usa dirección, importe.', { line: index + 1 }));
    let address: string;
    try { address = new PublicKey(fields[0]).toBase58(); } catch { throw new Error(t('Línea {line}: la dirección Solana no es válida.', { line: index + 1 })); }
    if (address === sourceAddress) throw new Error(t('La wallet de origen no puede aparecer como destinatario.'));
    if (seen.has(address)) throw new Error(t('Hay una dirección repetida en la lista.'));
    seen.add(address);
    let amountRaw: bigint;
    try { amountRaw = parseAmount(fields[1], decimals); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('{decimals}')) throw new Error(t(message, { decimals }));
      throw new Error(t(message || 'El importe no es válido.'));
    }
    return { address, amountRaw: amountRaw.toString() };
  });
}

function readTokenGroups(values: Array<{ pubkey: PublicKey; parsed: Record<string, unknown>; programId: PublicKey }>): SourceToken[] {
  const groups = new Map<string, SourceToken>();
  for (const value of values) {
    const mintAddress = typeof value.parsed.mint === 'string' ? value.parsed.mint : '';
    const tokenAmount = value.parsed.tokenAmount;
    if (!mintAddress || !tokenAmount || typeof tokenAmount !== 'object') continue;
    const parsedAmount = tokenAmount as { amount?: unknown; decimals?: unknown };
    if (typeof parsedAmount.amount !== 'string' || !/^\d+$/.test(parsedAmount.amount)
      || typeof parsedAmount.decimals !== 'number' || !Number.isInteger(parsedAmount.decimals)
      || parsedAmount.decimals < 0 || parsedAmount.decimals > 18 || BigInt(parsedAmount.amount) <= 0n) continue;
    const key = `${value.programId.toBase58()}:${mintAddress}`;
    const existing = groups.get(key);
    if (existing && existing.decimals !== parsedAmount.decimals) continue;
    const account = { address: value.pubkey.toBase58(), amountRaw: parsedAmount.amount };
    if (existing) {
      existing.accounts.push(account);
      existing.amountRaw = (BigInt(existing.amountRaw) + BigInt(account.amountRaw)).toString();
    } else {
      groups.set(key, {
        key,
        mint: mintAddress,
        programId: value.programId.toBase58(),
        decimals: parsedAmount.decimals,
        amountRaw: account.amountRaw,
        accounts: [account],
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.mint.localeCompare(b.mint));
}

async function loadSourceTokens(connection: ReturnType<typeof useConnection>['connection'], owner: PublicKey) {
  const responses = await Promise.all(TOKEN_PROGRAM_OPTIONS.map((programId) =>
    connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed'),
  ));
  const values: Array<{ pubkey: PublicKey; parsed: Record<string, unknown>; programId: PublicKey }> = [];
  for (let index = 0; index < responses.length; index += 1) {
    for (const entry of responses[index].value) {
      const data = entry.account.data as ParsedAccountData;
      const parsed = data?.parsed?.info;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const parsedInfo = parsed as Record<string, unknown>;
      if (parsedInfo.owner !== owner.toBase58()) continue;
      values.push({ pubkey: entry.pubkey, parsed: parsedInfo, programId: TOKEN_PROGRAM_OPTIONS[index] });
    }
  }
  return readTokenGroups(values);
}

function assignAmounts(recipients: RecipientInput[], token: SourceToken) {
  const available = token.accounts.map((account) => ({ address: account.address, remaining: BigInt(account.amountRaw) }));
  return recipients.map((recipient) => {
    let remaining = BigInt(recipient.amountRaw);
    const allocations: TransferAllocation[] = [];
    for (const account of available) {
      if (remaining === 0n) break;
      const amount = account.remaining < remaining ? account.remaining : remaining;
      if (amount === 0n) continue;
      allocations.push({ sourceAddress: account.address, amountRaw: amount.toString(), feeRaw: '0' });
      account.remaining -= amount;
      remaining -= amount;
    }
    if (remaining > 0n) throw new Error('El saldo del token no alcanza para cubrir el total indicado.');
    return { ...recipient, feeRaw: '0', netRaw: recipient.amountRaw, allocations } satisfies PlannedRecipient;
  });
}

function instructionFingerprint(instructions: TransactionInstruction[]) {
  return JSON.stringify(instructions.map((instruction) => ({
    program: instruction.programId.toBase58(),
    keys: instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    data: Array.from(instruction.data),
  })));
}

function readSavedState(value: unknown): SavedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { version: 1, active: null, history: [] };
  const item = value as Partial<SavedState>;
  const history = Array.isArray(item.history) ? item.history.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return typeof entry.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(entry.signature)
      && ['pending', 'confirmed', 'failed'].includes(entry.status)
      && Number.isSafeInteger(entry.createdAt) && entry.createdAt > 0;
  }).slice(0, MAX_HISTORY) : [];
  let active: DispersePlan | null = null;
  if (item.active && typeof item.active === 'object') {
    const candidate = item.active as DispersePlan & { sourceType?: unknown };
    try {
      const sourceType = candidate.sourceType === undefined ? 'vault' : candidate.sourceType;
      const sourceAddress = new PublicKey(candidate.sourceAddress).toBase58();
      const mint = new PublicKey(candidate.mint).toBase58();
      const programId = new PublicKey(candidate.programId).toBase58();
      const validRecipients = Array.isArray(candidate.recipients) && candidate.recipients.length > 0 && candidate.recipients.length <= MAX_RECIPIENTS
        && candidate.recipients.every((recipient) => new PublicKey(recipient.address).toBase58() === recipient.address
          && /^\d+$/.test(recipient.amountRaw) && /^\d+$/.test(recipient.feeRaw) && /^\d+$/.test(recipient.netRaw)
          && (recipient.solFundingLamports === undefined || /^\d+$/.test(recipient.solFundingLamports))
          && Array.isArray(recipient.allocations) && recipient.allocations.every((allocation) => new PublicKey(allocation.sourceAddress).toBase58() === allocation.sourceAddress
            && /^\d+$/.test(allocation.amountRaw) && /^\d+$/.test(allocation.feeRaw)));
      const validBatches = Array.isArray(candidate.batches) && candidate.batches.length > 0
        && candidate.batches.every((batch, index) => batch.index === index && Array.isArray(batch.recipientIndexes)
          && batch.recipientIndexes.length > 0 && typeof batch.instructionFingerprint === 'string'
          && (batch.fundingLamports === undefined || /^\d+$/.test(batch.fundingLamports))
          && Number.isSafeInteger(batch.feeLamports) && Number.isSafeInteger(batch.ataRentLamports));
      if (candidate.version === 1 && (sourceType === 'vault' || sourceType === 'connected')
        && sourceAddress === candidate.sourceAddress && mint === candidate.mint && programId === candidate.programId
        && Number.isInteger(candidate.decimals) && candidate.decimals >= 0 && candidate.decimals <= 18
        && validRecipients && validBatches && candidate.expectedBalances && typeof candidate.expectedBalances === 'object'
        && (candidate.interBatchDelaySeconds === undefined || (Number.isInteger(candidate.interBatchDelaySeconds) && candidate.interBatchDelaySeconds >= 0 && candidate.interBatchDelaySeconds <= 300))
        && (candidate.interBatchJitterSeconds === undefined || (Number.isInteger(candidate.interBatchJitterSeconds) && candidate.interBatchJitterSeconds >= 0 && candidate.interBatchJitterSeconds <= 120))
        && (candidate.nextBatchReadyAt === undefined || candidate.nextBatchReadyAt === null || (Number.isSafeInteger(candidate.nextBatchReadyAt) && candidate.nextBatchReadyAt > 0))
        && (candidate.consecutiveFailures === undefined || (Number.isInteger(candidate.consecutiveFailures) && candidate.consecutiveFailures >= 0 && candidate.consecutiveFailures <= 6))
        && (candidate.maxConfirmedFailures === undefined || (Number.isInteger(candidate.maxConfirmedFailures) && candidate.maxConfirmedFailures >= 0 && candidate.maxConfirmedFailures <= 5))
        && Number.isInteger(candidate.currentBatch) && candidate.currentBatch >= 0 && candidate.currentBatch <= candidate.batches.length
        && ['ready', 'pending', 'complete', 'failed'].includes(candidate.status)
        && (candidate.pendingSignature === null || (typeof candidate.pendingSignature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(candidate.pendingSignature)))) {
        active = { ...candidate, sourceType };
      }
    } catch { active = null; }
  }
  return { version: 1, active, history };
}

function explorerTransaction(signature: string) {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'value' in error) {
    const value = (error as { value?: { logs?: string[] } }).value;
    if (value?.logs?.length) return value.logs.slice(-5).join(' · ');
  }
  return error instanceof Error ? error.message : '';
}

export default function ProjectWalletTokenDisperse({ wallets, session, onWalletsChange }: { wallets: VaultWallet[]; session: WalletVaultSession; onWalletsChange: (wallets: VaultWallet[]) => void }) {
  const { connection } = useConnection();
  const { connected, publicKey: connectedPublicKey, signTransaction: signConnectedTransaction } = useWallet();
  const { t, locale } = useWireLocale();
  const [sourceAddress, setSourceAddress] = useState(wallets[0]?.address ?? '');
  const [sourceType, setSourceType] = useState<'vault' | 'connected'>('vault');
  const [visibleWallets, setVisibleWallets] = useState(wallets);
  const [tokens, setTokens] = useState<SourceToken[]>([]);
  const [tokenKey, setTokenKey] = useState('');
  const [recipientText, setRecipientText] = useState('');
  const [vaultRecipientAddress, setVaultRecipientAddress] = useState('');
  const [vaultRecipientAmount, setVaultRecipientAmount] = useState('');
  const [recipientWalletCount, setRecipientWalletCount] = useState('1');
  const [minimumSupplyPercent, setMinimumSupplyPercent] = useState('0.10');
  const [maximumSupplyPercent, setMaximumSupplyPercent] = useState('1.00');
  const [solFundingPerRecipient, setSolFundingPerRecipient] = useState('0');
  const [recipientsPerBatch, setRecipientsPerBatch] = useState('4');
  const [interBatchDelaySeconds, setInterBatchDelaySeconds] = useState('0');
  const [interBatchJitterSeconds, setInterBatchJitterSeconds] = useState('0');
  const [maxConfirmedFailures, setMaxConfirmedFailures] = useState('0');
  const [clockNow, setClockNow] = useState(0);
  const [active, setActive] = useState<DispersePlan | null>(null);
  const [history, setHistory] = useState<DisperseReceipt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedToken = useMemo(() => tokens.find((token) => token.key === tokenKey) ?? null, [tokens, tokenKey]);
  const connectedSourceAddress = connected && connectedPublicKey ? connectedPublicKey.toBase58() : '';
  const connectedSourceAvailable = Boolean(connectedSourceAddress && signConnectedTransaction);
  const connectedOptionAddress = active?.sourceType === 'connected' ? active.sourceAddress : connectedSourceAddress;
  const showConnectedOption = connectedSourceAvailable || active?.sourceType === 'connected';
  const activeSourceReady = active?.sourceType === 'connected'
    ? connectedSourceAvailable && connectedSourceAddress === active.sourceAddress
    : Boolean(active && !session.isLocked && session.wallets.some((wallet) => wallet.address === active.sourceAddress));
  const currentBatch = active?.batches[active.currentBatch] ?? null;
  const nextBatchReadyAt = active?.nextBatchReadyAt ?? null;
  const waitSeconds = nextBatchReadyAt ? Math.max(0, Math.ceil((nextBatchReadyAt - clockNow) / 1000)) : 0;
  const latestReceipt = active?.pendingSignature ? history.find((receipt) => receipt.signature === active.pendingSignature) ?? null : null;
  const recipientLineCount = recipientText.split(/\r?\n/).filter((line) => line.trim()).length;
  const maxRecipientWalletCount = Math.max(0, Math.min(MAX_RECIPIENTS - recipientLineCount, MAX_WALLETS - session.wallets.length));

  useEffect(() => { setVisibleWallets(wallets); }, [wallets]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? readSavedState(JSON.parse(stored)) : { version: 1 as const, active: null, history: [] };
      setActive(parsed.active);
      setHistory(parsed.history);
      if (parsed.active) {
        setSourceAddress(parsed.active.sourceAddress);
        setSourceType(parsed.active.sourceType);
        setTokenKey(`${parsed.active.programId}:${parsed.active.mint}`);
        setRecipientText(parsed.active.recipients.map((recipient) => `${recipient.address}, ${formatEditableAmount(recipient.amountRaw, parsed.active!.decimals)}`).join('\n'));
      }
    } catch {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    if (!loaded || active) return;
    const selectedVaultSourceExists = visibleWallets.some((wallet) => wallet.address === sourceAddress);
    const selectedConnectedSourceExists = connectedSourceAvailable && connectedSourceAddress === sourceAddress;
    if ((sourceType === 'vault' && selectedVaultSourceExists) || (sourceType === 'connected' && selectedConnectedSourceExists)) return;
    if (connectedSourceAvailable) {
      setSourceType('connected');
      setSourceAddress(connectedSourceAddress);
      return;
    }
    setSourceType('vault');
    setSourceAddress(visibleWallets[0]?.address ?? '');
  }, [active, connectedSourceAddress, connectedSourceAvailable, loaded, sourceAddress, sourceType, visibleWallets]);

  useEffect(() => {
    const availableRecipients = visibleWallets.filter((wallet) => wallet.address !== sourceAddress);
    if (!availableRecipients.some((wallet) => wallet.address === vaultRecipientAddress)) {
      setVaultRecipientAddress(availableRecipients[0]?.address ?? '');
    }
  }, [sourceAddress, vaultRecipientAddress, visibleWallets]);

  useEffect(() => {
    if (!loaded) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, active, history } satisfies SavedState)); }
    catch { setError(t('No se pudo guardar el plan de distribución en este navegador.')); }
  }, [active, history, loaded, t]);

  useEffect(() => {
    if (!nextBatchReadyAt || active?.status !== 'ready') return;
    const updateClock = () => setClockNow(Date.now());
    updateClock();
    if (nextBatchReadyAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockNow(now);
      if (now >= nextBatchReadyAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active?.status, nextBatchReadyAt]);

  const refreshTokens = useCallback(async () => {
    if (!sourceAddress) return;
    setLoadingTokens(true);
    setError('');
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error(t('Wire solo permite enviar desde el clúster Devnet.'));
      const balances = await loadSourceTokens(connection, new PublicKey(sourceAddress));
      setTokens(balances);
      if (!balances.some((token) => token.key === tokenKey)) setTokenKey(balances[0]?.key ?? '');
      setNotice(t('Balances de tokens actualizados desde Devnet.'));
    } catch (caught) {
      setError(t(errorText(caught) || 'No se pudieron cargar los tokens de esta wallet.'));
    } finally { setLoadingTokens(false); }
  }, [connection, sourceAddress, sourceType, tokenKey, t]);

  useEffect(() => { void refreshTokens(); }, [refreshTokens]);

  const verifyPending = useCallback(async () => {
    if (!active?.pendingSignature || !latestReceipt || working) return;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const statuses = await connection.getSignatureStatuses([active.pendingSignature], { searchTransactionHistory: true });
      const status = statuses.value[0];
      if (!status) {
        setNotice(t('La firma todavía no aparece en el historial de Devnet. No vuelvas a enviarla.'));
        return;
      }
      const isConfirmed = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || status.confirmations === null;
      if (!isConfirmed) {
        setNotice(t('La transacción sigue procesándose. Espera y verifica su estado otra vez.'));
        return;
      }
      if (status.err) {
        setHistory((current) => current.map((receipt) => receipt.signature === active.pendingSignature ? { ...receipt, status: 'failed' } : receipt));
        const outcome = advanceAfterConfirmedFailure(active);
        setActive(outcome.plan);
        setError(outcome.skipped
          ? outcome.hasNext
            ? t('Lote {batch} falló confirmado y se omitió. El siguiente sigue requiriendo revisión y firma manual. Fallos consecutivos: {count}/{max}.', { batch: active.currentBatch + 1, count: outcome.plan.consecutiveFailures ?? 1, max: outcome.plan.maxConfirmedFailures ?? 0 })
            : t('El último lote falló y se omitió; ya no quedan lotes pendientes. Revisa el historial.')
          : t('El límite de fallos confirmados se alcanzó y la distribución se detuvo. Revisa el historial antes de preparar otra.'));
        return;
      }
      const batch = active.batches[active.currentBatch];
      if (!batch) throw new Error(t('No se encontró el lote pendiente en el plan guardado.'));
      const amountByAccount = new Map<string, bigint>();
      for (const recipientIndex of batch.recipientIndexes) {
        for (const allocation of active.recipients[recipientIndex].allocations) {
          amountByAccount.set(allocation.sourceAddress, (amountByAccount.get(allocation.sourceAddress) ?? 0n) + BigInt(allocation.amountRaw));
        }
      }
      const expectedBalances = { ...active.expectedBalances };
      for (const [address, amount] of amountByAccount) expectedBalances[address] = (BigInt(expectedBalances[address] ?? '0') - amount).toString();
      setHistory((current) => current.map((receipt) => receipt.signature === active.pendingSignature ? { ...receipt, status: 'confirmed' } : receipt));
      const nextBatch = active.currentBatch + 1;
       const nextReadyAt = scheduleNextBatch(active, nextBatch);
       setActive({ ...active, expectedBalances, currentBatch: nextBatch, nextBatchReadyAt: nextReadyAt, consecutiveFailures: 0, status: nextBatch >= active.batches.length ? 'complete' : 'ready', pendingSignature: null });
       setNotice(nextReadyAt
         ? t('Lote confirmado. La siguiente revisión se habilitará en {seconds} s; no se enviará sola.', { seconds: Math.ceil((nextReadyAt - Date.now()) / 1000) })
         : t('Lote confirmado en Devnet. Puedes revisar el siguiente antes de enviarlo.'));
    } catch (caught) {
      setError(t(errorText(caught) || 'No se pudo consultar el estado de la firma.'));
    } finally { setWorking(false); }
  }, [active, connection, latestReceipt, t, working]);

  const addVaultRecipient = () => {
    if (!selectedToken || !vaultRecipientAddress) return;
    const recipient = visibleWallets.find((wallet) => wallet.address === vaultRecipientAddress);
    if (!recipient || recipient.address === sourceAddress) {
      setError(t('La wallet de origen no puede aparecer como destinatario.'));
      return;
    }
    let amountText = '';
    if (vaultRecipientAmount.trim()) {
      try {
        const amountRaw = parseAmount(vaultRecipientAmount, selectedToken.decimals);
        amountText = formatEditableAmount(amountRaw.toString(), selectedToken.decimals);
      } catch (caught) {
        const raw = caught instanceof Error ? caught.message : '';
        setError(raw.includes('{decimals}')
          ? t(raw, { decimals: selectedToken.decimals })
          : t(raw || 'El importe no es válido.'));
        return;
      }
    }
    const existingAddresses = new Set(recipientText.split(/\r?\n/)
      .map((line) => line.trim().split(/[\t,; ]+/)[0])
      .filter(Boolean));
    if (existingAddresses.has(recipient.address)) {
      setError(t('Hay una dirección repetida en la lista.'));
      return;
    }
    const currentLines = recipientText.split(/\r?\n/).filter((line) => line.trim()).length;
    if (currentLines >= MAX_RECIPIENTS) {
      setError(t('Máximo {count} destinatarios por distribución.', { count: MAX_RECIPIENTS }));
      return;
    }
    setRecipientText((current) => `${current.trimEnd()}${current.trim() ? '\n' : ''}${recipient.address}${amountText ? `, ${amountText}` : ''}`);
    setVaultRecipientAmount('');
    setError('');
    setNotice(amountText ? t('Wallet añadida a los destinatarios. Revisa la dirección y el importe.') : t('Wallet añadida sin importe. Genera una asignación por supply o escribe el importe.'));
  };

  const createRecipientWallets = useCallback(async () => {
    if (working || session.isLocked) return;
    const count = Number(recipientWalletCount);
    if (!Number.isInteger(count) || count < 1 || count > maxRecipientWalletCount) {
      setError(t('Elige una cantidad de wallets entre 1 y {max}.', { max: maxRecipientWalletCount }));
      return;
    }

    setWorking(true);
    setError('');
    setNotice('');
    const created: VaultWallet[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        const label = t('Wallet destinataria {number}', { number: session.wallets.length + index + 1 });
        created.push(await session.createWallet(label, 'holder'));
      }
      const nextWallets = session.wallets;
      setVisibleWallets(nextWallets);
      onWalletsChange(nextWallets);
      setVaultRecipientAddress(created[0]?.address ?? '');
      setRecipientText((current) => `${current.trimEnd()}${current.trim() ? '\n' : ''}${created.map((wallet) => wallet.address).join('\n')}`);
      setNotice(t('{count} wallets se crearon cifradas y se añadieron como destinatarias. Genera una asignación por supply o escribe sus importes.', { count: created.length }));
    } catch (caught) {
      const currentWallets = session.wallets;
      setVisibleWallets(currentWallets);
      onWalletsChange(currentWallets);
      if (created.length) {
        setRecipientText((current) => `${current.trimEnd()}${current.trim() ? '\n' : ''}${created.map((wallet) => wallet.address).join('\n')}`);
      }
      setError(created.length
        ? t('Se crearon {count} wallets antes del error. Permanecen guardadas cifradas en la bóveda.', { count: created.length })
        : t(errorText(caught) || 'No se pudieron crear las wallets nuevas.'));
    } finally {
      setWorking(false);
    }
  }, [maxRecipientWalletCount, onWalletsChange, recipientWalletCount, session, t, working]);

  const generateSupplyAllocations = useCallback(async () => {
    if (!selectedToken || !sourceAddress || working) return;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const minimumBps = parsePercentBasisPoints(minimumSupplyPercent);
      const maximumBps = parsePercentBasisPoints(maximumSupplyPercent);
      if (minimumBps > maximumBps) throw new Error(t('El mínimo no puede superar el máximo.'));
      const addresses = parseAllocationAddresses(recipientText, sourceAddress, t);
      if (maximumBps * addresses.length > 10_000) throw new Error(t('El máximo por wallet multiplicado por los destinatarios no puede superar el 100% del supply.'));

      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error(t('Wire solo permite enviar desde el clúster Devnet.'));
      const mint = new PublicKey(selectedToken.mint);
      const programId = new PublicKey(selectedToken.programId);
      const mintInfo = await getMint(connection, mint, 'confirmed', programId);
      if (!mintInfo.isInitialized || mintInfo.decimals !== selectedToken.decimals || mintInfo.supply <= 0n) {
        throw new Error(t('No se pudo verificar el supply actual del mint en Devnet.'));
      }
      const freshToken = (await loadSourceTokens(connection, new PublicKey(sourceAddress))).find((token) => token.key === selectedToken.key);
      if (!freshToken) throw new Error(t('La wallet de origen ya no tiene saldo de este token. Actualiza los balances.'));

      const allocations = addresses.map((address) => {
        const basisPoints = randomIntegerInclusive(minimumBps, maximumBps);
        const amountRaw = (mintInfo.supply * BigInt(basisPoints)) / 10_000n;
        if (amountRaw <= 0n) throw new Error(t('El porcentaje elegido produce menos de la unidad mínima del token. Aumenta el mínimo.'));
        return { address, amountRaw };
      });
      const total = allocations.reduce((sum, allocation) => sum + allocation.amountRaw, 0n);
      if (total > BigInt(freshToken.amountRaw)) throw new Error(t('La asignación generada supera el saldo actual de la wallet. Reduce el rango porcentual y vuelve a generar.'));

      const amountsByAddress = new Map(allocations.map((allocation) => [allocation.address, allocation.amountRaw]));
      const lines = addresses.map((address) => `${address}, ${formatEditableAmount(amountsByAddress.get(address)!.toString(), selectedToken.decimals)}`);
      setRecipientText(lines.join('\n'));
      setNotice(t('Importes generados entre {min}% y {max}% del supply actual ({supply} tokens). Revísalos y edítalos antes de preparar la distribución.', {
        min: minimumSupplyPercent,
        max: maximumSupplyPercent,
        supply: formatAmount(mintInfo.supply, selectedToken.decimals, locale),
      }));
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : '';
      setError(t(raw || 'No se pudieron generar las asignaciones por supply.'));
    } finally {
      setWorking(false);
    }
  }, [connection, locale, maximumSupplyPercent, minimumSupplyPercent, recipientText, selectedToken, sourceAddress, t, working]);

  const prepareDistribution = useCallback(async () => {
    if (!selectedToken) return;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error(t('Wire solo permite enviar desde el clúster Devnet.'));
      const source = new PublicKey(sourceAddress);
      if (sourceType === 'vault') {
        if (session.isLocked) throw new Error(t('Desbloquea la bóveda para usar esta wallet de origen.'));
        if (!session.wallets.some((wallet) => wallet.address === sourceAddress)) throw new Error(t('La wallet de origen ya no está en la bóveda.'));
      } else if (!connectedSourceAvailable || connectedSourceAddress !== sourceAddress) {
        throw new Error(t('Conecta la wallet de origen para revisar y firmar.'));
      }
      const recipientsInput = parseRecipients(recipientText, selectedToken.decimals, sourceAddress, t);
      const total = recipientsInput.reduce((sum, recipient) => sum + BigInt(recipient.amountRaw), 0n);
      const requestedBatchSize = Number(recipientsPerBatch);
      if (!Number.isInteger(requestedBatchSize) || requestedBatchSize < 1 || requestedBatchSize > MAX_RECIPIENTS_PER_BATCH) {
        throw new Error(t('El tamaño de lote debe estar entre 1 y {max} destinatarios.', { max: MAX_RECIPIENTS_PER_BATCH }));
      }
      const requestedDelay = Number(interBatchDelaySeconds);
      const requestedJitter = Number(interBatchJitterSeconds);
      if (!Number.isInteger(requestedDelay) || requestedDelay < 0 || requestedDelay > 300) throw new Error(t('La pausa debe estar entre 0 y 300 segundos.'));
      if (!Number.isInteger(requestedJitter) || requestedJitter < 0 || requestedJitter > 120) throw new Error(t('El jitter debe estar entre 0 y 120 segundos.'));
      const requestedMaxFailures = Number(maxConfirmedFailures);
      if (!Number.isInteger(requestedMaxFailures) || requestedMaxFailures < 0 || requestedMaxFailures > 5) throw new Error(t('El límite debe estar entre 0 y 5 fallos confirmados.'));
      let fundingLamports: bigint;
      try { fundingLamports = parseSolLamports(solFundingPerRecipient); }
      catch (caught) { throw new Error(t(caught instanceof Error ? caught.message : 'El importe SOL no es válido.')); }

      const mint = new PublicKey(selectedToken.mint);
      const programId = new PublicKey(selectedToken.programId);
      const mintInfo = await getMint(connection, mint, 'confirmed', programId);
      if (!mintInfo.isInitialized || mintInfo.decimals !== selectedToken.decimals) throw new Error(t('La información del mint cambió. Actualiza los balances y revisa otra vez.'));
      const refreshedToken = (await loadSourceTokens(connection, source)).find((token) => token.key === selectedToken.key);
      if (!refreshedToken) throw new Error(t('La wallet ya no tiene saldo de este token. Actualiza los balances.'));
      const freshAccounts: SourceTokenAccount[] = [];
      for (const candidate of refreshedToken.accounts) {
        const accountInfo = await getAccount(connection, new PublicKey(candidate.address), 'confirmed', programId);
        if (!accountInfo.owner.equals(source) || !accountInfo.mint.equals(mint) || accountInfo.isFrozen) {
          throw new Error(t('Una cuenta de tokens de origen cambió, está congelada o no pertenece a esta wallet. Actualiza los balances.'));
        }
        if (accountInfo.amount > 0n) freshAccounts.push({ address: candidate.address, amountRaw: accountInfo.amount.toString() });
      }
      const freshToken: SourceToken = {
        ...refreshedToken,
        accounts: freshAccounts,
        amountRaw: freshAccounts.reduce((sum, account) => sum + BigInt(account.amountRaw), 0n).toString(),
      };
      if (total > BigInt(freshToken.amountRaw)) throw new Error(t('El saldo del token no alcanza para cubrir el total indicado.'));
      const epoch = BigInt((await connection.getEpochInfo('confirmed')).epoch);
      const transferFeeConfig = getTransferFeeConfig(mintInfo);
      const recipients = assignAmounts(recipientsInput, freshToken).map((recipient) => {
        const allocations = recipient.allocations.map((allocation) => {
          const fee = transferFeeConfig ? calculateEpochFee(transferFeeConfig, epoch, BigInt(allocation.amountRaw)) : 0n;
          return { ...allocation, feeRaw: fee.toString() };
        });
        const feeRaw = allocations.reduce((sum, allocation) => sum + BigInt(allocation.feeRaw), 0n);
        return {
          ...recipient,
          allocations,
          feeRaw: feeRaw.toString(),
          netRaw: (BigInt(recipient.amountRaw) - feeRaw).toString(),
          solFundingLamports: fundingLamports.toString(),
        };
      });

      const expectedBalances: Record<string, string> = {};
      for (const account of freshAccounts) expectedBalances[account.address] = account.amountRaw;

      const initialPlan: DispersePlan = {
        version: 1,
        sourceType,
        sourceAddress,
        mint: selectedToken.mint,
        programId: selectedToken.programId,
        decimals: selectedToken.decimals,
        recipients,
        expectedBalances,
        batches: [],
        currentBatch: 0,
        interBatchDelaySeconds: requestedDelay,
        interBatchJitterSeconds: requestedJitter,
        nextBatchReadyAt: null,
        consecutiveFailures: 0,
        maxConfirmedFailures: requestedMaxFailures,
        status: 'ready',
        pendingSignature: null,
      };
      const recipientChunks: number[][] = [];
      for (let i = 0; i < recipients.length; i += requestedBatchSize) {
        recipientChunks.push(Array.from({ length: Math.min(requestedBatchSize, recipients.length - i) }, (_, offset) => i + offset));
      }

      const preparedBatches: PlannedBatch[] = [];
      const prepareRange = async (recipientIndexes: number[]): Promise<void> => {
        try {
          const built = await buildBatchTransaction(connection, source, mint, programId, mintInfo, initialPlan, recipientIndexes, t);
          preparedBatches.push({
            index: preparedBatches.length,
            recipientIndexes,
            instructionFingerprint: built.instructionFingerprint,
            feeLamports: built.feeLamports,
            ataRentLamports: built.ataRentLamports,
            fundingLamports: built.fundingLamports.toString(),
          });
        } catch (caught) {
          if (recipientIndexes.length < 2) throw caught;
          const middle = Math.ceil(recipientIndexes.length / 2);
          await prepareRange(recipientIndexes.slice(0, middle));
          await prepareRange(recipientIndexes.slice(middle));
        }
      };
      for (const recipientIndexes of recipientChunks) await prepareRange(recipientIndexes);

      const sourceSol = await connection.getBalance(source, 'confirmed');
      const totalNetworkFees = preparedBatches.reduce((sum, batch) => sum + batch.feeLamports, 0);
      const totalRent = preparedBatches.reduce((sum, batch) => sum + batch.ataRentLamports, 0);
      const totalFunding = preparedBatches.reduce((sum, batch) => sum + BigInt(batch.fundingLamports ?? '0'), 0n);
      if (BigInt(sourceSol) < BigInt(totalNetworkFees + totalRent) + totalFunding) throw new Error(t('La wallet de origen necesita más SOL para la financiación, las comisiones y las cuentas receptoras.'));
      const plan = { ...initialPlan, batches: preparedBatches };
      setActive(plan);
      setNotice(t('Revisión lista. Cada lote requiere una confirmación tuya desde Wire.'));
    } catch (caught) {
      setError(t(errorText(caught) || 'No se pudo preparar la distribución.'));
    } finally { setWorking(false); }
  }, [connectedSourceAddress, connectedSourceAvailable, connection, interBatchDelaySeconds, interBatchJitterSeconds, maxConfirmedFailures, recipientText, recipientsPerBatch, selectedToken, session, solFundingPerRecipient, sourceAddress, sourceType, t]);

  const sendNextBatch = useCallback(async () => {
    if (!active || active.status !== 'ready' || !currentBatch || working) return;
    if (active.nextBatchReadyAt && Date.now() < active.nextBatchReadyAt) {
      setError(t('Espera {seconds} s antes de revisar el siguiente lote.', { seconds: Math.ceil((active.nextBatchReadyAt - Date.now()) / 1000) }));
      return;
    }
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error(t('Wire solo permite enviar desde el clúster Devnet.'));
      if (active.sourceType === 'vault') {
        if (session.isLocked) throw new Error(t('Desbloquea la bóveda para usar esta wallet de origen.'));
        if (!session.wallets.some((wallet) => wallet.address === active.sourceAddress)) throw new Error(t('La wallet de origen ya no está en la bóveda.'));
      } else if (!connectedSourceAvailable || connectedSourceAddress !== active.sourceAddress || !signConnectedTransaction) {
        throw new Error(t('Reconecta la wallet conectada que elegiste para este plan.'));
      }
      const source = new PublicKey(active.sourceAddress);
      const mint = new PublicKey(active.mint);
      const programId = new PublicKey(active.programId);
      const currentMint = await getMint(connection, mint, 'confirmed', programId);
      if (!currentMint.isInitialized || currentMint.decimals !== active.decimals) throw new Error(t('La información del mint cambió. Vuelve a preparar la revisión.'));

      const currentAccounts = new Map<string, bigint>();
      for (const [address, expectedRaw] of Object.entries(active.expectedBalances)) {
        const account = await getAccount(connection, new PublicKey(address), 'confirmed', programId);
        if (!account.owner.equals(source) || !account.mint.equals(mint) || account.isFrozen || account.amount.toString() !== expectedRaw) {
          throw new Error(t('El saldo de origen cambió desde la revisión. Actualiza y prepara otra vez antes de firmar.'));
        }
        currentAccounts.set(address, account.amount);
      }

      const rebuilt = await buildBatchTransaction(connection, source, mint, programId, currentMint, active, currentBatch.recipientIndexes, t);
      if (rebuilt.instructionFingerprint !== currentBatch.instructionFingerprint) throw new Error(t('El lote cambió desde la revisión. Prepáralo de nuevo antes de firmar.'));
      if (rebuilt.feeLamports > currentBatch.feeLamports || rebuilt.ataRentLamports > currentBatch.ataRentLamports
        || rebuilt.fundingLamports.toString() !== (currentBatch.fundingLamports ?? '0')) {
        throw new Error(t('El lote o sus costes cambiaron desde la revisión. Revisa el lote otra vez antes de firmar.'));
      }

      const batchCostsRemaining = active.batches.slice(active.currentBatch).reduce((sum, batch) => sum + BigInt(batch.feeLamports + batch.ataRentLamports) + BigInt(batch.fundingLamports ?? '0'), 0n);
      if (BigInt(await connection.getBalance(source, 'confirmed')) < batchCostsRemaining) throw new Error(t('La wallet de origen ya no tiene SOL suficiente para completar los lotes revisados.'));

      const allowedPrograms = [ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SystemProgram.programId];
      if (rebuilt.transaction.instructions.some((instruction) => !allowedPrograms.some((allowed) => instruction.programId.equals(allowed)))) {
        throw new Error(t('El lote contiene un programa inesperado. No se firmó.'));
      }
      const message = rebuilt.transaction.compileMessage();
      const requiredSigners = message.accountKeys.slice(0, message.header.numRequiredSignatures);
      if (requiredSigners.length !== 1 || !requiredSigners[0].equals(source)) throw new Error(t('La transacción requiere una firma inesperada. No se firmó.'));
      const unsignedMessage = rebuilt.transaction.serializeMessage();
      const signed = active.sourceType === 'vault'
        ? await session.signTransaction(active.sourceAddress, rebuilt.transaction)
        : await signConnectedTransaction!(rebuilt.transaction);
      const signedMessage = signed.serializeMessage();
      if (unsignedMessage.length !== signedMessage.length || unsignedMessage.some((byte, index) => byte !== signedMessage[index])) {
        throw new Error(t('El mensaje cambió al firmar. No se enviará la transacción.'));
      }
      if (!signed.verifySignatures()) throw new Error(t('La firma local de la wallet no es válida. No se envió.'));
      const sourceSignature = signed.signatures.find((entry) => entry.publicKey.equals(source))?.signature;
      if (!sourceSignature) throw new Error(t('La wallet de origen no firmó la transacción. No se envió.'));
      const signature = bs58.encode(sourceSignature);
      const batchRecipients = currentBatch.recipientIndexes.map((index) => active.recipients[index]);
      const receipt: DisperseReceipt = {
        signature,
        status: 'pending',
        sourceAddress: active.sourceAddress,
        mint: active.mint,
        decimals: active.decimals,
        batchIndex: active.currentBatch,
        batchCount: active.batches.length,
        recipients: batchRecipients.map((recipient) => ({ address: recipient.address, amountRaw: recipient.amountRaw, netRaw: recipient.netRaw, solFundingLamports: recipient.solFundingLamports ?? '0' })),
        feeLamports: rebuilt.feeLamports,
        ataRentLamports: rebuilt.ataRentLamports,
        createdAt: Date.now(),
      };
      const pendingActive = { ...active, status: 'pending' as const, pendingSignature: signature };
      const nextHistory = [receipt, ...history.filter((item) => item.signature !== signature)].slice(0, MAX_HISTORY);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, active: pendingActive, history: nextHistory } satisfies SavedState));
      } catch {
        throw new Error(t('No se pudo guardar el estado local antes del envío. No se envió la transacción.'));
      }
      setHistory(nextHistory);
      setActive(pendingActive);

      let confirmationFailed = false;
      try {
        const sentSignature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
        if (sentSignature !== signature) throw new Error(t('La firma enviada no coincide con la firma local. Revisa Explorer antes de continuar.'));
        const confirmation = await connection.confirmTransaction({ signature, blockhash: rebuilt.blockhash, lastValidBlockHeight: rebuilt.lastValidBlockHeight }, 'confirmed');
        if (confirmation.value.err) {
          setHistory((current) => current.map((item) => item.signature === signature ? { ...item, status: 'failed' } : item));
          const outcome = advanceAfterConfirmedFailure(active);
          setActive(outcome.plan);
          confirmationFailed = true;
          throw new Error(outcome.skipped
            ? outcome.hasNext
              ? t('Lote {batch} falló confirmado y se omitió. El siguiente sigue requiriendo revisión y firma manual. Fallos consecutivos: {count}/{max}.', { batch: active.currentBatch + 1, count: outcome.plan.consecutiveFailures ?? 1, max: outcome.plan.maxConfirmedFailures ?? 0 })
              : t('El último lote falló y se omitió; ya no quedan lotes pendientes. Revisa el historial.')
            : t('El límite de fallos confirmados se alcanzó y la distribución se detuvo. Revisa el historial antes de preparar otra.'));
        }
        const updatedBalances = { ...active.expectedBalances };
        for (const recipientIndex of currentBatch.recipientIndexes) {
          for (const allocation of active.recipients[recipientIndex].allocations) {
            updatedBalances[allocation.sourceAddress] = (BigInt(updatedBalances[allocation.sourceAddress]) - BigInt(allocation.amountRaw)).toString();
          }
        }
        const nextBatch = active.currentBatch + 1;
        const nextReadyAt = scheduleNextBatch(active, nextBatch);
        setHistory((current) => current.map((item) => item.signature === signature ? { ...item, status: 'confirmed' } : item));
        setActive({ ...active, expectedBalances: updatedBalances, currentBatch: nextBatch, nextBatchReadyAt: nextReadyAt, consecutiveFailures: 0, status: nextBatch >= active.batches.length ? 'complete' : 'ready', pendingSignature: null });
        setNotice(nextReadyAt
          ? t('Lote confirmado. La siguiente revisión se habilitará en {seconds} s; no se enviará sola.', { seconds: Math.ceil((nextReadyAt - Date.now()) / 1000) })
          : t('Lote {current} de {total} confirmado en Devnet.', { current: active.currentBatch + 1, total: active.batches.length }));
      } catch (sendError) {
        if (!confirmationFailed) {
          setNotice(t('El envío quedó incierto. La firma se guardó; verifica su estado antes de continuar y no la envíes de nuevo.'));
        }
        throw sendError;
      }
    } catch (caught) {
      setError(t(errorText(caught) || 'No se pudo completar este lote. Revisa su estado antes de intentarlo de nuevo.'));
    } finally { setWorking(false); }
  }, [active, connectedSourceAddress, connectedSourceAvailable, connection, currentBatch, history, session, signConnectedTransaction, t, working]);

  const resetPlan = () => {
    if (active?.status === 'pending') return;
    setActive(null);
    setRecipientText('');
    setSolFundingPerRecipient('0');
    setError('');
    setNotice('');
  };

  const totalTokens = selectedToken ? formatAmount(selectedToken.amountRaw, selectedToken.decimals, locale) : '—';
  const totalPlanned = active ? active.recipients.reduce((sum, recipient) => sum + BigInt(recipient.amountRaw), 0n) : 0n;
  const totalTransferFees = active ? active.recipients.reduce((sum, recipient) => sum + BigInt(recipient.feeRaw), 0n) : 0n;
  const totalFundingLamports = active ? active.recipients.reduce((sum, recipient) => sum + BigInt(recipient.solFundingLamports ?? '0'), 0n) : 0n;
  const remainingFees = active ? active.batches.slice(active.currentBatch).reduce((sum, batch) => sum + batch.feeLamports, 0) : 0;
  const remainingRent = active ? active.batches.slice(active.currentBatch).reduce((sum, batch) => sum + batch.ataRentLamports, 0) : 0;
  const remainingFundingLamports = active ? active.batches.slice(active.currentBatch).reduce((sum, batch) => sum + BigInt(batch.fundingLamports ?? '0'), 0n) : 0n;

  return (
    <section className="mt-5 border-t border-[var(--line)] pt-5" aria-labelledby="project-wallet-token-disperse-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="project-wallet-token-disperse-title" className="font-semibold">{t('Token Disperse')}</h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t('Envía tokens SPL desde una wallet del vault a direcciones que indiques. No es una compra ni cambia el volumen del mercado.')}</p>
        </div>
        <span className="rounded-full border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--wire-green)]">{t('Solo Devnet')}</span>
      </header>

      <details className="mt-3 rounded-lg border border-[var(--line)] p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('Guía de Token Disperse')}</summary>
        <div className="mt-2 grid gap-2 text-xs leading-relaxed text-[var(--muted)]">
          <p>{t('Usa esta herramienta para repartir tokens desde la wallet conectada o una wallet de proyecto de la bóveda, por ejemplo entre colaboradores o wallets de prueba. Especifica cada destinatario y cantidad.')}</p>
          <p>{t('Wire prepara y simula lotes pequeños. Revisa las direcciones, los importes, el SOL opcional, los fees y el rent; cada envío requiere tu firma local y una confirmación manual.')}</p>
          <p>{t('Esto solo transfiere tokens: no compra ni vende, no crea una pool y no genera volumen de mercado. Las transferencias confirmadas son irreversibles.')}</p>
        </div>
      </details>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="grid gap-1.5 text-sm">
          {t('Wallet de origen')}
          <select value={sourceAddress ? `${sourceType}:${sourceAddress}` : ''} onChange={(event) => {
            const [nextSourceType, nextSourceAddress] = event.target.value.split(':', 2);
            if ((nextSourceType !== 'vault' && nextSourceType !== 'connected') || !nextSourceAddress) return;
            setSourceType(nextSourceType);
            setSourceAddress(nextSourceAddress);
            setTokenKey('');
            setTokens([]);
          }} disabled={working || Boolean(active)} className="wire-input min-h-11 w-full">
          <option value="" disabled>{t('Selecciona una wallet de origen')}</option>
          {showConnectedOption && <option value={`connected:${connectedOptionAddress}`}>{t('Wallet conectada')} · {shorten(connectedOptionAddress)}</option>}
          {visibleWallets.map((wallet) => <option key={`vault:${wallet.address}`} value={`vault:${wallet.address}`}>{t('Bóveda local')} · {wallet.label || t('Wallet sin nombre')} · {shorten(wallet.address)}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm">
          {t('Token de origen')}
          <span className="flex gap-2">
            <select value={tokenKey} onChange={(event) => setTokenKey(event.target.value)} disabled={loadingTokens || working || !tokens.length || Boolean(active)} className="wire-input min-h-11 min-w-0 flex-1">
              <option value="">{loadingTokens ? t('Cargando balances…') : t('Selecciona un token con saldo')}</option>
              {tokens.map((token) => <option key={token.key} value={token.key}>{shorten(token.mint)} · {formatAmount(token.amountRaw, token.decimals, locale)} · {token.programId === TOKEN_PROGRAM_ID.toBase58() ? t('SPL Token') : 'Token-2022'}</option>)}
            </select>
            <button type="button" onClick={() => void refreshTokens()} disabled={loadingTokens || working} className="wire-button wire-button-secondary min-h-11 w-11 p-0" aria-label={t('Actualizar balances de tokens')}>
              {loadingTokens ? <span className="wire-loading-mark" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            </button>
          </span>
          {selectedToken && <span className="text-xs text-[var(--muted)]">{t('Saldo disponible')}: {totalTokens}</span>}
        </label>
      </div>

      {!active && (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2 pt-1">
            <div>
              <p className="text-sm font-medium">{t('Añade una wallet del vault')}</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Selecciona otra wallet de proyecto como destinataria o pega cualquier dirección pública abajo.')}</p>
            </div>
            <div className="grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.35fr)_auto] sm:items-end">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('Auto-crear wallets destinatarias')}</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Se generan en este navegador y se guardan cifradas en la bóveda. Esto no envía SOL ni tokens.')}</p>
              </div>
              <label className="grid gap-1.5 text-xs">{t('Cantidad de wallets')}
                <input type="number" min={maxRecipientWalletCount > 0 ? 1 : 0} max={maxRecipientWalletCount} step={1} value={recipientWalletCount} onChange={(event) => setRecipientWalletCount(event.target.value)} disabled={working || session.isLocked || maxRecipientWalletCount < 1} className="wire-input min-h-11 w-full font-mono" />
              </label>
              <button type="button" onClick={() => void createRecipientWallets()} disabled={working || session.isLocked || !sourceAddress || maxRecipientWalletCount < 1} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">
                {working ? <span className="wire-loading-mark" aria-hidden="true" /> : null}{t('Crear wallets locales')}
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.45fr)_auto] sm:items-end">
              <label className="grid gap-1.5 text-xs">{t('Wallet destinataria')}
                <select value={vaultRecipientAddress} onChange={(event) => setVaultRecipientAddress(event.target.value)} disabled={working || !selectedToken || visibleWallets.length < 2} className="wire-input min-h-11 w-full">
                  <option value="">{visibleWallets.length < 2 ? t('Añade otra wallet al vault para seleccionarla.') : t('Selecciona una wallet de proyecto')}</option>
                  {visibleWallets.filter((wallet) => wallet.address !== sourceAddress).map((wallet) => <option key={wallet.address} value={wallet.address}>{wallet.label || t('Wallet sin nombre')} · {shorten(wallet.address)}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-xs">{t('Importe (opcional)')}
                <input type="text" inputMode="decimal" autoComplete="off" value={vaultRecipientAmount} onChange={(event) => setVaultRecipientAmount(event.target.value)} disabled={working || !selectedToken} placeholder={selectedToken ? `0.${'0'.repeat(Math.min(selectedToken.decimals, 2))}` : '0.00'} className="wire-input min-h-11 w-full font-mono" />
              </label>
              <button type="button" onClick={addVaultRecipient} disabled={working || !selectedToken || !vaultRecipientAddress || visibleWallets.length < 2} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Añadir destinatario')}</button>
            </div>
          </div>
          <label className="grid gap-1.5 text-sm">
            {t('Destinatarios e importes')}
            <textarea value={recipientText} onChange={(event) => setRecipientText(event.target.value)} rows={6} disabled={working} spellCheck={false} autoCapitalize="off" autoComplete="off" className="wire-input min-h-36 w-full resize-y font-mono text-xs" placeholder={t('Pega una dirección y un importe por línea: dirección, importe')} />
          </label>
          <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Usa una línea por destinatario con dirección, importe y coma o tabulación entre ambos. Escribe los decimales con punto. Hasta {count} destinos; los lotes se separan para limitar tamaño y costo.', { count: MAX_RECIPIENTS })}</p>
          <fieldset className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
            <legend className="px-1 text-sm font-medium">{t('Asignación por rango de supply')}</legend>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Genera un importe aleatorio para cada dirección usando el supply actual del mint. Los importes quedan fijos y editables; Wire vuelve a revisar saldo, fees y cuentas antes de pedir cada firma.')}</p>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
              <label className="grid gap-1.5 text-xs">{t('Mínimo del supply (%)')}
                <input type="text" inputMode="decimal" autoComplete="off" value={minimumSupplyPercent} onChange={(event) => setMinimumSupplyPercent(event.target.value)} disabled={working || !selectedToken} className="wire-input min-h-11 w-full font-mono" aria-label={t('Mínimo del supply (%)')} />
              </label>
              <label className="grid gap-1.5 text-xs">{t('Máximo del supply (%)')}
                <input type="text" inputMode="decimal" autoComplete="off" value={maximumSupplyPercent} onChange={(event) => setMaximumSupplyPercent(event.target.value)} disabled={working || !selectedToken} className="wire-input min-h-11 w-full font-mono" aria-label={t('Máximo del supply (%)')} />
              </label>
              <button type="button" onClick={() => void generateSupplyAllocations()} disabled={working || !selectedToken || !recipientText.trim() || !sourceAddress} className="wire-button wire-button-secondary min-h-11 justify-center">
                {working ? <span className="wire-loading-mark" aria-hidden="true" /> : null}{t('Generar importes')}
              </button>
            </div>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Admite 0.01–100% con dos decimales. El máximo por destino multiplicado por el número de direcciones no puede superar el 100% del supply; el total también debe caber en el saldo de origen.')}</p>
          </fieldset>
          <fieldset className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
            <legend className="px-1 text-sm font-medium">{t('Financiación SOL opcional')}</legend>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Envía el mismo importe SOL a cada destinatario desde la wallet de origen. Se incluye en el lote del token y solo sale después de revisar y firmar ese lote; 0 desactiva esta opción.')}</p>
            <label className="grid max-w-sm gap-1.5 text-xs">{t('SOL por destinatario')}
              <span className="flex items-center gap-2"><input type="text" inputMode="decimal" autoComplete="off" value={solFundingPerRecipient} onChange={(event) => setSolFundingPerRecipient(event.target.value)} disabled={working || Boolean(active) || !selectedToken} className="wire-input min-h-11 min-w-0 flex-1 font-mono" aria-label={t('SOL por destinatario')} /><span className="text-xs text-[var(--muted)]">SOL</span></span>
            </label>
          </fieldset>
          <fieldset className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
            <legend className="px-1 text-sm font-medium">{t('Tamaño de los lotes')}</legend>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Elige cuántos destinatarios incluir en cada revisión manual. Wire puede reducir el lote si la transacción supera el tamaño admitido.')}</p>
            <label className="grid max-w-sm gap-1.5 text-xs">{t('Destinatarios por lote')}
              <select value={recipientsPerBatch} onChange={(event) => setRecipientsPerBatch(event.target.value)} disabled={working || Boolean(active) || !selectedToken} className="wire-input min-h-11 w-full">
                {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
          </fieldset>
          <fieldset className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
            <legend className="px-1 text-sm font-medium">{t('Pausa y jitter entre lotes')}</legend>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Después de confirmar un lote, Wire espera la pausa configurada más un tiempo aleatorio de jitter antes de habilitar la siguiente revisión. El temporizador no firma ni envía transacciones.')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs">{t('Pausa base (segundos)')}
                <input type="number" min={0} max={300} step={1} value={interBatchDelaySeconds} onChange={(event) => setInterBatchDelaySeconds(event.target.value)} disabled={working || Boolean(active) || !selectedToken} className="wire-input min-h-11 w-full font-mono" />
              </label>
              <label className="grid gap-1.5 text-xs">{t('Jitter máximo (+segundos)')}
                <input type="number" min={0} max={120} step={1} value={interBatchJitterSeconds} onChange={(event) => setInterBatchJitterSeconds(event.target.value)} disabled={working || Boolean(active) || !selectedToken} className="wire-input min-h-11 w-full font-mono" />
              </label>
            </div>
          </fieldset>
          <fieldset className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
            <legend className="px-1 text-sm font-medium">{t('Límite de fallos confirmados')}</legend>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{t('Solo se puede omitir una transacción que Devnet reporte como fallida y confirmada. Un estado pendiente, error de RPC o resultado incierto detiene el flujo; Wire nunca reintenta el lote fallido.')}</p>
            <label className="grid max-w-sm gap-1.5 text-xs">{t('Fallos consecutivos que se pueden omitir')}
              <select value={maxConfirmedFailures} onChange={(event) => setMaxConfirmedFailures(event.target.value)} disabled={working || Boolean(active) || !selectedToken} className="wire-input min-h-11 w-full">
                {[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
            <p className="text-xs text-[var(--muted)]">{t('0 significa detenerse ante el primer fallo confirmado. Cada lote posterior sigue necesitando revisión y firma manual.')}</p>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void prepareDistribution()} disabled={working || !selectedToken || !recipientText.trim() || !sourceAddress} className="wire-button wire-button-primary min-h-11">
              {working ? <span className="wire-loading-mark" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{t('Revisar distribución')}
            </button>
          </div>
        </div>
      )}

      {active && (
        <div className="mt-4 grid gap-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <div>
            <h4 className="font-semibold">{active.status === 'complete' ? t('Distribución completada') : active.status === 'failed' ? t('Distribución detenida') : t('Revisa la distribución')}</h4>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Origen')}: {t(active.sourceType === 'connected' ? 'Wallet conectada' : 'Bóveda local')} · <code className="break-all">{active.sourceAddress}</code> · {t('Mint')}: <code className="break-all">{active.mint}</code></p>
            {!activeSourceReady && <p className="mt-1 text-xs text-amber-300" role="status">{active.sourceType === 'connected' ? t('Reconecta la wallet conectada que elegiste para este plan.') : session.isLocked ? t('Desbloquea la bóveda para usar esta wallet de origen.') : t('La wallet de origen ya no está en la bóveda.')}</p>}
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Pausa configurada')}: {active.interBatchDelaySeconds ?? 0} s + {t('jitter')}: 0–{active.interBatchJitterSeconds ?? 0} s. {t('Límite de fallos')}: {active.maxConfirmedFailures ?? 0}; {t('Fallos consecutivos')}: {active.consecutiveFailures ?? 0}. {t('Wire nunca firma ni envía el siguiente lote automáticamente.')}</p>
          </div>
          <dl className="grid gap-2 rounded-lg border border-[var(--line)] p-3 text-sm sm:grid-cols-2">
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('Destinatarios')}</dt><dd className="mt-1 font-mono">{active.recipients.length}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('Importe total enviado')}</dt><dd className="mt-1 font-mono [overflow-wrap:anywhere]">{formatAmount(totalPlanned, active.decimals, locale)}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('SOL total a destinatarios')}</dt><dd className="mt-1 font-mono [overflow-wrap:anywhere]">{formatSolLamports(totalFundingLamports)} SOL</dd></div>
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('Fee de transferencia del token')}</dt><dd className="mt-1 font-mono [overflow-wrap:anywhere]">{formatAmount(totalTransferFees, active.decimals, locale)}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('Lotes')}</dt><dd className="mt-1 font-mono">{active.batches.length}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('SOL pendiente de enviar')}</dt><dd className="mt-1 font-mono [overflow-wrap:anywhere]">{formatSolLamports(remainingFundingLamports)} SOL</dd></div>
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('Fees de red restantes estimados')}</dt><dd className="mt-1 font-mono [overflow-wrap:anywhere]">{(remainingFees / 1_000_000_000).toFixed(9)} SOL</dd></div>
            <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">{t('Rent restante estimado de cuentas')}</dt><dd className="mt-1 font-mono [overflow-wrap:anywhere]">{(remainingRent / 1_000_000_000).toFixed(9)} SOL</dd></div>
          </dl>
          <details className="rounded-lg border border-[var(--line)] p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('Ver destinatarios e importes')}</summary>
            <ol className="mt-3 grid gap-2">
              {active.recipients.map((recipient, index) => {
                const walletLabel = visibleWallets.find((wallet) => wallet.address === recipient.address)?.label;
                return (
                  <li key={recipient.address} className="grid gap-1 rounded-md border border-[var(--line)] p-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">{walletLabel && <span className="mr-2 font-medium text-[var(--text)]">{walletLabel}</span>}<code className="break-all text-[var(--muted)]">{recipient.address}</code></div>
                    <span className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{formatAmount(recipient.amountRaw, active.decimals, locale)} · {t('Recibe estimado')}: {formatAmount(recipient.netRaw, active.decimals, locale)}{BigInt(recipient.solFundingLamports ?? '0') > 0n ? ` · +${formatSolLamports(BigInt(recipient.solFundingLamports ?? '0'))} SOL` : ''}</span>
                    {currentBatch?.recipientIndexes.includes(index) && active.status === 'ready' && active.currentBatch === currentBatch.index && <span className="text-[var(--wire-green)]">{t('Lote actual')}</span>}
                  </li>
                );
              })}
            </ol>
          </details>
          {active.status === 'pending' && latestReceipt && (
            <div className="grid gap-2 rounded-lg border border-amber-400/40 p-3" role="status" aria-live="polite">
              <p className="text-sm font-medium">{t('La firma está pendiente. No vuelvas a enviar este lote.')}</p>
              <code className="break-all text-xs text-[var(--muted)]">{latestReceipt.signature}</code>
              <div className="flex flex-wrap gap-2">
                <a href={explorerTransaction(latestReceipt.signature)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs"><ExternalLink size={13} aria-hidden="true" />{t('Ver en Explorer')}</a>
                <button type="button" onClick={() => void verifyPending()} disabled={working} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{working ? <span className="wire-loading-mark" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}{t('Verificar firma en Devnet')}</button>
              </div>
            </div>
          )}
          {active.status === 'ready' && currentBatch && (
            <div className="grid gap-3 rounded-lg border border-[var(--wire-green)]/40 p-3">
              <div>
                <h5 className="text-sm font-semibold">{t('Lote {current} de {total}', { current: active.currentBatch + 1, total: active.batches.length })}</h5>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t('Firmar localmente autoriza solo este lote. Wire no enviará los siguientes hasta que pulses continuar.')}</p>
              </div>
              <ul className="grid gap-2">
                {currentBatch.recipientIndexes.map((index) => {
                  const recipient = active.recipients[index];
                  const walletLabel = visibleWallets.find((wallet) => wallet.address === recipient.address)?.label;
                  return <li key={recipient.address} className="flex flex-wrap items-center justify-between gap-2 text-xs"><div className="min-w-0">{walletLabel && <span className="mr-2 font-medium text-[var(--text)]">{walletLabel}</span>}<code className="break-all text-[var(--muted)]">{recipient.address}</code></div><span className="min-w-0 text-right font-mono [overflow-wrap:anywhere]">{formatAmount(recipient.amountRaw, active.decimals, locale)} · {t('Recibe estimado')}: {formatAmount(recipient.netRaw, active.decimals, locale)}{BigInt(recipient.solFundingLamports ?? '0') > 0n ? ` · +${formatSolLamports(BigInt(recipient.solFundingLamports ?? '0'))} SOL` : ''}</span></li>;
                })}
              </ul>
              <p className="text-xs text-[var(--muted)]">{t('SOL de este lote')}: {formatSolLamports(BigInt(currentBatch.fundingLamports ?? '0'))} SOL · {t('Fee de red estimado')}: {(currentBatch.feeLamports / 1_000_000_000).toFixed(9)} SOL · {t('Rent de cuentas estimado')}: {(currentBatch.ataRentLamports / 1_000_000_000).toFixed(9)} SOL</p>
              {waitSeconds > 0 && <p className="text-xs text-[var(--muted)]" role="status" aria-live="polite">{t('Siguiente revisión disponible en {seconds} s. No se enviará sola.', { seconds: waitSeconds })}</p>}
              <button type="button" onClick={() => void sendNextBatch()} disabled={working || !activeSourceReady || waitSeconds > 0} className="wire-button wire-button-primary min-h-11 justify-center">{working ? <span className="wire-loading-mark" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}{t('Firmar y enviar este lote')}</button>
            </div>
          )}
          {active.status === 'complete' && <p className="text-sm text-[var(--wire-green)]" role="status">{t('Todos los lotes confirmados en Devnet.')}</p>}
          {active.status === 'failed' && <p className="text-sm text-[var(--danger,#ff8b8b)]" role="alert">{t('El plan se detuvo tras el lote fallido. No se reenvía automáticamente; revisa el historial antes de preparar otra distribución.')}</p>}
          {active.status !== 'pending' && <button type="button" onClick={resetPlan} disabled={working} className="wire-button wire-button-secondary min-h-11 justify-self-start px-3 text-xs">{active.status === 'complete' ? t('Preparar otra distribución') : t('Cancelar lotes restantes')}</button>}
        </div>
      )}

      <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-[var(--muted)]"><ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--wire-green)]" aria-hidden="true" />{t('Las transferencias son irreversibles. Revisa cada destino. Las claves de la bóveda permanecen cifradas en el navegador y solo se usan en memoria para firmar localmente.')}</p>
      {(error || notice) && <p className={`mt-3 text-sm ${error ? 'text-[var(--danger,#ff8b8b)]' : 'text-[var(--wire-green)]'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error || notice}</p>}

      {history.length > 0 && (
        <details className="mt-4 border-t border-[var(--line)] pt-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('Historial de Token Disperse')} · {history.length}</summary>
          <ol className="mt-3 grid gap-2">
            {history.slice(0, 12).map((receipt) => (
              <li key={receipt.signature} className="grid gap-2 rounded-lg border border-[var(--line)] p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={receipt.status === 'confirmed' ? 'text-[var(--wire-green)]' : receipt.status === 'failed' ? 'text-[var(--danger,#ff8b8b)]' : 'text-[var(--muted)]'}>{receipt.status === 'confirmed' ? t('Confirmada en Devnet') : receipt.status === 'failed' ? t('Falló en Devnet') : t('Pendiente de confirmación en Devnet')} · {t('Lote {current} de {total}', { current: receipt.batchIndex + 1, total: receipt.batchCount })}</span>
                  <time dateTime={new Date(receipt.createdAt).toISOString()} className="text-[var(--muted)]">{new Intl.DateTimeFormat(locale === 'es' ? 'es-419' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(receipt.createdAt)}</time>
                </div>
                <code className="break-all text-[var(--muted)]">{receipt.signature}</code>
                <div className="flex flex-wrap gap-2">
                  <a href={explorerTransaction(receipt.signature)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs"><ExternalLink size={12} aria-hidden="true" />{t('Ver transacción')}</a>
                  {receipt.status === 'pending' && active?.pendingSignature === receipt.signature && <button type="button" onClick={() => void verifyPending()} disabled={working} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Verificar firma en Devnet')}</button>}
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

async function buildBatchTransaction(
  connection: ReturnType<typeof useConnection>['connection'],
  source: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
  mintInfo: Awaited<ReturnType<typeof getMint>>,
  plan: DispersePlan,
  recipientIndexes: number[],
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  const epoch = BigInt((await connection.getEpochInfo('confirmed')).epoch);
  const transferFeeConfig = getTransferFeeConfig(mintInfo);
  const instructions: TransactionInstruction[] = [];
  let ataRentLamports = 0;
  let fundingLamports = 0n;
  const accountSize = getAccountLenForMint(mintInfo);
  const ataRent = await connection.getMinimumBalanceForRentExemption(accountSize, 'confirmed');
  for (const recipientIndex of recipientIndexes) {
    const recipient = plan.recipients[recipientIndex];
    if (!recipient) throw new Error(t('El destinatario ya no existe en el plan guardado.'));
    const owner = new PublicKey(recipient.address);
    const recipientFunding = BigInt(recipient.solFundingLamports ?? '0');
    if (recipientFunding > 18_446_744_073_709_551_615n) throw new Error(t('El importe SOL supera el máximo de una transferencia.'));
    fundingLamports += recipientFunding;
    if (recipientFunding > 0n) {
      instructions.push(SystemProgram.transfer({ fromPubkey: source, toPubkey: owner, lamports: recipientFunding }));
    }
    const ata = getAssociatedTokenAddressSync(mint, owner, true, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const accountInfo = await connection.getAccountInfo(ata, 'confirmed');
    if (accountInfo) {
      const tokenAccount = await getAccount(connection, ata, 'confirmed', programId);
      if (!tokenAccount.owner.equals(owner) || !tokenAccount.mint.equals(mint)) throw new Error(t('La cuenta receptora existe, pero no coincide con el token o el dueño.'));
    } else {
      ataRentLamports += ataRent;
    }
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(source, ata, owner, mint, programId));
    for (const allocation of recipient.allocations) {
      const amount = BigInt(allocation.amountRaw);
      const expectedFee = transferFeeConfig ? calculateEpochFee(transferFeeConfig, epoch, amount) : 0n;
      if (expectedFee.toString() !== allocation.feeRaw) throw new Error(t('La comisión del token cambió desde la revisión. Actualiza el lote antes de firmar.'));
      const tokenSource = new PublicKey(allocation.sourceAddress);
      const instruction = transferFeeConfig
        ? await createTransferCheckedWithFeeAndTransferHookInstruction(
          connection, tokenSource, mint, ata, source, amount, plan.decimals, expectedFee, [], 'confirmed', programId,
        )
        : await createTransferCheckedWithTransferHookInstruction(
          connection, tokenSource, mint, ata, source, amount, plan.decimals, [], 'confirmed', programId,
        );
      instructions.push(instruction);
    }
  }
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: source, recentBlockhash: latest.blockhash }).add(...instructions);
  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (serialized.length > MAX_PACKET_BYTES) throw new Error(t('El lote supera el tamaño permitido. Reduce los destinatarios por revisión.'));
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    const details = simulation.value.logs?.slice(-4).join(' · ');
    throw new Error(details ? t('La simulación rechazó este lote: {details}', { details }) : t('La simulación rechazó este lote. Revisa el mint y las cuentas receptoras.'));
  }
  const feeResult = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
  if (feeResult.value === null) throw new Error(t('El RPC no pudo estimar la comisión de red. Inténtalo de nuevo.'));
  return {
    transaction,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    instructionFingerprint: instructionFingerprint(instructions),
    feeLamports: feeResult.value,
    ataRentLamports,
    fundingLamports,
  };
}
