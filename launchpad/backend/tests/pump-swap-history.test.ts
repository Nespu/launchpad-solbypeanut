import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import bs58 from 'bs58';
import { bondingCurvePda } from '@pump-fun/pump-sdk';
import {
  canonicalPumpPoolPda,
  OFFLINE_PUMP_AMM_PROGRAM,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  pumpPoolAuthorityPda,
} from '@pump-fun/pump-swap-sdk';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { verifyConfirmedExternalSwap, verifyConfirmedPumpSwap } from '../src/services/swapHistoryService';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const ammIdl = OFFLINE_PUMP_AMM_PROGRAM.idl as unknown as {
  events: Array<{ name: string; discriminator: number[] }>;
  instructions: Array<{ name: string; discriminator: number[] }>;
};

function key() {
  return Keypair.generate().publicKey;
}

function eventLog(name: 'BuyEvent' | 'SellEvent', fields: Record<string, unknown>) {
  const descriptor = ammIdl.events.find((event) => event.name.toLowerCase() === name.toLowerCase());
  assert.ok(descriptor, `missing ${name} in Pump AMM SDK IDL`);
  const typeName = name === 'BuyEvent' ? 'buyEvent' : 'sellEvent';
  const encoded = OFFLINE_PUMP_AMM_PROGRAM.coder.types.encode(typeName, fields);
  return Buffer.concat([Buffer.from(descriptor.discriminator), encoded]).toString('base64');
}

function sharedEventFields(pool: PublicKey, user: PublicKey) {
  const zero = () => new BN(0);
  return {
    timestamp: new BN(1_797_000_000),
    userBaseTokenReserves: zero(),
    userQuoteTokenReserves: zero(),
    poolBaseTokenReserves: new BN(5_000_000),
    poolQuoteTokenReserves: new BN(2_000_000_000),
    lpFeeBasisPoints: zero(),
    lpFee: zero(),
    protocolFeeBasisPoints: zero(),
    protocolFee: zero(),
    pool,
    user,
    userBaseTokenAccount: key(),
    userQuoteTokenAccount: key(),
    protocolFeeRecipient: key(),
    protocolFeeRecipientTokenAccount: key(),
    coinCreator: PublicKey.default,
    coinCreatorFeeBasisPoints: zero(),
    coinCreatorFee: zero(),
    cashbackFeeBasisPoints: zero(),
    cashback: zero(),
    buybackFeeBasisPoints: zero(),
    buybackFee: zero(),
    virtualQuoteReserves: zero(),
    canBoost: false,
    baseSupply: new BN('1000000000000000'),
    holderRewardsBps: zero(),
    holderRewards: zero(),
    creatorFeeUnclaimed: zero(),
  };
}

test('PumpSwap history verifies SDK BuyEvent and SellEvent names and exact wallet token deltas', async () => {
  const mint = key();
  const wallet = key();
  const poolAddress = canonicalPumpPoolPda(mint, SOL_MINT);
  const pool = {
    baseMint: mint,
    quoteMint: SOL_MINT,
    creator: pumpPoolAuthorityPda(mint),
  };
  const accountInfo: AccountInfo<Buffer> = {
    data: Buffer.alloc(8),
    executable: false,
    lamports: 1,
    owner: PUMP_AMM_PROGRAM_ID,
    rentEpoch: 0,
  };
  const sdkPrototype = Object.getPrototypeOf(PUMP_AMM_SDK) as {
    decodePoolNullable: (account: AccountInfo<Buffer>) => unknown;
  };
  const originalDecode = sdkPrototype.decodePoolNullable;
  sdkPrototype.decodePoolNullable = () => pool;

  try {
    for (const side of ['buy', 'sell'] as const) {
      const signature = bs58.encode(Buffer.alloc(64, side === 'buy' ? 21 : 22));
      const tokenAmountRaw = 1_250_000n;
      const quoteAmountRaw = 42_000_000n;
      const eventName = side === 'buy' ? 'BuyEvent' : 'SellEvent';
      const eventFields = side === 'buy'
        ? {
          ...sharedEventFields(poolAddress, wallet),
          baseAmountOut: new BN(tokenAmountRaw.toString()),
          maxQuoteAmountIn: new BN((quoteAmountRaw + 1_000_000n).toString()),
          quoteAmountIn: new BN(quoteAmountRaw.toString()),
          quoteAmountInWithLpFee: new BN(quoteAmountRaw.toString()),
          userQuoteAmountIn: new BN(quoteAmountRaw.toString()),
          trackVolume: false,
          totalUnclaimedTokens: new BN(0),
          totalClaimedTokens: new BN(0),
          currentSolVolume: new BN(0),
          lastUpdateTimestamp: new BN(1_797_000_000),
          minBaseAmountOut: new BN(tokenAmountRaw.toString()),
          ixName: 'buy',
        }
        : {
          ...sharedEventFields(poolAddress, wallet),
          baseAmountIn: new BN(tokenAmountRaw.toString()),
          minQuoteAmountOut: new BN(quoteAmountRaw.toString()),
          quoteAmountOut: new BN(quoteAmountRaw.toString()),
          quoteAmountOutWithoutLpFee: new BN(quoteAmountRaw.toString()),
          userQuoteAmountOut: new BN(quoteAmountRaw.toString()),
        };
      const encodedEvent = eventLog(eventName, eventFields);
      const instructionName = side === 'buy' ? 'buyV2' : 'sellV2';
      const instructionDiscriminator = ammIdl.instructions.find((instruction) => instruction.name === instructionName)?.discriminator;
      assert.ok(instructionDiscriminator, `missing ${instructionName} in Pump AMM SDK IDL`);
      const instructionData = bs58.encode(Buffer.from(instructionDiscriminator));
      const before = side === 'buy' ? 500_000n : 2_000_000n;
      const after = side === 'buy' ? before + tokenAmountRaw : before - tokenAmountRaw;
      const transaction = {
        slot: 700,
        blockTime: 1_797_000_000,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [{ pubkey: wallet, signer: true }],
            instructions: [{
              programId: PUMP_AMM_PROGRAM_ID,
              accounts: [poolAddress, mint, wallet],
              data: instructionData,
            }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          logMessages: [
            `Program ${PUMP_AMM_PROGRAM_ID.toBase58()} invoke [1]`,
            `Program data: ${encodedEvent}`,
            `Program ${PUMP_AMM_PROGRAM_ID.toBase58()} success`,
          ],
          preTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: wallet.toBase58(), uiTokenAmount: { amount: before.toString(), decimals: 6 } }],
          postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: wallet.toBase58(), uiTokenAmount: { amount: after.toString(), decimals: 6 } }],
          innerInstructions: [],
        },
      };
      const connection = {
        getParsedTransaction: async () => transaction,
        getAccountInfo: async (address: PublicKey) => address.equals(poolAddress) ? accountInfo : null,
      } as unknown as Connection;

      const verified = await verifyConfirmedPumpSwap(
        connection,
        signature,
        wallet.toBase58(),
        mint.toBase58(),
        bondingCurvePda(mint).toBase58(),
        side,
      );

      assert.equal(verified?.venue, 'PUMP_SWAP');
      assert.equal(verified?.marketAddress, poolAddress.toBase58());
      assert.equal(verified?.tokenAmountRaw, tokenAmountRaw);
      assert.equal(verified?.quoteAmountRaw, quoteAmountRaw);
      assert.equal(verified?.solAmountLamports, quoteAmountRaw);

      const external = await verifyConfirmedExternalSwap(connection, signature, wallet.toBase58(), mint.toBase58(), side);
      assert.equal(external?.venue, 'PUMP_SWAP');
      assert.equal(external?.marketAddress, poolAddress.toBase58());
      assert.equal(external?.tokenAmountRaw, tokenAmountRaw);
      assert.equal(external?.quoteAmountRaw, quoteAmountRaw);
    }
  } finally {
    sdkPrototype.decodePoolNullable = originalDecode;
  }
});

test('PumpSwap history rejects an event whose token delta does not match the signed wallet balance change', async () => {
  const mint = key();
  const wallet = key();
  const poolAddress = canonicalPumpPoolPda(mint, SOL_MINT);
  const pool = { baseMint: mint, quoteMint: SOL_MINT, creator: pumpPoolAuthorityPda(mint) };
  const accountInfo: AccountInfo<Buffer> = {
    data: Buffer.alloc(8), executable: false, lamports: 1, owner: PUMP_AMM_PROGRAM_ID, rentEpoch: 0,
  };
  const sdkPrototype = Object.getPrototypeOf(PUMP_AMM_SDK) as {
    decodePoolNullable: (account: AccountInfo<Buffer>) => unknown;
  };
  const originalDecode = sdkPrototype.decodePoolNullable;
  sdkPrototype.decodePoolNullable = () => pool;

  try {
    const signature = bs58.encode(Buffer.alloc(64, 23));
    const eventFields = {
      ...sharedEventFields(poolAddress, wallet),
      baseAmountOut: new BN(100),
      maxQuoteAmountIn: new BN(1_000),
      quoteAmountIn: new BN(1_000),
      quoteAmountInWithLpFee: new BN(1_000),
      userQuoteAmountIn: new BN(1_000),
      trackVolume: false,
      totalUnclaimedTokens: new BN(0),
      totalClaimedTokens: new BN(0),
      currentSolVolume: new BN(0),
      lastUpdateTimestamp: new BN(1_797_000_000),
      minBaseAmountOut: new BN(100),
      ixName: 'buy',
    };
    const instructionDiscriminator = ammIdl.instructions.find((instruction) => instruction.name === 'buyV2')?.discriminator;
    assert.ok(instructionDiscriminator);
    const transaction = {
      slot: 700,
      blockTime: 1_797_000_000,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [{ pubkey: wallet, signer: true }],
          instructions: [{ programId: PUMP_AMM_PROGRAM_ID, accounts: [poolAddress, mint, wallet], data: bs58.encode(Buffer.from(instructionDiscriminator)) }],
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        logMessages: [
          `Program ${PUMP_AMM_PROGRAM_ID.toBase58()} invoke [1]`,
          `Program data: ${eventLog('BuyEvent', eventFields)}`,
          `Program ${PUMP_AMM_PROGRAM_ID.toBase58()} success`,
        ],
        preTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: wallet.toBase58(), uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: wallet.toBase58(), uiTokenAmount: { amount: '99', decimals: 6 } }],
        innerInstructions: [],
      },
    };
    const connection = {
      getParsedTransaction: async () => transaction,
      getAccountInfo: async () => accountInfo,
    } as unknown as Connection;

    await assert.rejects(
      verifyConfirmedPumpSwap(connection, signature, wallet.toBase58(), mint.toBase58(), bondingCurvePda(mint).toBase58(), 'buy'),
      /does not match the wallet balance changes/,
    );
  } finally {
    sdkPrototype.decodePoolNullable = originalDecode;
  }
});
