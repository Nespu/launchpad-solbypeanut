import { PublicKey } from '@solana/web3.js';
import type { WalletTransferBasisLot } from './tokenHistoryAnalytics';

export const WALLET_TRANSFER_BASIS_STORAGE_KEY = 'wire:wallet-transfer-basis:v1';
export const MAX_WALLET_TRANSFER_BASIS_RECORDS = 2000;
const MAX_RAW_TOKEN_AMOUNT = 18_446_744_073_709_551_615n;

export type StoredWalletTransferBasisLot = WalletTransferBasisLot & { savedAt: number };

function isPublicAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function isRawInteger(value: unknown, allowZero = false): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) return false;
  const amount = BigInt(value);
  return amount <= MAX_RAW_TOKEN_AMOUNT && (allowZero || amount > 0n);
}

export function parseWalletTransferBasisLot(value: unknown): StoredWalletTransferBasisLot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature)
    || typeof item.slot !== 'string' || !/^\d{1,20}$/.test(item.slot)
    || !(item.blockTime === null || (typeof item.blockTime === 'number' && Number.isSafeInteger(item.blockTime) && item.blockTime >= 0))
    || !isPublicAddress(item.mintAddress)
    || !isPublicAddress(item.sourceWalletAddress)
    || !isPublicAddress(item.destinationWalletAddress)
    || item.sourceWalletAddress === item.destinationWalletAddress
    || !isPublicAddress(item.quoteMint)
    || !Number.isInteger(item.quoteDecimals) || (item.quoteDecimals as number) < 0 || (item.quoteDecimals as number) > 18
    || !Number.isInteger(item.lotIndex) || (item.lotIndex as number) < 0 || (item.lotIndex as number) > 10000
    || !isRawInteger(item.tokenAmountRaw)
    || !isRawInteger(item.transferAmountRaw)
    || !isRawInteger(item.quoteAmountRaw, true)
    || typeof item.savedAt !== 'number' || !Number.isSafeInteger(item.savedAt) || item.savedAt <= 0 || item.savedAt > 8.64e15) return null;

  return {
    signature: item.signature,
    slot: item.slot,
    blockTime: item.blockTime as number | null,
    mintAddress: item.mintAddress,
    sourceWalletAddress: item.sourceWalletAddress,
    destinationWalletAddress: item.destinationWalletAddress,
    quoteMint: item.quoteMint,
    quoteDecimals: item.quoteDecimals as number,
    lotIndex: item.lotIndex as number,
    tokenAmountRaw: item.tokenAmountRaw,
    transferAmountRaw: item.transferAmountRaw,
    quoteAmountRaw: item.quoteAmountRaw,
    savedAt: item.savedAt,
  };
}

export function parseWalletTransferBasis(value: unknown): StoredWalletTransferBasisLot[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const payload = value as Record<string, unknown>;
  if (payload.version !== 1 || !Array.isArray(payload.records)) return [];
  const seen = new Set<string>();
  return payload.records
    .map(parseWalletTransferBasisLot)
    .filter((record): record is StoredWalletTransferBasisLot => {
      if (!record) return false;
      const key = walletTransferBasisKey(record);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_WALLET_TRANSFER_BASIS_RECORDS);
}

export function walletTransferBasisKey(lot: WalletTransferBasisLot) {
  return [lot.signature, lot.mintAddress, lot.sourceWalletAddress, lot.destinationWalletAddress, lot.quoteMint, lot.lotIndex].join(':');
}

export function walletTransferBasisTransferKey(lot: Pick<WalletTransferBasisLot, 'signature' | 'mintAddress' | 'sourceWalletAddress' | 'destinationWalletAddress' | 'quoteMint'>) {
  return [lot.signature, lot.mintAddress, lot.sourceWalletAddress, lot.destinationWalletAddress, lot.quoteMint].join(':');
}

function sameBasisValues(left: WalletTransferBasisLot, right: WalletTransferBasisLot) {
  return left.signature === right.signature
    && left.slot === right.slot
    && left.blockTime === right.blockTime
    && left.mintAddress === right.mintAddress
    && left.sourceWalletAddress === right.sourceWalletAddress
    && left.destinationWalletAddress === right.destinationWalletAddress
    && left.quoteMint === right.quoteMint
    && left.quoteDecimals === right.quoteDecimals
    && left.lotIndex === right.lotIndex
    && left.tokenAmountRaw === right.tokenAmountRaw
    && left.transferAmountRaw === right.transferAmountRaw
    && left.quoteAmountRaw === right.quoteAmountRaw;
}

export function upsertWalletTransferBasis(
  current: StoredWalletTransferBasisLot[],
  additions: Array<WalletTransferBasisLot & { savedAt?: number }>,
  replacedTransferKeys: string[] = [],
  now = Date.now(),
): StoredWalletTransferBasisLot[] {
  const replaceSet = new Set(replacedTransferKeys);
  const records = new Map(current
    .filter((record) => !replaceSet.has(walletTransferBasisTransferKey(record)))
    .map((record) => [walletTransferBasisKey(record), record]));
  for (const candidate of additions) {
    const record = parseWalletTransferBasisLot({ ...candidate, savedAt: candidate.savedAt ?? now });
    if (!record) continue;
    const key = walletTransferBasisKey(record);
    const previous = records.get(key);
    if (previous && sameBasisValues(previous, record)) continue;
    records.set(key, record);
  }
  return [...records.values()]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_WALLET_TRANSFER_BASIS_RECORDS);
}

export function readWalletTransferBasis(storage?: Pick<Storage, 'getItem'>): StoredWalletTransferBasisLot[] {
  try {
    const raw = (storage ?? window.localStorage).getItem(WALLET_TRANSFER_BASIS_STORAGE_KEY);
    if (!raw) return [];
    return parseWalletTransferBasis(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeWalletTransferBasis(
  records: StoredWalletTransferBasisLot[],
  storage?: Pick<Storage, 'setItem'>,
) {
  try {
    (storage ?? window.localStorage).setItem(WALLET_TRANSFER_BASIS_STORAGE_KEY, JSON.stringify({ version: 1, records }));
    return true;
  } catch {
    return false;
  }
}
