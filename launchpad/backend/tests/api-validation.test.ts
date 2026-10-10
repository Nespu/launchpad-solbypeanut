import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { validateBody, validateQuery } from '../src/middleware/validateRequest';
import {
  createPoolSchema,
  createTokenSchema,
  myPoolsQuerySchema,
  updateWithdrawalResultSchema,
  withdrawLiquiditySchema,
  submitTransactionSchema,
} from '../src/utils/schemas';
import { cleanMetadataText } from '../src/utils/metadataText';

const address = '11111111111111111111111111111111';

function createResponse() {
  const result: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const response = {
    status(code: number) {
      result.statusCode = code;
      return response;
    },
    json(body: unknown) {
      result.body = body;
      return response;
    },
  } as unknown as Response;

  return { response, result };
}

test('create token schema applies defaults and trims display fields', () => {
  const parsed = createTokenSchema.parse({
    userWallet: address,
    name: '  Test Token  ',
    symbol: ' TST ',
    totalSupply: 1_000_000,
    liquiditySol: 1,
  });

  assert.equal(parsed.name, 'Test Token');
  assert.equal(parsed.symbol, 'TST');
  assert.equal(parsed.description, '');
  assert.deepEqual(parsed.securityAssets, []);
});

test('create token schema rejects invalid addresses, unsafe supply, and duplicate security options', () => {
  const validToken = {
    userWallet: address,
    name: 'Test Token',
    symbol: 'TST',
    totalSupply: 1_000_000,
    liquiditySol: 1,
  };

  assert.equal(createTokenSchema.safeParse({ ...validToken, userWallet: 'invalid' }).success, false);
  assert.equal(createTokenSchema.safeParse({ ...validToken, totalSupply: Number.MAX_SAFE_INTEGER }).success, false);
  assert.equal(createTokenSchema.safeParse({ ...validToken, securityAssets: ['mint', 'mint'] }).success, false);
});

test('free-text token fields reject null bytes and on-chain metadata cleanup removes every null byte', () => {
  const createInput = {
    userWallet: address,
    name: 'Token',
    symbol: 'TST',
    totalSupply: 100,
    liquiditySol: 1,
  };
  assert.equal(createTokenSchema.safeParse({ ...createInput, name: 'To\0ken' }).success, false);
  assert.equal(createTokenSchema.safeParse({ ...createInput, symbol: 'T\0ST' }).success, false);
  assert.equal(createTokenSchema.safeParse({ ...createInput, description: 'desc\0ription' }).success, false);
  assert.equal(createTokenSchema.safeParse({ ...createInput, copyFrom: 'mint\0address' }).success, false);

  const submitInput = {
    signedTransaction: 'AA==',
    mintAddress: address,
    userWallet: address,
    name: 'Token',
    symbol: 'TST',
    imageUrl: 'https://example.com/token.png',
    totalSupply: 100,
    liquiditySol: 1,
  };
  assert.equal(submitTransactionSchema.safeParse({ ...submitInput, description: 'desc\0ription' }).success, false);
  assert.equal(submitTransactionSchema.safeParse({ ...submitInput, copyFrom: 'mint\0address' }).success, false);
  assert.equal(cleanMetadataText('To\0ke\0n\0  '), 'Token');
});

test('pool and withdrawal schemas only accept positive integer token amounts', () => {
  const poolInput = { userWallet: address, mintAddress: address, tokenAmount: '1000', solAmount: 0.5 };
  const withdrawalInput = { userWallet: address, poolAddress: address, lpTokenAmount: '1000' };

  assert.equal(createPoolSchema.safeParse(poolInput).success, true);
  assert.equal(createPoolSchema.safeParse({ ...poolInput, tokenAmount: '0' }).success, false);
  assert.equal(createPoolSchema.safeParse({ ...poolInput, tokenAmount: '1.5' }).success, false);
  assert.equal(withdrawLiquiditySchema.safeParse(withdrawalInput).success, true);
  assert.equal(withdrawLiquiditySchema.safeParse({ ...withdrawalInput, lpTokenAmount: '-1' }).success, false);
});

test('withdrawal result requires a transaction signature or failure reason', () => {
  const baseInput = { withdrawalId: 'withdrawal-1', userWallet: address };

  assert.equal(updateWithdrawalResultSchema.safeParse(baseInput).success, false);
  assert.equal(updateWithdrawalResultSchema.safeParse({ ...baseInput, error: 'Wallet rejected signing' }).success, true);
  assert.equal(updateWithdrawalResultSchema.safeParse({ ...baseInput, txHash: 'a'.repeat(64) }).success, true);
});

test('body middleware rejects invalid input before calling the route handler', () => {
  const request = { body: { userWallet: 'invalid' } } as Request;
  const { response, result } = createResponse();
  let nextCalled = false;

  validateBody(createTokenSchema)(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(result.statusCode, 400);
  assert.equal(nextCalled, false);
  const invalidPaths = (result.body as { details: Array<{ path: string }> }).details.map(({ path }) => path);
  for (const path of ['userWallet', 'name', 'symbol', 'totalSupply', 'liquiditySol']) {
    assert.ok(invalidPaths.includes(path));
  }
});

test('body middleware stores parsed defaults before calling the route handler', () => {
  const request = {
    body: {
      userWallet: address,
      name: ' Token ',
      symbol: ' T ',
      totalSupply: 10,
      liquiditySol: 0.1,
    },
  } as Request;
  const { response, result } = createResponse();
  let nextCalled = false;

  validateBody(createTokenSchema)(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(result.statusCode, 200);
  assert.equal(nextCalled, true);
  assert.equal(request.body.name, 'Token');
  assert.deepEqual(request.body.securityAssets, []);
});

test('query middleware rejects invalid wallet addresses', () => {
  const request = { query: { userWallet: 'invalid' } } as unknown as Request;
  const { response, result } = createResponse();
  let nextCalled = false;

  validateQuery(myPoolsQuerySchema)(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(result.statusCode, 400);
  assert.equal(nextCalled, false);
  assert.equal((result.body as { details: Array<{ path: string }> }).details[0].path, 'userWallet');
});

test('query middleware accepts valid wallet addresses', () => {
  const request = { query: { userWallet: address } } as unknown as Request;
  const { response, result } = createResponse();
  let nextCalled = false;

  validateQuery(myPoolsQuerySchema)(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(result.statusCode, 200);
  assert.equal(nextCalled, true);
});
