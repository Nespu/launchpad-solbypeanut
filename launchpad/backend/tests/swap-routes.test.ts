import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type RequestHandler } from 'express';
import bs58 from 'bs58';
import { createRateLimit, type RateLimitCounter } from '../src/middleware/rateLimit';
import { createSwapHandlers } from '../src/controllers/swapController';
import { createSwapRouter } from '../src/routes/swapRoutes';
import type { Connection } from '@solana/web3.js';

const wallet = '11111111111111111111111111111111';
const otherWallet = 'Vote111111111111111111111111111111111111111';

function createMemoryCounter(): RateLimitCounter {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return async (key, windowMs) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return [bucket.count, Math.max(0, bucket.expiresAt - now)];
  };
}

async function startApi(sessionWallet: string | null) {
  const calls = { quote: 0, portfolioQuote: 0, prepare: 0, record: 0, prepareProject: 0, recordProject: 0, walletIdentity: undefined as unknown, projectWalletFlow: undefined as unknown };
  const handler = (key: 'quote' | 'portfolioQuote' | 'prepare' | 'record'): RequestHandler => (_req, res) => {
    if (res.locals.projectWalletFlow === true && key === 'prepare') calls.prepareProject += 1;
    else if (res.locals.projectWalletFlow === true && key === 'record') calls.recordProject += 1;
    else calls[key] += 1;
    calls.walletIdentity = res.locals.walletIdentity;
    calls.projectWalletFlow = res.locals.projectWalletFlow;
    res.status(200).json({ success: true });
  };
  const counter = createMemoryCounter();
  const rateLimitFactory: typeof createRateLimit = (prefix, max, windowMs, _unused, subject) =>
    createRateLimit(prefix, max, windowMs, counter, subject);
  const app = express();
  app.use(express.json());
  app.use('/api/swaps', createSwapRouter({
    quote: handler('quote'),
    portfolioQuote: handler('portfolioQuote'),
    prepare: handler('prepare'),
    record: handler('record'),
  }, async () => sessionWallet, rateLimitFactory));
  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    calls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const prepareBody = (userWallet = wallet, slippageBps = 500) => ({
  userWallet,
  mintAddress: wallet,
  side: 'buy',
  amountIn: '0.1',
  slippageBps,
});
const recordBody = { userWallet: wallet, mintAddress: wallet, side: 'buy', signature: bs58.encode(Buffer.alloc(64, 1)) };

test('swap preparation requires an identified wallet and blocks a mismatched session', async () => {
  const unauthenticated = await startApi(null);
  try {
    const response = await fetch(`${unauthenticated.baseUrl}/api/swaps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prepareBody()),
    });
    assert.equal(response.status, 401);
    assert.equal(unauthenticated.calls.prepare, 0);
  } finally {
    await unauthenticated.close();
  }

  const mismatched = await startApi(otherWallet);
  try {
    const response = await fetch(`${mismatched.baseUrl}/api/swaps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prepareBody()),
    });
    assert.equal(response.status, 403);
    assert.equal(mismatched.calls.prepare, 0);
  } finally {
    await mismatched.close();
  }
});

test('swap preparation accepts the matching wallet but rejects slippage above five percent', async () => {
  const api = await startApi(wallet);
  try {
    const invalid = await fetch(`${api.baseUrl}/api/swaps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prepareBody(wallet, 501)),
    });
    assert.equal(invalid.status, 400);
    assert.equal(api.calls.prepare, 0);

    const valid = await fetch(`${api.baseUrl}/api/swaps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prepareBody()),
    });
    assert.equal(valid.status, 200);
    assert.equal(api.calls.prepare, 1);
    assert.equal(api.calls.walletIdentity, wallet);
  } finally {
    await api.close();
  }
});

test('swap quote remains public and rejects slippage outside the supported range', async () => {
  const api = await startApi(null);
  try {
    const invalid = await fetch(`${api.baseUrl}/api/swaps/quote?mintAddress=${wallet}&side=buy&amountIn=0.1&slippageBps=1000`);
    assert.equal(invalid.status, 400);
    assert.equal(api.calls.quote, 0);

    const valid = await fetch(`${api.baseUrl}/api/swaps/quote?mintAddress=${wallet}&side=buy&amountIn=0.1&slippageBps=500`);
    assert.equal(valid.status, 200);
    assert.equal(api.calls.quote, 1);
  } finally {
    await api.close();
  }
});

test('portfolio exit quote is read-only, public, and validates the exact raw balance', async () => {
  const api = await startApi(null);
  try {
    const invalid = await fetch(`${api.baseUrl}/api/swaps/portfolio-quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mintAddress: wallet, amountRaw: '0' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(api.calls.portfolioQuote, 0);

    const valid = await fetch(`${api.baseUrl}/api/swaps/portfolio-quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mintAddress: wallet, amountRaw: '123456789' }),
    });
    assert.equal(valid.status, 200);
    assert.equal(api.calls.portfolioQuote, 1);
    assert.equal(api.calls.walletIdentity, undefined);
  } finally {
    await api.close();
  }
});

test('project-wallet routes allow unsigned preparation and chain-verified history without changing wallet identity', async () => {
  const api = await startApi(null);
  try {
    const prepare = await fetch(`${api.baseUrl}/api/swaps/prepare-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prepareBody()),
    });
    assert.equal(prepare.status, 200);
    assert.equal(api.calls.prepareProject, 1);
    assert.equal(api.calls.walletIdentity, undefined);
    assert.equal(api.calls.projectWalletFlow, true);

    const record = await fetch(`${api.baseUrl}/api/swaps/record-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recordBody),
    });
    assert.equal(record.status, 200);
    assert.equal(api.calls.recordProject, 1);
    assert.equal(api.calls.walletIdentity, undefined);
    assert.equal(api.calls.projectWalletFlow, true);

    const standardRecord = await fetch(`${api.baseUrl}/api/swaps/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recordBody),
    });
    assert.equal(standardRecord.status, 401);
    assert.equal(api.calls.record, 0);
  } finally {
    await api.close();
  }
});

test('project-wallet history handler skips Phantom session but leaves unconfirmed signatures pending', async () => {
  const quoteMint = 'So11111111111111111111111111111111111111112';
  const prisma = {
    token: { findUnique: async () => ({ launchPlatform: 'RAYDIUM', poolAddress: otherWallet, poolQuoteMint: quoteMint, bondingCurveAddress: null, symbol: 'TEST' }) },
    $queryRaw: async () => [],
  } as never;
  const connection = { getParsedTransaction: async () => null } as unknown as Connection;
  const counter = createMemoryCounter();
  const rateLimitFactory: typeof createRateLimit = (prefix, max, windowMs, _unused, subject) =>
    createRateLimit(prefix, max, windowMs, counter, subject);
  const app = express();
  app.use(express.json());
  app.use('/api/swaps', createSwapRouter(createSwapHandlers(prisma, connection), async () => null, rateLimitFactory));
  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    const projectRecord = await fetch(`http://127.0.0.1:${address.port}/api/swaps/record-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...recordBody, mintAddress: wallet }),
    });
    assert.equal(projectRecord.status, 202);
    assert.deepEqual(await projectRecord.json(), { success: true, recorded: false, pending: true });

    const normalRecord = await fetch(`http://127.0.0.1:${address.port}/api/swaps/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...recordBody, mintAddress: wallet }),
    });
    assert.equal(normalRecord.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
