'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { CircleDollarSign, RefreshCw, ShieldCheck } from 'lucide-react';
import type { VaultWallet, WalletVaultSession } from '../lib/walletVault';
import { DEVNET_GENESIS_HASH } from '../lib/solanaNetwork';
import { useWireLocale } from './LocaleProvider';

const PENDING_KEY = 'wire:pump-creator-fee-pending:v1';
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const ALLOWED_PROGRAM_IDS = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  PUMP_PROGRAM_ID.toBase58(),
  PUMP_AMM_PROGRAM_ID.toBase58(),
]);
const PUMP_CLAIM_DISCRIMINATOR = Uint8Array.from([207, 17, 138, 242, 4, 34, 19, 56]);
const PUMP_AMM_CLAIM_DISCRIMINATOR = Uint8Array.from([160, 57, 89, 42, 181, 139, 43, 66]);

type CreatorFeeBalance = {
  mint: string;
  symbol: string;
  decimals: number;
  source: string;
  pumpVaultRaw: string;
  ammVaultRaw: string;
  totalRaw: string;
};
type PreparedClaim = {
  creator: string;
  quoteMint: string;
  amountRaw: string;
  decimals: number;
  pumpAmountRaw: string;
  pumpSwapAmountRaw: string;
  estimatedNetworkFeeLamports: number;
  estimatedRentLamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
  transaction: string;
  transactionMessageHash: string;
};
type PendingClaim = {
  signature: string;
  creator: string;
  quoteMint: string;
  blockhash: string;
  lastValidBlockHeight: number;
  status: 'pending' | 'confirmed' | 'failed' | 'expired';
  createdAt: number;
};
type ClaimReview = { balance: CreatorFeeBalance; prepared: PreparedClaim };

function validRaw(value: unknown, allowZero = false): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,23})$/.test(value) && (allowZero || BigInt(value) > 0n);
}

function parsePending(value: string | null): PendingClaim | null {
  if (!value) return null;
  try {
    const item = JSON.parse(value) as Partial<PendingClaim>;
    if (typeof item.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature)
      || typeof item.creator !== 'string' || typeof item.quoteMint !== 'string'
      || typeof item.blockhash !== 'string' || !Number.isSafeInteger(item.lastValidBlockHeight)
      || !['pending', 'confirmed', 'failed', 'expired'].includes(String(item.status))
      || !Number.isSafeInteger(item.createdAt)) return null;
    return item as PendingClaim;
  } catch { return null; }
}

function amountLabel(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function base64Bytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function samePrefix(data: Buffer, expected: Uint8Array) {
  return data.length === expected.length && expected.every((byte, index) => data[index] === byte);
}

function validateClaimTransaction(transaction: Transaction, creator: PublicKey, prepared: PreparedClaim) {
  if (!transaction.feePayer?.equals(creator) || transaction.recentBlockhash !== prepared.blockhash) {
    throw new Error('La transacción preparada no corresponde con la wallet y el blockhash esperados.');
  }
  const message = transaction.compileMessage();
  if (message.accountKeys[0]?.equals(creator) !== true || message.header.numRequiredSignatures !== 1
    || !message.accountKeys[0]?.equals(creator)) {
    throw new Error('La operación requiere una firma distinta de la wallet elegida.');
  }
  if (transaction.instructions.length < 2 || transaction.instructions.length > 4
    || transaction.instructions.some((instruction) => !ALLOWED_PROGRAM_IDS.has(instruction.programId.toBase58()))) {
    throw new Error('La transacción contiene instrucciones que Wire no reconoce para este retiro.');
  }
  const computeInstruction = transaction.instructions[0];
  if (!computeInstruction?.programId.equals(ComputeBudgetProgram.programId)
    || computeInstruction.data.length !== 5 || computeInstruction.data[0] !== 2
    || computeInstruction.data.readUInt32LE(1) <= 0 || computeInstruction.data.readUInt32LE(1) > 600_000) {
    throw new Error('No se pudo verificar el límite de cómputo del retiro.');
  }
  const quoteMint = new PublicKey(prepared.quoteMint);
  const recognized = transaction.instructions.slice(1).every((instruction) => {
    const keys = instruction.keys;
    if (instruction.programId.equals(PUMP_PROGRAM_ID)) {
      const tokenProgram = keys[5]?.pubkey;
      return samePrefix(instruction.data, PUMP_CLAIM_DISCRIMINATOR)
        && keys[0]?.pubkey.equals(creator) === true
        && tokenProgram !== undefined
        && keys[1]?.pubkey.equals(getAssociatedTokenAddressSync(quoteMint, creator, true, tokenProgram)) === true
        && keys[4]?.pubkey.equals(quoteMint) === true
        && (tokenProgram.equals(TOKEN_PROGRAM_ID) || tokenProgram.equals(TOKEN_2022_PROGRAM_ID));
    }
    if (instruction.programId.equals(PUMP_AMM_PROGRAM_ID)) {
      const tokenProgram = keys[1]?.pubkey;
      return samePrefix(instruction.data, PUMP_AMM_CLAIM_DISCRIMINATOR)
        && keys[0]?.pubkey.equals(quoteMint) === true
        && tokenProgram !== undefined
        && (tokenProgram.equals(TOKEN_PROGRAM_ID) || tokenProgram.equals(TOKEN_2022_PROGRAM_ID))
        && keys[2]?.pubkey.equals(creator) === true
        && keys[5]?.pubkey.equals(getAssociatedTokenAddressSync(quoteMint, creator, true, tokenProgram)) === true;
    }
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const tokenProgram = keys[5]?.pubkey;
      return instruction.data.length === 1 && instruction.data[0] === 1
        && tokenProgram !== undefined
        && keys[1]?.pubkey.equals(getAssociatedTokenAddressSync(quoteMint, creator, true, tokenProgram)) === true
        && keys[2]?.pubkey.equals(creator) === true
        && keys[3]?.pubkey.equals(quoteMint) === true
        && (tokenProgram.equals(TOKEN_PROGRAM_ID) || tokenProgram.equals(TOKEN_2022_PROGRAM_ID));
    }
    return false;
  });
  if (!recognized) throw new Error('La instrucción no coincide con un retiro oficial de fees para la wallet y el activo seleccionados.');
}

export default function PumpCreatorFeeManager({
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
  const [creatorAddress, setCreatorAddress] = useState(connectedAddress ?? '');
  const [balances, setBalances] = useState<CreatorFeeBalance[]>([]);
  const [holderRewardsEnabled, setHolderRewardsEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [preparingMint, setPreparingMint] = useState<string | null>(null);
  const [claimReview, setClaimReview] = useState<ClaimReview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PendingClaim | null>(null);

  const savePending = (next: PendingClaim | null) => {
    setPending(next);
    try {
      if (next) window.localStorage.setItem(PENDING_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(PENDING_KEY);
      return true;
    } catch { return false; }
  };

  useEffect(() => {
    try { setPending(parsePending(window.localStorage.getItem(PENDING_KEY))); }
    catch { setPending(null); }
  }, []);

  useEffect(() => {
    if (!creatorAddress || creatorAddress === connectedAddress || vaultWallets.some((wallet) => wallet.address === creatorAddress)) return;
    setCreatorAddress(connectedAddress ?? vaultWallets[0]?.address ?? '');
  }, [connectedAddress, creatorAddress, vaultWallets]);

  const refresh = useCallback(async () => {
    if (!creatorAddress) {
      setBalances([]);
      return;
    }
    setLoading(true);
    setError('');
    setBalances([]);
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS_HASH) throw new Error('Conecta Wire y tu wallet a Solana Devnet para consultar estas comisiones.');
      const api = process.env.NEXT_PUBLIC_API_URL || '';
      const [statusResponse, balancesResponse] = await Promise.all([
        fetch(`${api}/api/pump/creator-fees/status`, { cache: 'no-store' }),
        fetch(`${api}/api/pump/creator-fees/balances?creator=${encodeURIComponent(creatorAddress)}`, { cache: 'no-store' }),
      ]);
      const [status, data] = await Promise.all([statusResponse.json(), balancesResponse.json()]);
      if (!statusResponse.ok || !status.success || status.network !== 'devnet') throw new Error(status.error || 'No se pudo consultar el estado de Pump en Devnet.');
      if (!balancesResponse.ok || !data.success || data.network !== 'devnet' || data.creator !== creatorAddress || !Array.isArray(data.balances)) {
        throw new Error(data.error || 'No se pudieron consultar los saldos de creator fees.');
      }
      const checked = data.balances.filter((item: unknown): item is CreatorFeeBalance => {
        if (!item || typeof item !== 'object') return false;
        const row = item as Partial<CreatorFeeBalance>;
        return typeof row.mint === 'string' && typeof row.symbol === 'string'
          && Number.isSafeInteger(row.decimals) && (row.decimals as number) >= 0 && (row.decimals as number) <= 18
          && validRaw(row.pumpVaultRaw, true) && validRaw(row.ammVaultRaw, true) && validRaw(row.totalRaw, true);
      }).filter((item: CreatorFeeBalance) => BigInt(item.totalRaw) > 0n);
      setBalances(checked);
      setHolderRewardsEnabled(status.holderRewardsEnabled === true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudieron consultar las comisiones.');
    } finally { setLoading(false); }
  }, [connection, creatorAddress]);

  useEffect(() => { void refresh(); }, [refresh]);

  const verifyPending = useCallback(async (receipt: PendingClaim | null = pending) => {
    if (!receipt) return;
    setError('');
    setNotice('');
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS_HASH) throw new Error('El estado solo se verifica en Solana Devnet.');
      const response = await connection.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true });
      const status = response.value[0];
      if (status?.err) {
        savePending({ ...receipt, status: 'failed' });
        setError('La transacción terminó con error en Solana. Actualiza los saldos antes de volver a preparar el retiro.');
        await refresh();
      } else if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        savePending({ ...receipt, status: 'confirmed' });
        setNotice('El retiro quedó confirmado en Devnet.');
        await refresh();
      } else {
        const height = await connection.getBlockHeight('confirmed');
        if (!status && height > receipt.lastValidBlockHeight) {
          savePending({ ...receipt, status: 'expired' });
          setNotice('El blockhash venció y RPC no encuentra una transacción confirmada. Actualiza los saldos antes de preparar otra.');
          await refresh();
        } else {
          savePending({ ...receipt, status: 'pending' });
          setNotice('La firma sigue pendiente en RPC. Wire no volverá a enviarla automáticamente.');
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo comprobar el estado de la firma.');
    }
  }, [connection, pending, refresh]);

  const prepareClaim = async (quote: CreatorFeeBalance) => {
    if (pending?.status === 'pending') return;
    const chosenWalletExists = creatorAddress === connectedAddress || vaultWallets.some((wallet) => wallet.address === creatorAddress);
    if (!chosenWalletExists) {
      setError('Selecciona una wallet conectada o una wallet de la bóveda.');
      return;
    }
    setPreparingMint(quote.mint);
    setError('');
    setNotice('');
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('El retiro solo está disponible en Solana Devnet.');
      const api = process.env.NEXT_PUBLIC_API_URL || '';
      const response = await fetch(`${api}/api/pump/creator-fees/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creator: creatorAddress, quoteMint: quote.mint }),
      });
      const data = await response.json() as Partial<PreparedClaim> & { success?: boolean; error?: string; network?: string };
      if (!response.ok || data.success !== true || data.network !== 'devnet') throw new Error(data.error || 'No se pudo preparar el retiro.');
      const prepared = data as PreparedClaim;
      if (prepared.creator !== creatorAddress || prepared.quoteMint !== quote.mint
        || !validRaw(prepared.amountRaw) || !validRaw(prepared.pumpAmountRaw, true) || !validRaw(prepared.pumpSwapAmountRaw, true)
        || !Number.isSafeInteger(prepared.estimatedNetworkFeeLamports) || prepared.estimatedNetworkFeeLamports < 0
        || !Number.isSafeInteger(prepared.estimatedRentLamports) || prepared.estimatedRentLamports < 0
        || typeof prepared.transaction !== 'string' || typeof prepared.transactionMessageHash !== 'string'
        || !Number.isSafeInteger(prepared.lastValidBlockHeight)) throw new Error('La respuesta de preparación está incompleta o no coincide con el saldo revisado.');
      const transaction = Transaction.from(base64Bytes(prepared.transaction));
      const creator = new PublicKey(creatorAddress);
      validateClaimTransaction(transaction, creator, prepared);
      const messageHash = await sha256Hex(transaction.serializeMessage());
      if (messageHash !== prepared.transactionMessageHash) throw new Error('La transacción cambió después de prepararse. No se solicitó la firma.');
      const latestHeight = await connection.getBlockHeight('confirmed');
      if (transaction.recentBlockhash !== prepared.blockhash || latestHeight > prepared.lastValidBlockHeight) throw new Error('El blockhash venció. Actualiza los saldos y vuelve a preparar el retiro.');

      setClaimReview({ balance: quote, prepared });
      setNotice('Revisa el importe, el origen de los fees y el coste de red. La transacción todavía no se ha firmado ni enviado.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo preparar el retiro.');
    } finally { setPreparingMint(null); }
  };

  const signAndSendClaim = async () => {
    if (!claimReview || pending?.status === 'pending') return;
    const { balance: quote, prepared } = claimReview;
    const chosenIsConnected = creatorAddress === connectedAddress && publicKey?.toBase58() === creatorAddress && Boolean(signTransaction);
    const chosenVault = vaultWallets.some((wallet) => wallet.address === creatorAddress);
    if (!chosenIsConnected && !(chosenVault && session && !session.isLocked)) {
      setError('Conecta la wallet elegida o desbloquea la bóveda para firmar esta operación.');
      return;
    }
    setPreparingMint(quote.mint);
    setError('');
    try {
      if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('El retiro solo está disponible en Solana Devnet.');
      const transaction = Transaction.from(base64Bytes(prepared.transaction));
      const creator = new PublicKey(creatorAddress);
      validateClaimTransaction(transaction, creator, prepared);
      if (await sha256Hex(transaction.serializeMessage()) !== prepared.transactionMessageHash) throw new Error('La transacción cambió después de prepararse. No se solicitó la firma.');
      if (await connection.getBlockHeight('confirmed') > prepared.lastValidBlockHeight) throw new Error('El blockhash venció. Actualiza los saldos y vuelve a preparar el retiro.');
      const signed = chosenIsConnected
        ? await signTransaction!(transaction)
        : await session!.signTransaction(creatorAddress, transaction);
      if (!signed.feePayer?.equals(creator) || signed.recentBlockhash !== prepared.blockhash
        || await sha256Hex(signed.serializeMessage()) !== prepared.transactionMessageHash) {
        throw new Error('La wallet cambió la transacción revisada. No se enviará.');
      }
      const signatureBytes = signed.signatures.find((entry) => entry.publicKey.equals(creator))?.signature;
      if (!signatureBytes) throw new Error('La wallet no devolvió la firma requerida.');
      const signature = bs58.encode(signatureBytes);
      const receipt: PendingClaim = {
        signature,
        creator: creatorAddress,
        quoteMint: quote.mint,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        status: 'pending',
        createdAt: Date.now(),
      };
      if (!savePending(receipt)) {
        setNotice('El navegador no pudo guardar la firma pendiente, así que Wire no envió la transacción. Mantén esta pestaña abierta y copia la firma antes de salir.');
        return;
      }
      setClaimReview(null);
      try {
        const sentSignature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
        if (sentSignature !== signature) throw new Error('RPC devolvió una firma distinta; verifica el estado antes de intentar otra operación.');
        await connection.confirmTransaction({ signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, 'confirmed');
      } catch {
        setNotice('La firma ya está guardada. Comprueba su estado antes de preparar otro retiro; Wire no la reenviará automáticamente.');
        return;
      }
      await verifyPending(receipt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo completar el retiro.');
    } finally { setPreparingMint(null); }
  };

  return (
    <section className="wire-panel mt-6 rounded-2xl p-4 sm:p-6" aria-labelledby="pump-creator-fees-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] text-[var(--wire-green)]"><CircleDollarSign size={18} aria-hidden="true" /></span>
          <div>
            <p className="wire-kicker">{t('PUMP · DEVNET')}</p>
            <h2 id="pump-creator-fees-title" className="mt-1 text-lg font-semibold">{t('Comisiones del creador')}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{t('Consulta y retira fees acumulados de Pump.fun y PumpSwap. El retiro requiere una firma de la wallet creadora que elijas.')}</p>
          </div>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || !creatorAddress} className="wire-button wire-button-secondary min-h-11 px-3 text-sm">
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />{t('Actualizar')}
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <label className="grid gap-1.5 text-xs text-[var(--muted)]">
          {t('Wallet creadora para consultar y firmar')}
          <select value={creatorAddress} onChange={(event) => { setCreatorAddress(event.target.value); setBalances([]); setClaimReview(null); setError(''); setNotice(''); }} className="wire-input min-h-11 w-full rounded-lg px-3 text-sm" disabled={!connectedAddress && vaultWallets.length === 0}>
            {connectedAddress && <option value={connectedAddress}>{t('Wallet conectada')} · {connectedAddress.slice(0, 4)}…{connectedAddress.slice(-4)}</option>}
            {vaultWallets.map((wallet) => <option key={wallet.address} value={wallet.address}>{wallet.label || t('Wallet de la bóveda')} · {wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}</option>)}
            {!connectedAddress && vaultWallets.length === 0 && <option value="">{t('Conecta una wallet o crea wallets en la bóveda')}</option>}
          </select>
        </label>
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs leading-relaxed text-[var(--muted)]">
          <div className="flex items-center gap-2 font-semibold text-[var(--text)]"><ShieldCheck size={14} className="text-[var(--wire-green)]" aria-hidden="true" />{t('Solo retiros revisables')}</div>
          <p className="mt-1">{t('Wire comprueba el saldo y la transacción. La wallet seleccionada es la única firmante; las claves de la bóveda permanecen en este navegador.')}</p>
        </div>
      </div>

      {holderRewardsEnabled === false && <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs leading-relaxed text-[var(--muted)]">{t('Holder Rewards de Pump está desactivado en Devnet. Pump distribuye esas recompensas automáticamente cuando el programa lo habilita; no existe un retiro manual desde Wire.')}</p>}
      {holderRewardsEnabled === true && <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs leading-relaxed text-[var(--muted)]">{t('Holder Rewards se distribuye automáticamente por Pump. Esta sección retira solo las comisiones del creador.')}</p>}

      {loading && <p className="mt-4 text-sm text-[var(--muted)]" role="status">{t('Consultando balances en Devnet…')}</p>}
      {!loading && !error && balances.length === 0 && creatorAddress && <p className="mt-4 rounded-lg border border-[var(--line)] p-3 text-sm text-[var(--muted)]">{t('No hay creator fees disponibles para esta wallet en Devnet.')}</p>}
      {balances.length > 0 && <ul className="mt-4 grid gap-2">{balances.map((balance) => (
        <li key={balance.mint} className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><strong className="font-mono text-base">{amountLabel(balance.totalRaw, balance.decimals)}</strong><span className="text-sm font-semibold text-[var(--wire-green)]">{balance.symbol}</span></div>
            <p className="mt-1 text-xs text-[var(--muted)]">{t('Pump.fun')}: {amountLabel(balance.pumpVaultRaw, balance.decimals)} · PumpSwap: {amountLabel(balance.ammVaultRaw, balance.decimals)}</p>
            <code className="mt-1 block truncate text-[10px] text-[var(--muted)]">{balance.mint}</code>
          </div>
          <button type="button" onClick={() => void prepareClaim(balance)} disabled={preparingMint !== null || pending?.status === 'pending'} className="wire-button wire-button-primary min-h-11 px-4 text-sm">
            {preparingMint === balance.mint ? t('Preparando y esperando firma…') : t('Revisar y retirar')}
          </button>
        </li>
      ))}</ul>}

      {claimReview && <div className="mt-4 rounded-xl border border-[var(--wire-green)]/40 bg-[var(--surface-2)] p-4" aria-labelledby="pump-claim-review-title">
        <h3 id="pump-claim-review-title" className="font-semibold">{t('Revisa el retiro antes de firmar')}</h3>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-[var(--muted)]">{t('Wallet creadora')}</dt><dd className="break-all font-mono text-xs">{claimReview.prepared.creator}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">{t('Total estimado')}</dt><dd className="font-mono">{amountLabel(claimReview.prepared.amountRaw, claimReview.prepared.decimals)} {claimReview.balance.symbol}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">{t('Pump.fun / PumpSwap')}</dt><dd className="font-mono text-xs">{amountLabel(claimReview.prepared.pumpAmountRaw, claimReview.prepared.decimals)} / {amountLabel(claimReview.prepared.pumpSwapAmountRaw, claimReview.prepared.decimals)} {claimReview.balance.symbol}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">{t('Fee de red estimado')}</dt><dd className="font-mono">{(claimReview.prepared.estimatedNetworkFeeLamports / 1_000_000_000).toFixed(9)} SOL</dd></div>
          {claimReview.prepared.estimatedRentLamports > 0 && <div><dt className="text-xs text-[var(--muted)]">{t('Reserva de cuenta estimada')}</dt><dd className="font-mono">{(claimReview.prepared.estimatedRentLamports / 1_000_000_000).toFixed(9)} SOL</dd></div>}
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">{t('Al continuar, solo la wallet creadora seleccionada firmará esta transacción de Devnet. Comprueba también los detalles que muestre Phantom.')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => void signAndSendClaim()} disabled={preparingMint !== null} className="wire-button wire-button-primary min-h-11 px-4 text-sm">{preparingMint === claimReview.balance.mint ? t('Esperando firma…') : t('Firmar y retirar')}</button>
          <button type="button" onClick={() => { setClaimReview(null); setNotice(''); }} disabled={preparingMint !== null} className="wire-button wire-button-secondary min-h-11 px-4 text-sm">{t('Cancelar revisión')}</button>
        </div>
      </div>}

      {pending && <div className="mt-4 rounded-xl border border-[var(--line)] p-3 text-sm">
        <p className="font-semibold">{t(pending.status === 'confirmed' ? 'Retiro confirmado' : pending.status === 'failed' ? 'Retiro fallido' : pending.status === 'expired' ? 'Transacción vencida' : 'Firma pendiente de verificar')}</p>
        <code className="mt-1 block break-all text-[10px] text-[var(--muted)]">{pending.creator}</code>
        <code className="mt-1 block break-all text-[10px] text-[var(--muted)]">{pending.signature}</code>
        <a href={`https://explorer.solana.com/tx/${encodeURIComponent(pending.signature)}?cluster=devnet`} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-xs text-[var(--wire-green)] underline">{t('Ver firma en Explorer')}</a>
        {pending.status === 'pending' && <button type="button" onClick={() => void verifyPending()} className="wire-button wire-button-secondary ml-3 min-h-11 px-3 text-xs">{t('Verificar estado')}</button>}
        {pending.status !== 'pending' && <button type="button" onClick={() => savePending(null)} className="wire-button wire-button-secondary ml-3 min-h-11 px-3 text-xs">{t('Cerrar estado')}</button>}
      </div>}
      {error && <p className="mt-3 text-sm text-[var(--danger,#ff8b8b)]" role="alert">{t(error)}</p>}
      {notice && <p className="mt-3 text-sm text-[var(--wire-green)]" role="status" aria-live="polite">{t(notice)}</p>}
    </section>
  );
}
