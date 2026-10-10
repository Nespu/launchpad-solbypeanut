import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import type { Request, Response } from 'express';
import {
  createGetMyPoolsHandler,
  createUpdateWithdrawalResultHandler,
} from '../src/controllers/tokenControllerHandlers';

const wallet = '11111111111111111111111111111111';
const otherWallet = 'Vote111111111111111111111111111111111111111';
const poolAddress = 'SysvarRent111111111111111111111111111111111';

function responseRecorder() {
  const result: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  };
  return { result, res: res as unknown as Response };
}

function request(input: { query?: Record<string, unknown>; body?: Record<string, unknown> }) {
  return input as unknown as Request;
}

function fakePrisma(overrides: Record<string, unknown>) {
  return overrides as unknown as PrismaClient;
}

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
  const { result, res } = responseRecorder();

  await handler(request({ query: { userWallet: wallet } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, pools });
  assert.deepEqual(query, {
    where: { creatorWallet: wallet, poolAddress: { not: null, notIn: ['pending', ''] } },
    select: { mintAddress: true, name: true, symbol: true, imageUrl: true, poolAddress: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
});

test('getMyPools rejects invalid wallet before querying Prisma', async () => {
  let queried = false;
  const handler = createGetMyPoolsHandler(fakePrisma({
    token: { findMany: async () => { queried = true; return []; } },
  }));
  const { result, res } = responseRecorder();

  await handler(request({ query: { userWallet: 'not-a-wallet' } }), res);

  assert.equal(result.statusCode, 400);
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
  const { result, res } = responseRecorder();

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: 'tx' } }), res);

  assert.equal(result.statusCode, 403);
  assert.equal(updated, false);
});

test('withdrawal result marks a pending cancellation as failed', async () => {
  let update: unknown;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'pending', txHash: null }),
        update: async (args: unknown) => { update = args; },
      },
    }),
    {} as Connection,
  );
  const { result, res } = responseRecorder();

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'failed' });
  assert.deepEqual(update, { where: { id: 'withdrawal-1' }, data: { status: 'failed' } });
});

test('withdrawal result marks on-chain failure as failed with its transaction signature', async () => {
  let update: unknown;
  const connection = {
    getParsedTransaction: async () => ({
      meta: { err: { InstructionError: [0, 'Custom'] } },
      transaction: { message: { accountKeys: [] } },
    }),
  } as unknown as Connection;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'pending', txHash: null }),
        update: async (args: unknown) => { update = args; },
      },
    }),
    connection,
  );
  const { result, res } = responseRecorder();

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: 'tx-failed' } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'failed', txHash: 'tx-failed' });
  assert.deepEqual(update, { where: { id: 'withdrawal-1' }, data: { status: 'failed', txHash: 'tx-failed' } });
});

test('withdrawal result completes only after confirmed transaction includes signer and pool', async () => {
  let update: unknown;
  let fetchedSignature: string | undefined;
  const connection = {
    getParsedTransaction: async (signature: string) => {
      fetchedSignature = signature;
      return {
        meta: { err: null },
        transaction: {
          message: {
            accountKeys: [
              { pubkey: { toBase58: () => wallet }, signer: true },
              { pubkey: { toBase58: () => poolAddress }, signer: false },
            ],
          },
        },
      };
    },
  } as unknown as Connection;
  const handler = createUpdateWithdrawalResultHandler(
    fakePrisma({
      withdrawal: {
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'pending', txHash: null }),
        update: async (args: unknown) => { update = args; },
      },
    }),
    connection,
  );
  const { result, res } = responseRecorder();

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: 'tx-ok' } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'completed', txHash: 'tx-ok' });
  assert.equal(fetchedSignature, 'tx-ok');
  assert.deepEqual(update, { where: { id: 'withdrawal-1' }, data: { status: 'completed', txHash: 'tx-ok' } });
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
        findUnique: async () => ({ id: 'withdrawal-1', userWallet: wallet, poolAddress, status: 'completed', txHash: 'tx-existing' }),
        update: async () => { updated = true; },
      },
    }),
    connection,
  );
  const { result, res } = responseRecorder();

  await handler(request({ body: { withdrawalId: 'withdrawal-1', userWallet: wallet, txHash: 'tx-existing' } }), res);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, status: 'completed', txHash: 'tx-existing' });
  assert.equal(checkedOnChain, false);
  assert.equal(updated, false);
});
