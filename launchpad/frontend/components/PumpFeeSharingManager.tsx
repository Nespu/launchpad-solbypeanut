'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { AlertTriangle, ExternalLink, Plus, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import type { VaultWallet, WalletVaultSession } from '../lib/walletVault';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';
import { useWireLocale } from './LocaleProvider';

const PENDING_KEY = 'wire:pump-fee-sharing-pending:v1';
const MAX_SHAREHOLDERS = 10;
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const PUMP_SWEEP = Uint8Array.from([32, 246, 191, 52, 8, 201, 73, 186]);
const PUMP_AMM_TRANSFER = Uint8Array.from([1, 33, 78, 185, 33, 67, 44, 92]);
const CREATE_SHARING_CONFIG = Uint8Array.from([195, 78, 86, 76, 111, 52, 251, 213]);
const UPDATE_SHARES_V2 = Uint8Array.from([111, 251, 49, 6, 78, 78, 106, 18]);
const DISTRIBUTE_FEES_V2 = Uint8Array.from([255, 203, 19, 79, 244, 68, 8, 159]);
const CREATE_SOCIAL_FEE_PDA = Uint8Array.from([144, 224, 59, 211, 78, 248, 202, 220]);
const GITHUB_PLATFORM = 2;

type Phase = 'not_configured' | 'editable' | 'finalized' | 'legacy_unsupported';
type Share = { type: 'wallet' | 'github' | 'unsupported_social'; address: string; shareBps: number; userId?: string };
type FeeBalance = {
  mint: string;
  decimals: number;
  symbol: string;
  pumpVaultRaw: string;
  ammVaultRaw: string;
  totalRaw: string;
};
type SharingStatus = {
  success: true;
  network: 'devnet';
  mint: string;
  quoteMint: string;
  quoteTokenProgram: string;
  graduated: boolean;
  creator: string;
  currentCreator: string;
  creatorMatches: boolean;
  sharingConfigAddress: string;
  phase: Phase;
  admin: string | null;
  adminRevoked: boolean;
  version: number | null;
  canFinalize: boolean;
  shareholders: Share[];
  balances: FeeBalance[];
};
type PreparedAction = 'create' | 'initialize_social' | 'finalize' | 'distribute';
type PreparedOperation = {
  creator: string;
  mint: string;
  quoteMint: string;
  sharingConfigAddress: string;
  graduated: boolean;
  action: PreparedAction;
  shareholders: Share[];
  estimatedNetworkFeeLamports: number;
  estimatedRentLamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
  transaction: string;
  transactionMessageHash: string;
  socialRecipientsToInitialize: Array<{ userId: string; address: string }>;
};
type PendingOperation = {
  signature: string;
  creator: string;
  mint: string;
  action: PreparedAction;
  blockhash: string;
  lastValidBlockHeight: number;
  createdAt: number;
  status: 'pending' | 'confirmed' | 'failed' | 'expired';
};
type DraftShare = { id: string; type: 'wallet' | 'github'; address: string; percent: string };
type Review = { action: PreparedAction; prepared: PreparedOperation };

function validPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function parsePending(raw: string | null): PendingOperation | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingOperation>;
    if (typeof value.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value.signature)
      || !validPublicKey(value.creator) || !validPublicKey(value.mint)
      || !['create', 'initialize_social', 'finalize', 'distribute'].includes(String(value.action))
      || typeof value.blockhash !== 'string' || !Number.isSafeInteger(value.lastValidBlockHeight)
      || !Number.isSafeInteger(value.createdAt)
      || !['pending', 'confirmed', 'failed', 'expired'].includes(String(value.status))) return null;
    return value as PendingOperation;
  } catch { return null; }
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hasDiscriminator(data: Buffer, discriminator: Uint8Array): boolean {
  return data.length >= discriminator.length && discriminator.every((value, index) => data[index] === value);
}

function pda(program: PublicKey, ...seeds: Uint8Array[]) {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

function sharingConfigPda(mint: PublicKey) {
  return pda(PUMP_FEE_PROGRAM_ID, new TextEncoder().encode('sharing-config'), mint.toBytes());
}

function githubFeePda(userId: string) {
  return pda(PUMP_FEE_PROGRAM_ID, new TextEncoder().encode('social-fee-pda'), new TextEncoder().encode(userId), Uint8Array.from([GITHUB_PLATFORM]));
}

function creatorVaultPda(owner: PublicKey) {
  return pda(PUMP_PROGRAM_ID, new TextEncoder().encode('creator-vault'), owner.toBytes());
}

function ammCreatorVaultPda(owner: PublicKey) {
  return pda(PUMP_AMM_PROGRAM_ID, new TextEncoder().encode('creator_vault'), owner.toBytes());
}

function canonicalPumpPoolPda(mint: PublicKey, quoteMint: PublicKey) {
  const poolAuthority = pda(PUMP_PROGRAM_ID, new TextEncoder().encode('pool-authority'), mint.toBytes());
  return pda(
    PUMP_AMM_PROGRAM_ID,
    new TextEncoder().encode('pool'),
    Uint8Array.from([0, 0]),
    poolAuthority.toBytes(),
    mint.toBytes(),
    quoteMint.toBytes(),
  );
}

function parsePercentToBps(raw: string): number | null {
  const value = raw.trim();
  if (!/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?|0?\.\d{1,2})$/.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0');
  return Number.isSafeInteger(bps) && bps > 0 && bps <= 10_000 ? bps : null;
}

function percentFromBps(value: number) {
  return (value / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatRaw(raw: string, decimals: number) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function verifyShareEncoding(instruction: Transaction['instructions'][number], expected: Share[]) {
  const data = instruction.data;
  if (!hasDiscriminator(data, UPDATE_SHARES_V2) || data.length < 12) return false;
  const count = data.readUInt32LE(8);
  if (count !== expected.length || data.length !== 12 + count * 34) return false;
  for (let index = 0; index < count; index += 1) {
    const offset = 12 + index * 34;
    const address = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    const shareBps = data.readUInt16LE(offset + 32);
    if (address !== expected[index]?.address || shareBps !== expected[index]?.shareBps) return false;
  }
  return true;
}

function verifySocialPdaCreation(
  instruction: Transaction['instructions'][number],
  payer: PublicKey,
  recipient: { userId: string; address: string },
) {
  const data = instruction.data;
  if (!instruction.programId.equals(PUMP_FEE_PROGRAM_ID) || !hasDiscriminator(data, CREATE_SOCIAL_FEE_PDA)
    || !instruction.keys[0]?.pubkey.equals(payer) || !instruction.keys[1]?.pubkey.equals(githubFeePda(recipient.userId))) {
    throw new Error('La inicialización del destinatario GitHub no coincide con la identidad revisada.');
  }
  const userIdLength = data.length >= 13 ? data.readUInt32LE(8) : 0;
  const userIdStart = 12;
  const userIdEnd = userIdStart + userIdLength;
  if (userIdLength < 1 || userIdLength > 20 || userIdEnd + 1 !== data.length
    || data.subarray(userIdStart, userIdEnd).toString('utf8') !== recipient.userId
    || data[userIdEnd] !== GITHUB_PLATFORM || recipient.address !== githubFeePda(recipient.userId).toBase58()) {
    throw new Error('El ID GitHub o la plataforma de la instrucción cambió después de la revisión.');
  }
}

function verifyPreparedTransaction(transaction: Transaction, prepared: PreparedOperation) {
  const payer = new PublicKey(prepared.creator);
  const mint = new PublicKey(prepared.mint);
  const quoteMint = new PublicKey(prepared.quoteMint);
  const config = new PublicKey(prepared.sharingConfigAddress);
  if (!transaction.feePayer?.equals(payer) || transaction.recentBlockhash !== prepared.blockhash) {
    throw new Error('La operación preparada no corresponde con la wallet, el mint y el blockhash esperados.');
  }
  const message = transaction.compileMessage();
  if (message.header.numRequiredSignatures !== 1 || !message.accountKeys[0]?.equals(payer)) {
    throw new Error('La operación requiere una firma distinta de la wallet elegida.');
  }
  const instructions = transaction.instructions;
  if (instructions.length < 3 || instructions.length > 5
    || instructions.some((instruction) => ![
      ComputeBudgetProgram.programId.toBase58(),
      PUMP_PROGRAM_ID.toBase58(),
      PUMP_AMM_PROGRAM_ID.toBase58(),
      PUMP_FEE_PROGRAM_ID.toBase58(),
    ].includes(instruction.programId.toBase58()))) {
    throw new Error('La operación contiene instrucciones que Wire no reconoce para Pump fee sharing.');
  }
  const compute = instructions[0];
  if (!compute.programId.equals(ComputeBudgetProgram.programId) || compute.data.length !== 5
    || compute.data[0] !== 2 || compute.data.readUInt32LE(1) !== 1_300_000) {
    throw new Error('No se pudo verificar el límite de cómputo de la transacción.');
  }

  if (prepared.action === 'initialize_social') {
    const recipients = prepared.socialRecipientsToInitialize;
    if (recipients.length < 1 || instructions.length !== 1 + recipients.length) {
      throw new Error('La cantidad de inicializaciones GitHub no coincide con la revisión.');
    }
    recipients.forEach((recipient, index) => verifySocialPdaCreation(instructions[index + 1], payer, recipient));
    return;
  }

  const expectedSweeps = prepared.graduated ? 2 : 1;
  const socialInitializations = prepared.action === 'finalize' ? prepared.socialRecipientsToInitialize.length : 0;
  const expectedLength = prepared.action === 'distribute'
    ? 1 + expectedSweeps + (prepared.graduated ? 2 : 1)
    : 1 + expectedSweeps + socialInitializations + 1;
  if (instructions.length !== expectedLength) throw new Error('La cantidad de instrucciones no coincide con la operación revisada.');

  const curveSweep = instructions[1];
  const feeOwner = prepared.action === 'create' ? payer : config;
  if (!curveSweep.programId.equals(PUMP_PROGRAM_ID) || !hasDiscriminator(curveSweep.data, PUMP_SWEEP)
    || !curveSweep.keys[0]?.pubkey.equals(payer)
    || !curveSweep.keys[2]?.pubkey.equals(mint)
    || !curveSweep.keys[3]?.pubkey.equals(quoteMint)
    || !curveSweep.keys[9]?.pubkey.equals(creatorVaultPda(feeOwner))) {
    throw new Error('La instrucción de barrido de Pump no coincide con el token o la bóveda seleccionados.');
  }

  let tailIndex = 2;
  if (prepared.graduated) {
    const poolSweep = instructions[tailIndex];
    const poolCreator = prepared.action === 'create' ? payer : config;
    if (!poolSweep.programId.equals(PUMP_AMM_PROGRAM_ID) || !hasDiscriminator(poolSweep.data, PUMP_SWEEP)
      || !poolSweep.keys[0]?.pubkey.equals(payer)
      || !poolSweep.keys[2]?.pubkey.equals(canonicalPumpPoolPda(mint, quoteMint))
      || !poolSweep.keys[3]?.pubkey.equals(quoteMint)
      || !poolSweep.keys[6]?.pubkey.equals(ammCreatorVaultPda(poolCreator))) {
      throw new Error('La instrucción de barrido de PumpSwap no coincide con la pool canónica y la wallet elegidas.');
    }
    tailIndex += 1;
  }

  if (prepared.action === 'create') {
    const create = instructions[tailIndex];
    if (!create.programId.equals(PUMP_FEE_PROGRAM_ID) || !hasDiscriminator(create.data, CREATE_SHARING_CONFIG)
      || create.data.length !== 8 || !create.keys[2]?.pubkey.equals(payer)
      || !create.keys[4]?.pubkey.equals(mint) || !create.keys[5]?.pubkey.equals(config)) {
      throw new Error('La instrucción no coincide con la activación de fee sharing de este token.');
    }
  } else if (prepared.action === 'finalize') {
    for (const recipient of prepared.socialRecipientsToInitialize) {
      verifySocialPdaCreation(instructions[tailIndex++], payer, recipient);
    }
    const update = instructions[tailIndex];
    if (!update.programId.equals(PUMP_FEE_PROGRAM_ID) || !verifyShareEncoding(update, prepared.shareholders)
      || !update.keys[2]?.pubkey.equals(payer) || !update.keys[4]?.pubkey.equals(mint)
      || !update.keys[5]?.pubkey.equals(config)) {
      throw new Error('Los porcentajes de la instrucción no coinciden con el reparto que revisaste.');
    }
  } else {
    if (prepared.graduated) {
      const transfer = instructions[tailIndex];
      if (!transfer.programId.equals(PUMP_AMM_PROGRAM_ID) || !hasDiscriminator(transfer.data, PUMP_AMM_TRANSFER)
        || !transfer.keys[0]?.pubkey.equals(payer) || !transfer.keys[1]?.pubkey.equals(quoteMint)
        || !transfer.keys[5]?.pubkey.equals(config)) {
        throw new Error('La instrucción para trasladar fees de PumpSwap no coincide con la pool seleccionada.');
      }
      tailIndex += 1;
    }
    const distribute = instructions[tailIndex];
    if (!distribute.programId.equals(PUMP_PROGRAM_ID) || !hasDiscriminator(distribute.data, DISTRIBUTE_FEES_V2)
      || !distribute.keys[0]?.pubkey.equals(payer) || !distribute.keys[1]?.pubkey.equals(mint)
      || !distribute.keys[3]?.pubkey.equals(config) || distribute.data.length !== 9 || distribute.data[8] !== 1) {
      throw new Error('La instrucción de distribución no coincide con el reparto confirmado de Pump.');
    }
  }
}

function validateDraftShares(drafts: DraftShare[]): Share[] {
  if (drafts.length < 1 || drafts.length > MAX_SHAREHOLDERS) {
    throw new Error(`El reparto debe tener entre 1 y ${MAX_SHAREHOLDERS} destinatarios.`);
  }
  const addresses = new Set<string>();
  const shares: Share[] = drafts.map((draft) => {
    const shareBps = parsePercentToBps(draft.percent);
    if (shareBps === null) throw new Error('Cada porcentaje debe estar entre 0.01% y 100%, con hasta dos decimales.');
    let address: string;
    let userId: string | undefined;
    if (draft.type === 'github') {
      userId = draft.address.trim();
      if (!/^[1-9][0-9]{0,19}$/.test(userId) || BigInt(userId) > 18_446_744_073_709_551_615n) {
        throw new Error('Usa el ID numérico válido de una cuenta personal de GitHub.');
      }
      address = githubFeePda(userId).toBase58();
    } else {
      if (!validPublicKey(draft.address)) throw new Error('Escribe una dirección Solana válida para cada destinatario.');
      address = draft.address;
    }
    if (addresses.has(address)) throw new Error('El reparto no puede repetir direcciones.');
    addresses.add(address);
    return draft.type === 'github' ? { type: 'github', address, userId, shareBps } : { type: 'wallet', address, shareBps };
  });
  if (shares.reduce((total, share) => total + share.shareBps, 0) !== 10_000) {
    throw new Error('La suma de los porcentajes debe ser exactamente 100%.');
  }
  return shares;
}

function explorerTransaction(signature: string) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export default function PumpFeeSharingManager({
  wallets,
  session,
  connectedAddress,
}: {
  wallets: VaultWallet[];
  session: WalletVaultSession | null;
  connectedAddress: string | null;
}) {
  const { t } = useWireLocale();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const vaultWallets = useMemo(() => wallets.filter((wallet) => wallet.address !== connectedAddress), [wallets, connectedAddress]);
  const [creatorAddress, setCreatorAddress] = useState(connectedAddress ?? vaultWallets[0]?.address ?? '');
  const [mintAddress, setMintAddress] = useState('');
  const [status, setStatus] = useState<SharingStatus | null>(null);
  const [drafts, setDrafts] = useState<DraftShare[]>([]);
  const [draftInitializedFor, setDraftInitializedFor] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [confirmedPermanent, setConfirmedPermanent] = useState(false);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const chosenIsConnected = creatorAddress === connectedAddress
    && publicKey?.toBase58() === creatorAddress && Boolean(signTransaction);
  const chosenVault = vaultWallets.some((wallet) => wallet.address === creatorAddress);
  const canSign = chosenIsConnected || (chosenVault && Boolean(session && !session.isLocked));

  useEffect(() => {
    if (!validPublicKey(creatorAddress) || (creatorAddress !== connectedAddress && !vaultWallets.some((wallet) => wallet.address === creatorAddress))) {
      setCreatorAddress(connectedAddress ?? vaultWallets[0]?.address ?? '');
    }
  }, [connectedAddress, creatorAddress, vaultWallets]);

  useEffect(() => {
    try { setPending(parsePending(window.localStorage.getItem(PENDING_KEY))); }
    catch { setPending(null); }
  }, []);

  const persistPending = (value: PendingOperation | null) => {
    setPending(value);
    try {
      if (value) window.localStorage.setItem(PENDING_KEY, JSON.stringify(value));
      else window.localStorage.removeItem(PENDING_KEY);
      return true;
    } catch { return false; }
  };

  const refreshStatus = useCallback(async () => {
    if (!validPublicKey(mintAddress) || !validPublicKey(creatorAddress)) {
      setError(t('Escribe el mint Pump y selecciona la wallet que autoriza la operación.'));
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    setReview(null);
    setConfirmedPermanent(false);
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('El reparto de creator fees solo está disponible en Solana Devnet.');
      const api = process.env.NEXT_PUBLIC_API_URL || '';
      const query = new URLSearchParams({ mint: mintAddress, creator: creatorAddress });
      const response = await fetch(`${api}/api/pump/fee-sharing/status?${query}`, { cache: 'no-store' });
      const data = await response.json() as Partial<SharingStatus> & { error?: string };
      if (!response.ok || data.success !== true || data.network !== 'devnet' || data.mint !== mintAddress) {
        throw new Error(data.error || 'No se pudo consultar el estado de fee sharing en Devnet.');
      }
      setStatus(data as SharingStatus);
      if (data.phase === 'editable' && data.canFinalize && draftInitializedFor !== mintAddress) {
        const initialShares = Array.isArray(data.shareholders) ? data.shareholders : [];
        setDrafts(initialShares.map((share, index) => ({
          id: `${Date.now()}-${index}`,
          type: share.type === 'github' ? 'github' : 'wallet',
          address: share.type === 'github' ? share.userId ?? '' : share.address,
          percent: percentFromBps(share.shareBps),
        })));
        setDraftInitializedFor(mintAddress);
      } else if (data.phase === 'not_configured' && data.creatorMatches && draftInitializedFor !== mintAddress) {
        setDrafts([{ id: `${Date.now()}-creator`, type: 'wallet', address: creatorAddress, percent: '100' }]);
        setDraftInitializedFor(mintAddress);
      }
    } catch (caught) {
      setStatus(null);
      setError(caught instanceof Error ? t(caught.message) : t('No se pudo consultar el estado de fee sharing en Devnet.'));
    } finally { setLoading(false); }
  }, [connection, creatorAddress, draftInitializedFor, mintAddress, t]);

  const prepare = async (action: PreparedAction) => {
    if (pending?.status === 'pending') {
      setError(t('Hay una firma pendiente. Verifica su estado antes de preparar otra operación.'));
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    setReview(null);
    setConfirmedPermanent(false);
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('El reparto de creator fees solo está disponible en Solana Devnet.');
      if (!status || status.mint !== mintAddress || status.creator !== creatorAddress) throw new Error('Actualiza el estado on-chain antes de preparar la operación.');
      if (!canSign) throw new Error('Conecta o desbloquea la wallet elegida para firmar esta operación.');
      let shareholders: Share[] | undefined;
      if (action === 'create' && (!status.creatorMatches || status.phase !== 'not_configured')) throw new Error('La wallet seleccionada no es la creadora actual o la configuración ya existe.');
      if (action === 'finalize') {
        if (status.phase !== 'editable' || !status.canFinalize) throw new Error('Solo la wallet administradora puede finalizar un reparto todavía editable.');
        shareholders = validateDraftShares(drafts);
      }
      if (action === 'distribute' && status.phase !== 'finalized') throw new Error('Primero debe existir un reparto final confirmado por Pump.');
      const api = process.env.NEXT_PUBLIC_API_URL || '';
      const response = await fetch(`${api}/api/pump/fee-sharing/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creator: creatorAddress,
          mint: mintAddress,
          action,
          shareholders: action === 'finalize' ? drafts.map((draft, index) => ({
            type: draft.type,
            ...(draft.type === 'github' ? { userId: shareholders?.[index]?.userId } : { address: draft.address }),
            shareBps: shareholders?.[index]?.shareBps,
          })) : undefined,
        }),
      });
      const data = await response.json() as Partial<PreparedOperation> & { success?: boolean; network?: string; error?: string };
      if (!response.ok || data.success !== true || data.network !== 'devnet') throw new Error(data.error || 'No se pudo preparar la transacción de Pump.');
      const prepared = data as PreparedOperation;
      const stagedSocialSetup = action === 'finalize' && prepared.action === 'initialize_social';
      if ((prepared.action !== action && !stagedSocialSetup) || prepared.creator !== creatorAddress || prepared.mint !== mintAddress
        || !validPublicKey(prepared.quoteMint) || !validPublicKey(prepared.sharingConfigAddress)
        || !Number.isSafeInteger(prepared.estimatedNetworkFeeLamports) || prepared.estimatedNetworkFeeLamports < 0
        || !Number.isSafeInteger(prepared.estimatedRentLamports) || prepared.estimatedRentLamports < 0
        || !Array.isArray(prepared.socialRecipientsToInitialize)
        || typeof prepared.transaction !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.transactionMessageHash)
        || !Number.isSafeInteger(prepared.lastValidBlockHeight)) throw new Error('La respuesta de preparación no coincide con el estado revisado.');
      if (action === 'finalize' && JSON.stringify(prepared.shareholders) !== JSON.stringify(shareholders)) {
        throw new Error('Los porcentajes preparados cambiaron. No se solicitó la firma.');
      }
      const transaction = Transaction.from(bytesFromBase64(prepared.transaction));
      verifyPreparedTransaction(transaction, prepared);
      if (await sha256Hex(transaction.serializeMessage()) !== prepared.transactionMessageHash) throw new Error('La transacción cambió después de prepararse. No se solicitó la firma.');
      if (transaction.recentBlockhash !== prepared.blockhash || await connection.getBlockHeight('confirmed') > prepared.lastValidBlockHeight) {
        throw new Error('La revisión venció. Actualiza el estado y vuelve a preparar la operación.');
      }
      setReview({ action: prepared.action, prepared });
      setNotice(stagedSocialSetup
        ? t('Se requiere una firma para inicializar las cuentas sociales. El reparto permanente se revisará después, en otra transacción.')
        : t('Revisa el token, destinatarios y costes. La operación todavía no se ha firmado ni enviado.'));
    } catch (caught) {
      setError(caught instanceof Error ? t(caught.message) : t('No se pudo preparar la transacción de Pump.'));
    } finally { setLoading(false); }
  };

  const verifyPending = useCallback(async (receipt: PendingOperation | null = pending) => {
    if (!receipt || receipt.status !== 'pending') return;
    setLoading(true);
    setError('');
    try {
      const result = await connection.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true });
      const statusValue = result.value[0];
      if (statusValue?.err) {
        persistPending({ ...receipt, status: 'failed' });
        setNotice(t('Pump marcó la transacción como fallida. Revisa la firma en Explorer antes de volver a preparar.'));
      } else if (statusValue?.confirmationStatus === 'confirmed' || statusValue?.confirmationStatus === 'finalized') {
        persistPending({ ...receipt, status: 'confirmed' });
        setMintAddress(receipt.mint);
        setCreatorAddress(receipt.creator);
        setNotice(receipt.action === 'initialize_social'
          ? t('Destinatarios GitHub inicializados en Devnet. Revisa y firma el reparto permanente por separado.')
          : t('La operación de fee sharing se confirmó en Devnet. Estado actualizado.'));
        window.setTimeout(() => void refreshStatus(), 0);
      } else if (await connection.getBlockHeight('confirmed') > receipt.lastValidBlockHeight) {
        persistPending({ ...receipt, status: 'expired' });
        setNotice(t('La firma venció sin confirmación encontrada. Comprueba Explorer antes de intentar de nuevo.'));
      } else {
        setNotice(t('La firma sigue pendiente en Devnet. Wire no volverá a enviar esta transacción automáticamente.'));
      }
    } catch {
      setError(t('No se pudo consultar la firma. Conservamos el estado para que puedas verificarlo de nuevo.'));
    } finally { setLoading(false); }
  }, [connection, pending, refreshStatus, t]);

  const signAndSend = async () => {
    if (!review || pending?.status === 'pending') return;
    if (review.action === 'finalize' && !confirmedPermanent) {
      setError(t('Confirma que entiendes que Pump no permitirá cambiar el reparto final.'));
      return;
    }
    if (!canSign) {
      setError(t('Conecta o desbloquea la wallet elegida para firmar esta operación.'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('El reparto de creator fees solo está disponible en Solana Devnet.');
      const prepared = review.prepared;
      const transaction = Transaction.from(bytesFromBase64(prepared.transaction));
      verifyPreparedTransaction(transaction, prepared);
      if (await sha256Hex(transaction.serializeMessage()) !== prepared.transactionMessageHash) throw new Error('La transacción cambió desde la revisión. No se solicitó la firma.');
      if (await connection.getBlockHeight('confirmed') > prepared.lastValidBlockHeight) throw new Error('La revisión venció. Actualiza el estado y vuelve a preparar la operación.');
      const signed = chosenIsConnected
        ? await signTransaction!(transaction)
        : await session!.signTransaction(creatorAddress, transaction);
      if (!signed.feePayer?.equals(new PublicKey(prepared.creator)) || signed.recentBlockhash !== prepared.blockhash
        || await sha256Hex(signed.serializeMessage()) !== prepared.transactionMessageHash) {
        throw new Error('La wallet cambió la operación revisada. Wire no la enviará.');
      }
      const signatureBytes = signed.signatures.find((entry) => entry.publicKey.toBase58() === creatorAddress)?.signature;
      if (!signatureBytes) throw new Error('La wallet no devolvió la firma requerida.');
      const signature = bs58.encode(signatureBytes);
      const receipt: PendingOperation = {
        signature,
        creator: creatorAddress,
        mint: mintAddress,
        action: review.action,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        createdAt: Date.now(),
        status: 'pending',
      };
      if (!persistPending(receipt)) {
        setNotice(t('El navegador no pudo guardar la firma pendiente. Wire no envió la transacción.'));
        return;
      }
      setReview(null);
      setConfirmedPermanent(false);
      try {
        const sent = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
        if (sent !== signature) throw new Error('RPC devolvió una firma distinta.');
        await connection.confirmTransaction({ signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, 'confirmed');
      } catch {
        setNotice(t('La firma quedó guardada. Verifica su estado antes de preparar otra operación; Wire no la reenviará automáticamente.'));
        return;
      }
      await verifyPending(receipt);
    } catch (caught) {
      setError(caught instanceof Error ? t(caught.message) : t('No se pudo completar la operación de fee sharing.'));
    } finally { setLoading(false); }
  };

  const percentTotal = drafts.reduce((total, item) => total + (parsePercentToBps(item.percent) ?? 0), 0);
  const visibleFeeBalances = (status?.balances ?? []).filter((balance) => BigInt(balance.totalRaw) > 0n);
  const displayShareholders = review?.action === 'finalize' || review?.action === 'initialize_social' ? review.prepared.shareholders : status?.shareholders ?? [];

  const changeMint = (value: string) => {
    setMintAddress(value.trim());
    setStatus(null);
    setReview(null);
    setError('');
    setNotice('');
    setDraftInitializedFor('');
    setDrafts([]);
  };

  const setDraft = (id: string, changes: Partial<DraftShare>) => {
    setReview(null);
    setConfirmedPermanent(false);
    setDrafts((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  };

  const addDraft = () => {
    if (drafts.length >= MAX_SHAREHOLDERS) return;
    setReview(null);
    setConfirmedPermanent(false);
    setDrafts((current) => [...current, { id: `${Date.now()}-${Math.random()}`, type: 'wallet', address: '', percent: '' }]);
  };

  return (
    <section className="wire-panel mt-6 rounded-2xl p-4 sm:p-6" aria-labelledby="pump-fee-sharing-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] text-[var(--wire-green)]"><Users size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="pump-fee-sharing-title" className="text-lg font-semibold">{t('Repartir creator fees')}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{t('Configura destinatarios para las comisiones de Pump.fun y PumpSwap. La wallet creadora firma la configuración; Pump distribuye los fees según el reparto confirmado.')}</p>
          </div>
        </div>
        <span className="rounded-full border border-[var(--wire-green)]/30 px-3 py-1 text-xs font-semibold text-[var(--wire-green)]">{t('Solo Devnet')}</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:items-end">
        <label className="grid gap-1.5 text-xs text-[var(--muted)]">
          {t('Mint del token Pump')}
          <input value={mintAddress} onChange={(event) => changeMint(event.target.value)} autoComplete="off" spellCheck={false} placeholder={t('Pega la dirección del mint')} className="wire-input min-h-11 w-full rounded-lg px-3 font-mono text-sm" />
        </label>
        <label className="grid gap-1.5 text-xs text-[var(--muted)]">
          {t('Wallet que firma / paga fees')}
          <select value={creatorAddress} onChange={(event) => { setCreatorAddress(event.target.value); setStatus(null); setReview(null); setError(''); setNotice(''); }} className="wire-input min-h-11 w-full rounded-lg px-3 text-sm" disabled={!connectedAddress && vaultWallets.length === 0}>
            {connectedAddress && <option value={connectedAddress}>{t('Wallet conectada')} · {connectedAddress.slice(0, 4)}…{connectedAddress.slice(-4)}</option>}
            {vaultWallets.map((wallet) => <option key={wallet.address} value={wallet.address}>{wallet.label || t('Wallet de la bóveda')} · {wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}</option>)}
            {!connectedAddress && vaultWallets.length === 0 && <option value="">{t('Conecta una wallet o crea wallets en la bóveda')}</option>}
          </select>
        </label>
        <button type="button" onClick={() => void refreshStatus()} disabled={loading || !creatorAddress || !mintAddress.trim()} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />{t('Consultar')}
        </button>
      </div>

      {!status && !error && <p className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-sm leading-relaxed text-[var(--muted)]">{t('Consulta primero el mint para comprobar quién puede configurar el reparto y si ya existe una configuración irreversible.')}</p>}

      {status && <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{status.phase === 'not_configured' ? t('Sin configuración de reparto')
              : status.phase === 'editable' ? t('Configuración creada · reparto aún no finalizado')
                : status.phase === 'finalized' ? t('Reparto confirmado por Pump') : t('Configuración antigua no compatible')}</p>
            <p className="mt-1 break-all font-mono text-xs text-[var(--muted)]">{status.mint}</p>
          </div>
          <span className="rounded-full border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--muted)]">{status.graduated ? t('PumpSwap graduado') : t('Curva de Pump')}</span>
        </div>
        <dl className="mt-3 grid gap-2 border-t border-[var(--line)] pt-3 text-xs sm:grid-cols-2">
          <div><dt className="text-[var(--muted)]">{t('Wallet creadora actual')}</dt><dd className="mt-0.5 break-all font-mono">{status.currentCreator}</dd></div>
          <div><dt className="text-[var(--muted)]">{t('Activo de fees')}</dt><dd className="mt-0.5 break-all font-mono">{status.quoteMint}</dd></div>
          {status.phase !== 'not_configured' && <div className="sm:col-span-2"><dt className="text-[var(--muted)]">{t('Dirección sharing_config')}</dt><dd className="mt-0.5 break-all font-mono">{status.sharingConfigAddress}</dd></div>}
        </dl>

        {status.phase === 'not_configured' && <div className="mt-4 rounded-lg border border-[var(--line)] p-3">
          <p className="text-sm leading-relaxed text-[var(--muted)]">{t('Pump creará la sharing_config y moverá ahí el destino de los creator fees. La configuración inicial mantiene 100% para la wallet creadora hasta que revises y firmes el reparto final.')}</p>
          <button type="button" onClick={() => void prepare('create')} disabled={loading || !status.creatorMatches || !canSign || pending?.status === 'pending'} className="wire-button wire-button-primary mt-3 min-h-11 px-4 text-sm">{t('Preparar activación')}</button>
          {!status.creatorMatches && <p className="mt-2 text-xs text-[var(--danger,#ff8b8b)]">{t('Selecciona la wallet creadora actual del token para activar la configuración.')}</p>}
        </div>}

        {status.phase === 'editable' && <div className="mt-4">
          {status.canFinalize ? <>
            <div className="rounded-lg border border-[var(--warning,#dca84b)]/40 bg-[var(--warning,#dca84b)]/5 p-3 text-sm leading-relaxed text-[var(--muted)]">
              <div className="flex items-center gap-2 font-semibold text-[var(--text)]"><AlertTriangle size={15} aria-hidden="true" className="text-[var(--warning,#dca84b)]" />{t('La decisión final es permanente')}</div>
              <p className="mt-1">{t('Pump permite fijar los porcentajes una sola vez. Revisa direcciones y suma; wire no podrá cambiarlos después de la firma.')}</p>
              {drafts.some((draft) => draft.type === 'github') && <p className="mt-2">{t('GitHub: usa el ID numérico de una cuenta personal, no una organización. Esa cuenta reclama en Pump.fun; Wire no puede reclamar ni verificar la identidad social.')}</p>}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">{t('Destinatarios')}</p>
              <button type="button" onClick={addDraft} disabled={drafts.length >= MAX_SHAREHOLDERS || loading} className="wire-button wire-button-secondary min-h-11 px-3 text-xs"><Plus size={14} aria-hidden="true" />{t('Añadir destinatario')}</button>
            </div>
            <div className="mt-2 grid gap-2">
              {drafts.map((draft, index) => <div key={draft.id} className="grid gap-2 rounded-lg border border-[var(--line)] p-3 sm:grid-cols-[150px_minmax(0,1fr)_130px_auto] sm:items-end">
                <label className="grid gap-1 text-xs text-[var(--muted)]">{t('Tipo de destinatario')}
                  <select value={draft.type} onChange={(event) => setDraft(draft.id, { type: event.target.value as DraftShare['type'], address: '' })} className="wire-input min-h-11 w-full rounded-lg px-3 text-xs">
                    <option value="wallet">{t('Wallet Solana')}</option>
                    <option value="github">GitHub</option>
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-[var(--muted)]">{draft.type === 'github' ? t('ID de GitHub {number}', { number: index + 1 }) : t('Wallet destinataria {number}', { number: index + 1 })}
                  <input value={draft.address} onChange={(event) => setDraft(draft.id, { address: event.target.value.trim() })} autoComplete="off" spellCheck={false} className="wire-input min-h-11 w-full rounded-lg px-3 font-mono text-xs" placeholder={draft.type === 'github' ? t('ID numérico de cuenta personal') : t('Dirección Solana')} />
                </label>
                <label className="grid gap-1 text-xs text-[var(--muted)]">{t('Porcentaje')}
                  <span className="flex min-h-11 items-center rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3"><input inputMode="decimal" value={draft.percent} onChange={(event) => setDraft(draft.id, { percent: event.target.value })} className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none" placeholder="0" aria-label={t('Porcentaje para wallet {number}', { number: index + 1 })} /><span className="ml-2 text-xs text-[var(--muted)]">%</span></span>
                </label>
                <button type="button" onClick={() => { setReview(null); setConfirmedPermanent(false); setDrafts((current) => current.filter((item) => item.id !== draft.id)); }} disabled={drafts.length <= 1 || loading} className="wire-button wire-button-quiet min-h-11 min-w-11 p-0 text-[var(--muted)] disabled:opacity-40" aria-label={t('Quitar wallet {number}', { number: index + 1 })}><Trash2 size={15} aria-hidden="true" /></button>
              </div>)}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <p className={percentTotal === 10_000 ? 'text-[var(--wire-green)]' : 'text-[var(--muted)]'}>{t('Total: {percent}% · máximo {count} wallets', { percent: percentFromBps(percentTotal), count: MAX_SHAREHOLDERS })}</p>
              <button type="button" onClick={() => void prepare('finalize')} disabled={loading || !canSign || pending?.status === 'pending' || percentTotal !== 10_000 || drafts.some((item) => {
                const validRecipient = item.type === 'github'
                  ? /^[1-9][0-9]{0,19}$/.test(item.address.trim()) && BigInt(item.address.trim() || '0') <= 18_446_744_073_709_551_615n
                  : validPublicKey(item.address);
                return !validRecipient || parsePercentToBps(item.percent) === null;
              })} className="wire-button wire-button-primary min-h-11 px-4 text-sm">{t('Revisar reparto final')}</button>
            </div>
          </> : <p className="rounded-lg border border-[var(--line)] p-3 text-sm leading-relaxed text-[var(--muted)]">{t('La configuración espera a la wallet administradora de Pump. La wallet elegida no puede fijar los porcentajes.')}</p>}
        </div>}

        {status.phase === 'finalized' && <>
          <div className="mt-4 grid gap-2">
            {status.shareholders.map((share, index) => <div key={`${share.address}-${index}`} className="grid gap-1 rounded-lg border border-[var(--line)] px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="grid gap-1 text-xs">{share.type === 'github' ? <><span>{t('Cuenta personal de GitHub')}</span><code className="break-all">ID {share.userId}</code></> : <><span>{share.type === 'unsupported_social' ? t('Destinatario social de plataforma no compatible') : t('Wallet Solana')}</span><code className="break-all">{share.address}</code></>}</div><span className="font-mono text-sm font-semibold">{percentFromBps(share.shareBps)}%</span>
            </div>)}
          </div>
          <div className="mt-3 rounded-lg border border-[var(--line)] p-3 text-sm leading-relaxed text-[var(--muted)]">
            <p>{t('Las comisiones se acumulan en Pump.fun y, si el token graduó, en PumpSwap. Esta acción las barre y distribuye según los porcentajes de arriba; el pagador cubre la red y cualquier cuenta de token que falte.')}</p>
            {visibleFeeBalances.length > 0 ? <dl className="mt-3 grid gap-2 border-t border-[var(--line)] pt-3">
              {visibleFeeBalances.map((balance) => <div key={balance.mint} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs"><dt>{balance.symbol} · Pump.fun / PumpSwap</dt><dd className="text-right font-mono">{formatRaw(balance.pumpVaultRaw, balance.decimals)} / {formatRaw(balance.ammVaultRaw, balance.decimals)}</dd></div>)}
            </dl> : <p className="mt-2 text-xs">{t('No hay saldos ya acumulados en las bóvedas. Pump también verificará los fees pendientes de barrer al preparar la distribución.')}</p>}
            <button type="button" onClick={() => void prepare('distribute')} disabled={loading || !canSign || pending?.status === 'pending'} className="wire-button wire-button-primary mt-3 min-h-11 px-4 text-sm">{t('Preparar distribución de fees')}</button>
          </div>
        </>}

        {status.phase === 'legacy_unsupported' && <p className="mt-4 rounded-lg border border-[var(--warning,#dca84b)]/40 p-3 text-sm leading-relaxed text-[var(--muted)]">{t('La configuración usa una versión antigua de Pump. Wire no intentará cambiarla ni distribuir fees con instrucciones incompatibles.')}</p>}
      </div>}

      {review && <div className="mt-4 rounded-xl border border-[var(--wire-green)]/40 bg-[var(--surface-2)] p-4" aria-labelledby="pump-fee-sharing-review-title">
        <h3 id="pump-fee-sharing-review-title" className="text-base font-semibold">{review.action === 'create' ? t('Revisa la activación de fee sharing') : review.action === 'initialize_social' ? t('Revisa la inicialización de destinatarios GitHub') : review.action === 'finalize' ? t('Revisa el reparto permanente') : t('Revisa la distribución de creator fees')}</h3>
        <p className="mt-1 break-all font-mono text-xs text-[var(--muted)]">{review.prepared.mint}</p>
        {review.action !== 'create' && <div className="mt-3 grid gap-2">
          {displayShareholders.map((share, index) => <div key={`${share.address}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs"><code className="break-all">{share.type === 'github' ? `${t('GitHub ID')}: ${share.userId}` : share.address}</code><span className="font-mono">{percentFromBps(share.shareBps)}%</span></div>)}
        </div>}
        <dl className="mt-3 grid gap-2 border-t border-[var(--line)] pt-3 text-xs sm:grid-cols-2">
          <div><dt className="text-[var(--muted)]">{t('Wallet firmante y pagadora')}</dt><dd className="mt-0.5 break-all font-mono">{review.prepared.creator}</dd></div>
          <div><dt className="text-[var(--muted)]">{t('Red')}</dt><dd className="mt-0.5">{t('Solana Devnet')}</dd></div>
          <div><dt className="text-[var(--muted)]">{t('Fee de red estimado')}</dt><dd className="mt-0.5 font-mono">{(review.prepared.estimatedNetworkFeeLamports / 1_000_000_000).toFixed(9)} SOL</dd></div>
          <div><dt className="text-[var(--muted)]">{t('Rent estimado')}</dt><dd className="mt-0.5 font-mono">{(review.prepared.estimatedRentLamports / 1_000_000_000).toFixed(9)} SOL</dd></div>
        </dl>
        {review.action === 'create' && <p className="mt-3 rounded-lg border border-[var(--line)] p-3 text-xs leading-relaxed text-[var(--muted)]">{t('Esta firma inicializa la sharing_config. La wallet creadora conserva 100% hasta que revises y firmes la instrucción final en un paso separado.')}</p>}
        {review.action === 'initialize_social' && <p className="mt-3 rounded-lg border border-[var(--line)] p-3 text-xs leading-relaxed text-[var(--muted)]">{t('Esta firma crea las cuentas sociales de GitHub y paga su rent. No fija ni cambia porcentajes. Después tendrás que revisar y firmar el reparto permanente por separado.')}</p>}
        {review.action === 'finalize' && <label className="mt-3 flex cursor-pointer gap-2 rounded-lg border border-[var(--warning,#dca84b)]/40 p-3 text-xs leading-relaxed text-[var(--muted)]"><input type="checkbox" checked={confirmedPermanent} onChange={(event) => setConfirmedPermanent(event.target.checked)} className="mt-0.5 accent-[var(--wire-green)]" /><span>{t('Entiendo que Pump hará permanentes estos porcentajes después de firmar y no podré editarlos.')}</span></label>}
        <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">{review.action === 'distribute' ? t('La instrucción distribuye los fees confirmados a las wallets de la lista. Revisa en Phantom el total de SOL que pagará esta wallet.') : t('La transacción todavía está sin firmar. La wallet mostrará los detalles antes del envío.')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => { setReview(null); setConfirmedPermanent(false); }} disabled={loading} className="wire-button wire-button-secondary min-h-11 px-4 text-sm">{t('Cancelar revisión')}</button>
          <button type="button" onClick={() => void signAndSend()} disabled={loading || pending?.status === 'pending' || (review.action === 'finalize' && !confirmedPermanent)} className="wire-button wire-button-primary min-h-11 px-4 text-sm">{loading ? t('Esperando confirmación…') : review.action === 'finalize' ? t('Firmar reparto permanente') : review.action === 'create' ? t('Firmar activación') : review.action === 'initialize_social' ? t('Inicializar destinatarios GitHub') : t('Firmar y distribuir')}</button>
        </div>
      </div>}

      {pending && <div className="mt-4 rounded-xl border border-[var(--line)] p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="font-semibold">{t(pending.status === 'pending' ? 'Firma pendiente' : pending.status === 'confirmed' ? 'Operación confirmada' : pending.status === 'failed' ? 'Operación fallida' : 'Firma vencida')}</p><code className="mt-1 block break-all text-xs text-[var(--muted)]">{pending.signature}</code></div>
          <div className="flex gap-2">
            {pending.status === 'pending' && <button type="button" onClick={() => void verifyPending()} disabled={loading} className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Verificar')}</button>}
            <a href={explorerTransaction(pending.signature)} target="_blank" rel="noreferrer" className="wire-button wire-button-secondary min-h-11 px-3 text-xs">{t('Explorer')}<ExternalLink size={13} aria-hidden="true" /></a>
          </div>
        </div>
      </div>}

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--line)] p-3 text-xs leading-relaxed text-[var(--muted)]">
        <ShieldCheck size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--wire-green)]" />
        <p>{t('La configuración y la distribución se preparan solo en Devnet. La wallet elegida es la única firmante; las claves de la bóveda permanecen en este navegador. Pump permite fijar el reparto una sola vez.')}</p>
      </div>

      {(error || notice) && <p className={`mt-4 text-sm ${error ? 'text-[var(--danger,#ff8b8b)]' : 'text-[var(--wire-green)]'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error || notice}</p>}
    </section>
  );
}
