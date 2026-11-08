import { createHash } from 'node:crypto';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { ClmmConfigLayout, PoolInfoLayout } from '@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout';
import {
  DEV_CREATE_CPMM_POOL_PROGRAM,
  DEVNET_PROGRAM_ID,
  fixedSwapInLayout,
  fixedSwapOutLayout,
  liquidityStateV4Layout,
  liquidityStateV5Layout,
} from '@raydium-io/raydium-sdk-v2';
import bs58 from 'bs58';
import { bondingCurvePda, PUMP_PROGRAM_ID, PUMP_SDK, pumpIdl } from '@pump-fun/pump-sdk';
import {
  canonicalPumpPoolPda,
  isPumpPool,
  OFFLINE_PUMP_AMM_PROGRAM,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
} from '@pump-fun/pump-swap-sdk';
import { QUOTE_ASSETS } from './poolQuoteAsset';
import { PublicError } from '../utils/publicError';

type SwapSide = 'buy' | 'sell';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_DEVNET_CLMM_PROGRAM_ID = new PublicKey('DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const CLMM_SWAP_DISCRIMINATOR = createHash('sha256').update('global:swap').digest().subarray(0, 8);
const CLMM_POOL_STATE_DISCRIMINATOR = createHash('sha256').update('account:PoolState').digest().subarray(0, 8);
const CLMM_CONFIG_STATE_DISCRIMINATOR = createHash('sha256').update('account:AmmConfig').digest().subarray(0, 8);
const SWAP_EVENT_DISCRIMINATOR = createHash('sha256').update('event:SwapEvent').digest().subarray(0, 8);
const PUMP_TRADE_EVENT_DISCRIMINATOR = Buffer.from(
  (pumpIdl as unknown as { events: Array<{ name: string; discriminator: number[] }> })
    .events.find((event) => event.name === 'TradeEvent')?.discriminator ?? [],
);

type RaydiumSwapEvent = {
  poolAddress: string;
  inputAmount: bigint;
  outputAmount: bigint;
  inputTransferFee: bigint;
  outputTransferFee: bigint;
  baseInput: boolean;
  inputMint: string | null;
  outputMint: string | null;
};

function decodeSwapEvent(data: Buffer): RaydiumSwapEvent | null {
  if (data.length < SWAP_EVENT_DISCRIMINATOR.length
    || !data.subarray(0, SWAP_EVENT_DISCRIMINATOR.length).equals(SWAP_EVENT_DISCRIMINATOR)) return null;
  // Devnet's CPMM deployment still emits the legacy 89-byte event. Newer
  // deployments append input/output mints and fee details (170 bytes).
  if (data.length !== 89 && data.length !== 170) throw new Error('Raydium returned an unsupported swap event layout.');

  let offset = 8;
  const readKey = () => {
    const key = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return key;
  };
  const readU64 = () => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };

  const poolAddress = readKey();
  readU64(); // Input vault balance before the swap.
  readU64(); // Output vault balance before the swap.
  const inputAmount = readU64();
  const outputAmount = readU64();
  const inputTransferFee = readU64();
  const outputTransferFee = readU64();
  const baseInputByte = data[offset++];
  if (baseInputByte !== 0 && baseInputByte !== 1) throw new Error('Raydium returned an invalid swap direction.');
  let inputMint: string | null = null;
  let outputMint: string | null = null;
  if (data.length === 170) {
    inputMint = readKey();
    outputMint = readKey();
    readU64(); // Trade fee.
    readU64(); // Creator fee.
    const creatorFeeOnInputByte = data[offset++];
    if (creatorFeeOnInputByte !== 0 && creatorFeeOnInputByte !== 1) throw new Error('Raydium returned an invalid creator fee mode.');
  }
  if (offset !== data.length) throw new Error('Raydium returned an invalid swap event length.');

  return {
    poolAddress,
    inputAmount,
    outputAmount,
    inputTransferFee,
    outputTransferFee,
    baseInput: baseInputByte === 1,
    inputMint,
    outputMint,
  };
}

function readRaydiumSwapEvents(logMessages: string[] | null | undefined): RaydiumSwapEvent[] {
  if (!logMessages) return [];
  const programStack: string[] = [];
  const events: RaydiumSwapEvent[] = [];
  const raydiumProgramId = DEV_CREATE_CPMM_POOL_PROGRAM.toBase58();

  for (const line of logMessages) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      programStack.length = Math.max(0, depth - 1);
      programStack.push(invoke[1]);
      continue;
    }

    const finished = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed(?::.*)?)$/.exec(line);
    if (finished) {
      const index = programStack.lastIndexOf(finished[1]);
      if (index >= 0) programStack.length = index;
      continue;
    }

    if (programStack[programStack.length - 1] !== raydiumProgramId || !line.startsWith('Program data: ')) continue;
    const encodedValues = line.slice('Program data: '.length).trim().split(/\s+/).filter(Boolean);
    for (const encoded of encodedValues) {
      const payload = Buffer.from(encoded, 'base64');
      const event = decodeSwapEvent(payload);
      if (event) events.push(event);
    }
  }

  return events;
}

function keyString(value: unknown): string | null {
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof value === 'object' && 'toBase58' in value && typeof value.toBase58 === 'function') {
    return value.toBase58();
  }
  return typeof value === 'string' ? value : null;
}

function instructionCallsPoolSwap(instruction: unknown, poolAddress: string, expectedMints: string[]): boolean {
  if (!instruction || typeof instruction !== 'object') return false;
  const candidate = instruction as { programId?: unknown; accounts?: unknown[] };
  if (keyString(candidate.programId) !== DEV_CREATE_CPMM_POOL_PROGRAM.toBase58()) return false;
  if (!Array.isArray(candidate.accounts)) return false;
  const accountKeys = new Set(candidate.accounts.map(keyString).filter((key): key is string => key !== null));
  return accountKeys.has(poolAddress) && expectedMints.every((mint) => accountKeys.has(mint));
}

export type VerifiedSwap = {
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  quoteMint: string;
  quoteDecimals: number;
  solAmountLamports: bigint | null;
  tokenDecimals: number;
  slot: bigint;
  blockTime: Date | null;
  networkFeeLamports: bigint;
};

export type VerifiedPumpSwap = VerifiedSwap & {
  venue: 'PUMP_FUN' | 'PUMP_SWAP';
  marketAddress: string;
};

export type VerifiedRaydiumAmmSwap = VerifiedSwap & {
  venue: 'RAYDIUM_AMM_V4' | 'RAYDIUM_AMM_STABLE';
  marketAddress: string;
};

export type VerifiedRaydiumClmmSwap = VerifiedSwap & {
  venue: 'RAYDIUM_CLMM';
  marketAddress: string;
};

async function getConfirmedParsedSwap(connection: Connection, signature: string) {
  return connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
}

type ConfirmedParsedSwap = NonNullable<Awaited<ReturnType<typeof getConfirmedParsedSwap>>>;

export async function verifyConfirmedRaydiumSwap(
  connection: Connection,
  signature: string,
  userWallet: string,
  mintAddress: string,
  quoteMint: string,
  poolAddress: string,
  side: SwapSide,
  confirmedTransaction?: ConfirmedParsedSwap,
): Promise<VerifiedSwap | null> {
  if (side !== 'buy' && side !== 'sell') throw new Error('The selected swap direction is invalid.');
  const transaction = confirmedTransaction ?? await connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const quoteAsset = Object.values(QUOTE_ASSETS).find((asset) => asset.mintAddress === quoteMint);
  if (!quoteAsset) throw new Error('This pool uses an unsupported quote asset.');
  if (!transaction) return null;

  const { meta } = transaction;
  if (!meta || meta.err) throw new Error('The Solana transaction did not complete successfully.');
  if (!transaction.transaction.signatures.includes(signature)) throw new Error('The signature does not match the fetched transaction.');

  const walletSigned = transaction.transaction.message.accountKeys.some((account) =>
    account.signer && account.pubkey.toBase58() === userWallet,
  );
  if (!walletSigned) throw new Error('The wallet did not sign this transaction.');

  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  const cpmmInstructions = instructions.filter((instruction) => {
    if (!instruction || typeof instruction !== 'object') return false;
    return keyString((instruction as { programId?: unknown }).programId) === DEV_CREATE_CPMM_POOL_PROGRAM.toBase58();
  });
  if (cpmmInstructions.length !== 1 || !instructionCallsPoolSwap(cpmmInstructions[0], poolAddress, [quoteMint, mintAddress])) {
    throw new Error('The transaction does not contain a swap for this Raydium pool.');
  }
  const swapEvents = readRaydiumSwapEvents(meta.logMessages);
  if (swapEvents.length !== 1 || swapEvents[0].poolAddress !== poolAddress) {
    throw new Error('The confirmed Raydium swap event could not be uniquely verified.');
  }
  const swapEvent = swapEvents[0];
  const expectedInputMint = side === 'buy' ? quoteMint : mintAddress;
  const expectedOutputMint = side === 'buy' ? mintAddress : quoteMint;
  if (!swapEvent.baseInput
    || (swapEvent.inputMint !== null && swapEvent.inputMint !== expectedInputMint)
    || (swapEvent.outputMint !== null && swapEvent.outputMint !== expectedOutputMint)) {
    throw new Error('The confirmed swap event does not match the selected token and direction.');
  }

  const balances = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]
    .filter((balance) => balance.mint === mintAddress);
  if (balances.length === 0 || balances.some((balance) => !balance.owner)) {
    throw new Error('Solana did not return enough token balance details to verify this swap.');
  }

  const before = new Map<number, bigint>();
  const after = new Map<number, bigint>();
  let tokenDecimals: number | null = null;
  for (const balance of meta.preTokenBalances ?? []) {
    if (balance.mint !== mintAddress || balance.owner !== userWallet) continue;
    before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    tokenDecimals = balance.uiTokenAmount.decimals;
  }
  for (const balance of meta.postTokenBalances ?? []) {
    if (balance.mint !== mintAddress || balance.owner !== userWallet) continue;
    after.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    tokenDecimals = balance.uiTokenAmount.decimals;
  }

  const accountIndexes = new Set([...before.keys(), ...after.keys()]);
  let tokenDelta = 0n;
  for (const accountIndex of accountIndexes) {
    tokenDelta += (after.get(accountIndex) ?? 0n) - (before.get(accountIndex) ?? 0n);
  }
  if (tokenDelta === 0n || (side === 'buy' && tokenDelta < 0n) || (side === 'sell' && tokenDelta > 0n)) {
    throw new Error('The verified token balance change does not match the selected swap direction.');
  }
  if (tokenDecimals === null || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    throw new Error('The token precision could not be verified.');
  }
  const expectedTokenAmount = side === 'buy'
    ? swapEvent.outputAmount - swapEvent.outputTransferFee
    : swapEvent.inputAmount + swapEvent.inputTransferFee;
  if (expectedTokenAmount <= 0n || tokenDelta !== (side === 'buy' ? expectedTokenAmount : -expectedTokenAmount)) {
    throw new Error('The wallet token balance change does not match Raydium’s confirmed swap event.');
  }
  const expectedQuoteAmount = side === 'buy'
    ? swapEvent.inputAmount + swapEvent.inputTransferFee
    : swapEvent.outputAmount - swapEvent.outputTransferFee;
  if (expectedQuoteAmount <= 0n) throw new Error('The confirmed quote-asset amount is invalid.');
  if (quoteMint !== SOL_MINT) {
    const quoteBalances = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]
      .filter((balance) => balance.mint === quoteMint);
    if (quoteBalances.length === 0 || quoteBalances.some((balance) => !balance.owner)) {
      throw new Error('Solana did not return enough quote-token balance details to verify this swap.');
    }
    const quoteBefore = new Map<number, bigint>();
    const quoteAfter = new Map<number, bigint>();
    for (const balance of meta.preTokenBalances ?? []) {
      if (balance.mint === quoteMint && balance.owner === userWallet) quoteBefore.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    }
    for (const balance of meta.postTokenBalances ?? []) {
      if (balance.mint === quoteMint && balance.owner === userWallet) quoteAfter.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    }
    const quoteIndexes = new Set([...quoteBefore.keys(), ...quoteAfter.keys()]);
    let quoteDelta = 0n;
    for (const accountIndex of quoteIndexes) quoteDelta += (quoteAfter.get(accountIndex) ?? 0n) - (quoteBefore.get(accountIndex) ?? 0n);
    if (quoteDelta !== (side === 'buy' ? -expectedQuoteAmount : expectedQuoteAmount)) {
      throw new Error('The wallet quote-token balance change does not match Raydium’s confirmed swap event.');
    }
    const decimals = quoteBalances.find((balance) => balance.owner === userWallet)?.uiTokenAmount.decimals;
    if (decimals !== quoteAsset.decimals) throw new Error('The quote-token precision could not be verified.');
  }
  const solAmountLamports = quoteMint === SOL_MINT ? expectedQuoteAmount : null;
  if (quoteMint === SOL_MINT) {
    const solTransferFee = side === 'buy' ? swapEvent.inputTransferFee : swapEvent.outputTransferFee;
    if (solTransferFee !== 0n) throw new Error('The SOL transfer fee could not be verified.');
  }
  if (!Number.isSafeInteger(meta.fee) || meta.fee < 0) throw new Error('The network fee could not be verified.');

  return {
    tokenAmountRaw: tokenDelta < 0n ? -tokenDelta : tokenDelta,
    quoteAmountRaw: expectedQuoteAmount,
    quoteMint,
    quoteDecimals: quoteAsset.decimals,
    solAmountLamports,
    tokenDecimals,
    slot: BigInt(transaction.slot),
    blockTime: transaction.blockTime == null ? null : new Date(transaction.blockTime * 1000),
    networkFeeLamports: BigInt(meta.fee),
  };
}

async function verifyConfirmedRaydiumAmmSwap(
  connection: Connection,
  transaction: ConfirmedParsedSwap,
  signature: string,
  userWallet: string,
  mintAddress: string,
  side: SwapSide,
  market: { venue: 'RAYDIUM_AMM_V4' | 'RAYDIUM_AMM_STABLE'; programId: PublicKey; isStable: boolean },
): Promise<VerifiedRaydiumAmmSwap> {
  const { meta } = transaction;
  if (!meta || meta.err) throw new PublicError('La transacción de Solana no se completó correctamente.', 422);
  if (!transaction.transaction.signatures.includes(signature)) {
    throw new PublicError('La firma no coincide con la transacción consultada.', 422);
  }
  if (!transaction.transaction.message.accountKeys.some((account) =>
    account.signer && account.pubkey.toBase58() === userWallet,
  )) {
    throw new PublicError('La wallet no firmó esta transacción.', 422);
  }

  const allInstructions = [
    ...transaction.transaction.message.instructions,
    ...(meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  const ammProgramId = market.programId.toBase58();
  const ammInstructions = allInstructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === ammProgramId,
  );
  const topLevelAmmInstructions = transaction.transaction.message.instructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === ammProgramId,
  );
  if (ammInstructions.length !== 1 || topLevelAmmInstructions.length !== 1) {
    throw new PublicError('La firma no contiene un único swap directo verificable de este mercado Raydium.', 422);
  }
  if (allInstructions.some((instruction) => {
    const programId = keyString((instruction as { programId?: unknown }).programId);
    return (programId === DEVNET_PROGRAM_ID.AmmV4.toBase58() && programId !== ammProgramId)
      || (programId === DEVNET_PROGRAM_ID.AmmStable.toBase58() && programId !== ammProgramId)
      || programId === DEV_CREATE_CPMM_POOL_PROGRAM.toBase58()
      || programId === PUMP_PROGRAM_ID.toBase58()
      || programId === PUMP_AMM_PROGRAM_ID.toBase58();
  })) {
    throw new PublicError('No se pueden importar transacciones que mezclen mercados en una sola operación.', 422);
  }

  const instruction = topLevelAmmInstructions[0] as { accounts?: unknown[]; data?: unknown };
  if (!Array.isArray(instruction.accounts)
    || (market.isStable ? instruction.accounts.length !== 19 : ![17, 18].includes(instruction.accounts.length))
    || typeof instruction.data !== 'string') {
    throw new PublicError('La instrucción Raydium no usa el formato directo admitido.', 422);
  }
  let instructionData: Buffer;
  try {
    instructionData = Buffer.from(bs58.decode(instruction.data));
  } catch {
    throw new PublicError('No se pudo decodificar la instrucción Raydium.', 422);
  }
  if (instructionData.length !== fixedSwapInLayout.span || (instructionData[0] !== 9 && instructionData[0] !== 11)) {
    throw new PublicError('La instrucción Raydium no es un swap exact-in o exact-out compatible.', 422);
  }

  const includesTargetOrders = !market.isStable && instruction.accounts.length === 18;
  const sourceTokenAccountIndex = market.isStable ? 16 : includesTargetOrders ? 15 : 14;
  const destinationTokenAccountIndex = market.isStable ? 17 : includesTargetOrders ? 16 : 15;
  const walletIndex = market.isStable ? 18 : includesTargetOrders ? 17 : 16;
  const poolAddress = keyString(instruction.accounts[1]);
  const openOrders = keyString(instruction.accounts[3]);
  const targetOrders = includesTargetOrders || market.isStable ? keyString(instruction.accounts[4]) : null;
  const modelDataAccount = market.isStable ? keyString(instruction.accounts[7]) : null;
  const baseVault = keyString(instruction.accounts[market.isStable || includesTargetOrders ? 5 : 4]);
  const quoteVault = keyString(instruction.accounts[market.isStable || includesTargetOrders ? 6 : 5]);
  const marketProgramId = keyString(instruction.accounts[market.isStable ? 8 : includesTargetOrders ? 7 : 6]);
  const marketId = keyString(instruction.accounts[market.isStable ? 9 : includesTargetOrders ? 8 : 7]);
  const sourceTokenAccount = keyString(instruction.accounts[sourceTokenAccountIndex]);
  const destinationTokenAccount = keyString(instruction.accounts[destinationTokenAccountIndex]);
  const instructionWallet = keyString(instruction.accounts[walletIndex]);
  if (!poolAddress || !openOrders || !baseVault || !quoteVault
    || !marketProgramId || !marketId || !sourceTokenAccount || !destinationTokenAccount
    || (market.isStable && !modelDataAccount) || instructionWallet !== userWallet) {
    throw new PublicError('La instrucción Raydium no identifica la pool y las cuentas de esta wallet.', 422);
  }

  const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddress), 'confirmed');
  const stateLayout = market.isStable ? liquidityStateV5Layout : liquidityStateV4Layout;
  if (!poolInfo || !poolInfo.owner.equals(market.programId) || poolInfo.data.length !== stateLayout.span) {
    throw new PublicError('La cuenta de mercado no es una pool Raydium válida de Devnet.', 422);
  }
  let poolState: ReturnType<typeof liquidityStateV4Layout.decode> | ReturnType<typeof liquidityStateV5Layout.decode>;
  let stableModelDataAddress: string | null = null;
  if (market.isStable) {
    const stablePoolState = liquidityStateV5Layout.decode(poolInfo.data);
    poolState = stablePoolState;
    stableModelDataAddress = stablePoolState.modelDataAccount.toBase58();
  } else {
    poolState = liquidityStateV4Layout.decode(poolInfo.data);
  }
  const baseMint = poolState.baseMint.toBase58();
  const poolQuoteMint = poolState.quoteMint.toBase58();
  const canonicalMint = new PublicKey(mintAddress).toBase58();
  const tokenIsBase = baseMint === canonicalMint;
  const quoteMint = tokenIsBase ? poolQuoteMint : baseMint;
  const quoteAsset = Object.values(QUOTE_ASSETS).find((asset) => asset.mintAddress === quoteMint);
  if ((!tokenIsBase && poolQuoteMint !== canonicalMint) || !quoteAsset || quoteMint === canonicalMint) {
    throw new PublicError('La pool AMM V4 no contiene el token y un activo de cotización admitido.', 422);
  }
  if (openOrders !== poolState.openOrders.toBase58()
    || (targetOrders !== null && targetOrders !== poolState.targetOrders.toBase58())
    || (market.isStable && modelDataAccount !== stableModelDataAddress)
    || baseVault !== poolState.baseVault.toBase58()
    || quoteVault !== poolState.quoteVault.toBase58()
    || marketProgramId !== poolState.marketProgramId.toBase58()
    || marketId !== poolState.marketId.toBase58()) {
    throw new PublicError('Las cuentas de la instrucción no coinciden con el estado confirmado de la pool.', 422);
  }

  const accountKeys = transaction.transaction.message.accountKeys.map((account) => account.pubkey.toBase58());
  const sourceIndex = accountKeys.indexOf(sourceTokenAccount);
  const destinationIndex = accountKeys.indexOf(destinationTokenAccount);
  if (sourceIndex < 0 || destinationIndex < 0 || sourceIndex === destinationIndex
    || accountKeys.lastIndexOf(sourceTokenAccount) !== sourceIndex
    || accountKeys.lastIndexOf(destinationTokenAccount) !== destinationIndex) {
    throw new PublicError('No se pudieron asociar las cuentas de tokens del swap con los metadatos de la transacción.', 422);
  }

  const preTokenBalances = meta.preTokenBalances ?? [];
  const postTokenBalances = meta.postTokenBalances ?? [];
  const tokenBalances = [...preTokenBalances, ...postTokenBalances];
  const tokenAccountMint = (accountIndex: number): string => {
    const records = tokenBalances.filter((balance) => balance.accountIndex === accountIndex);
    const mints = [...new Set(records.map((balance) => balance.mint))];
    if (records.length === 0 || mints.length !== 1 || records.some((balance) => balance.owner !== userWallet)) {
      throw new PublicError('Solana no devolvió los metadatos de las cuentas de tokens de la wallet.', 422);
    }
    return mints[0];
  };
  const sourceMint = tokenAccountMint(sourceIndex);
  const destinationMint = tokenAccountMint(destinationIndex);
  if (sourceMint === destinationMint
    || (side === 'buy' && (sourceMint !== quoteMint || destinationMint !== canonicalMint))
    || (side === 'sell' && (sourceMint !== canonicalMint || destinationMint !== quoteMint))) {
    throw new PublicError('Los lados de entrada y salida no coinciden con el token y la dirección seleccionados.', 422);
  }

  const balanceDelta = (accountIndex: number, mint: string): { delta: bigint; decimals: number } => {
    const before = preTokenBalances.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    const after = postTokenBalances.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    const record = after ?? before;
    if (!record || record.owner !== userWallet || (before && before.owner !== userWallet) || (after && after.owner !== userWallet)) {
      throw new PublicError('No se pudo confirmar el cambio de balance de la wallet.', 422);
    }
    if (before && after && before.uiTokenAmount.decimals !== after.uiTokenAmount.decimals) {
      throw new PublicError('La precisión del token cambió entre los balances de la transacción.', 422);
    }
    return {
      delta: BigInt(after?.uiTokenAmount.amount ?? '0') - BigInt(before?.uiTokenAmount.amount ?? '0'),
      decimals: record.uiTokenAmount.decimals,
    };
  };
  const walletBalanceDelta = (mint: string): { delta: bigint; decimals: number } => {
    const records = tokenBalances.filter((balance) => balance.mint === mint);
    if (records.length === 0 || records.some((balance) => !balance.owner)) {
      throw new PublicError('Solana no devolvió balances suficientes para verificar el swap.', 422);
    }
    const before = new Map<number, bigint>();
    const after = new Map<number, bigint>();
    const decimals = new Set<number>();
    for (const balance of preTokenBalances) {
      if (balance.mint === mint && balance.owner === userWallet) {
        before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
        decimals.add(balance.uiTokenAmount.decimals);
      }
    }
    for (const balance of postTokenBalances) {
      if (balance.mint === mint && balance.owner === userWallet) {
        after.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
        decimals.add(balance.uiTokenAmount.decimals);
      }
    }
    if (decimals.size !== 1) throw new PublicError('No se pudo confirmar la precisión del token.', 422);
    const indexes = new Set([...before.keys(), ...after.keys()]);
    let delta = 0n;
    for (const index of indexes) delta += (after.get(index) ?? 0n) - (before.get(index) ?? 0n);
    return { delta, decimals: [...decimals][0] };
  };

  const sourceDelta = balanceDelta(sourceIndex, sourceMint);
  const destinationDelta = balanceDelta(destinationIndex, destinationMint);
  const tokenDelta = walletBalanceDelta(canonicalMint);
  const quoteDelta = walletBalanceDelta(quoteMint);
  const expectedTokenDelta = side === 'buy' ? destinationDelta.delta : sourceDelta.delta;
  const expectedQuoteDelta = side === 'buy' ? sourceDelta.delta : destinationDelta.delta;
  if (tokenDelta.delta !== expectedTokenDelta || quoteDelta.delta !== expectedQuoteDelta
    || (side === 'buy' && (tokenDelta.delta <= 0n || quoteDelta.delta >= 0n))
    || (side === 'sell' && (tokenDelta.delta >= 0n || quoteDelta.delta <= 0n))) {
    throw new PublicError('Los cambios netos de balance de la wallet no coinciden con un swap único.', 422);
  }

  const tokenDecimals = tokenIsBase ? poolState.baseDecimal.toNumber() : poolState.quoteDecimal.toNumber();
  const quoteDecimals = tokenIsBase ? poolState.quoteDecimal.toNumber() : poolState.baseDecimal.toNumber();
  if (tokenDelta.decimals !== tokenDecimals || quoteDelta.decimals !== quoteDecimals
    || quoteDecimals !== quoteAsset.decimals) {
    throw new PublicError('La precisión de los tokens no coincide con el estado de la pool de Devnet.', 422);
  }

  const inputAmount = instructionData[0] === 9
    ? BigInt(fixedSwapInLayout.decode(instructionData).amountIn.toString())
    : BigInt(fixedSwapOutLayout.decode(instructionData).maxAmountIn.toString());
  const outputAmount = instructionData[0] === 9
    ? BigInt(fixedSwapInLayout.decode(instructionData).minAmountOut.toString())
    : BigInt(fixedSwapOutLayout.decode(instructionData).amountOut.toString());
  const actualInput = sourceDelta.delta < 0n ? -sourceDelta.delta : sourceDelta.delta;
  const actualOutput = destinationDelta.delta < 0n ? -destinationDelta.delta : destinationDelta.delta;
  if (inputAmount <= 0n || outputAmount <= 0n
    || (instructionData[0] === 9 && (actualInput !== inputAmount || actualOutput < outputAmount))
    || (instructionData[0] === 11 && (actualInput > inputAmount || actualOutput !== outputAmount))) {
    throw new PublicError('Los balances confirmados no cumplen los importes exact-in/exact-out de Raydium.', 422);
  }
  if (!Number.isSafeInteger(meta.fee) || meta.fee < 0) {
    throw new PublicError('No se pudo confirmar el fee de red de la transacción.', 422);
  }

  const quoteAmountRaw = quoteDelta.delta < 0n ? -quoteDelta.delta : quoteDelta.delta;
  if (quoteAmountRaw <= 0n) throw new PublicError('El monto de cotización confirmado no es válido.', 422);
  return {
    venue: market.venue,
    marketAddress: poolAddress,
    tokenAmountRaw: tokenDelta.delta < 0n ? -tokenDelta.delta : tokenDelta.delta,
    quoteAmountRaw,
    quoteMint,
    quoteDecimals,
    solAmountLamports: quoteMint === SOL_MINT ? quoteAmountRaw : null,
    tokenDecimals,
    slot: BigInt(transaction.slot),
    blockTime: transaction.blockTime == null ? null : new Date(transaction.blockTime * 1000),
    networkFeeLamports: BigInt(meta.fee),
  };
}

async function verifyConfirmedPumpCurveSwap(
  connection: Connection,
  signature: string,
  userWallet: string,
  mintAddress: string,
  curveAddress: string,
  side: SwapSide,
  confirmedTransaction?: ConfirmedParsedSwap,
): Promise<VerifiedSwap | null> {
  if (side !== 'buy' && side !== 'sell') throw new Error('The selected swap direction is invalid.');
  const transaction = confirmedTransaction ?? await getConfirmedParsedSwap(connection, signature);
  if (!transaction) return null;
  const { meta } = transaction;
  if (!meta || meta.err) throw new Error('The Solana transaction did not complete successfully.');
  if (!transaction.transaction.signatures.includes(signature)) throw new Error('The signature does not match the fetched transaction.');

  const walletSigned = transaction.transaction.message.accountKeys.some((account) =>
    account.signer && account.pubkey.toBase58() === userWallet,
  );
  if (!walletSigned) throw new Error('The wallet did not sign this transaction.');

  const expectedCurve = bondingCurvePda(new PublicKey(mintAddress)).toBase58();
  if (curveAddress !== expectedCurve) throw new Error('The Pump.fun bonding curve address does not match this mint.');
  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  const pumpInstructions = instructions.filter((instruction) => {
    if (!instruction || typeof instruction !== 'object') return false;
    return keyString((instruction as { programId?: unknown }).programId) === PUMP_PROGRAM_ID.toBase58();
  });
  const expectedIxName = side === 'buy' ? 'buy_v2' : 'sell_v2';
  const expectedIxDiscriminator = Buffer.from(
    (pumpIdl as unknown as { instructions: Array<{ name: string; discriminator: number[] }> })
      .instructions.find((instruction) => instruction.name === expectedIxName)?.discriminator ?? [],
  );
  const matchingInstructions = pumpInstructions.filter((instruction) => {
    const candidate = instruction as { data?: unknown; accounts?: unknown[] };
    if (typeof candidate.data !== 'string' || !Array.isArray(candidate.accounts)) return false;
    const data = Buffer.from(bs58.decode(candidate.data));
    if (!data.subarray(0, expectedIxDiscriminator.length).equals(expectedIxDiscriminator)) return false;
    const accountKeys = new Set(candidate.accounts.map(keyString).filter((key): key is string => key !== null));
    return accountKeys.has(mintAddress) && accountKeys.has(curveAddress) && accountKeys.has(userWallet);
  });
  if (pumpInstructions.length !== 1 || matchingInstructions.length !== 1) {
    throw new Error('The confirmed transaction does not contain one matching Pump.fun curve trade.');
  }

  const programStack: string[] = [];
  const tradeEvents: ReturnType<typeof PUMP_SDK.decodeTradeEventBc>[] = [];
  for (const line of meta.logMessages ?? []) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      programStack.length = Math.max(0, depth - 1);
      programStack.push(invoke[1]);
      continue;
    }
    const finished = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed(?::.*)?)$/.exec(line);
    if (finished) {
      const index = programStack.lastIndexOf(finished[1]);
      if (index >= 0) programStack.length = index;
      continue;
    }
    if (programStack[programStack.length - 1] !== PUMP_PROGRAM_ID.toBase58() || !line.startsWith('Program data: ')) continue;
    for (const encoded of line.slice('Program data: '.length).trim().split(/\s+/).filter(Boolean)) {
      const data = Buffer.from(encoded, 'base64');
      if (!data.subarray(0, 8).equals(PUMP_TRADE_EVENT_DISCRIMINATOR)) continue;
      tradeEvents.push(PUMP_SDK.decodeTradeEventBc(data.subarray(8)));
    }
  }
  const matchingEvents = tradeEvents.filter((event) =>
    event.mint.toBase58() === mintAddress &&
    event.user.toBase58() === userWallet &&
    event.isBuy === (side === 'buy'),
  );
  if (tradeEvents.length !== 1 || matchingEvents.length !== 1) {
    throw new Error('The confirmed Pump.fun trade event could not be uniquely verified.');
  }

  const event = matchingEvents[0];
  const before = new Map<number, bigint>();
  const after = new Map<number, bigint>();
  let tokenDecimals: number | null = null;
  const allTokenBalances = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]
    .filter((balance) => balance.mint === mintAddress);
  if (!allTokenBalances.length || allTokenBalances.some((balance) => !balance.owner)) {
    throw new Error('Solana did not return enough token balance details to verify this Pump.fun trade.');
  }
  for (const balance of meta.preTokenBalances ?? []) {
    if (balance.mint !== mintAddress || balance.owner !== userWallet) continue;
    before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    tokenDecimals = balance.uiTokenAmount.decimals;
  }
  for (const balance of meta.postTokenBalances ?? []) {
    if (balance.mint !== mintAddress || balance.owner !== userWallet) continue;
    after.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    tokenDecimals = balance.uiTokenAmount.decimals;
  }
  let tokenDelta = 0n;
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    tokenDelta += (after.get(index) ?? 0n) - (before.get(index) ?? 0n);
  }
  const expectedDelta = BigInt(event.tokenAmount.toString());
  if (
    tokenDecimals !== 6 ||
    expectedDelta <= 0n ||
    tokenDelta !== (side === 'buy' ? expectedDelta : -expectedDelta)
  ) {
    throw new Error('The wallet token balance change does not match Pump.fun’s confirmed trade event.');
  }

  const quoteAmount = BigInt((event.quoteAmount.isZero() ? event.solAmount : event.quoteAmount).toString());
  if (quoteAmount <= 0n || !Number.isSafeInteger(meta.fee) || meta.fee < 0) {
    throw new Error('The confirmed Pump.fun quote amount or network fee could not be verified.');
  }
  const normalizedQuoteMint = new PublicKey(event.quoteMint).equals(PublicKey.default)
    ? SOL_MINT
    : event.quoteMint.toBase58();
  if (normalizedQuoteMint !== SOL_MINT) throw new Error('This Pump.fun trade does not use the supported SOL quote asset.');

  return {
    tokenAmountRaw: expectedDelta,
    quoteAmountRaw: quoteAmount,
    quoteMint: SOL_MINT,
    quoteDecimals: 9,
    solAmountLamports: quoteAmount,
    tokenDecimals,
    slot: BigInt(transaction.slot),
    blockTime: transaction.blockTime == null ? null : new Date(transaction.blockTime * 1000),
    networkFeeLamports: BigInt(meta.fee),
  };
}

type PumpAmmTradeEvent = {
  name: 'BuyEvent' | 'SellEvent' | 'buyEvent' | 'sellEvent';
  data: Record<string, unknown>;
};

const pumpAmmCoder = OFFLINE_PUMP_AMM_PROGRAM as unknown as {
  coder: { events: { decode: (encoded: string) => PumpAmmTradeEvent | null } };
  idl: { instructions: Array<{ name: string; discriminator: number[] }> };
};

function eventValue(data: Record<string, unknown>, camelName: string, snakeName: string): unknown {
  return data[camelName] ?? data[snakeName];
}

function eventKey(data: Record<string, unknown>, camelName: string, snakeName: string): string | null {
  return keyString(eventValue(data, camelName, snakeName));
}

function eventAmount(data: Record<string, unknown>, camelName: string, snakeName: string): bigint {
  const value = eventValue(data, camelName, snakeName);
  if (value === null || value === undefined || typeof (value as { toString?: unknown }).toString !== 'function') {
    throw new Error('PumpSwap returned an incomplete trade event.');
  }
  return BigInt((value as { toString(): string }).toString());
}

function readPumpAmmTradeEvents(logMessages: string[] | null | undefined): PumpAmmTradeEvent[] {
  if (!logMessages) return [];
  const programStack: string[] = [];
  const tradeEvents: PumpAmmTradeEvent[] = [];
  const pumpAmmProgramId = PUMP_AMM_PROGRAM_ID.toBase58();

  for (const line of logMessages) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      programStack.length = Math.max(0, depth - 1);
      programStack.push(invoke[1]);
      continue;
    }
    const finished = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed(?::.*)?)$/.exec(line);
    if (finished) {
      const index = programStack.lastIndexOf(finished[1]);
      if (index >= 0) programStack.length = index;
      continue;
    }
    if (programStack[programStack.length - 1] !== pumpAmmProgramId || !line.startsWith('Program data: ')) continue;
    for (const encoded of line.slice('Program data: '.length).trim().split(/\s+/).filter(Boolean)) {
      const event = pumpAmmCoder.coder.events.decode(encoded);
      if (event && ['BuyEvent', 'SellEvent', 'buyEvent', 'sellEvent'].includes(event.name)) tradeEvents.push(event);
    }
  }

  return tradeEvents;
}

async function verifyConfirmedPumpAmmSwap(
  connection: Connection,
  transaction: ConfirmedParsedSwap,
  signature: string,
  userWallet: string,
  mintAddress: string,
  side: SwapSide,
): Promise<Omit<VerifiedPumpSwap, 'venue' | 'marketAddress'>> {
  const { meta } = transaction;
  if (!meta || meta.err) throw new Error('The Solana transaction did not complete successfully.');
  if (!transaction.transaction.signatures.includes(signature)) throw new Error('The signature does not match the fetched transaction.');
  if (!transaction.transaction.message.accountKeys.some((account) => account.signer && account.pubkey.toBase58() === userWallet)) {
    throw new Error('The wallet did not sign this transaction.');
  }

  const mint = new PublicKey(mintAddress);
  const poolAddress = canonicalPumpPoolPda(mint, new PublicKey(SOL_MINT));
  const poolAccount = await connection.getAccountInfo(poolAddress, 'confirmed');
  if (!poolAccount || !poolAccount.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    throw new Error('The canonical PumpSwap pool could not be verified on Solana.');
  }
  const pool = PUMP_AMM_SDK.decodePoolNullable(poolAccount);
  if (!pool || !isPumpPool(pool.baseMint, pool.creator) || !pool.baseMint.equals(mint) || pool.quoteMint.toBase58() !== SOL_MINT) {
    throw new Error('The PumpSwap pool does not match this token and the supported SOL quote asset.');
  }

  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  const pumpAmmInstructions = instructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === PUMP_AMM_PROGRAM_ID.toBase58(),
  );
  const expectedNames = side === 'buy'
    ? ['buyV2', 'buyExactQuoteInV2', 'buy', 'buyExactQuoteIn']
    : ['sellV2', 'sell'];
  const expectedDiscriminators = expectedNames.map((name) => Buffer.from(
    pumpAmmCoder.idl.instructions.find((instruction) => instruction.name === name)?.discriminator ?? [],
  )).filter((value) => value.length === 8);
  const matchingInstructions = pumpAmmInstructions.filter((instruction) => {
    const candidate = instruction as { data?: unknown; accounts?: unknown[] };
    if (typeof candidate.data !== 'string' || !Array.isArray(candidate.accounts)) return false;
    const data = Buffer.from(bs58.decode(candidate.data));
    if (!expectedDiscriminators.some((discriminator) => data.subarray(0, 8).equals(discriminator))) return false;
    const accountKeys = new Set(candidate.accounts.map(keyString).filter((key): key is string => key !== null));
    return accountKeys.has(poolAddress.toBase58()) && accountKeys.has(mintAddress) && accountKeys.has(userWallet);
  });
  if (pumpAmmInstructions.length !== 1 || matchingInstructions.length !== 1) {
    throw new Error('The confirmed transaction does not contain one matching PumpSwap trade.');
  }

  const tradeEvents = readPumpAmmTradeEvents(meta.logMessages);
  const eventName = side === 'buy' ? 'buyevent' : 'sellevent';
  const matchingEvents = tradeEvents.filter((event) =>
    event.name.toLowerCase() === eventName
      && eventKey(event.data, 'pool', 'pool') === poolAddress.toBase58()
      && eventKey(event.data, 'user', 'user') === userWallet,
  );
  if (tradeEvents.length !== 1 || matchingEvents.length !== 1) {
    throw new Error('The confirmed PumpSwap trade event could not be uniquely verified.');
  }

  const event = matchingEvents[0];
  const tokenAmountRaw = eventAmount(event.data,
    side === 'buy' ? 'baseAmountOut' : 'baseAmountIn',
    side === 'buy' ? 'base_amount_out' : 'base_amount_in');
  const quoteAmountRaw = eventAmount(event.data,
    side === 'buy' ? 'userQuoteAmountIn' : 'userQuoteAmountOut',
    side === 'buy' ? 'user_quote_amount_in' : 'user_quote_amount_out');
  const tokenBalances = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]
    .filter((balance) => balance.mint === mintAddress);
  if (!tokenBalances.length || tokenBalances.some((balance) => !balance.owner)) {
    throw new Error('Solana did not return enough token balance details to verify this PumpSwap trade.');
  }
  const before = new Map<number, bigint>();
  const after = new Map<number, bigint>();
  let tokenDecimals: number | null = null;
  for (const balance of meta.preTokenBalances ?? []) {
    if (balance.mint !== mintAddress || balance.owner !== userWallet) continue;
    before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    tokenDecimals = balance.uiTokenAmount.decimals;
  }
  for (const balance of meta.postTokenBalances ?? []) {
    if (balance.mint !== mintAddress || balance.owner !== userWallet) continue;
    after.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
    tokenDecimals = balance.uiTokenAmount.decimals;
  }
  let tokenDelta = 0n;
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    tokenDelta += (after.get(index) ?? 0n) - (before.get(index) ?? 0n);
  }
  if (tokenDecimals !== 6 || tokenAmountRaw <= 0n
    || tokenDelta !== (side === 'buy' ? tokenAmountRaw : -tokenAmountRaw)
    || quoteAmountRaw <= 0n
    || !Number.isSafeInteger(meta.fee) || meta.fee < 0) {
    throw new Error('The confirmed PumpSwap event does not match the wallet balance changes.');
  }

  return {
    tokenAmountRaw,
    quoteAmountRaw,
    quoteMint: SOL_MINT,
    quoteDecimals: 9,
    solAmountLamports: quoteAmountRaw,
    tokenDecimals,
    slot: BigInt(transaction.slot),
    blockTime: transaction.blockTime == null ? null : new Date(transaction.blockTime * 1000),
    networkFeeLamports: BigInt(meta.fee),
  };
}

export async function verifyConfirmedPumpSwap(
  connection: Connection,
  signature: string,
  userWallet: string,
  mintAddress: string,
  curveAddress: string,
  side: SwapSide,
  confirmedTransaction?: ConfirmedParsedSwap,
): Promise<VerifiedPumpSwap | null> {
  if (side !== 'buy' && side !== 'sell') throw new Error('The selected swap direction is invalid.');
  const expectedCurve = bondingCurvePda(new PublicKey(mintAddress)).toBase58();
  if (curveAddress !== expectedCurve) throw new Error('The Pump.fun bonding curve address does not match this mint.');
  const transaction = confirmedTransaction ?? await getConfirmedParsedSwap(connection, signature);
  if (!transaction) return null;

  const topLevelProgramIds = transaction.transaction.message.instructions
    .map((instruction) => keyString((instruction as { programId?: unknown }).programId))
    .filter((programId): programId is string => programId !== null);
  const hasCurveTrade = topLevelProgramIds.includes(PUMP_PROGRAM_ID.toBase58());
  const hasAmmTrade = topLevelProgramIds.includes(PUMP_AMM_PROGRAM_ID.toBase58());
  if (hasCurveTrade === hasAmmTrade) throw new Error('The confirmed transaction does not identify one Pump market.');

  if (hasAmmTrade) {
    const verified = await verifyConfirmedPumpAmmSwap(connection, transaction, signature, userWallet, mintAddress, side);
    return {
      ...verified,
      venue: 'PUMP_SWAP',
      marketAddress: canonicalPumpPoolPda(new PublicKey(mintAddress), new PublicKey(SOL_MINT)).toBase58(),
    };
  }

  const verified = await verifyConfirmedPumpCurveSwap(
    connection,
    signature,
    userWallet,
    mintAddress,
    curveAddress,
    side,
    transaction,
  );
  return verified ? { ...verified, venue: 'PUMP_FUN', marketAddress: curveAddress } : null;
}

async function verifyConfirmedRaydiumClmmSwap(
  connection: Connection,
  transaction: ConfirmedParsedSwap,
  signature: string,
  userWallet: string,
  mintAddress: string,
  side: SwapSide,
): Promise<VerifiedRaydiumClmmSwap> {
  const { meta } = transaction;
  if (!meta || meta.err) throw new PublicError('La transacción de Solana no se completó correctamente.', 422);
  if (!transaction.transaction.signatures.includes(signature)) {
    throw new PublicError('La firma no coincide con la transacción consultada.', 422);
  }
  if (!transaction.transaction.message.accountKeys.some((account) =>
    account.signer && account.pubkey.toBase58() === userWallet,
  )) {
    throw new PublicError('La wallet no firmó esta transacción.', 422);
  }

  const topLevelInstructions = transaction.transaction.message.instructions;
  const allInstructions = [
    ...topLevelInstructions,
    ...(meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  const clmmProgramId = RAYDIUM_DEVNET_CLMM_PROGRAM_ID.toBase58();
  const clmmInstructions = allInstructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === clmmProgramId,
  );
  const topLevelClmmInstructions = topLevelInstructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === clmmProgramId,
  );
  if (clmmInstructions.length !== 1 || topLevelClmmInstructions.length !== 1) {
    throw new PublicError('La firma no contiene un único swap directo verificable de Raydium CLMM.', 422);
  }
  const otherSwapProgramIds = new Set([
    DEVNET_PROGRAM_ID.CLMM.toBase58(), // The pinned SDK also contains an older Devnet CLMM address.
    DEVNET_PROGRAM_ID.AmmV4.toBase58(),
    DEVNET_PROGRAM_ID.AmmStable.toBase58(),
    DEV_CREATE_CPMM_POOL_PROGRAM.toBase58(),
    PUMP_PROGRAM_ID.toBase58(),
    PUMP_AMM_PROGRAM_ID.toBase58(),
  ]);
  if (allInstructions.some((instruction) =>
    otherSwapProgramIds.has(keyString((instruction as { programId?: unknown }).programId) ?? ''),
  )) {
    throw new PublicError('No se pueden importar transacciones que mezclen mercados en una sola operación.', 422);
  }
  const allowedTopLevelProgramIds = new Set([
    clmmProgramId,
    ComputeBudgetProgram.programId.toBase58(),
    SystemProgram.programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
    MEMO_PROGRAM_ID.toBase58(),
  ]);
  if (topLevelInstructions.some((instruction) =>
    !allowedTopLevelProgramIds.has(keyString((instruction as { programId?: unknown }).programId) ?? ''),
  )) {
    throw new PublicError('La firma contiene instrucciones adicionales fuera del swap CLMM y sus programas auxiliares.', 422);
  }

  const instruction = topLevelClmmInstructions[0] as { accounts?: unknown[]; data?: unknown };
  if (!Array.isArray(instruction.accounts) || instruction.accounts.length < 14 || typeof instruction.data !== 'string') {
    throw new PublicError('La instrucción Raydium CLMM no usa el formato directo admitido.', 422);
  }
  let instructionData: Buffer;
  try {
    instructionData = Buffer.from(bs58.decode(instruction.data));
  } catch {
    throw new PublicError('No se pudo decodificar la instrucción Raydium CLMM.', 422);
  }
  if (instructionData.length !== 41
    || !instructionData.subarray(0, 8).equals(CLMM_SWAP_DISCRIMINATOR)
    || (instructionData[40] !== 0 && instructionData[40] !== 1)) {
    throw new PublicError('La instrucción Raydium CLMM no es un swap exact-in o exact-out compatible.', 422);
  }
  const amount = instructionData.readBigUInt64LE(8);
  const otherAmountThreshold = instructionData.readBigUInt64LE(16);
  const sqrtPriceLimitX64 = instructionData.readBigUInt64LE(24)
    | (instructionData.readBigUInt64LE(32) << 64n);
  const isExactIn = instructionData[40] === 1;
  if (amount <= 0n || otherAmountThreshold <= 0n || sqrtPriceLimitX64 <= 0n) {
    throw new PublicError('Los límites e importes de la instrucción Raydium CLMM no son válidos.', 422);
  }

  const instructionAccounts = instruction.accounts.map(keyString);
  const [instructionWallet, configAddress, poolAddress, sourceAddress, destinationAddress,
    inputVaultAddress, outputVaultAddress, observationAddress, tokenProgramAddress,
    token2022ProgramAddress, memoProgramAddress, inputMintAddress, outputMintAddress] = instructionAccounts;
  const canonicalMint = new PublicKey(mintAddress).toBase58();
  if (!instructionWallet || instructionWallet !== userWallet || !configAddress || !poolAddress
    || !sourceAddress || !destinationAddress || sourceAddress === destinationAddress
    || !inputVaultAddress || !outputVaultAddress || !observationAddress
    || tokenProgramAddress !== TOKEN_PROGRAM_ID.toBase58()
    || token2022ProgramAddress !== TOKEN_2022_PROGRAM_ID.toBase58()
    || memoProgramAddress !== MEMO_PROGRAM_ID.toBase58()
    || !inputMintAddress || !outputMintAddress || inputMintAddress === outputMintAddress) {
    throw new PublicError('La instrucción Raydium CLMM no identifica la wallet y las cuentas esperadas.', 422);
  }

  const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddress), 'confirmed');
  if (!poolInfo || !poolInfo.owner.equals(RAYDIUM_DEVNET_CLMM_PROGRAM_ID)
    || poolInfo.data.length !== PoolInfoLayout.span
    || !poolInfo.data.subarray(0, 8).equals(CLMM_POOL_STATE_DISCRIMINATOR)) {
    throw new PublicError('La cuenta de mercado no es una pool Raydium CLMM válida de Devnet.', 422);
  }
  const poolState = PoolInfoLayout.decode(poolInfo.data);
  if (poolState.ammConfig.toBase58() !== configAddress) {
    throw new PublicError('La configuración de la instrucción no coincide con el estado de la pool.', 422);
  }

  const configInfo = await connection.getAccountInfo(new PublicKey(configAddress), 'confirmed');
  if (!configInfo || !configInfo.owner.equals(RAYDIUM_DEVNET_CLMM_PROGRAM_ID)
    || configInfo.data.length !== ClmmConfigLayout.span
    || !configInfo.data.subarray(0, 8).equals(CLMM_CONFIG_STATE_DISCRIMINATOR)) {
    throw new PublicError('La cuenta de configuración no pertenece a Raydium CLMM en Devnet.', 422);
  }
  const configState = ClmmConfigLayout.decode(configInfo.data);
  const configIndex = Buffer.alloc(2);
  configIndex.writeUInt16LE(configState.index);
  const [derivedConfigAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('amm_config'), configIndex],
    RAYDIUM_DEVNET_CLMM_PROGRAM_ID,
  );
  const [derivedPoolAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), poolState.ammConfig.toBuffer(), poolState.mintA.toBuffer(), poolState.mintB.toBuffer()],
    RAYDIUM_DEVNET_CLMM_PROGRAM_ID,
  );
  const [derivedVaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), new PublicKey(poolAddress).toBuffer(), poolState.mintA.toBuffer()],
    RAYDIUM_DEVNET_CLMM_PROGRAM_ID,
  );
  const [derivedVaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), new PublicKey(poolAddress).toBuffer(), poolState.mintB.toBuffer()],
    RAYDIUM_DEVNET_CLMM_PROGRAM_ID,
  );
  const [derivedObservation] = PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), new PublicKey(poolAddress).toBuffer()],
    RAYDIUM_DEVNET_CLMM_PROGRAM_ID,
  );
  if (!derivedConfigAddress.equals(new PublicKey(configAddress))
    || !derivedPoolAddress.equals(new PublicKey(poolAddress))
    || !derivedObservation.equals(new PublicKey(observationAddress))
    || (poolState.mintA.equals(new PublicKey(inputMintAddress))
      ? !derivedVaultA.equals(new PublicKey(inputVaultAddress)) || !derivedVaultB.equals(new PublicKey(outputVaultAddress))
      : poolState.mintB.equals(new PublicKey(inputMintAddress))
        ? !derivedVaultB.equals(new PublicKey(inputVaultAddress)) || !derivedVaultA.equals(new PublicKey(outputVaultAddress))
        : true)) {
    throw new PublicError('Las cuentas de la instrucción no coinciden con las direcciones derivadas de la pool.', 422);
  }

  const mintA = poolState.mintA.toBase58();
  const mintB = poolState.mintB.toBase58();
  const tokenIsMintA = mintA === canonicalMint;
  const tokenIsMintB = mintB === canonicalMint;
  const quoteMint = tokenIsMintA ? mintB : tokenIsMintB ? mintA : '';
  const quoteAsset = Object.values(QUOTE_ASSETS).find((asset) => asset.mintAddress === quoteMint);
  const expectedInputMint = side === 'buy' ? quoteMint : canonicalMint;
  const expectedOutputMint = side === 'buy' ? canonicalMint : quoteMint;
  if ((!tokenIsMintA && !tokenIsMintB) || !quoteAsset || !quoteMint
    || inputMintAddress !== expectedInputMint || outputMintAddress !== expectedOutputMint) {
    throw new PublicError('La pool CLMM no contiene el token y un activo de cotización admitido.', 422);
  }

  const accountKeys = transaction.transaction.message.accountKeys.map((account) => account.pubkey.toBase58());
  const sourceIndex = accountKeys.indexOf(sourceAddress);
  const destinationIndex = accountKeys.indexOf(destinationAddress);
  if (sourceIndex < 0 || destinationIndex < 0 || sourceIndex === destinationIndex
    || accountKeys.lastIndexOf(sourceAddress) !== sourceIndex
    || accountKeys.lastIndexOf(destinationAddress) !== destinationIndex) {
    throw new PublicError('No se pudieron asociar las cuentas de tokens del swap con la transacción.', 422);
  }

  const preTokenBalances = meta.preTokenBalances ?? [];
  const postTokenBalances = meta.postTokenBalances ?? [];
  const tokenBalances = [...preTokenBalances, ...postTokenBalances];
  const tokenAccountMint = (accountIndex: number): string => {
    const records = tokenBalances.filter((balance) => balance.accountIndex === accountIndex);
    const mints = [...new Set(records.map((balance) => balance.mint))];
    if (!records.length || mints.length !== 1 || records.some((balance) => balance.owner !== userWallet)) {
      throw new PublicError('Solana no confirmó la propiedad de las cuentas de tokens del swap.', 422);
    }
    return mints[0];
  };
  const sourceMint = tokenAccountMint(sourceIndex);
  const destinationMint = tokenAccountMint(destinationIndex);
  if (sourceMint !== inputMintAddress || destinationMint !== outputMintAddress) {
    throw new PublicError('Los mints de las cuentas no coinciden con la instrucción CLMM.', 422);
  }

  const balanceDelta = (accountIndex: number, mint: string): { delta: bigint; decimals: number } => {
    const before = preTokenBalances.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    const after = postTokenBalances.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    const record = after ?? before;
    if (!record || record.owner !== userWallet || (before && before.owner !== userWallet) || (after && after.owner !== userWallet)
      || (before && after && before.uiTokenAmount.decimals !== after.uiTokenAmount.decimals)) {
      throw new PublicError('No se pudo confirmar el cambio de balance de la wallet.', 422);
    }
    return {
      delta: BigInt(after?.uiTokenAmount.amount ?? '0') - BigInt(before?.uiTokenAmount.amount ?? '0'),
      decimals: record.uiTokenAmount.decimals,
    };
  };
  const walletBalanceDelta = (mint: string): { delta: bigint; decimals: number } => {
    const records = tokenBalances.filter((balance) => balance.mint === mint);
    if (!records.length || records.some((balance) => !balance.owner)) {
      throw new PublicError('Solana no devolvió balances suficientes para verificar el swap.', 422);
    }
    const before = new Map<number, bigint>();
    const after = new Map<number, bigint>();
    const decimals = new Set<number>();
    for (const balance of preTokenBalances) {
      if (balance.mint === mint && balance.owner === userWallet) {
        before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
        decimals.add(balance.uiTokenAmount.decimals);
      }
    }
    for (const balance of postTokenBalances) {
      if (balance.mint === mint && balance.owner === userWallet) {
        after.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
        decimals.add(balance.uiTokenAmount.decimals);
      }
    }
    if (decimals.size !== 1) throw new PublicError('No se pudo confirmar la precisión del token.', 422);
    let delta = 0n;
    for (const index of new Set([...before.keys(), ...after.keys()])) {
      delta += (after.get(index) ?? 0n) - (before.get(index) ?? 0n);
    }
    return { delta, decimals: [...decimals][0] };
  };

  const sourceDelta = balanceDelta(sourceIndex, inputMintAddress);
  const destinationDelta = balanceDelta(destinationIndex, outputMintAddress);
  const tokenDelta = walletBalanceDelta(canonicalMint);
  const quoteDelta = walletBalanceDelta(quoteMint);
  const expectedTokenDelta = side === 'buy' ? destinationDelta.delta : sourceDelta.delta;
  const expectedQuoteDelta = side === 'buy' ? sourceDelta.delta : destinationDelta.delta;
  if (tokenDelta.delta !== expectedTokenDelta || quoteDelta.delta !== expectedQuoteDelta
    || (side === 'buy' && (tokenDelta.delta <= 0n || quoteDelta.delta >= 0n))
    || (side === 'sell' && (tokenDelta.delta >= 0n || quoteDelta.delta <= 0n))) {
    throw new PublicError('Los cambios netos de balance no coinciden con un único swap CLMM.', 422);
  }

  const tokenDecimals = tokenIsMintA ? poolState.mintDecimalsA : poolState.mintDecimalsB;
  const quoteDecimals = tokenIsMintA ? poolState.mintDecimalsB : poolState.mintDecimalsA;
  if (tokenDelta.decimals !== tokenDecimals || quoteDelta.decimals !== quoteDecimals
    || quoteDecimals !== quoteAsset.decimals) {
    throw new PublicError('La precisión de los tokens no coincide con el estado de la pool CLMM.', 422);
  }

  const actualInput = sourceDelta.delta < 0n ? -sourceDelta.delta : sourceDelta.delta;
  const actualOutput = destinationDelta.delta < 0n ? -destinationDelta.delta : destinationDelta.delta;
  if ((isExactIn && (actualInput !== amount || actualOutput < otherAmountThreshold))
    || (!isExactIn && (actualOutput !== amount || actualInput > otherAmountThreshold))) {
    throw new PublicError('Los balances confirmados no cumplen los importes exact-in/exact-out de Raydium CLMM.', 422);
  }
  if (!Number.isSafeInteger(meta.fee) || meta.fee < 0) {
    throw new PublicError('No se pudo confirmar el fee de red de la transacción.', 422);
  }

  const quoteAmountRaw = quoteDelta.delta < 0n ? -quoteDelta.delta : quoteDelta.delta;
  if (quoteAmountRaw <= 0n) throw new PublicError('El monto de cotización confirmado no es válido.', 422);
  return {
    venue: 'RAYDIUM_CLMM',
    marketAddress: poolAddress,
    tokenAmountRaw: tokenDelta.delta < 0n ? -tokenDelta.delta : tokenDelta.delta,
    quoteAmountRaw,
    quoteMint,
    quoteDecimals,
    solAmountLamports: quoteMint === SOL_MINT ? quoteAmountRaw : null,
    tokenDecimals,
    slot: BigInt(transaction.slot),
    blockTime: transaction.blockTime == null ? null : new Date(transaction.blockTime * 1000),
    networkFeeLamports: BigInt(meta.fee),
  };
}

export async function verifyConfirmedExternalSwap(
  connection: Connection,
  signature: string,
  userWallet: string,
  mintAddress: string,
  side: SwapSide,
): Promise<(VerifiedSwap & { venue: 'RAYDIUM'; marketAddress: string }) | VerifiedRaydiumAmmSwap | VerifiedRaydiumClmmSwap | VerifiedPumpSwap | null> {
  if (side !== 'buy' && side !== 'sell') throw new Error('The selected swap direction is invalid.');
  const canonicalMint = new PublicKey(mintAddress).toBase58();
  const transaction = await getConfirmedParsedSwap(connection, signature);
  if (!transaction) return null;

  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  const raydiumClmmInstructions = instructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === RAYDIUM_DEVNET_CLMM_PROGRAM_ID.toBase58(),
  );
  if (raydiumClmmInstructions.length > 0) {
    return verifyConfirmedRaydiumClmmSwap(connection, transaction, signature, userWallet, canonicalMint, side);
  }
  const raydiumAmmV4Instructions = instructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === DEVNET_PROGRAM_ID.AmmV4.toBase58(),
  );
  const raydiumStableInstructions = instructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === DEVNET_PROGRAM_ID.AmmStable.toBase58(),
  );
  if (raydiumAmmV4Instructions.length > 0 || raydiumStableInstructions.length > 0) {
    const isStable = raydiumStableInstructions.length > 0;
    return verifyConfirmedRaydiumAmmSwap(connection, transaction, signature, userWallet, canonicalMint, side, {
      venue: isStable ? 'RAYDIUM_AMM_STABLE' : 'RAYDIUM_AMM_V4',
      programId: isStable ? DEVNET_PROGRAM_ID.AmmStable : DEVNET_PROGRAM_ID.AmmV4,
      isStable,
    });
  }
  const raydiumInstructions = instructions.filter((instruction) =>
    keyString((instruction as { programId?: unknown }).programId) === DEV_CREATE_CPMM_POOL_PROGRAM.toBase58(),
  );
  const raydiumEvents = readRaydiumSwapEvents(transaction.meta?.logMessages);

  if (raydiumInstructions.length > 0 || raydiumEvents.length > 0) {
    if (raydiumInstructions.length !== 1 || raydiumEvents.length !== 1) {
      throw new PublicError('La firma no corresponde a un único swap CPMM verificable en Devnet.', 422);
    }
    const event = raydiumEvents[0];
    const quoteCandidates = Object.values(QUOTE_ASSETS).filter((asset) => {
      if (asset.mintAddress === canonicalMint
        || !instructionCallsPoolSwap(raydiumInstructions[0], event.poolAddress, [asset.mintAddress, canonicalMint])) return false;
      if (event.inputMint === null || event.outputMint === null) return true;
      const expectedInput = side === 'buy' ? asset.mintAddress : canonicalMint;
      const expectedOutput = side === 'buy' ? canonicalMint : asset.mintAddress;
      return event.inputMint === expectedInput && event.outputMint === expectedOutput;
    });
    if (quoteCandidates.length !== 1) {
      throw new PublicError('El swap externo no usa un activo de cotización compatible de Devnet.', 422);
    }

    const verified = await verifyConfirmedRaydiumSwap(
      connection,
      signature,
      userWallet,
      canonicalMint,
      quoteCandidates[0].mintAddress,
      event.poolAddress,
      side,
      transaction,
    );
    if (!verified) return null;
    return { ...verified, venue: 'RAYDIUM', marketAddress: event.poolAddress };
  }

  const topLevelProgramIds = transaction.transaction.message.instructions
    .map((instruction) => keyString((instruction as { programId?: unknown }).programId))
    .filter((programId): programId is string => programId !== null);
  if (!topLevelProgramIds.includes(PUMP_PROGRAM_ID.toBase58())
    && !topLevelProgramIds.includes(PUMP_AMM_PROGRAM_ID.toBase58())) {
    throw new PublicError('La firma no corresponde a un swap verificable de un mercado compatible en Devnet.', 422);
  }

  const curveAddress = bondingCurvePda(new PublicKey(canonicalMint)).toBase58();
  return verifyConfirmedPumpSwap(connection, signature, userWallet, canonicalMint, curveAddress, side, transaction);
}
