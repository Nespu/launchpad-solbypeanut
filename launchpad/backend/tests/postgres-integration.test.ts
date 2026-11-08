import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import type { Request, Response } from 'express';
import { createGetMyPoolsHandler, createUpdateWithdrawalResultHandler } from '../src/controllers/tokenControllerHandlers';
import { cleanMetadataText } from '../src/utils/metadataText';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest: typeof test = testDatabaseUrl ? test : test.skip;
const creator = Keypair.generate();
const creatorWallet = creator.publicKey.toBase58();
const otherWallet = 'Vote111111111111111111111111111111111111111';
const poolAddress = 'SysvarRent111111111111111111111111111111111';

function responseRecorder() {
  const result: { statusCode?: number; body?: unknown } = {};
  const res = {
    locals: { walletIdentity: creatorWallet },
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

integrationTest('PostgreSQL persists pool filtering and confirmed withdrawal status', async (t) => {
  const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const runId = `wire-it-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tokenPrefix = `${runId}-token-`;
  let withdrawalId: string | undefined;

  await prisma.$connect();
  t.after(async () => {
    if (withdrawalId) await prisma.withdrawal.deleteMany({ where: { id: withdrawalId } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: tokenPrefix } } });
    await prisma.$disconnect();
  });

  const tokenRows = [
    { mintAddress: `${tokenPrefix}pool`, creatorWallet, poolAddress, status: 'completed' },
    { mintAddress: `${tokenPrefix}pending`, creatorWallet, poolAddress: 'pending', status: 'created' },
    { mintAddress: `${tokenPrefix}empty`, creatorWallet, poolAddress: '', status: 'created' },
    { mintAddress: `${tokenPrefix}none`, creatorWallet, poolAddress: null, status: 'created' },
    { mintAddress: `${tokenPrefix}other`, creatorWallet: otherWallet, poolAddress, status: 'completed' },
  ];

  await prisma.token.createMany({
    data: tokenRows.map((row) => ({
      ...row,
      name: row.mintAddress,
      symbol: 'IT',
      imageUrl: 'https://example.invalid/image.png',
      totalSupply: 1n,
      liquiditySol: 1,
      txHash: 'integration-test',
    })),
  });

  const cleanedToken = await prisma.token.create({
    data: {
      mintAddress: `${tokenPrefix}cleaned`,
      name: cleanMetadataText('To\0ken\0'),
      symbol: cleanMetadataText('T\0ST\0'),
      imageUrl: 'https://example.invalid/image.png',
      totalSupply: 1n,
      liquiditySol: 1,
      creatorWallet,
      txHash: 'integration-clean-metadata',
    },
  });
  assert.equal(cleanedToken.name, 'Token');
  assert.equal(cleanedToken.symbol, 'TST');

  const poolsResponse = responseRecorder();
  await createGetMyPoolsHandler(prisma)(request({ query: {} }), poolsResponse.res);
  assert.equal(poolsResponse.result.statusCode, 200);
  assert.deepEqual(
    (poolsResponse.result.body as { pools: Array<{ mintAddress: string }> }).pools.map((pool) => pool.mintAddress),
    [`${tokenPrefix}pool`],
  );

  const withdrawalTransaction = new Transaction({
    feePayer: creator.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(SystemProgram.transfer({
    fromPubkey: creator.publicKey,
    toPubkey: new PublicKey(poolAddress),
    lamports: 1,
  }));
  withdrawalTransaction.sign(creator);
  const signedTransaction = withdrawalTransaction.serialize().toString('base64');
  const signedMessage = withdrawalTransaction.compileMessage();
  const withdrawal = await prisma.withdrawal.create({
    data: {
      userWallet: creatorWallet,
      poolAddress,
      lpTokenAmount: 1,
      userAmount: 0.9,
      platformFee: 0.1,
      transactionMessageHash: createHash('sha256')
        .update(withdrawalTransaction.compileMessage().serialize())
        .digest('hex'),
      status: 'pending',
    },
  });
  withdrawalId = withdrawal.id;

  const connection = {
    rpcEndpoint: 'https://api.devnet.solana.com',
    getAccountInfo: async () => ({}),
    getTransaction: async () => ({ transaction: { message: signedMessage }, meta: { err: null } }),
  } as unknown as Connection;
  const withdrawalResponse = responseRecorder();
  await createUpdateWithdrawalResultHandler(prisma, connection)(
    request({ body: { withdrawalId, userWallet: creatorWallet, signedTransaction } }),
    withdrawalResponse.res,
  );

  assert.equal(withdrawalResponse.result.statusCode, 200);
  assert.ok(withdrawalTransaction.signature);
  const txHash = bs58.encode(withdrawalTransaction.signature!);
  assert.deepEqual(withdrawalResponse.result.body, {
    success: true,
    status: 'pending',
    txHash,
  });

  await createUpdateWithdrawalResultHandler(prisma, connection)(
    request({ body: { withdrawalId, userWallet: creatorWallet, txHash } }),
    withdrawalResponse.res,
  );
  assert.equal(withdrawalResponse.result.statusCode, 200);
  assert.deepEqual(withdrawalResponse.result.body, {
    success: true,
    status: 'completed',
    txHash,
  });
  const persistedWithdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  assert.equal(persistedWithdrawal?.status, 'completed');
  assert.equal(persistedWithdrawal?.txHash, txHash);
});
