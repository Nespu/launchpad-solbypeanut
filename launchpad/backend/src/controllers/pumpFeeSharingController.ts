import { createHash } from 'node:crypto';
import {
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
} from '@solana/spl-token';
import {
  OnlinePumpSdk,
  PumpSdk as PumpInstructionSdk,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  ammCreatorVaultPda,
  canonicalPumpPoolPdaWithQuote,
  creatorVaultPda,
  feeSharingConfigPda,
  isSharingConfigEditable,
  normalizeQuoteMint,
  Platform,
  socialFeePda,
  type BondingCurve,
  type CreatorVaultQuoteBalance,
  type Shareholder,
  type SharingConfig,
} from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, type Pool } from '@pump-fun/pump-swap-sdk';
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { Request, Response } from 'express';
import { sendInternalError } from '../utils/internalError';
import { PublicError } from '../utils/publicError';
import { connection } from '../utils/solana';
import { DEVNET_GENESIS_HASH } from '../utils/solanaNetwork';

const FEE_SHARING_COMPUTE_UNITS = 1_300_000;
const SHARING_CONFIG_ACCOUNT_BYTES = 1_024;
const SOCIAL_FEE_PDA_ACCOUNT_BYTES = 179;

type PumpReadSdk = Pick<OnlinePumpSdk,
  | 'fetchBondingCurve'
  | 'fetchQuoteTokenProgram'
  | 'getCreatorVaultQuoteBalances'
>;
type PumpInstructionBuilder = Pick<PumpInstructionSdk,
  | 'createFeeSharingConfig'
  | 'sweepCreatorFeeInstruction'
  | 'sweepPoolCreatorFeeInstruction'
  | 'updateFeeSharesV2'
  | 'transferCreatorFeesToPumpV2'
  | 'distributeCreatorFeesV2'
  | 'decodeSharingConfig'
  | 'decodeSocialFeePda'
  | 'createSocialFeePda'
>;
type AmmSdk = Pick<OnlinePumpAmmSdk, 'fetchPool'>;
type Dependencies = {
  connection: Connection;
  createPumpReadSdk: (rpc: Connection) => PumpReadSdk;
  createPumpInstructionBuilder: () => PumpInstructionBuilder;
  createAmmSdk: (rpc: Connection) => AmmSdk;
  readMint: typeof getMint;
};

type ChainState = {
  mint: PublicKey;
  curve: BondingCurve;
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
  sharingConfigAddress: PublicKey;
  sharingConfig: SharingConfig | null;
  poolAddress: PublicKey | null;
  pool: Pool | null;
  currentCreator: PublicKey;
  pumpReadSdk: PumpReadSdk;
  pumpInstructionBuilder: PumpInstructionBuilder;
};

type FeeShareRecipient = {
  type: 'wallet' | 'github' | 'unsupported_social';
  address: string;
  shareBps: number;
  userId?: string;
};

type NormalizedRecipients = {
  rows: FeeShareRecipient[];
  shareholders: Shareholder[];
};

const defaultDependencies: Dependencies = {
  connection,
  createPumpReadSdk: (rpc) => new OnlinePumpSdk(rpc),
  createPumpInstructionBuilder: () => new PumpInstructionSdk(),
  createAmmSdk: (rpc) => new OnlinePumpAmmSdk(rpc),
  readMint: getMint,
};

function publicErrorResponse(res: Response, error: unknown, context: string): Response {
  if (error instanceof PublicError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  return sendInternalError(res, error, context);
}

async function assertDevnet(rpc: Connection): Promise<void> {
  if (await rpc.getGenesisHash() !== DEVNET_GENESIS_HASH) {
    throw new PublicError('Wire solo prepara estas operaciones en Solana Devnet.', 503);
  }
}

function serializeShares(shares: readonly Shareholder[]) {
  return shares.map((share) => ({ address: share.address.toBase58(), shareBps: share.shareBps }));
}

async function describeShareholders(
  rpc: Connection,
  builder: PumpInstructionBuilder,
  shares: readonly Shareholder[],
): Promise<FeeShareRecipient[]> {
  return Promise.all(shares.map(async (share) => {
    const address = share.address.toBase58();
    const info = await rpc.getAccountInfo(share.address, 'confirmed');
    if (info?.owner.equals(PUMP_FEE_PROGRAM_ID)) {
      try {
        const social = builder.decodeSocialFeePda(info);
        return {
          type: social.platform === Platform.GitHub ? 'github' : 'unsupported_social',
          address,
          shareBps: share.shareBps,
          userId: social.userId,
        };
      } catch {
        throw new PublicError('Un destinatario pertenece al programa de Pump, pero no se pudo validar como social fee PDA.', 409);
      }
    }
    return { type: 'wallet', address, shareBps: share.shareBps };
  }));
}

function formatBalance(balance: CreatorVaultQuoteBalance, decimals: number, symbol: string) {
  return {
    mint: balance.mint.toBase58(),
    decimals,
    symbol,
    pumpVaultRaw: balance.pumpVault.toString(),
    ammVaultRaw: balance.ammVault.toString(),
    totalRaw: balance.total.toString(),
  };
}

async function readChainState(
  rpc: Connection,
  createPumpReadSdk: Dependencies['createPumpReadSdk'],
  createPumpInstructionBuilder: Dependencies['createPumpInstructionBuilder'],
  createAmmSdk: Dependencies['createAmmSdk'],
  mint: PublicKey,
): Promise<ChainState> {
  const pumpReadSdk = createPumpReadSdk(rpc);
  const pumpInstructionBuilder = createPumpInstructionBuilder();
  const curve = await pumpReadSdk.fetchBondingCurve(mint);
  if (curve.isHolderReward) {
    throw new PublicError('Este token usa Holder Rewards de Pump y no admite reparto de creator fees.', 409);
  }

  const quoteMint = normalizeQuoteMint(curve.quoteMint);
  const quoteTokenProgram = await pumpReadSdk.fetchQuoteTokenProgram(quoteMint);
  const sharingConfigAddress = feeSharingConfigPda(mint);
  const sharingInfo = await rpc.getAccountInfo(sharingConfigAddress, 'confirmed');
  let sharingConfig: SharingConfig | null = null;
  if (sharingInfo) {
    if (!sharingInfo.owner.equals(PUMP_FEE_PROGRAM_ID)) {
      throw new PublicError('La cuenta de fee sharing no pertenece al programa oficial de Pump.', 409);
    }
    sharingConfig = pumpInstructionBuilder.decodeSharingConfig(sharingInfo);
    if (!sharingConfig.mint.equals(mint)) {
      throw new PublicError('La configuración de fee sharing no coincide con el token.', 409);
    }
  }

  let poolAddress: PublicKey | null = null;
  let pool: Pool | null = null;
  if (curve.complete) {
    poolAddress = canonicalPumpPoolPdaWithQuote(mint, quoteMint);
    const poolInfo = await rpc.getAccountInfo(poolAddress, 'confirmed');
    if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      throw new PublicError('La curva ya graduó, pero no se encontró su pool canónica de PumpSwap.', 409);
    }
    pool = await createAmmSdk(rpc).fetchPool(poolAddress);
    if (!pool.baseMint.equals(mint) || !pool.quoteMint.equals(quoteMint)) {
      throw new PublicError('La pool de PumpSwap no corresponde al token y activo de cotización.', 409);
    }
  }

  const currentCreator = pool?.coinCreator ?? curve.creator;
  if (sharingConfig) {
    if (!curve.creator.equals(sharingConfigAddress)
      || (pool && !pool.coinCreator.equals(sharingConfigAddress))) {
      throw new PublicError('La configuración existe, pero la curva o la pool no apunta a ella. No se preparó ninguna transacción.', 409);
    }
  } else if (pool && !curve.creator.equals(pool.coinCreator)) {
    throw new PublicError('La curva y la pool muestran creadores distintos. Wire no puede preparar este cambio con seguridad.', 409);
  }

  return {
    mint,
    curve,
    quoteMint,
    quoteTokenProgram,
    sharingConfigAddress,
    sharingConfig,
    poolAddress,
    pool,
    currentCreator,
    pumpReadSdk,
    pumpInstructionBuilder,
  };
}

function toPublicState(
  state: ChainState,
  requestedSigner: PublicKey,
  balances: Array<ReturnType<typeof formatBalance>> = [],
  shareholders: FeeShareRecipient[] = [],
) {
  const config = state.sharingConfig;
  let phase: 'not_configured' | 'editable' | 'finalized' | 'legacy_unsupported';
  if (!config) phase = 'not_configured';
  else if (config.version === 1) phase = 'legacy_unsupported';
  else if (config.adminRevoked || !isSharingConfigEditable({ sharingConfig: config })) phase = 'finalized';
  else phase = 'editable';
  return {
    success: true,
    network: 'devnet',
    mint: state.mint.toBase58(),
    quoteMint: state.quoteMint.toBase58(),
    quoteTokenProgram: state.quoteTokenProgram.toBase58(),
    graduated: state.curve.complete,
    creator: requestedSigner.toBase58(),
    currentCreator: state.currentCreator.toBase58(),
    creatorMatches: requestedSigner.equals(state.currentCreator),
    sharingConfigAddress: state.sharingConfigAddress.toBase58(),
    phase,
    admin: config?.admin.toBase58() ?? null,
    adminRevoked: config?.adminRevoked ?? false,
    version: config?.version ?? null,
    canFinalize: Boolean(config && phase === 'editable' && config.admin.equals(requestedSigner)),
    shareholders: config ? shareholders : [],
    balances,
  };
}

function normalizeShareholders(value: unknown): NormalizedRecipients {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new PublicError('El reparto debe tener entre 1 y 10 destinatarios.', 400);
  }
  const seen = new Set<string>();
  const rows: FeeShareRecipient[] = [];
  const shareholders: Shareholder[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new PublicError('Hay un destinatario inválido.', 400);
    const row = item as Record<string, unknown>;
    if (!Number.isSafeInteger(row.shareBps)) throw new PublicError('Cada destinatario necesita un porcentaje válido.', 400);
    let address: PublicKey;
    let recipient: FeeShareRecipient;
    if (row.type === 'wallet' && typeof row.address === 'string') {
      try { address = new PublicKey(row.address); } catch { throw new PublicError('Una wallet destinataria no es válida.', 400); }
      if (address.toBase58() !== row.address) throw new PublicError('Una wallet destinataria no está en formato canónico.', 400);
      recipient = { type: 'wallet', address: address.toBase58(), shareBps: row.shareBps as number };
    } else if (row.type === 'github' && typeof row.userId === 'string') {
      if (!/^[1-9][0-9]{0,19}$/.test(row.userId) || BigInt(row.userId) > 18_446_744_073_709_551_615n) {
        throw new PublicError('Usa el ID numérico válido de una cuenta personal de GitHub.', 400);
      }
      address = socialFeePda(row.userId, Platform.GitHub);
      recipient = { type: 'github', address: address.toBase58(), userId: row.userId, shareBps: row.shareBps as number };
    } else {
      throw new PublicError('Cada destinatario debe ser una wallet o una cuenta personal de GitHub.', 400);
    }
    const key = address.toBase58();
    if (seen.has(key)) throw new PublicError('El reparto no puede repetir wallets.', 400);
    seen.add(key);
    const shareBps = row.shareBps as number;
    if (shareBps < 1 || shareBps > 10_000) throw new PublicError('Cada porcentaje debe ser mayor que 0 y no superar 100%.', 400);
    total += shareBps;
    shareholders.push({ address, shareBps });
    rows.push(recipient);
  }
  if (total !== 10_000) throw new PublicError('La suma del reparto debe ser exactamente 100%.', 400);
  return { rows, shareholders };
}

async function prepareSocialRecipientAccounts(
  rpc: Connection,
  builder: PumpInstructionBuilder,
  payer: PublicKey,
  recipients: readonly FeeShareRecipient[],
): Promise<{ instructions: TransactionInstruction[]; recipientsToInitialize: Array<{ userId: string; address: string }> }> {
  const instructions: TransactionInstruction[] = [];
  const recipientsToInitialize: Array<{ userId: string; address: string }> = [];
  for (const recipient of recipients) {
    if (recipient.type !== 'github' || !recipient.userId) continue;
    const address = socialFeePda(recipient.userId, Platform.GitHub);
    const info = await rpc.getAccountInfo(address, 'confirmed');
    if (info) {
      if (!info.owner.equals(PUMP_FEE_PROGRAM_ID)) {
        throw new PublicError('La dirección social de GitHub ya está ocupada por una cuenta de otro programa.', 409);
      }
      let social: ReturnType<PumpInstructionBuilder['decodeSocialFeePda']>;
      try { social = builder.decodeSocialFeePda(info); }
      catch { throw new PublicError('Pump no pudo validar la cuenta social de GitHub existente.', 409); }
      if (social.userId !== recipient.userId || social.platform !== Platform.GitHub) {
        throw new PublicError('La cuenta social existente no coincide con el ID personal de GitHub indicado.', 409);
      }
      continue;
    }
    instructions.push(await builder.createSocialFeePda({ payer, userId: recipient.userId, platform: Platform.GitHub }));
    recipientsToInitialize.push({ userId: recipient.userId, address: address.toBase58() });
  }
  return { instructions, recipientsToInitialize };
}

async function estimateRent(
  rpc: Connection,
  readMint: Dependencies['readMint'],
  state: ChainState,
  action: 'create' | 'finalize' | 'distribute',
  socialAccountsToInitialize = 0,
): Promise<number> {
  let total = 0;
  const rentForQuoteAta = async (owner: PublicKey) => {
    if (state.quoteMint.equals(NATIVE_MINT)) return;
    const ata = getAssociatedTokenAddressSync(state.quoteMint, owner, true, state.quoteTokenProgram);
    const info = await rpc.getAccountInfo(ata, 'confirmed');
    if (info) {
      if (!info.owner.equals(state.quoteTokenProgram)) throw new PublicError('Una cuenta de destino no coincide con el programa del activo de cotización.', 409);
      return;
    }
    const mint = await readMint(rpc, state.quoteMint, 'confirmed', state.quoteTokenProgram);
    total += await rpc.getMinimumBalanceForRentExemption(getAccountLenForMint(mint), 'confirmed');
  };
  const rentForNativeVault = async (address: PublicKey) => {
    if (!state.quoteMint.equals(NATIVE_MINT)) return;
    if (!(await rpc.getAccountInfo(address, 'confirmed'))) {
      total += await rpc.getMinimumBalanceForRentExemption(0, 'confirmed');
    }
  };

  if (action === 'create') {
    total += await rpc.getMinimumBalanceForRentExemption(SHARING_CONFIG_ACCOUNT_BYTES, 'confirmed');
  }
  if (socialAccountsToInitialize > 0) {
    const socialAccountRent = await rpc.getMinimumBalanceForRentExemption(SOCIAL_FEE_PDA_ACCOUNT_BYTES, 'confirmed');
    total += socialAccountRent * socialAccountsToInitialize;
  }

  const feeOwner = state.sharingConfigAddress;
  if (action === 'create') {
    await rentForNativeVault(creatorVaultPda(state.currentCreator));
    if (state.pool) await rentForNativeVault(ammCreatorVaultPda(state.currentCreator));
    await rentForQuoteAta(creatorVaultPda(state.currentCreator));
    if (state.pool) await rentForQuoteAta(ammCreatorVaultPda(state.currentCreator));
  } else if (action === 'finalize') {
    await rentForNativeVault(creatorVaultPda(feeOwner));
    if (state.pool) await rentForNativeVault(ammCreatorVaultPda(feeOwner));
    await rentForQuoteAta(creatorVaultPda(feeOwner));
    if (state.pool) await rentForQuoteAta(ammCreatorVaultPda(feeOwner));
    for (const shareholder of state.sharingConfig?.shareholders ?? []) await rentForQuoteAta(shareholder.address);
  } else {
    await rentForNativeVault(creatorVaultPda(feeOwner));
    if (state.pool) await rentForNativeVault(ammCreatorVaultPda(feeOwner));
    await rentForQuoteAta(creatorVaultPda(feeOwner));
    if (state.pool) await rentForQuoteAta(ammCreatorVaultPda(feeOwner));
    for (const shareholder of state.sharingConfig?.shareholders ?? []) await rentForQuoteAta(shareholder.address);
  }
  return total;
}

async function buildInstructions(
  state: ChainState,
  action: 'create' | 'finalize' | 'distribute',
  payer: PublicKey,
  newShareholders: Shareholder[] | null,
  socialRecipientInstructions: TransactionInstruction[] = [],
): Promise<TransactionInstruction[]> {
  const { pumpInstructionBuilder, mint, quoteMint, quoteTokenProgram, pool, poolAddress, sharingConfigAddress, sharingConfig } = state;
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: FEE_SHARING_COMPUTE_UNITS }),
  ];
  if (action === 'create') {
    instructions.push(await pumpInstructionBuilder.sweepCreatorFeeInstruction({
      payer, mint, creator: state.currentCreator, quoteMint, quoteTokenProgram,
    }));
    if (pool) {
      instructions.push(await pumpInstructionBuilder.sweepPoolCreatorFeeInstruction({
        payer, mint, coinCreator: pool.coinCreator, quoteMint, quoteTokenProgram,
      }));
    }
    instructions.push(await pumpInstructionBuilder.createFeeSharingConfig({
      creator: payer, mint, pool: poolAddress,
    }));
    return instructions;
  }

  if (!sharingConfig) throw new PublicError('Primero crea la configuración de reparto.', 409);
  if (action === 'finalize') {
    if (!newShareholders) throw new PublicError('Falta la distribución final de destinatarios.', 400);
    instructions.push(await pumpInstructionBuilder.sweepCreatorFeeInstruction({
      payer, mint, creator: sharingConfigAddress, quoteMint, quoteTokenProgram,
    }));
    if (pool) {
      instructions.push(await pumpInstructionBuilder.sweepPoolCreatorFeeInstruction({
        payer, mint, coinCreator: sharingConfigAddress, quoteMint, quoteTokenProgram,
      }));
    }
    instructions.push(...socialRecipientInstructions);
    instructions.push(await pumpInstructionBuilder.updateFeeSharesV2({
      authority: payer,
      mint,
      currentShareholders: sharingConfig.shareholders.map((shareholder) => shareholder.address),
      newShareholders,
      quoteMint,
      quoteTokenProgram,
      bondingCurveComplete: state.curve.complete,
    }));
    return instructions;
  }

  instructions.push(await pumpInstructionBuilder.sweepCreatorFeeInstruction({
    payer, mint, creator: sharingConfigAddress, quoteMint, quoteTokenProgram,
  }));
  if (pool) {
    instructions.push(await pumpInstructionBuilder.sweepPoolCreatorFeeInstruction({
      payer, mint, coinCreator: sharingConfigAddress, quoteMint, quoteTokenProgram,
    }));
    instructions.push(await pumpInstructionBuilder.transferCreatorFeesToPumpV2({ payer, mint, quoteMint, quoteTokenProgram }));
  }
  instructions.push(await pumpInstructionBuilder.distributeCreatorFeesV2({
    mint,
    sharingConfig,
    sharingConfigAddress,
    quoteMint,
    payer,
    shouldInitializeAta: true,
    quoteTokenProgram,
  }));
  return instructions;
}

function buildTransaction(payer: PublicKey, instructions: TransactionInstruction[], blockhash: string) {
  return new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...instructions);
}

async function prepareTransaction(
  rpc: Connection,
  readMint: Dependencies['readMint'],
  state: ChainState,
  action: 'create' | 'finalize' | 'distribute',
  payer: PublicKey,
  newShareholders: Shareholder[] | null,
  preparedRecipients: FeeShareRecipient[] = [],
  socialRecipientInstructions: TransactionInstruction[] = [],
  socialRecipientsToInitialize: Array<{ userId: string; address: string }> = [],
) {
  const latest = await rpc.getLatestBlockhash('confirmed');
  const instructions = await buildInstructions(state, action, payer, newShareholders, socialRecipientInstructions);
  const transaction = buildTransaction(payer, instructions, latest.blockhash);
  const message = transaction.compileMessage();
  const [fee, rentLamports] = await Promise.all([
    rpc.getFeeForMessage(message, 'confirmed'),
    estimateRent(rpc, readMint, state, action, socialRecipientsToInitialize.length),
  ]);
  if (fee.value === null) throw new PublicError('No se pudo estimar la comisión de red.', 503);
  if (message.header.numRequiredSignatures !== 1 || !message.accountKeys[0]?.equals(payer)) {
    throw new PublicError('La operación contiene una firma distinta de la wallet elegida.', 409);
  }

  const simulationTx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer,
    recentBlockhash: latest.blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message());
  const simulation = await rpc.simulateTransaction(simulationTx, {
    commitment: 'confirmed',
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    throw new PublicError('Pump no aceptó la simulación de esta operación en Devnet. Revisa el estado de la curva e inténtalo de nuevo.', 409);
  }

  return {
    creator: payer.toBase58(),
    mint: state.mint.toBase58(),
    quoteMint: state.quoteMint.toBase58(),
    sharingConfigAddress: state.sharingConfigAddress.toBase58(),
    graduated: state.curve.complete,
    action,
    shareholders: preparedRecipients.length > 0
      ? preparedRecipients
      : state.sharingConfig ? serializeShares(state.sharingConfig.shareholders) : [],
    socialRecipientsToInitialize,
    estimatedNetworkFeeLamports: fee.value,
    estimatedRentLamports: rentLamports,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    transactionMessageHash: createHash('sha256').update(transaction.serializeMessage()).digest('hex'),
  };
}

async function prepareSocialInitializationTransaction(
  rpc: Connection,
  state: ChainState,
  payer: PublicKey,
  recipients: FeeShareRecipient[],
  socialInstructions: TransactionInstruction[],
  recipientsToInitialize: Array<{ userId: string; address: string }>,
) {
  if (socialInstructions.length === 0 || socialInstructions.length !== recipientsToInitialize.length) {
    throw new PublicError('No hay destinatarios sociales nuevos para inicializar.', 409);
  }
  const latest = await rpc.getLatestBlockhash('confirmed');
  const transaction = buildTransaction(payer, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: FEE_SHARING_COMPUTE_UNITS }),
    ...socialInstructions,
  ], latest.blockhash);
  const message = transaction.compileMessage();
  const [fee, socialRent] = await Promise.all([
    rpc.getFeeForMessage(message, 'confirmed'),
    rpc.getMinimumBalanceForRentExemption(SOCIAL_FEE_PDA_ACCOUNT_BYTES, 'confirmed'),
  ]);
  if (fee.value === null) throw new PublicError('No se pudo estimar la comisión de red.', 503);
  if (message.header.numRequiredSignatures !== 1 || !message.accountKeys[0]?.equals(payer)) {
    throw new PublicError('La operación contiene una firma distinta de la wallet elegida.', 409);
  }
  const simulationTx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer,
    recentBlockhash: latest.blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message());
  const simulation = await rpc.simulateTransaction(simulationTx, {
    commitment: 'confirmed',
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    throw new PublicError('Pump no aceptó la inicialización social en Devnet. Revisa la wallet y vuelve a consultar.', 409);
  }
  return {
    creator: payer.toBase58(),
    mint: state.mint.toBase58(),
    quoteMint: state.quoteMint.toBase58(),
    sharingConfigAddress: state.sharingConfigAddress.toBase58(),
    graduated: state.curve.complete,
    action: 'initialize_social' as const,
    shareholders: recipients,
    socialRecipientsToInitialize: recipientsToInitialize,
    estimatedNetworkFeeLamports: fee.value,
    estimatedRentLamports: socialRent * recipientsToInitialize.length,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    transactionMessageHash: createHash('sha256').update(transaction.serializeMessage()).digest('hex'),
  };
}

export function createPumpFeeSharingHandlers(dependencies: Dependencies = defaultDependencies) {
  const { connection: rpc, createPumpReadSdk, createPumpInstructionBuilder, createAmmSdk, readMint } = dependencies;
  return {
    status: async (req: Request, res: Response): Promise<Response> => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await assertDevnet(rpc);
        const mint = new PublicKey(String(req.query.mint));
        const signer = new PublicKey(String(req.query.creator));
        const state = await readChainState(rpc, createPumpReadSdk, createPumpInstructionBuilder, createAmmSdk, mint);
        let balances: CreatorVaultQuoteBalance[] = [];
        if (state.sharingConfig) balances = await state.pumpReadSdk.getCreatorVaultQuoteBalances(state.sharingConfigAddress);
        const formattedBalances = await Promise.all(balances.map(async (balance) => {
          if (balance.mint.equals(NATIVE_MINT)) return formatBalance(balance, 9, 'SOL');
          const mintInfo = await readMint(rpc, balance.mint, 'confirmed', balance.quoteTokenProgram);
          const address = balance.mint.toBase58();
          return formatBalance(balance, mintInfo.decimals, `${address.slice(0, 4)}…${address.slice(-4)}`);
        }));
        const shareholders = state.sharingConfig
          ? await describeShareholders(rpc, state.pumpInstructionBuilder, state.sharingConfig.shareholders)
          : [];
        return res.status(200).json(toPublicState(state, signer, formattedBalances, shareholders));
      } catch (error) {
        return publicErrorResponse(res, error, 'Pump fee sharing state lookup failed');
      }
    },

    prepare: async (req: Request, res: Response): Promise<Response> => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await assertDevnet(rpc);
        const mint = new PublicKey(req.body.mint);
        const signer = new PublicKey(req.body.creator);
        const action = req.body.action as 'create' | 'finalize' | 'distribute';
        const state = await readChainState(rpc, createPumpReadSdk, createPumpInstructionBuilder, createAmmSdk, mint);
        let shareholders: Shareholder[] | null = null;
        let preparedRecipients: FeeShareRecipient[] = [];
        let socialRecipientInstructions: TransactionInstruction[] = [];
        let socialRecipientsToInitialize: Array<{ userId: string; address: string }> = [];
        if (action === 'create') {
          if (state.sharingConfig) throw new PublicError('La configuración ya existe. Actualiza el estado antes de continuar.', 409);
          if (!signer.equals(state.currentCreator)) throw new PublicError('Conecta o selecciona la wallet creadora actual del token.', 403);
        } else if (action === 'finalize') {
          if (!state.sharingConfig) throw new PublicError('Primero activa la configuración de fee sharing.', 409);
          if (!isSharingConfigEditable({ sharingConfig: state.sharingConfig })) throw new PublicError('Pump ya hizo permanente el reparto final; no se puede cambiar.', 409);
          if (!state.sharingConfig.admin.equals(signer)) throw new PublicError('Solo la wallet administradora actual puede finalizar el reparto.', 403);
          const normalized = normalizeShareholders(req.body.shareholders);
          shareholders = normalized.shareholders;
          preparedRecipients = normalized.rows;
          const social = await prepareSocialRecipientAccounts(
            rpc,
            state.pumpInstructionBuilder,
            signer,
            preparedRecipients,
          );
          socialRecipientInstructions = social.instructions;
          socialRecipientsToInitialize = social.recipientsToInitialize;
        } else {
          if (!state.sharingConfig || state.sharingConfig.version === 1) throw new PublicError('Este token no tiene una configuración de reparto compatible con Pump v2.', 409);
          if (state.sharingConfig.shareholders.length < 1) throw new PublicError('La configuración no tiene destinatarios válidos.', 409);
          const balances = await state.pumpReadSdk.getCreatorVaultQuoteBalances(state.sharingConfigAddress);
          const currentQuoteBalance = balances.find((balance) => balance.mint.equals(state.quoteMint));
          const hasVaultBalance = Boolean(currentQuoteBalance
            && (!currentQuoteBalance.pumpVault.isZero() || !currentQuoteBalance.ammVault.isZero()));
          const hasUncollectedCurveFees = !state.curve.creatorFee.isZero();
          const hasUncollectedPoolFees = Boolean(state.pool && !state.pool.creatorFees.isZero());
          if (!hasVaultBalance && !hasUncollectedCurveFees && !hasUncollectedPoolFees) {
            throw new PublicError('Todavía no hay creator fees pendientes para distribuir.', 409);
          }
        }
        const prepared = action === 'finalize' && socialRecipientInstructions.length > 0
          ? await prepareSocialInitializationTransaction(
            rpc,
            state,
            signer,
            preparedRecipients,
            socialRecipientInstructions,
            socialRecipientsToInitialize,
          )
          : await prepareTransaction(
            rpc,
            readMint,
            state,
            action,
            signer,
            shareholders,
            preparedRecipients,
          );
        return res.status(200).json({ success: true, network: 'devnet', ...prepared });
      } catch (error) {
        return publicErrorResponse(res, error, 'Pump fee sharing preparation failed');
      }
    },
  };
}
