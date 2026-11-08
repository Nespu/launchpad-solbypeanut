import { createHash } from 'node:crypto';
import { ASSOCIATED_TOKEN_PROGRAM_ID, createBurnCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { logger } from "../utils/logger";

export interface LpContext {
  userWallet: PublicKey;
  lpMint: PublicKey; // mint address of the LP token, returned by pool creation
  lpDecimals: number; // usually 9, but confirm against what Raydium returns
  tokenProgramId?: PublicKey;
}

export interface LpBurnSourceAccount {
  address: PublicKey;
  amount: bigint;
  decimals: number;
}

function validateBurn(ctx: LpContext, amount: bigint) {
  if (amount <= 0n) throw new Error('LP burn amount must be greater than zero');
  if (!Number.isInteger(ctx.lpDecimals) || ctx.lpDecimals < 0 || ctx.lpDecimals > 18) {
    throw new Error('LP token decimals must be an integer between 0 and 18');
  }
}

/**
 * Instrucción SPL de quema de LP — no conectada al flujo de producto.
 *
 * Quemar LP tokens es una instrucción SPL estándar (no depende de ningún SDK
 * externo), así que esto sí está completo. Solo puede ejecutarse DESPUÉS de
 * que exista la pool y sus LP estén en cuentas SPL propiedad del usuario.
 *
 * Se usa createBurnCheckedInstruction (no createBurnInstruction) porque valida
 * los decimales on-chain, lo que evita quemar la cantidad equivocada por un
 * error de configuración.
 */
export function buildLpBurnInstruction(ctx: LpContext, amount: bigint): TransactionInstruction[] {
  validateBurn(ctx, amount);

  const userLpAta = getAssociatedTokenAddressSync(ctx.lpMint, ctx.userWallet, false, ctx.tokenProgramId ?? TOKEN_PROGRAM_ID);

  // The caller must provide the exact raw-unit amount to burn. Never infer it
  // from a percentage or silently default to zero: burning LP is irreversible
  // and does not close the Raydium pool itself.
  const burnIx = createBurnCheckedInstruction(
    userLpAta,
    ctx.lpMint,
    ctx.userWallet, // authority (el usuario firma esto)
    amount,
    ctx.lpDecimals,
    [],
    ctx.tokenProgramId ?? TOKEN_PROGRAM_ID,
  );

  logger.info({ lpMint: ctx.lpMint.toBase58(), amount: amount.toString() }, "Built LP burn instruction");
  return [burnIx];
}

/** Burn an exact amount across the owner's verified LP token accounts. */
export function buildLpBurnInstructions(
  ctx: LpContext,
  amount: bigint,
  sourceAccounts: LpBurnSourceAccount[],
): TransactionInstruction[] {
  validateBurn(ctx, amount);
  if (!Array.isArray(sourceAccounts) || sourceAccounts.length === 0) {
    throw new Error('No LP token accounts are available to burn from');
  }

  const orderedAccounts = [...sourceAccounts].sort((a, b) => a.address.toBase58().localeCompare(b.address.toBase58()));
  let available = 0n;
  for (const account of orderedAccounts) {
    if (account.amount < 0n || account.decimals !== ctx.lpDecimals) {
      throw new Error('LP token account data does not match the verified mint');
    }
    available += account.amount;
  }
  if (available < amount) throw new Error('LP burn amount exceeds the available balance');

  let remaining = amount;
  const instructions: TransactionInstruction[] = [];
  for (const account of orderedAccounts) {
    if (remaining === 0n) break;
    const burnAmount = account.amount < remaining ? account.amount : remaining;
    if (burnAmount === 0n) continue;
    instructions.push(createBurnCheckedInstruction(
      account.address,
      ctx.lpMint,
      ctx.userWallet,
      burnAmount,
      ctx.lpDecimals,
      [],
      ctx.tokenProgramId ?? TOKEN_PROGRAM_ID,
    ));
    remaining -= burnAmount;
  }
  if (remaining !== 0n) throw new Error('Could not allocate the requested LP burn amount');

  logger.info({ lpMint: ctx.lpMint.toBase58(), amount: amount.toString(), accounts: instructions.length }, 'Built LP burn instructions');
  return instructions;
}

export const TEMPORAL_LP_LOCK_DAYS = 180;

// Streamflow's Devnet deployment and partner fee oracle. The Streamflow Rust
// SDK is MIT-licensed; the JS SDK is GPL-3.0, so Wire encodes the public Anchor
// ABI directly instead of adding the GPL package to this app.
export const STREAMFLOW_DEVNET_PROGRAM_ID = new PublicKey('HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ');
export const STREAMFLOW_DEVNET_TREASURY = new PublicKey('5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw');
export const STREAMFLOW_DEVNET_WITHDRAWOR = new PublicKey('wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u');
export const STREAMFLOW_DEVNET_FEE_ORACLE = new PublicKey('Aa2JJfFzUN3V54DXUHRBJowFw416xfZHpPk9DaNy3iYs');
export const STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM = new PublicKey('pardoTarcc6HKsPcbXkVycxsJsoN9QEzrdHgVdHAGY3');

const STREAMFLOW_CREATE_V2_DISCRIMINATOR = createHash('sha256').update('global:create_v2').digest().subarray(0, 8);
const PARTNER_ORACLE_GET_VESTING_FEES_DISCRIMINATOR = Buffer.from([239, 230, 28, 173, 134, 247, 57, 176]);
const STREAMFLOW_METADATA_SEED = Buffer.from('strm-met');
const STREAMFLOW_ESCROW_SEED = Buffer.from('strm');

export interface TemporalLockFeeQuote {
  creationFeeLamports: number;
  tokenLockFeePercent: number;
  feeConfigWallet: string;
  quotedAt: number;
}

export interface TemporalLockInstructionResult {
  instruction: TransactionInstruction;
  metadataAddress: PublicKey;
  escrowAddress: PublicKey;
  senderTokenAddress: PublicKey;
  treasuryTokenAddress: PublicKey;
}

export function calculateTemporalLockTokenFeeRaw(amount: bigint, feePercent: number): bigint {
  if (amount < 0n || !Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
    throw new Error('Streamflow lock fee inputs are invalid');
  }
  // Matches Streamflow's published Rust SDK calculation: truncate the
  // percentage factor to six decimal places, then use integer arithmetic.
  const factor = BigInt(Math.floor((feePercent / 100) * 1_000_000));
  return amount * factor / 1_000_000n;
}

function writeU64LE(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('Streamflow lock amount is outside the supported range');
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value);
  return result;
}

function deriveStreamflowMetadata(mint: PublicKey, sender: PublicKey, nonce: number): PublicKey {
  const nonceBytes = Buffer.alloc(4);
  nonceBytes.writeUInt32BE(nonce);
  return PublicKey.findProgramAddressSync(
    [STREAMFLOW_METADATA_SEED, mint.toBuffer(), sender.toBuffer(), nonceBytes],
    STREAMFLOW_DEVNET_PROGRAM_ID,
  )[0];
}

export function buildTemporalLockInstruction(
  ctx: LpContext,
  amount: bigint,
  unlockTimestamp: number,
  nonce: number,
): TemporalLockInstructionResult {
  validateBurn(ctx, amount);
  if (amount < 2n) throw new Error('A Streamflow LP lock must contain at least two raw LP units');
  if (!Number.isSafeInteger(unlockTimestamp) || unlockTimestamp <= 0) throw new Error('Streamflow unlock time is invalid');
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffff_ffff) throw new Error('Streamflow metadata nonce is invalid');
  if (!(ctx.tokenProgramId ?? TOKEN_PROGRAM_ID).equals(TOKEN_PROGRAM_ID)) {
    throw new Error('Wire only supports Streamflow LP locks for the classic SPL Token program');
  }

  const senderTokenAddress = getAssociatedTokenAddressSync(ctx.lpMint, ctx.userWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const recipientTokenAddress = senderTokenAddress;
  const metadataAddress = deriveStreamflowMetadata(ctx.lpMint, ctx.userWallet, nonce);
  const escrowAddress = PublicKey.findProgramAddressSync(
    [STREAMFLOW_ESCROW_SEED, metadataAddress.toBuffer()],
    STREAMFLOW_DEVNET_PROGRAM_ID,
  )[0];
  const treasuryTokenAddress = getAssociatedTokenAddressSync(
    ctx.lpMint,
    STREAMFLOW_DEVNET_TREASURY,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const streamName = Buffer.alloc(64);
  Buffer.from(`Wire LP lock ${TEMPORAL_LP_LOCK_DAYS} days`, 'utf8').copy(streamName);
  const nonceLe = Buffer.alloc(4);
  nonceLe.writeUInt32LE(nonce);
  const instructionData = Buffer.concat([
    STREAMFLOW_CREATE_V2_DISCRIMINATOR,
    writeU64LE(BigInt(unlockTimestamp)), // start_time
    writeU64LE(amount), // net_amount_deposited
    writeU64LE(1n), // period
    writeU64LE(1n), // amount_per_period (one raw unit after the cliff)
    writeU64LE(BigInt(unlockTimestamp)), // cliff
    writeU64LE(amount - 1n), // cliff_amount
    Buffer.alloc(6), // non-cancelable, non-transferable, no top-up/auto-withdrawal
    streamName,
    writeU64LE(0n), // withdraw_frequency
    Buffer.from([0, 0]), // pausable, can_update_rate
    nonceLe,
  ]);

  const instruction = new TransactionInstruction({
    programId: STREAMFLOW_DEVNET_PROGRAM_ID,
    keys: [
      { pubkey: ctx.userWallet, isSigner: true, isWritable: true },
      { pubkey: senderTokenAddress, isSigner: false, isWritable: true },
      { pubkey: ctx.userWallet, isSigner: false, isWritable: true },
      { pubkey: metadataAddress, isSigner: false, isWritable: true },
      { pubkey: escrowAddress, isSigner: false, isWritable: true },
      { pubkey: recipientTokenAddress, isSigner: false, isWritable: true },
      { pubkey: STREAMFLOW_DEVNET_TREASURY, isSigner: false, isWritable: true },
      { pubkey: treasuryTokenAddress, isSigner: false, isWritable: true },
      { pubkey: STREAMFLOW_DEVNET_WITHDRAWOR, isSigner: false, isWritable: true },
      { pubkey: STREAMFLOW_DEVNET_TREASURY, isSigner: false, isWritable: true },
      { pubkey: treasuryTokenAddress, isSigner: false, isWritable: true },
      { pubkey: ctx.lpMint, isSigner: false, isWritable: false },
      { pubkey: STREAMFLOW_DEVNET_FEE_ORACLE, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: STREAMFLOW_DEVNET_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });

  return { instruction, metadataAddress, escrowAddress, senderTokenAddress, treasuryTokenAddress };
}

/** Read live Devnet fees through Streamflow's read-only fee-oracle instruction. */
export async function getTemporalLockFeeQuote(connection: Connection): Promise<TemporalLockFeeQuote> {
  const feeOracleAccount = await connection.getAccountInfo(STREAMFLOW_DEVNET_FEE_ORACLE, 'confirmed');
  if (!feeOracleAccount || !feeOracleAccount.owner.equals(STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM)) {
    throw new Error('Streamflow Devnet fee oracle is unavailable or has an unexpected owner');
  }

  const quoteInstruction = new TransactionInstruction({
    programId: STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM,
    keys: [{ pubkey: STREAMFLOW_DEVNET_FEE_ORACLE, isSigner: false, isWritable: false }],
    data: Buffer.concat([PARTNER_ORACLE_GET_VESTING_FEES_DISCRIMINATOR, STREAMFLOW_DEVNET_TREASURY.toBuffer()]),
  });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: STREAMFLOW_DEVNET_TREASURY,
    recentBlockhash: blockhash,
    instructions: [quoteInstruction],
  }).compileToV0Message();
  const simulation = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });
  const result = simulation.value;
  const returnData = result.returnData;
  if (result.err || !returnData || returnData.programId !== STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM.toBase58()) {
    throw new Error('Streamflow Devnet fee quote could not be verified');
  }

  const feeBytes = Buffer.from(returnData.data[0], 'base64');
  // The partner oracle's VestingFees return struct is:
  // pubkey (32), creation_fee (u32), auto_claim_fee (u32),
  // token_fee_percent (f32), token_lock_token_fee_percent (f32).
  if (feeBytes.length !== 48) throw new Error('Streamflow Devnet fee quote has an unsupported layout');
  const creationFeeLamports = feeBytes.readUInt32LE(32);
  const tokenLockFeePercent = feeBytes.readFloatLE(44);
  if (!Number.isFinite(tokenLockFeePercent) || tokenLockFeePercent < 0 || tokenLockFeePercent > 100) {
    throw new Error('Streamflow Devnet returned an invalid LP token fee');
  }

  return {
    creationFeeLamports,
    tokenLockFeePercent,
    feeConfigWallet: new PublicKey(feeBytes.subarray(0, 32)).toBase58(),
    quotedAt: Date.now(),
  };
}
