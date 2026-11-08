import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type { PrismaClient } from '@prisma/client';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import {
  createGetMyPoolsHandler,
  createUpdateWithdrawalResultHandler,
} from '../src/controllers/tokenControllerHandlers';
import { createGetWalletHistoryHandler } from '../src/controllers/walletHistoryController';
import { confirmSignedTransaction, createTokenIdempotently } from '../src/services/tokenSubmission';
import { PublicError } from '../src/utils/publicError';

const wallet = '11111111111111111111111111111111';
const otherWallet = 'Vote111111111111111111111111111111111111111';
const poolAddress = 'SysvarRent111111111111111111111111111111111';
const withdrawalSignature = bs58.encode(new Uint8Array(64).fill(1));
const withdrawalMessageBytes = Uint8Array.from([1, 2, 3, 4]);
const withdrawalMessageHash = createHash('sha256').update(withdrawalMessageBytes).digest('hex');

function responseRecorder(locals: Record<string, unknown> = {}) {
  const result: { statusCode?: number; body?: unknown } = {};
  const responseLocals = locals;
  const res = {
    locals: responseLocals,
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    setHeader() { return this; },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  };
  return { result, res: res as unknown as Response };
}

function historySwapRow(index: number) {
  return {
    id: `swap-${index}`,
    signature: bs58.encode(new Uint8Array(64).fill((index % 250) + 1)),
    mintAddress: poolAddress,
    poolAddress,
    venue: 'RAYDIUM',
    side: 'buy',
    tokenAmountRaw: '1',
    solAmountLamports: '1',
    quoteAmountRaw: '1',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteDecimals: 9,
    tokenDecimals: 6,
    slot: String(1000 - index),
    blockTime: null,
    networkFeeLamports: '5000',
    createdAt: new Date(0),
  };
}

function walletHistoryPrisma(queryRaw: (...args: unknown[]) => Promise<unknown>) {
  return fakePrisma({
    token: { findMany: async () => [] },
    withdrawal: { findMany: async () => [] },
    $queryRaw: queryRaw,
  });
}

function historyResponseRecorder() {
  const result: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    locals: {},
    status(code: number) { result.statusCode = code; return this; },
    setHeader(name: string, value: string) { result.headers[name] = value; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  return { result, res: res as unknown as Response };
}

test('wallet history swap cursor pages older rows and reports when more remain', async () => {
  let capturedValues: unknown[] = [];
  let capturedQuery = '';
  const handler = createGetWalletHistoryHandler(walletHistoryPrisma(async (strings, ...values) => {
    capturedQuery = Array.isArray(strings) ? strings.join('?') : '';
    capturedValues = values;
    return Array.from({ length: 201 }, (_, index) => historySwapRow(index));
  }), async () => wallet);
  const { result, res } = historyResponseRecorder();

  await handler({ query: {} } as unknown as Request, res, () => undefined);

  const body = result.body as { swaps: Array<{ slot: string }>; swapsHasMore: boolean };
  assert.equal(result.statusCode, 200);
  assert.equal(body.swaps.length, 200);
  assert.equal(body.swapsHasMore, true);
  assert.equal(body.swaps[199].slot, '801');
  assert.match(capturedQuery, /ORDER BY "slot" DESC, "signature" DESC/);
  assert.deepEqual(capturedValues, [wallet, 201]);
});

test('wallet history cursor is parameterized and rejects incomplete cursors', async () => {
  const signature = bs58.encode(new Uint8Array(64).fill(8));
  let queryCount = 0;
  let capturedValues: unknown[] = [];
  const handler = createGetWalletHistoryHandler(walletHistoryPrisma(async (strings, ...values) => {
    queryCount += 1;
    capturedValues = values;
    assert.match(Array.isArray(strings) ? strings.join('?') : '', /"slot" < \?::bigint/);
    return [];
  }), async () => wallet);

  const invalid = historyResponseRecorder();
  await handler({ query: { beforeSlot: '12' } } as unknown as Request, invalid.res, () => undefined);
  assert.equal(invalid.result.statusCode, 400);
  assert.equal(queryCount, 0);

  const valid = historyResponseRecorder();
  await handler({ query: { beforeSlot: '12', beforeSignature: signature } } as unknown as Request, valid.res, () => undefined);
  assert.equal(valid.result.statusCode, 200);
  assert.ok(capturedValues.includes(wallet));
  assert.ok(capturedValues.includes('12'));
  assert.ok(capturedValues.includes(signature));
  assert.ok(capturedValues.includes(201));
  assert.equal(queryCount, 1);
});

function request(input: { query?: Record<string, unknown>; body?: Record<string, unknown> }) {
  return input as unknown as Request;
}

function fakePrisma(overrides: Record<string, unknown>) {
  return overrides as unknown as PrismaClient;
}

test('confirmed signed transaction retry does not send the transaction again', async () => {
  let sent = false;
  const connection = {
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'finalized' }] }),
    sendRawTransaction: async () => { sent = true; return 'signature'; },
    confirmTransaction: async () => { throw new Error('Already finalized'); },
  } as unknown as Connection;

  await confirmSignedTransaction(connection, Buffer.from('signed'), 'signature');
  assert.equal(sent, false);
});

test('retry after a confirmed transaction and failed database write does not resend on-chain', async () => {
  let statusCalls = 0;
  let sendCount = 0;
  let createCount = 0;
  const record = { mintAddress: 'mint-retry', txHash: 'signature-retry', creatorWallet: wallet };
  const connection = {
    getSignatureStatuses: async () => ({
      value: [++statusCalls === 1 ? null : { err: null, confirmationStatus: 'finalized' }],
    }),
    sendRawTransaction: async () => {
      sendCount += 1;
      return record.txHash;
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
  const token = {
    findUnique: async () => null,
    create: async () => {
      createCount += 1;
      if (createCount === 1) throw new Error('simulated database outage after chain confirmation');
      return record;
    },
  };

  await confirmSignedTransaction(connection, Buffer.from('signed'), record.txHash);
  await assert.rejects(createTokenIdempotently(token as never, record as never), /simulated database outage/);

  await confirmSignedTransaction(connection, Buffer.from('signed'), record.txHash);
  const result = await createTokenIdempotently(token as never, record as never);

  assert.deepEqual(result, record);
  assert.equal(sendCount, 1, 'the confirmed transaction must not be broadcast again');
  assert.equal(statusCalls, 2, 'retry should look up the existing finalized signature');
});

test('expired signed transaction asks the user to sign again', async () => {
  const connection = {
    getSignatureStatuses: async () => ({ value: [null] }),
    sendRawTransaction: async () => { throw new Error('Blockhash not found'); },
  } as unknown as Connection;

  await assert.rejects(
    confirmSignedTransaction(connection, Buffer.from('expired'), 'signature'),
    (error: unknown) => error instanceof PublicError &&
      error.status === 400 && error.message === 'La transacción expiró. Vuelve a firmar.',
  );
});

test('token registration retry accepts the same mint, signature, and creator', async () => {
  const record = { mintAddress: 'mint', txHash: 'signature', creatorWallet: wallet };
  let created = false;
  const token = {
    findUnique: async () => record,
    create: async () => { created = true; return record; },
  };

  const result = await createTokenIdempotently(token as never, record as never);
  assert.deepEqual(result, record);
  assert.equal(created, false);
});

test('unique-token race only returns success when the competing row matches', async () => {
  const record = { mintAddress: 'mint', txHash: 'signature', creatorWallet: wallet };
  let findCount = 0;
  const token = {
    findUnique: async () => (++findCount === 1 ? null : record),
    create: async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    },
  };

  const result = await createTokenIdempotently(token as never, record as never);
  assert.deepEqual(result, record);
  assert.equal(findCount, 2);
});

test('getMyPools canonicalizes wallet and asks Prisma to exclude missing and pending pools', async () => {
  let query: unknown;
  const pools = [{ mintAddress: 'mint', poolAddress, name: 'Token' }];
  const prisma = fakePrisma({
    token: {
      findMany: async (args: unknown) => {
        query = args;
        return pools;
      },
    },
  });
  const handler = createGetMyPoolsHandler(prisma);
  const { result, res } = responseRecorder({ walletIdentity: wallet });

  await handler(request({ query: { userWallet: otherWallet } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, pools });
  assert.deepEqual(query, {
    where: { creatorWallet: wallet, poolAddress: { not: null, notIn: ['pending', ''] } },
    select: { mintAddress: true, name: true, symbol: true, imageUrl: true, poolAddress: true, poolQuoteMint: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
});

test('getMyPools rejects missing session identity before querying Prisma', async () => {
  let queried = false;
  const handler = createGetMyPoolsHandler(fakePrisma({
    token: { findMany: async () => { queried = true; return []; } },
  }));
  const { result, res } = responseRecorder();

  await handler(request({ query: { userWallet: wallet } }), res);

  assert.equal(result.statusCode, 401);
  assert.equal(queried, false);
});

test('withdrawal result rejects a wallet that does not own the record', async () => {
  let updated = false;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: otherWallet, poolAddress, status: 'pending', txHash: null }),
        update: async () => { updated = true; },
      },
    }),
    {} as Connection,
  );
  const { result, res } = responseRecorder({ walletIdentity: wallet });

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: 'tx' } }), res);

  assert.equal(result.statusCode, 403);
  assert.equal(updated, false);
});

test('withdrawal result cancels an unsigned pending preparation', async () => {
  let updateMany: unknown;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'pending', verifiedTxHash: null }),
        updateMany: async (args: unknown) => { updateMany = args; return { count: 1 }; },
      },
    }),
    {} as Connection,
  );
  const { result, res } = responseRecorder({ walletIdentity: wallet });

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, cancel: true } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'cancelled' });
  assert.deepEqual(updateMany, {
    where: { id: 'withdrawal-1', status: 'pending', verifiedTxHash: null },
    data: { status: 'cancelled' },
  });
});

test('withdrawal result marks on-chain failure as failed with its transaction signature', async () => {
  let update: unknown;
  const connection = {
    getAccountInfo: async () => ({}),
    getTransaction: async () => ({
      meta: { err: { InstructionError: [0, 'Custom'] } },
      transaction: {
        message: {
          staticAccountKeys: [new PublicKey(wallet), new PublicKey(poolAddress)],
          header: { numRequiredSignatures: 1 },
          serialize: () => withdrawalMessageBytes,
        },
      },
    }),
  } as unknown as Connection;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'pending', txHash: null, verifiedTxHash: withdrawalSignature, transactionMessageHash: withdrawalMessageHash }),
        updateMany: async (args: unknown) => { update = args; return { count: 1 }; },
      },
    }),
    connection,
  );
  const { result, res } = responseRecorder({ walletIdentity: wallet });

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: withdrawalSignature } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'failed', txHash: withdrawalSignature });
  assert.deepEqual(update, {
    where: { id: 'withdrawal-1', status: { in: ['pending', 'expired_unverified'] }, verifiedTxHash: withdrawalSignature },
    data: { status: 'failed', txHash: withdrawalSignature },
  });
});

test('withdrawal result completes only after confirmed transaction includes signer and pool', async () => {
  let update: unknown;
  let fetchedSignature: string | undefined;
  const connection = {
    getAccountInfo: async () => ({}),
    getTransaction: async (signature: string) => {
      fetchedSignature = signature;
      return {
        meta: { err: null },
        transaction: {
          message: {
            staticAccountKeys: [new PublicKey(wallet), new PublicKey(poolAddress)],
            header: { numRequiredSignatures: 1 },
            serialize: () => withdrawalMessageBytes,
          },
        },
      };
    },
  } as unknown as Connection;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'pending', txHash: null, verifiedTxHash: withdrawalSignature, transactionMessageHash: withdrawalMessageHash }),
        updateMany: async (args: unknown) => { update = args; return { count: 1 }; },
      },
    }),
    connection,
  );
  const { result, res } = responseRecorder({ walletIdentity: wallet });

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: withdrawalSignature } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'completed', txHash: withdrawalSignature });
  assert.equal(fetchedSignature, withdrawalSignature);
  assert.deepEqual(update, {
    where: { id: 'withdrawal-1', status: { in: ['pending', 'expired_unverified'] }, verifiedTxHash: withdrawalSignature },
    data: { status: 'completed', txHash: withdrawalSignature },
  });
});

test('withdrawal result is idempotent for an already completed transaction', async () => {
  let checkedOnChain = false;
  let updated = false;
  const connection = {
    getParsedTransaction: async () => { checkedOnChain = true; return null; },
  } as unknown as Connection;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'completed', txHash: 'tx-existing', transactionMessageHash: withdrawalMessageHash }),
        update: async () => { updated = true; },
      },
    }),
    connection,
  );
  const { result, res } = responseRecorder({ walletIdentity: wallet });

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: 'tx-existing' } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'completed', txHash: 'tx-existing' });
  assert.equal(checkedOnChain, false);
  assert.equal(updated, false);
});
