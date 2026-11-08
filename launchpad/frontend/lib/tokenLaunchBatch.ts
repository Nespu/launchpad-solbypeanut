import { PublicKey } from '@solana/web3.js';

export const MAX_TOKEN_LAUNCH_BATCH_DRAFTS = 5;

export type TokenLaunchBatchSubmission = {
  attemptId: string;
  signedTransaction: string;
  mintAddress: string;
  userWallet: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  name: string;
  symbol: string;
  totalSupply: number;
  liquiditySol: number;
};

export type TokenLaunchBatchDraft = {
  id: string;
  createdAt: number;
  creatorWallet: string;
  launchPlatform: 'RAYDIUM' | 'PUMP_FUN';
  name: string;
  symbol: string;
  description: string;
  imageBase64: string;
  totalSupply: string;
  liquiditySol: string;
  securityAssets: string[];
  holderReward: boolean;
  twitter: string;
  telegram: string;
  selectedProjectWalletAddresses: string[];
  launchWalletBuyAmounts: Record<string, string>;
  launchBuyDelaySeconds: number;
  launchBuySlippageBps: number;
  status: 'ready' | 'pending' | 'complete';
  pendingSubmission?: TokenLaunchBatchSubmission;
  txId?: string;
  mintAddress?: string;
};

const DATABASE_NAME = 'wire-token-launch-batch-v1';
const DATABASE_VERSION = 1;
const STORE_NAME = 'wallet-drafts';

function openDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('El almacenamiento local no está disponible en este navegador.'));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir la cola local de lanzamientos.'));
    request.onblocked = () => reject(new Error('Cierra otras pestañas de Wire para abrir la cola de lanzamientos.'));
  });
}

function canonicalAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function validBuyAmount(value: unknown) {
  return typeof value === 'string'
    && value.length <= 40
    && /^\d{1,20}(?:\.\d{1,9})?$/.test(value.trim())
    && /[1-9]/.test(value);
}

export function isTokenLaunchBatchDraft(value: unknown): value is TokenLaunchBatchDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<TokenLaunchBatchDraft>;
  const supply = Number(draft.totalSupply);
  const liquidity = Number(draft.liquiditySol);
  const selectedWallets = draft.selectedProjectWalletAddresses;
  const amounts = draft.launchWalletBuyAmounts;
  return typeof draft.id === 'string'
    && draft.id.length >= 8
    && typeof draft.createdAt === 'number'
    && Number.isFinite(draft.createdAt)
    && canonicalAddress(draft.creatorWallet)
    && (draft.launchPlatform === 'RAYDIUM' || draft.launchPlatform === 'PUMP_FUN')
    && typeof draft.name === 'string' && draft.name.trim().length > 0 && draft.name.length <= 32
    && typeof draft.symbol === 'string' && draft.symbol.trim().length > 0 && draft.symbol.length <= 10
    && typeof draft.description === 'string' && draft.description.length <= 600
    && typeof draft.imageBase64 === 'string'
    && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(draft.imageBase64)
    && draft.imageBase64.length <= 2_800_000
    && typeof draft.totalSupply === 'string' && Number.isSafeInteger(supply) && supply > 0 && supply <= 18_446_744_073
    && typeof draft.liquiditySol === 'string' && Number.isFinite(liquidity) && (draft.launchPlatform === 'PUMP_FUN' ? liquidity >= 0 : liquidity > 0)
    && Array.isArray(draft.securityAssets) && draft.securityAssets.length <= 3
    && draft.securityAssets.every((key) => key === 'mint' || key === 'freeze' || key === 'update')
    && typeof draft.holderReward === 'boolean'
    && typeof draft.twitter === 'string' && draft.twitter.length <= 100
    && typeof draft.telegram === 'string' && draft.telegram.length <= 100
    && Array.isArray(selectedWallets) && selectedWallets.length <= 10
    && selectedWallets.every(canonicalAddress)
    && new Set(selectedWallets).size === selectedWallets.length
    && Boolean(amounts) && typeof amounts === 'object' && !Array.isArray(amounts)
    && Object.entries(amounts as Record<string, unknown>).length <= 10
    && Object.entries(amounts as Record<string, unknown>).every(([address, amount]) => selectedWallets.includes(address) && validBuyAmount(amount))
    && [0, 2, 5, 10, 30].includes(draft.launchBuyDelaySeconds as number)
    && [50, 100, 200, 500].includes(draft.launchBuySlippageBps as number)
    && (draft.status === 'ready' || draft.status === 'pending' || draft.status === 'complete')
    && (draft.status !== 'pending' || (
      isPendingSubmission(draft.pendingSubmission, draft.creatorWallet)
      && draft.pendingSubmission?.mintAddress === draft.mintAddress
      && draft.pendingSubmission?.launchPlatform === draft.launchPlatform
      && draft.pendingSubmission?.name === draft.name
      && draft.pendingSubmission?.symbol === draft.symbol
      && draft.pendingSubmission?.totalSupply === (draft.launchPlatform === 'PUMP_FUN' ? 1_000_000_000 : Number(draft.totalSupply))
      && draft.pendingSubmission?.liquiditySol === (draft.launchPlatform === 'PUMP_FUN' ? 0 : Number(draft.liquiditySol))
    ))
    && (draft.status === 'pending' || draft.pendingSubmission === undefined)
    && (draft.status !== 'complete' || (typeof draft.txId === 'string' && canonicalAddress(draft.mintAddress)));
}

function isPendingSubmission(value: unknown, creatorWallet: string) {
  if (!value || typeof value !== 'object') return false;
  const submission = value as Partial<TokenLaunchBatchSubmission>;
  return typeof submission.attemptId === 'string'
    && submission.attemptId.length > 0
    && typeof submission.signedTransaction === 'string'
    && submission.signedTransaction.length > 0
    && submission.signedTransaction.length <= 16_000
    && /^[a-z0-9+/]+={0,2}$/i.test(submission.signedTransaction)
    && canonicalAddress(submission.mintAddress)
    && submission.userWallet === creatorWallet
    && (submission.launchPlatform === 'RAYDIUM' || submission.launchPlatform === 'PUMP_FUN')
    && typeof submission.name === 'string' && submission.name.length <= 32
    && typeof submission.symbol === 'string' && submission.symbol.length <= 10
    && typeof submission.totalSupply === 'number'
    && Number.isSafeInteger(submission.totalSupply)
    && submission.totalSupply > 0
    && submission.totalSupply <= 18_446_744_073
    && typeof submission.liquiditySol === 'number'
    && Number.isFinite(submission.liquiditySol)
    && submission.liquiditySol >= 0;
}

export async function readTokenLaunchBatch(creatorWallet: string): Promise<TokenLaunchBatchDraft[]> {
  if (!canonicalAddress(creatorWallet)) throw new Error('La wallet conectada no es válida.');
  const database = await openDatabase();
  try {
    const saved = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(creatorWallet);
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error ?? new Error('No se pudo leer la cola de lanzamientos.'));
    });
    return Array.isArray(saved)
      ? saved.filter(isTokenLaunchBatchDraft).slice(0, MAX_TOKEN_LAUNCH_BATCH_DRAFTS)
      : [];
  } finally {
    database.close();
  }
}

export async function writeTokenLaunchBatch(creatorWallet: string, drafts: TokenLaunchBatchDraft[]) {
  if (!canonicalAddress(creatorWallet)) throw new Error('La wallet conectada no es válida.');
  if (drafts.length > MAX_TOKEN_LAUNCH_BATCH_DRAFTS
    || drafts.some((draft) => !isTokenLaunchBatchDraft(draft) || draft.creatorWallet !== creatorWallet)
    || new Set(drafts.map((draft) => draft.id)).size !== drafts.length) {
    throw new Error('La cola contiene un lanzamiento inválido. Revísala antes de guardarla.');
  }
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(drafts, creatorWallet);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('No se pudo guardar la cola de lanzamientos.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('No se pudo guardar la cola de lanzamientos.'));
    });
  } finally {
    database.close();
  }
}
