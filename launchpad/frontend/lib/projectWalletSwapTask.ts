import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { VaultWallet } from './walletVault';

export const PROJECT_SWAP_TASK_STORAGE_PREFIX = 'wire:project-wallet-swap-task:v1:';
export const MAX_PROJECT_SWAP_TASK_WALLETS = 10;
export const MIN_TIMED_BUY_CONSECUTIVE_ERRORS = 1;
export const MAX_TIMED_BUY_CONSECUTIVE_ERRORS = 5;
export const DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS = 1;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export type ProjectSwapSide = 'buy' | 'sell';
export type ProjectSwapTaskRunStatus = 'ready' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

export type ProjectSwapQuote = {
  venue: 'RAYDIUM' | 'PUMP_FUN' | 'PUMP_SWAP';
  poolAddress: string;
  side: ProjectSwapSide;
  inputMint: string;
  outputMint: string;
  inputSymbol: string;
  outputSymbol: string;
  quoteMint: string;
  quoteDecimals: number;
  amountIn: string;
  amountOut: string;
  minimumAmountOut: string;
  maximumAmountIn: string | null;
  estimatedPoolFee: string;
  priceImpactPercent: string | null;
  slippageBps: number;
  network: string;
};

export type ProjectSwapTaskRow = {
  wallet: VaultWallet;
  amountIn: string;
  quote: ProjectSwapQuote;
  networkFeeLamports: string;
  status: 'reviewed' | 'confirmed' | 'pending' | 'failed' | 'cancelled';
  signature?: string;
  previousSignature?: string;
  detail?: string;
  historyPending?: boolean;
  blockedByBudget?: boolean;
};

export type ProjectSwapTask = {
  runStatus?: ProjectSwapTaskRunStatus;
  side: ProjectSwapSide;
  slippageBps: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  maxConsecutiveErrors: number;
  delayUntil?: number | null;
  maxTotalSpend: string;
  selected: string[];
  amounts: Record<string, string>;
  rows: ProjectSwapTaskRow[];
};

export type SavedProjectWalletSwapTask = {
  storageKey: string;
  mintAddress: string;
  quoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  savedAt: number;
  task: ProjectSwapTask;
};

export function canReQuoteFailedProjectSwap(status: ProjectSwapTaskRow['status'], hasPendingSignature: boolean): boolean {
  return status === 'failed' && !hasPendingSignature;
}

export function canContinueTimedBuyAfterFailure(
  consecutiveFailures: number,
  stopAfterConsecutiveErrors: number,
  hasNextReviewedWallet: boolean,
): boolean {
  return Number.isInteger(consecutiveFailures)
    && Number.isInteger(stopAfterConsecutiveErrors)
    && stopAfterConsecutiveErrors >= MIN_TIMED_BUY_CONSECUTIVE_ERRORS
    && stopAfterConsecutiveErrors <= MAX_TIMED_BUY_CONSECUTIVE_ERRORS
    && consecutiveFailures >= 1
    && consecutiveFailures < stopAfterConsecutiveErrors
    && hasNextReviewedWallet;
}

type TaskContext = {
  mintAddress: string;
  quoteMint: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  wallets: VaultWallet[];
};

function canonicalAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function validAmount(value: unknown, decimals = 18): value is string {
  return typeof value === 'string'
    && value.length <= 40
    && new RegExp(`^\\d{1,20}(?:\\.\\d{1,${decimals}})?$`).test(value.trim())
    && /[1-9]/.test(value);
}

function validNonnegativeAmount(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 40
    && /^\d{1,20}(?:\.\d{1,18})?$/.test(value.trim());
}

function validOptionalAmount(value: unknown, decimals = 18): value is string | null {
  return value === null || validAmount(value, decimals);
}

function validSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { return bs58.decode(value).length === 64; } catch { return false; }
}

export function isProjectSwapQuote(value: unknown): value is ProjectSwapQuote {
  if (!value || typeof value !== 'object') return false;
  const quote = value as Partial<ProjectSwapQuote>;
  return (quote.venue === 'RAYDIUM' || quote.venue === 'PUMP_FUN' || quote.venue === 'PUMP_SWAP')
    && canonicalAddress(quote.poolAddress)
    && (quote.side === 'buy' || quote.side === 'sell')
    && canonicalAddress(quote.inputMint)
    && canonicalAddress(quote.outputMint)
    && typeof quote.inputSymbol === 'string' && quote.inputSymbol.length > 0 && quote.inputSymbol.length <= 16
    && typeof quote.outputSymbol === 'string' && quote.outputSymbol.length > 0 && quote.outputSymbol.length <= 16
    && canonicalAddress(quote.quoteMint)
    && Number.isInteger(quote.quoteDecimals) && quote.quoteDecimals! >= 0 && quote.quoteDecimals! <= 18
    && validAmount(quote.amountIn)
    && validAmount(quote.amountOut)
    && validAmount(quote.minimumAmountOut)
    && validOptionalAmount(quote.maximumAmountIn)
    && validNonnegativeAmount(quote.estimatedPoolFee)
    && (quote.priceImpactPercent === null || (typeof quote.priceImpactPercent === 'string' && /^\d{1,12}(?:\.\d{1,8})?$/.test(quote.priceImpactPercent)))
    && [50, 100, 200, 500].includes(quote.slippageBps as number)
    && quote.network === 'Solana Devnet';
}

export function isProjectMarketWatchQuote(
  value: unknown,
  context: {
    mintAddress: string;
    quoteMint: string;
    launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
    amountIn: string;
    slippageBps: number;
  },
): value is ProjectSwapQuote {
  if (!isProjectSwapQuote(value)) return false;
  const quote = value;
  const quoteDecimals = context.quoteMint === 'So11111111111111111111111111111111111111112' ? 9 : 6;
  let expectedRaw: bigint;
  let actualRaw: bigint;
  try {
    expectedRaw = parseRawAmount(context.amountIn, quoteDecimals);
    actualRaw = parseRawAmount(quote.amountIn, quoteDecimals);
  } catch {
    return false;
  }
  const venueMatches = context.launchPlatform === 'PUMP_FUN'
    ? quote.venue === 'PUMP_FUN' || quote.venue === 'PUMP_SWAP'
    : quote.venue === 'RAYDIUM';
  return venueMatches
    && quote.side === 'buy'
    && quote.inputMint === context.quoteMint
    && quote.outputMint === context.mintAddress
    && quote.quoteMint === context.quoteMint
    && quote.quoteDecimals === quoteDecimals
    && quote.slippageBps === context.slippageBps
    && quote.network === 'Solana Devnet'
    && expectedRaw > 0n
    && actualRaw === expectedRaw;
}

function parseRawAmount(value: string, decimals: number) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function projectWalletSwapTaskStorageKey(mintAddress: string, quoteMint: string, launchPlatform: 'RAYDIUM' | 'PUMP_FUN') {
  return `${PROJECT_SWAP_TASK_STORAGE_PREFIX}${launchPlatform}:${mintAddress}:${quoteMint}`;
}

export function listSavedProjectWalletSwapTasks(
  wallets: VaultWallet[],
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
): SavedProjectWalletSwapTask[] {
  const tasks: SavedProjectWalletSwapTask[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    if (!storageKey?.startsWith(PROJECT_SWAP_TASK_STORAGE_PREFIX)) continue;
    const [launchPlatform, mintAddress, quoteMint, ...extra] = storageKey.slice(PROJECT_SWAP_TASK_STORAGE_PREFIX.length).split(':');
    if (extra.length || (launchPlatform !== 'RAYDIUM' && launchPlatform !== 'PUMP_FUN')) continue;
    const raw = storage.getItem(storageKey);
    if (!raw) continue;
    let savedAt: unknown;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      savedAt = (value as { savedAt?: unknown }).savedAt;
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(savedAt)) continue;
    const task = parseProjectWalletSwapTask(raw, {
      mintAddress,
      quoteMint,
      launchPlatform,
      wallets,
    });
    if (!task) continue;
    tasks.push({ storageKey, mintAddress, quoteMint, launchPlatform, savedAt: savedAt as number, task });
  }
  return tasks.sort((left, right) => right.savedAt - left.savedAt);
}

export function parseProjectWalletSwapTask(raw: string | null, context: TaskContext): ProjectSwapTask | null {
  if (!raw || !canonicalAddress(context.mintAddress) || !canonicalAddress(context.quoteMint)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const task = value as Partial<ProjectSwapTask & { version: number; mintAddress: string; quoteMint: string; launchPlatform: string; savedAt: number; delaySeconds?: number }>;
    const legacyDelay = task.delaySeconds;
    const delayMinSeconds = task.delayMinSeconds ?? legacyDelay;
    const delayMaxSeconds = task.delayMaxSeconds ?? legacyDelay;
    const maxConsecutiveErrors = task.maxConsecutiveErrors ?? DEFAULT_TIMED_BUY_CONSECUTIVE_ERRORS;
    const validRunStatuses = ['ready', 'running', 'paused', 'stopped', 'completed', 'failed'];
    if (![1, 2, 3].includes(task.version ?? -1) || (task.runStatus !== undefined && !validRunStatuses.includes(task.runStatus))
      || task.mintAddress !== context.mintAddress || task.quoteMint !== context.quoteMint
      || task.launchPlatform !== context.launchPlatform || !Number.isSafeInteger(task.savedAt)
      || (task.side !== 'buy' && task.side !== 'sell') || ![50, 100, 200, 500].includes(task.slippageBps ?? -1)
      || !Number.isInteger(delayMinSeconds) || !Number.isInteger(delayMaxSeconds)
      || !Number.isInteger(maxConsecutiveErrors) || maxConsecutiveErrors < MIN_TIMED_BUY_CONSECUTIVE_ERRORS || maxConsecutiveErrors > MAX_TIMED_BUY_CONSECUTIVE_ERRORS
      || (delayMinSeconds ?? -1) < 0 || (delayMaxSeconds ?? 31) > 30 || (delayMinSeconds ?? 31) > (delayMaxSeconds ?? -1)
      || (task.version === 1 && ![0, 2, 5, 10, 30].includes(legacyDelay ?? -1))
      || typeof task.maxTotalSpend !== 'string' || task.maxTotalSpend.length > 40
      || (task.maxTotalSpend !== '' && !validAmount(task.maxTotalSpend))
      || !Array.isArray(task.selected) || task.selected.length < 1 || task.selected.length > MAX_PROJECT_SWAP_TASK_WALLETS
      || new Set(task.selected).size !== task.selected.length || !task.selected.every(canonicalAddress)
      || !task.amounts || typeof task.amounts !== 'object' || Array.isArray(task.amounts)
      || !Array.isArray(task.rows) || task.rows.length < 1 || task.rows.length > MAX_PROJECT_SWAP_TASK_WALLETS
      || task.rows.length !== task.selected.length) return null;
    const savedDelayUntil = task.delayUntil === undefined ? null : task.delayUntil;
    if (savedDelayUntil !== null && (!Number.isSafeInteger(savedDelayUntil)
      || task.side !== 'buy' || !delayMaxSeconds
      || savedDelayUntil > Date.now() + delayMaxSeconds * 1000 + 60_000)) return null;

    const walletByAddress = new Map(context.wallets.map((wallet) => [wallet.address, wallet]));
    const inputMint = task.side === 'buy' ? context.quoteMint : context.mintAddress;
    const outputMint = task.side === 'buy' ? context.mintAddress : context.quoteMint;
    const quoteDecimals = context.quoteMint === SOL_MINT ? 9 : 6;
    const amountDecimals = task.side === 'buy' ? quoteDecimals : context.launchPlatform === 'PUMP_FUN' ? 6 : 9;
    const amounts = task.amounts as Record<string, unknown>;
    if (Object.keys(amounts).length !== task.selected.length
      || Object.entries(amounts).some(([address, amount]) => !task.selected!.includes(address) || !validAmount(amount, amountDecimals))) return null;
    if (task.side === 'buy' && !validAmount(task.maxTotalSpend, quoteDecimals)) return null;

    const rows: ProjectSwapTaskRow[] = [];
    const rowAddresses = new Set<string>();
    let maximumSpend = 0n;
    for (const candidate of task.rows) {
      if (!candidate || typeof candidate !== 'object') return null;
      const row = candidate as Partial<ProjectSwapTaskRow>;
      const addressCandidate = (candidate as { walletAddress?: unknown }).walletAddress;
      if (typeof addressCandidate !== 'string') return null;
      const address = addressCandidate;
      const wallet = walletByAddress.get(address);
      if (!wallet || !task.selected.includes(address) || rowAddresses.has(address)
        || !validAmount(row.amountIn, amountDecimals) || amounts[address] !== row.amountIn
        || !isProjectSwapQuote(row.quote) || row.quote.side !== task.side || row.quote.slippageBps !== task.slippageBps
        || row.quote.quoteMint !== context.quoteMint || row.quote.quoteDecimals !== quoteDecimals
        || row.quote.inputMint !== inputMint || row.quote.outputMint !== outputMint
        || !validAmount(row.quote.amountIn, amountDecimals) || parseRawAmount(row.quote.amountIn, amountDecimals) !== parseRawAmount(row.amountIn, amountDecimals)
        || typeof row.networkFeeLamports !== 'string' || !/^\d{1,20}$/.test(row.networkFeeLamports)
        || !['reviewed', 'confirmed', 'pending', 'failed', 'cancelled'].includes(row.status ?? '')
        || (row.signature !== undefined && !validSignature(row.signature))
        || (row.previousSignature !== undefined && !validSignature(row.previousSignature))
        || (row.detail !== undefined && (typeof row.detail !== 'string' || row.detail.length > 500))
        || (row.historyPending !== undefined && typeof row.historyPending !== 'boolean')
        || (row.blockedByBudget !== undefined && typeof row.blockedByBudget !== 'boolean')) return null;
      if ((row.status === 'confirmed' || row.status === 'pending') && !row.signature) return null;
      if (row.status === 'cancelled' && row.signature) return null;
      rowAddresses.add(address);
      if (task.side === 'buy') maximumSpend += parseRawAmount(row.quote.maximumAmountIn ?? row.amountIn, quoteDecimals);
      rows.push({
        wallet,
        amountIn: row.amountIn,
        quote: row.quote,
        networkFeeLamports: row.networkFeeLamports,
        // A stored signature is never considered complete. The user must query Devnet.
        status: row.signature ? 'pending' : row.status as ProjectSwapTaskRow['status'],
        ...(row.signature ? { signature: row.signature } : {}),
        ...(row.previousSignature ? { previousSignature: row.previousSignature } : {}),
        ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
        ...(row.historyPending ? { historyPending: true } : {}),
        ...(row.blockedByBudget ? { blockedByBudget: true } : {}),
        ...(row.signature ? { detail: 'Firma recuperada del navegador. Verifica su estado en Devnet antes de continuar.' } : {}),
        ...(row.status === 'cancelled' ? { detail: 'Cancelada antes de firmar. No se envió ninguna transacción.' } : {}),
      });
    }
    if (rowAddresses.size !== task.selected.length || task.selected.some((address) => !rowAddresses.has(address))) return null;
    const exceedsBudget = task.side === 'buy' && maximumSpend > parseRawAmount(task.maxTotalSpend, quoteDecimals);
    if (exceedsBudget) {
      for (const row of rows) {
        row.blockedByBudget = true;
        row.detail = 'La cotización actual supera el presupuesto máximo total.';
      }
    } else {
      for (const row of rows) row.blockedByBudget = false;
    }

    return {
      // A persisted running task is never resumed by restoring UI state.
      runStatus: task.runStatus === 'running' ? 'paused' : task.runStatus ?? 'ready',
      side: task.side,
      slippageBps: task.slippageBps,
      delayMinSeconds: delayMinSeconds!,
      delayMaxSeconds: delayMaxSeconds!,
      maxConsecutiveErrors,
      delayUntil: savedDelayUntil !== null && savedDelayUntil > Date.now() ? savedDelayUntil : null,
      maxTotalSpend: task.maxTotalSpend,
      selected: [...task.selected],
      amounts: Object.fromEntries(Object.entries(amounts).map(([address, amount]) => [address, amount as string])),
      rows,
    };
  } catch {
    return null;
  }
}

export function serializeProjectWalletSwapTask(task: ProjectSwapTask, context: Omit<TaskContext, 'wallets'>, savedAt = Date.now()) {
  return JSON.stringify({
    version: 3,
    mintAddress: context.mintAddress,
    quoteMint: context.quoteMint,
    launchPlatform: context.launchPlatform,
    runStatus: task.runStatus ?? 'ready',
    side: task.side,
    slippageBps: task.slippageBps,
    delayMinSeconds: task.delayMinSeconds,
    delayMaxSeconds: task.delayMaxSeconds,
    maxConsecutiveErrors: task.maxConsecutiveErrors,
    delayUntil: task.delayUntil ?? null,
    maxTotalSpend: task.maxTotalSpend,
    selected: task.selected,
    amounts: task.amounts,
    rows: task.rows.map((row) => ({
      walletAddress: row.wallet.address,
      amountIn: row.amountIn,
      quote: row.quote,
      networkFeeLamports: row.networkFeeLamports,
      status: row.status,
      ...(row.signature ? { signature: row.signature } : {}),
      ...(row.previousSignature ? { previousSignature: row.previousSignature } : {}),
      ...(row.detail && row.detail.length <= 500 ? { detail: row.detail } : {}),
      ...(row.historyPending ? { historyPending: true } : {}),
      ...(row.blockedByBudget ? { blockedByBudget: true } : {}),
    })),
    savedAt,
  });
}
