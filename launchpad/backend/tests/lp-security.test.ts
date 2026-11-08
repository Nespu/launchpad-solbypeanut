import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, type Connection } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  buildLpBurnInstructions,
  buildTemporalLockInstruction,
  calculateTemporalLockTokenFeeRaw,
  getTemporalLockFeeQuote,
  STREAMFLOW_DEVNET_FEE_ORACLE,
  STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM,
  STREAMFLOW_DEVNET_PROGRAM_ID,
  STREAMFLOW_DEVNET_TREASURY,
  STREAMFLOW_DEVNET_WITHDRAWOR,
  TEMPORAL_LP_LOCK_DAYS,
} from '../src/services/lpSecurityService';

const wallet = new PublicKey(Buffer.alloc(32, 1));
const mint = new PublicKey(Buffer.alloc(32, 2));
const firstAccount = new PublicKey(Buffer.alloc(32, 3));
const secondAccount = new PublicKey(Buffer.alloc(32, 4));
const context = { userWallet: wallet, lpMint: mint, lpDecimals: 9, tokenProgramId: TOKEN_PROGRAM_ID };

test('LP burn builds exact checked instructions across multiple source accounts', () => {
  const instructions = buildLpBurnInstructions(context, 10n, [
    { address: secondAccount, amount: 8n, decimals: 9 },
    { address: firstAccount, amount: 3n, decimals: 9 },
  ]);

  assert.equal(instructions.length, 2);
  assert.deepEqual(instructions.map((instruction) => Buffer.from(instruction.data).readBigUInt64LE(1)), [3n, 7n]);
  assert.ok(instructions.every((instruction) => instruction.programId.equals(TOKEN_PROGRAM_ID)));
  assert.deepEqual(instructions.map((instruction) => instruction.keys[0]?.pubkey.toBase58()), [
    firstAccount.toBase58(), secondAccount.toBase58(),
  ]);
});

test('LP burn rejects zero, over-balance, and mismatched-decimal requests', () => {
  const source = [{ address: firstAccount, amount: 5n, decimals: 9 }];
  assert.throws(() => buildLpBurnInstructions(context, 0n, source), /greater than zero/);
  assert.throws(() => buildLpBurnInstructions(context, 6n, source), /exceeds the available balance/);
  assert.throws(() => buildLpBurnInstructions(context, 2n, [{ ...source[0]!, decimals: 8 }]), /does not match the verified mint/);
});

test('LP burn rejects empty source accounts and invalid LP decimals', () => {
  assert.throws(() => buildLpBurnInstructions(context, 1n, []), /No LP token accounts/);
  assert.throws(() => buildLpBurnInstructions({ ...context, lpDecimals: 19 }, 1n, [
    { address: firstAccount, amount: 1n, decimals: 19 },
  ]), /between 0 and 18/);
});

test('Streamflow lock encodes the reviewed 180-day, non-cancelable schedule and canonical account layout', () => {
  const amount = 25_000_000_000n;
  const unlockTimestamp = 1_800_000_000;
  const nonce = 7;
  const result = buildTemporalLockInstruction(context, amount, unlockTimestamp, nonce);
  const instruction = result.instruction;
  const data = Buffer.from(instruction.data);
  const keys = instruction.keys;

  assert.equal(instruction.programId.toBase58(), STREAMFLOW_DEVNET_PROGRAM_ID.toBase58());
  assert.equal(data.length, 140);
  assert.equal(data.subarray(0, 8).toString('hex'), 'd6904cec5f8b31b4');
  assert.equal(data.readBigUInt64LE(8), BigInt(unlockTimestamp));
  assert.equal(data.readBigUInt64LE(16), amount);
  assert.equal(data.readBigUInt64LE(24), 1n);
  assert.equal(data.readBigUInt64LE(32), 1n);
  assert.equal(data.readBigUInt64LE(40), BigInt(unlockTimestamp));
  assert.equal(data.readBigUInt64LE(48), amount - 1n);
  assert.ok(data.subarray(56, 62).every((flag) => flag === 0));
  assert.equal(data.subarray(62, 126).toString('utf8').replace(/\0+$/, ''), `Wire LP lock ${TEMPORAL_LP_LOCK_DAYS} days`);
  assert.equal(data.readBigUInt64LE(126), 0n);
  assert.deepEqual([...data.subarray(134, 136)], [0, 0]);
  assert.equal(data.readUInt32LE(136), nonce);

  const sourceAta = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const treasuryAta = getAssociatedTokenAddressSync(mint, STREAMFLOW_DEVNET_TREASURY, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  assert.deepEqual(keys.map((key) => key.pubkey.toBase58()), [
    wallet.toBase58(), sourceAta.toBase58(), wallet.toBase58(), result.metadataAddress.toBase58(),
    result.escrowAddress.toBase58(), sourceAta.toBase58(), STREAMFLOW_DEVNET_TREASURY.toBase58(),
    treasuryAta.toBase58(), STREAMFLOW_DEVNET_WITHDRAWOR.toBase58(), STREAMFLOW_DEVNET_TREASURY.toBase58(),
    treasuryAta.toBase58(), mint.toBase58(), STREAMFLOW_DEVNET_FEE_ORACLE.toBase58(),
    'SysvarRent111111111111111111111111111111111', STREAMFLOW_DEVNET_PROGRAM_ID.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), '11111111111111111111111111111111',
  ]);
  assert.ok(keys[0]?.isSigner);
  assert.ok(keys.slice(1).every((key) => !key.isSigner));
  assert.ok(keys.slice(0, 11).every((key) => key.isWritable));
  assert.ok(keys.slice(11).every((key) => !key.isWritable));
  assert.equal(result.senderTokenAddress.toBase58(), sourceAta.toBase58());
  assert.equal(result.treasuryTokenAddress.toBase58(), treasuryAta.toBase58());
});

test('Streamflow lock rejects unsupported programs, tiny amounts, and invalid schedules', () => {
  assert.throws(() => buildTemporalLockInstruction(context, 1n, 1_800_000_000, 0), /at least two raw LP units/);
  assert.throws(() => buildTemporalLockInstruction({ ...context, tokenProgramId: TOKEN_2022_PROGRAM_ID }, 10n, 1_800_000_000, 0), /classic SPL Token/);
  assert.throws(() => buildTemporalLockInstruction(context, 10n, 0, 0), /unlock time is invalid/);
  assert.throws(() => buildTemporalLockInstruction(context, 10n, 1_800_000_000, -1), /nonce is invalid/);
  assert.throws(() => buildTemporalLockInstruction(context, 10n, 1_800_000_000, 0x1_0000_0000), /nonce is invalid/);
});

test('Streamflow token fee uses integer arithmetic and rejects invalid input', () => {
  assert.equal(calculateTemporalLockTokenFeeRaw(1_000_000_000n, 0.1), 1_000_000n);
  assert.equal(calculateTemporalLockTokenFeeRaw(999n, 0.1), 0n);
  assert.throws(() => calculateTemporalLockTokenFeeRaw(-1n, 0.1), /inputs are invalid/);
  assert.throws(() => calculateTemporalLockTokenFeeRaw(100n, Number.NaN), /inputs are invalid/);
  assert.throws(() => calculateTemporalLockTokenFeeRaw(100n, 100.1), /inputs are invalid/);
});

test('Streamflow fee quote validates the oracle owner and decodes only the supported live layout', async () => {
  const configWallet = new PublicKey(Buffer.alloc(32, 9));
  const feeBytes = Buffer.alloc(48);
  configWallet.toBuffer().copy(feeBytes, 0);
  feeBytes.writeUInt32LE(1234, 32);
  feeBytes.writeUInt32LE(100, 36);
  feeBytes.writeFloatLE(0, 40);
  feeBytes.writeFloatLE(0.1, 44);
  const connection = {
    getAccountInfo: async () => ({ owner: STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM }),
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
    simulateTransaction: async () => ({ value: {
      err: null,
      returnData: { programId: STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM.toBase58(), data: [feeBytes.toString('base64'), 'base64'] },
    } }),
  } as unknown as Connection;

  const quote = await getTemporalLockFeeQuote(connection);
  assert.equal(quote.creationFeeLamports, 1234);
  assert.ok(Math.abs(quote.tokenLockFeePercent - 0.1) < 1e-7);
  assert.equal(quote.feeConfigWallet, configWallet.toBase58());
  assert.ok(Number.isFinite(quote.quotedAt));

  const wrongOwner = {
    ...connection,
    getAccountInfo: async () => ({ owner: PublicKey.default }),
  } as unknown as Connection;
  await assert.rejects(getTemporalLockFeeQuote(wrongOwner), /unexpected owner/);

  const malformedQuote = {
    ...connection,
    simulateTransaction: async () => ({ value: {
      err: null,
      returnData: { programId: STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM.toBase58(), data: [Buffer.alloc(43).toString('base64'), 'base64'] },
    } }),
  } as unknown as Connection;
  await assert.rejects(getTemporalLockFeeQuote(malformedQuote), /unsupported layout/);

  const unexpectedProgram = {
    ...connection,
    simulateTransaction: async () => ({ value: {
      err: null,
      returnData: { programId: PublicKey.default.toBase58(), data: [feeBytes.toString('base64'), 'base64'] },
    } }),
  } as unknown as Connection;
  await assert.rejects(getTemporalLockFeeQuote(unexpectedProgram), /could not be verified/);

  const invalidTokenFeeBytes = Buffer.from(feeBytes);
  invalidTokenFeeBytes.writeFloatLE(100.1, 44);
  const invalidTokenFee = {
    ...connection,
    simulateTransaction: async () => ({ value: {
      err: null,
      returnData: { programId: STREAMFLOW_DEVNET_PARTNER_ORACLE_PROGRAM.toBase58(), data: [invalidTokenFeeBytes.toString('base64'), 'base64'] },
    } }),
  } as unknown as Connection;
  await assert.rejects(getTemporalLockFeeQuote(invalidTokenFee), /invalid LP token fee/);
  assert.ok(STREAMFLOW_DEVNET_FEE_ORACLE.toBase58());
});
