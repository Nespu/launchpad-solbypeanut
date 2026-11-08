import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import test from 'node:test';
import { ClmmConfigLayout, PoolInfoLayout } from '@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout';
import { DEV_CREATE_CPMM_POOL_PROGRAM, DEVNET_PROGRAM_ID, fixedSwapInLayout, fixedSwapOutLayout, liquidityStateV4Layout, liquidityStateV5Layout } from '@raydium-io/raydium-sdk-v2';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import type { Request, Response } from 'express';
import { createSwapHandlers } from '../src/controllers/swapController';
import { DEVNET_USDC_MINT_ADDRESS } from '../src/services/poolQuoteAsset';
import { verifyConfirmedExternalSwap, verifyConfirmedRaydiumSwap } from '../src/services/swapHistoryService';

const SWAP_EVENT_DISCRIMINATOR = createHash('sha256').update('event:SwapEvent').digest().subarray(0, 8);
const CLMM_PROGRAM_ID = new PublicKey('DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH');
const CLMM_SWAP_DISCRIMINATOR = createHash('sha256').update('global:swap').digest().subarray(0, 8);
const CLMM_POOL_STATE_DISCRIMINATOR = createHash('sha256').update('account:PoolState').digest().subarray(0, 8);
const CLMM_CONFIG_STATE_DISCRIMINATOR = createHash('sha256').update('account:AmmConfig').digest().subarray(0, 8);
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

type EventInput = {
  pool: PublicKey;
  inputAmount: bigint;
  outputAmount: bigint;
  inputMint: PublicKey;
  outputMint: PublicKey;
};

function encodeSwapEvent(input: EventInput): string {
  const data = Buffer.alloc(170);
  let offset = 0;
  SWAP_EVENT_DISCRIMINATOR.copy(data, offset);
  offset += 8;
  input.pool.toBuffer().copy(data, offset);
  offset += 32;
  for (const value of [100_000_000n, 200_000_000n, input.inputAmount, input.outputAmount, 0n, 0n]) {
    data.writeBigUInt64LE(value, offset);
    offset += 8;
  }
  data[offset++] = 1; // baseInput
  input.inputMint.toBuffer().copy(data, offset);
  offset += 32;
  input.outputMint.toBuffer().copy(data, offset);
  offset += 32;
  data.writeBigUInt64LE(0n, offset);
  offset += 8;
  data.writeBigUInt64LE(0n, offset);
  offset += 8;
  data[offset] = 1; // creatorFeeOnInput
  return data.toString('base64');
}

function createConfirmedSwap(input: {
  signature: string;
  wallet: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  side: 'buy' | 'sell';
  quoteBefore: bigint;
  quoteAfter: bigint;
  tokenBefore: bigint;
  tokenAfter: bigint;
  eventQuoteAmount?: bigint;
}) {
  const quoteMint = new PublicKey(DEVNET_USDC_MINT_ADDRESS);
  const event = encodeSwapEvent({
    pool: input.pool,
    inputAmount: input.side === 'buy'
      ? input.eventQuoteAmount ?? input.quoteBefore - input.quoteAfter
      : input.tokenBefore - input.tokenAfter,
    outputAmount: input.side === 'buy'
      ? input.tokenAfter - input.tokenBefore
      : input.eventQuoteAmount ?? input.quoteAfter - input.quoteBefore,
    inputMint: input.side === 'buy' ? quoteMint : input.mint,
    outputMint: input.side === 'buy' ? input.mint : quoteMint,
  });
  const parsedTransaction = {
    slot: 42,
    blockTime: 1_797_000_000,
    transaction: {
      signatures: [input.signature],
      message: {
        accountKeys: [{ pubkey: input.wallet, signer: true }],
        instructions: [{
          programId: DEV_CREATE_CPMM_POOL_PROGRAM,
          accounts: [input.pool, input.mint, quoteMint],
        }],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      logMessages: [
        `Program ${DEV_CREATE_CPMM_POOL_PROGRAM.toBase58()} invoke [1]`,
        `Program data: ${event}`,
        `Program ${DEV_CREATE_CPMM_POOL_PROGRAM.toBase58()} success`,
      ],
      preTokenBalances: [
        { accountIndex: 2, mint: input.mint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: input.tokenBefore.toString(), decimals: 6 } },
        { accountIndex: 3, mint: quoteMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: input.quoteBefore.toString(), decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: input.mint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: input.tokenAfter.toString(), decimals: 6 } },
        { accountIndex: 3, mint: quoteMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: input.quoteAfter.toString(), decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
  const connection = {
    getParsedTransaction: async () => parsedTransaction,
  } as unknown as Connection;
  return { connection, quoteMint };
}

test('USDC buy history verifies Raydium event, wallet signature, and both token balance deltas', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const pool = newPublicKey();
  const signature = bs58.encode(Buffer.alloc(64, 7));
  const { connection, quoteMint } = createConfirmedSwap({
    signature,
    wallet,
    mint,
    pool,
    side: 'buy',
    quoteBefore: 20_000_000n,
    quoteAfter: 19_000_000n,
    tokenBefore: 0n,
    tokenAfter: 2_500_000n,
  });

  const result = await verifyConfirmedRaydiumSwap(
    connection, signature, wallet.toBase58(), mint.toBase58(), quoteMint.toBase58(), pool.toBase58(), 'buy',
  );
  assert.ok(result);
  assert.equal(result.quoteAmountRaw, 1_000_000n);
  assert.equal(result.quoteMint, DEVNET_USDC_MINT_ADDRESS);
  assert.equal(result.quoteDecimals, 6);
  assert.equal(result.solAmountLamports, null);
  assert.equal(result.tokenAmountRaw, 2_500_000n);
  assert.equal(result.networkFeeLamports, 5_000n);
});

test('USDC sell history records quote received and rejects an unrelated wallet balance delta', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const pool = newPublicKey();
  const signature = bs58.encode(Buffer.alloc(64, 8));
  const valid = createConfirmedSwap({
    signature,
    wallet,
    mint,
    pool,
    side: 'sell',
    quoteBefore: 19_000_000n,
    quoteAfter: 20_000_000n,
    tokenBefore: 2_500_000n,
    tokenAfter: 0n,
  });
  const result = await verifyConfirmedRaydiumSwap(
    valid.connection, signature, wallet.toBase58(), mint.toBase58(), valid.quoteMint.toBase58(), pool.toBase58(), 'sell',
  );
  assert.ok(result);
  assert.equal(result.quoteAmountRaw, 1_000_000n);
  assert.equal(result.tokenAmountRaw, 2_500_000n);

  const mismatched = createConfirmedSwap({
    signature,
    wallet,
    mint,
    pool,
    side: 'sell',
    quoteBefore: 19_000_000n,
    quoteAfter: 19_999_999n,
    tokenBefore: 2_500_000n,
    tokenAfter: 0n,
    eventQuoteAmount: 1_000_000n,
  });
  await assert.rejects(
    verifyConfirmedRaydiumSwap(
      mismatched.connection, signature, wallet.toBase58(), mint.toBase58(), mismatched.quoteMint.toBase58(), pool.toBase58(), 'sell',
    ),
    /quote-token balance change does not match/,
  );
});

test('external Raydium CPMM swaps are discovered and verified without a Wire token record', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const pool = newPublicKey();
  const signature = bs58.encode(Buffer.alloc(64, 9));
  const { connection, quoteMint } = createConfirmedSwap({
    signature,
    wallet,
    mint,
    pool,
    side: 'buy',
    quoteBefore: 20_000_000n,
    quoteAfter: 19_000_000n,
    tokenBefore: 0n,
    tokenAfter: 2_500_000n,
  });

  const result = await verifyConfirmedExternalSwap(connection, signature, wallet.toBase58(), mint.toBase58(), 'buy');
  assert.ok(result);
  assert.equal(result.venue, 'RAYDIUM');
  assert.equal(result.marketAddress, pool.toBase58());
  assert.equal(result.quoteMint, quoteMint.toBase58());
  assert.equal(result.quoteAmountRaw, 1_000_000n);
  assert.equal(result.tokenAmountRaw, 2_500_000n);
});

function createConfirmedAmmV4Swap(input: {
  side: 'buy' | 'sell';
  signature: string;
  wallet: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  quoteBefore: bigint;
  quoteAfter: bigint;
  tokenBefore: bigint;
  tokenAfter: bigint;
  minimumOrExactOutput: bigint;
  useExactOutput?: boolean;
  omitTargetOrders?: boolean;
  marketKind?: 'V4' | 'STABLE';
}) {
  const isStable = input.marketKind === 'STABLE';
  const quoteMint = new PublicKey(DEVNET_USDC_MINT_ADDRESS);
  const openOrders = newPublicKey();
  const targetOrders = newPublicKey();
  const baseVault = newPublicKey();
  const quoteVault = newPublicKey();
  const modelDataAccount = newPublicKey();
  const marketProgram = newPublicKey();
  const market = newPublicKey();
  const source = newPublicKey();
  const destination = newPublicKey();
  const accounts = [
    newPublicKey(), input.pool, newPublicKey(), openOrders,
    ...(input.omitTargetOrders ? [] : [targetOrders]),
    baseVault, quoteVault, ...(isStable ? [modelDataAccount] : []),
    marketProgram, market, newPublicKey(), newPublicKey(), newPublicKey(),
    newPublicKey(), newPublicKey(), newPublicKey(), source, destination, input.wallet,
  ];
  const amountData = Buffer.alloc(input.useExactOutput ? fixedSwapOutLayout.span : fixedSwapInLayout.span);
  amountData[0] = input.useExactOutput ? 11 : 9;
  const quoteInput = input.side === 'buy' ? input.quoteBefore - input.quoteAfter : input.tokenBefore - input.tokenAfter;
  amountData.writeBigUInt64LE(input.useExactOutput ? (input.side === 'buy' ? quoteInput + 100n : quoteInput) : quoteInput, 1);
  amountData.writeBigUInt64LE(input.minimumOrExactOutput, 9);

  const layout = isStable ? liquidityStateV5Layout : liquidityStateV4Layout;
  const poolData = Buffer.alloc(layout.span);
  if (isStable) {
    poolData.writeBigUInt64LE(6n, 40); // Base mint decimals.
    poolData.writeBigUInt64LE(6n, 48); // Quote mint decimals.
    baseVault.toBuffer().copy(poolData, 368);
    quoteVault.toBuffer().copy(poolData, 400);
    input.mint.toBuffer().copy(poolData, 432);
    quoteMint.toBuffer().copy(poolData, 464);
    newPublicKey().toBuffer().copy(poolData, 496); // LP mint.
    modelDataAccount.toBuffer().copy(poolData, 528);
    openOrders.toBuffer().copy(poolData, 560);
    market.toBuffer().copy(poolData, 592);
    marketProgram.toBuffer().copy(poolData, 624);
    targetOrders.toBuffer().copy(poolData, 656);
  } else {
    poolData.writeBigUInt64LE(6n, 32); // Base mint decimals.
    poolData.writeBigUInt64LE(6n, 40); // Quote mint decimals.
    baseVault.toBuffer().copy(poolData, 336);
    quoteVault.toBuffer().copy(poolData, 368);
    input.mint.toBuffer().copy(poolData, 400);
    quoteMint.toBuffer().copy(poolData, 432);
    newPublicKey().toBuffer().copy(poolData, 464); // LP mint.
    openOrders.toBuffer().copy(poolData, 496);
    market.toBuffer().copy(poolData, 528);
    marketProgram.toBuffer().copy(poolData, 560);
    targetOrders.toBuffer().copy(poolData, 592);
  }

  const accountKeys = accounts.map((pubkey) => ({ pubkey, signer: pubkey.equals(input.wallet) }));
  const sourceIndex = accounts.findIndex((account) => account.equals(source));
  const destinationIndex = accounts.findIndex((account) => account.equals(destination));
  const sourceMint = input.side === 'buy' ? quoteMint : input.mint;
  const destinationMint = input.side === 'buy' ? input.mint : quoteMint;
  const sourceBefore = input.side === 'buy' ? input.quoteBefore : input.tokenBefore;
  const sourceAfter = input.side === 'buy' ? input.quoteAfter : input.tokenAfter;
  const destinationBefore = input.side === 'buy' ? input.tokenBefore : input.quoteBefore;
  const destinationAfter = input.side === 'buy' ? input.tokenAfter : input.quoteAfter;
  const parsedTransaction = {
    slot: 75,
    blockTime: 1_797_000_000,
    transaction: {
      signatures: [input.signature],
      message: {
        accountKeys,
        instructions: [{ programId: isStable ? DEVNET_PROGRAM_ID.AmmStable : DEVNET_PROGRAM_ID.AmmV4, accounts, data: bs58.encode(amountData) }],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preTokenBalances: [
        { accountIndex: sourceIndex, mint: sourceMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: sourceBefore.toString(), decimals: 6 } },
        { accountIndex: destinationIndex, mint: destinationMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: destinationBefore.toString(), decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: sourceIndex, mint: sourceMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: sourceAfter.toString(), decimals: 6 } },
        { accountIndex: destinationIndex, mint: destinationMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: destinationAfter.toString(), decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
  const connection = {
    getParsedTransaction: async () => parsedTransaction,
    getAccountInfo: async () => ({ owner: isStable ? DEVNET_PROGRAM_ID.AmmStable : DEVNET_PROGRAM_ID.AmmV4, data: poolData }),
  } as unknown as Connection;
  return { connection, quoteMint, parsedTransaction };
}

function createConfirmedClmmSwap(input: {
  side: 'buy' | 'sell';
  signature: string;
  wallet: PublicKey;
  mint: PublicKey;
  quoteBefore: bigint;
  quoteAfter: bigint;
  tokenBefore: bigint;
  tokenAfter: bigint;
  minimumOrExactOutput: bigint;
  useExactOutput?: boolean;
  wrongPoolOwner?: boolean;
  quoteMintAddress?: string;
}) {
  const quoteMint = new PublicKey(input.quoteMintAddress ?? DEVNET_USDC_MINT_ADDRESS);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('amm_config'), Buffer.from([0, 0])], CLMM_PROGRAM_ID);
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), config.toBuffer(), input.mint.toBuffer(), quoteMint.toBuffer()],
    CLMM_PROGRAM_ID,
  );
  const [vaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), pool.toBuffer(), input.mint.toBuffer()], CLMM_PROGRAM_ID,
  );
  const [vaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), pool.toBuffer(), quoteMint.toBuffer()], CLMM_PROGRAM_ID,
  );
  const [observation] = PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), pool.toBuffer()], CLMM_PROGRAM_ID,
  );
  const source = newPublicKey();
  const destination = newPublicKey();
  const tickArray = newPublicKey();
  const inputMint = input.side === 'buy' ? quoteMint : input.mint;
  const outputMint = input.side === 'buy' ? input.mint : quoteMint;
  const inputVault = input.side === 'buy' ? vaultB : vaultA;
  const outputVault = input.side === 'buy' ? vaultA : vaultB;
  const accounts = [
    input.wallet, config, pool, source, destination, inputVault, outputVault, observation,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MEMO_PROGRAM_ID, inputMint, outputMint, tickArray,
  ];
  const amountData = Buffer.alloc(41);
  CLMM_SWAP_DISCRIMINATOR.copy(amountData);
  const actualInput = input.side === 'buy' ? input.quoteBefore - input.quoteAfter : input.tokenBefore - input.tokenAfter;
  const actualOutput = input.side === 'buy' ? input.tokenAfter - input.tokenBefore : input.quoteAfter - input.quoteBefore;
  amountData.writeBigUInt64LE(input.useExactOutput ? actualOutput : actualInput, 8);
  amountData.writeBigUInt64LE(input.minimumOrExactOutput, 16);
  amountData.writeBigUInt64LE(0n, 24);
  amountData.writeBigUInt64LE(1n, 32); // Non-zero Q64.64 sqrt-price limit.
  amountData[40] = input.useExactOutput ? 0 : 1;

  const configData = Buffer.alloc(ClmmConfigLayout.span);
  CLMM_CONFIG_STATE_DISCRIMINATOR.copy(configData);
  configData.writeUInt16LE(0, 9);
  const poolData = Buffer.alloc(PoolInfoLayout.span);
  CLMM_POOL_STATE_DISCRIMINATOR.copy(poolData);
  config.toBuffer().copy(poolData, 9);
  input.mint.toBuffer().copy(poolData, 73);
  quoteMint.toBuffer().copy(poolData, 105);
  vaultA.toBuffer().copy(poolData, 137);
  vaultB.toBuffer().copy(poolData, 169);
  observation.toBuffer().copy(poolData, 201);
  poolData[233] = 6;
  poolData[234] = 6;
  poolData.writeUInt16LE(60, 235);

  const accountKeys = accounts.map((pubkey) => ({ pubkey, signer: pubkey.equals(input.wallet) }));
  const sourceIndex = accounts.findIndex((account) => account.equals(source));
  const destinationIndex = accounts.findIndex((account) => account.equals(destination));
  const sourceMint = input.side === 'buy' ? quoteMint : input.mint;
  const destinationMint = input.side === 'buy' ? input.mint : quoteMint;
  const sourceBefore = input.side === 'buy' ? input.quoteBefore : input.tokenBefore;
  const sourceAfter = input.side === 'buy' ? input.quoteAfter : input.tokenAfter;
  const destinationBefore = input.side === 'buy' ? input.tokenBefore : input.quoteBefore;
  const destinationAfter = input.side === 'buy' ? input.tokenAfter : input.quoteAfter;
  const parsedTransaction = {
    slot: 90,
    blockTime: 1_797_000_000,
    transaction: {
      signatures: [input.signature],
      message: {
        accountKeys,
        instructions: [{ programId: CLMM_PROGRAM_ID, accounts, data: bs58.encode(amountData) }],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preTokenBalances: [
        { accountIndex: sourceIndex, mint: sourceMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: sourceBefore.toString(), decimals: 6 } },
        { accountIndex: destinationIndex, mint: destinationMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: destinationBefore.toString(), decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: sourceIndex, mint: sourceMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: sourceAfter.toString(), decimals: 6 } },
        { accountIndex: destinationIndex, mint: destinationMint.toBase58(), owner: input.wallet.toBase58(), uiTokenAmount: { amount: destinationAfter.toString(), decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
  const connection = {
    getParsedTransaction: async () => parsedTransaction,
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(pool)) {
        return { owner: input.wrongPoolOwner ? newPublicKey() : CLMM_PROGRAM_ID, data: poolData };
      }
      if (address.equals(config)) return { owner: CLMM_PROGRAM_ID, data: configData };
      return null;
    },
  } as unknown as Connection;
  return { connection, quoteMint, pool, parsedTransaction };
}

test('external Raydium CLMM exact-in buy and exact-out sell verify canonical state, signer, and token deltas', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const buySignature = bs58.encode(Buffer.alloc(64, 21));
  const buy = createConfirmedClmmSwap({
    side: 'buy', signature: buySignature, wallet, mint,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
  });
  const buyResult = await verifyConfirmedExternalSwap(buy.connection, buySignature, wallet.toBase58(), mint.toBase58(), 'buy');
  assert.ok(buyResult);
  assert.equal(buyResult.venue, 'RAYDIUM_CLMM');
  assert.equal(buyResult.marketAddress, buy.pool.toBase58());
  assert.equal(buyResult.quoteMint, buy.quoteMint.toBase58());
  assert.equal(buyResult.quoteAmountRaw, 1_000_000n);
  assert.equal(buyResult.tokenAmountRaw, 2_500_000n);

  const sellSignature = bs58.encode(Buffer.alloc(64, 22));
  const sell = createConfirmedClmmSwap({
    side: 'sell', signature: sellSignature, wallet, mint,
    quoteBefore: 9_000_000n, quoteAfter: 10_000_000n,
    tokenBefore: 2_500_000n, tokenAfter: 0n, minimumOrExactOutput: 2_500_000n, useExactOutput: true,
  });
  const sellResult = await verifyConfirmedExternalSwap(sell.connection, sellSignature, wallet.toBase58(), mint.toBase58(), 'sell');
  assert.ok(sellResult);
  assert.equal(sellResult.venue, 'RAYDIUM_CLMM');
  assert.equal(sellResult.quoteAmountRaw, 1_000_000n);
  assert.equal(sellResult.tokenAmountRaw, 2_500_000n);
});

test('external Raydium CLMM history rejects a forged pool owner, mismatched vault, or violated amount limit', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const signature = bs58.encode(Buffer.alloc(64, 23));
  const wrongOwner = createConfirmedClmmSwap({
    side: 'buy', signature, wallet, mint,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n, wrongPoolOwner: true,
  });
  await assert.rejects(
    verifyConfirmedExternalSwap(wrongOwner.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /pool Raydium CLMM válida de Devnet/,
  );

  const mismatchedVault = createConfirmedClmmSwap({
    side: 'buy', signature, wallet, mint,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
  });
  mismatchedVault.parsedTransaction.transaction.message.instructions[0].accounts[5] = newPublicKey();
  await assert.rejects(
    verifyConfirmedExternalSwap(mismatchedVault.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /direcciones derivadas de la pool/,
  );

  const mixedInstruction = createConfirmedClmmSwap({
    side: 'buy', signature, wallet, mint,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
  });
  mixedInstruction.parsedTransaction.transaction.message.instructions.push({
    programId: newPublicKey(), accounts: [], data: bs58.encode(Buffer.alloc(0)),
  });
  await assert.rejects(
    verifyConfirmedExternalSwap(mixedInstruction.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /instrucciones adicionales fuera del swap CLMM/,
  );

  const badLimit = createConfirmedClmmSwap({
    side: 'buy', signature, wallet, mint,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
  });
  const instruction = badLimit.parsedTransaction.transaction.message.instructions[0];
  const data = Buffer.from(bs58.decode(instruction.data));
  data.writeBigUInt64LE(1_100_000n, 8);
  instruction.data = bs58.encode(data);
  await assert.rejects(
    verifyConfirmedExternalSwap(badLimit.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /importes exact-in\/exact-out de Raydium CLMM/,
  );

  const unsupportedQuote = createConfirmedClmmSwap({
    side: 'buy', signature, wallet, mint,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
    quoteMintAddress: newPublicKey().toBase58(),
  });
  await assert.rejects(
    verifyConfirmedExternalSwap(unsupportedQuote.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /activo de cotización admitido/,
  );
});

test('external Raydium AMM V4 exact-in and exact-out swaps verify pool state, signer, and both wallet balance deltas', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const pool = newPublicKey();
  const buySignature = bs58.encode(Buffer.alloc(64, 11));
  const buy = createConfirmedAmmV4Swap({
    side: 'buy', signature: buySignature, wallet, mint, pool,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
  });
  const buyResult = await verifyConfirmedExternalSwap(buy.connection, buySignature, wallet.toBase58(), mint.toBase58(), 'buy');
  assert.ok(buyResult);
  assert.equal(buyResult.venue, 'RAYDIUM_AMM_V4');
  assert.equal(buyResult.marketAddress, pool.toBase58());
  assert.equal(buyResult.quoteMint, buy.quoteMint.toBase58());
  assert.equal(buyResult.quoteAmountRaw, 1_000_000n);
  assert.equal(buyResult.tokenAmountRaw, 2_500_000n);
  assert.equal(buyResult.networkFeeLamports, 5_000n);

  const sellSignature = bs58.encode(Buffer.alloc(64, 12));
  const sell = createConfirmedAmmV4Swap({
    side: 'sell', signature: sellSignature, wallet, mint, pool,
    quoteBefore: 9_000_000n, quoteAfter: 10_000_000n,
    tokenBefore: 2_500_000n, tokenAfter: 0n, minimumOrExactOutput: 1_000_000n, useExactOutput: true, omitTargetOrders: true,
  });
  const sellResult = await verifyConfirmedExternalSwap(sell.connection, sellSignature, wallet.toBase58(), mint.toBase58(), 'sell');
  assert.ok(sellResult);
  assert.equal(sellResult.venue, 'RAYDIUM_AMM_V4');
  assert.equal(sellResult.quoteAmountRaw, 1_000_000n);
  assert.equal(sellResult.tokenAmountRaw, 2_500_000n);
});

test('external Raydium Stable AMM exact-in swaps verify the stable-pool state and model account', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const pool = newPublicKey();
  const signature = bs58.encode(Buffer.alloc(64, 14));
  const stableSwap = createConfirmedAmmV4Swap({
    side: 'buy', signature, wallet, mint, pool,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
    marketKind: 'STABLE',
  });
  const result = await verifyConfirmedExternalSwap(stableSwap.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy');
  assert.ok(result);
  assert.equal(result.venue, 'RAYDIUM_AMM_STABLE');
  assert.equal(result.marketAddress, pool.toBase58());
  assert.equal(result.quoteMint, stableSwap.quoteMint.toBase58());
  assert.equal(result.quoteAmountRaw, 1_000_000n);
  assert.equal(result.tokenAmountRaw, 2_500_000n);

  const mismatchedModelData = createConfirmedAmmV4Swap({
    side: 'buy', signature, wallet, mint, pool,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
    marketKind: 'STABLE',
  });
  mismatchedModelData.parsedTransaction.transaction.message.instructions[0].accounts[7] = newPublicKey();
  await assert.rejects(
    verifyConfirmedExternalSwap(mismatchedModelData.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /cuentas de la instrucción no coinciden con el estado confirmado/,
  );

  const exactOutSignature = bs58.encode(Buffer.alloc(64, 15));
  const stableExactOut = createConfirmedAmmV4Swap({
    side: 'sell', signature: exactOutSignature, wallet, mint, pool,
    quoteBefore: 9_000_000n, quoteAfter: 10_000_000n,
    tokenBefore: 2_500_000n, tokenAfter: 0n, minimumOrExactOutput: 1_000_000n,
    useExactOutput: true, marketKind: 'STABLE',
  });
  const exactOutResult = await verifyConfirmedExternalSwap(
    stableExactOut.connection, exactOutSignature, wallet.toBase58(), mint.toBase58(), 'sell',
  );
  assert.ok(exactOutResult);
  assert.equal(exactOutResult.venue, 'RAYDIUM_AMM_STABLE');
  assert.equal(exactOutResult.quoteAmountRaw, 1_000_000n);
  assert.equal(exactOutResult.tokenAmountRaw, 2_500_000n);

  const insufficientMaximum = createConfirmedAmmV4Swap({
    side: 'sell', signature: exactOutSignature, wallet, mint, pool,
    quoteBefore: 9_000_000n, quoteAfter: 10_000_000n,
    tokenBefore: 2_500_000n, tokenAfter: 0n, minimumOrExactOutput: 1_000_000n,
    useExactOutput: true, marketKind: 'STABLE',
  });
  const boundedExactOut = Buffer.alloc(fixedSwapOutLayout.span);
  boundedExactOut[0] = 11;
  boundedExactOut.writeBigUInt64LE(2_499_999n, 1);
  boundedExactOut.writeBigUInt64LE(1_000_000n, 9);
  insufficientMaximum.parsedTransaction.transaction.message.instructions[0].data = bs58.encode(boundedExactOut);
  await assert.rejects(
    verifyConfirmedExternalSwap(insufficientMaximum.connection, exactOutSignature, wallet.toBase58(), mint.toBase58(), 'sell'),
    /balances confirmados no cumplen los importes exact-in\/exact-out/,
  );
});

test('external Raydium AMM V4 import rejects pool-state and wallet-delta mismatches', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const pool = newPublicKey();
  const signature = bs58.encode(Buffer.alloc(64, 13));
  const valid = createConfirmedAmmV4Swap({
    side: 'buy', signature, wallet, mint, pool,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_000n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
  });
  const wrongOwnerConnection = {
    getParsedTransaction: async () => valid.parsedTransaction,
    getAccountInfo: async () => ({ owner: newPublicKey(), data: Buffer.alloc(liquidityStateV4Layout.span) }),
  } as unknown as Connection;
  await assert.rejects(
    verifyConfirmedExternalSwap(wrongOwnerConnection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /pool Raydium válida de Devnet/,
  );

  const incorrectDelta = createConfirmedAmmV4Swap({
    side: 'buy', signature, wallet, mint, pool,
    quoteBefore: 10_000_000n, quoteAfter: 9_000_001n,
    tokenBefore: 0n, tokenAfter: 2_500_000n, minimumOrExactOutput: 2_000_000n,
  });
  const fixedInputData = Buffer.alloc(fixedSwapInLayout.span);
  fixedInputData[0] = 9;
  fixedInputData.writeBigUInt64LE(1_000_000n, 1);
  fixedInputData.writeBigUInt64LE(2_000_000n, 9);
  incorrectDelta.parsedTransaction.transaction.message.instructions[0].data = bs58.encode(fixedInputData);
  await assert.rejects(
    verifyConfirmedExternalSwap(incorrectDelta.connection, signature, wallet.toBase58(), mint.toBase58(), 'buy'),
    /balances confirmados no cumplen/,
  );
});

test('a confirmed external CPMM swap can be recorded for the identified wallet', async () => {
  const wallet = newPublicKey();
  const mint = newPublicKey();
  const pool = newPublicKey();
  const signature = bs58.encode(Buffer.alloc(64, 10));
  const { connection } = createConfirmedSwap({
    signature,
    wallet,
    mint,
    pool,
    side: 'buy',
    quoteBefore: 20_000_000n,
    quoteAfter: 19_000_000n,
    tokenBefore: 0n,
    tokenAfter: 2_500_000n,
  });
  let insertedValues: unknown[] = [];
  const prisma = {
    token: { findUnique: async () => null },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(strings).join(' ');
      if (query.includes('INSERT INTO "Swap"')) {
        insertedValues = values;
        return [{ signature }];
      }
      return [];
    },
  } as never;
  const handlers = createSwapHandlers(prisma, connection);
  const responseState: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
  const response = {
    locals: { walletIdentity: wallet.toBase58() },
    setHeader: () => undefined,
    status: (statusCode: number) => {
      responseState.statusCode = statusCode;
      return response;
    },
    json: (body: unknown) => {
      responseState.body = body;
      return response;
    },
  } as unknown as Response;

  await handlers.record({ body: {
    userWallet: wallet.toBase58(),
    mintAddress: mint.toBase58(),
    side: 'buy',
    signature,
  } } as Request, response, () => undefined);

  assert.equal(responseState.statusCode, 201);
  assert.deepEqual(responseState.body, { success: true, recorded: true, signature });
  assert.equal(insertedValues[1], signature);
  assert.equal(insertedValues[2], wallet.toBase58());
  assert.equal(insertedValues[3], mint.toBase58());
  assert.equal(insertedValues[4], pool.toBase58());
  assert.equal(insertedValues[5], 'RAYDIUM');
  assert.equal(insertedValues[6], 'buy');
});

function newPublicKey(): PublicKey {
  return Keypair.generate().publicKey;
}
