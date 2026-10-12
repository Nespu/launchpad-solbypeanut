import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type RequestHandler } from 'express';
import { createRateLimit, type RateLimitCounter } from '../src/middleware/rateLimit';
import { createTokenRouter, type RateLimitFactory, type TokenRouteHandlers } from '../src/routes/createTokenRouter';

const address = '11111111111111111111111111111111';

function createMemoryCounter(now: () => number = Date.now): RateLimitCounter {
  const buckets = new Map<string, { count: number; expiresAt: number }>();

  return async (key, windowMs) => {
    const timestamp = now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.expiresAt <= timestamp) {
      bucket = { count: 0, expiresAt: timestamp + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    return [bucket.count, Math.max(0, bucket.expiresAt - timestamp)];
  };
}

function createHandlers(calls: { count: number; lastBody?: unknown }): TokenRouteHandlers {
  const handler: RequestHandler = (req, res) => {
    calls.count += 1;
    calls.lastBody = req.body;
    res.status(201).json({ success: true });
  };

  return {
    createToken: handler,
    submitTransaction: handler,
    withdrawLiquidity: handler,
    createPool: handler,
    submitPoolTransaction: handler,
    getLpBalance: handler,
    getMyPools: handler,
    getMyTokens: handler,
    getTokenDetails: handler,
    updateWithdrawalResult: handler,
    getFeeConfig: handler,
  };
}

async function startTestApi(rateLimitFactory: RateLimitFactory) {
  const calls = { count: 0, lastBody: undefined as unknown };
  const app = express();
  app.use(express.json());
  app.use('/api', createTokenRouter(createHandlers(calls), rateLimitFactory));

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const serverAddress = server.address() as AddressInfo;
  return {
    calls,
    baseUrl: `http://127.0.0.1:${serverAddress.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

const rateLimitFactory = (counter: RateLimitCounter): RateLimitFactory =>
  (prefix, max, windowMs) => createRateLimit(prefix, max, windowMs, counter);

test('token route validates a request and passes parsed values to its handler', async () => {
  const api = await startTestApi(rateLimitFactory(createMemoryCounter()));

  try {
    const invalidResponse = await fetch(`${api.baseUrl}/api/create-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal(api.calls.count, 0);

    const validResponse = await fetch(`${api.baseUrl}/api/create-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userWallet: address,
        name: ' Token ',
        symbol: ' TST ',
        totalSupply: 1000,
        liquiditySol: 0.5,
      }),
    });

    assert.equal(validResponse.status, 201);
    assert.equal(api.calls.count, 1);
    assert.equal((api.calls.lastBody as { name: string }).name, 'Token');
    assert.deepEqual((api.calls.lastBody as { securityAssets: string[] }).securityAssets, []);
  } finally {
    await api.close();
  }
});

test('route rate limit returns 429 at the configured maximum and keeps route buckets separate', async () => {
  const api = await startTestApi(rateLimitFactory(createMemoryCounter()));

  try {
    const statuses: number[] = [];
    let limitedResponse: Response | undefined;

    for (let index = 0; index < 11; index += 1) {
      const response = await fetch(`${api.baseUrl}/api/create-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      statuses.push(response.status);
      if (index === 10) limitedResponse = response;
    }

    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
    assert.equal(statuses[10], 429);
    assert.equal(limitedResponse?.headers.get('ratelimit-limit'), '10');
    assert.equal(limitedResponse?.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(limitedResponse?.headers.get('retry-after')) > 0);
    assert.equal(api.calls.count, 0);

    const otherRouteResponse = await fetch(`${api.baseUrl}/api/create-pool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(otherRouteResponse.status, 400);
  } finally {
    await api.close();
  }
});

test('rate limiter fails closed with 503 when its counter store fails', async () => {
  const failedCounter: RateLimitCounter = async () => {
    throw new Error('simulated Redis outage');
  };
  const api = await startTestApi(rateLimitFactory(failedCounter));

  try {
    const response = await fetch(`${api.baseUrl}/api/create-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    assert.equal(response.status, 503);
    assert.equal(api.calls.count, 0);
  } finally {
    await api.close();
  }
});

test('my pools route validates the wallet query before calling its handler', async () => {
  const api = await startTestApi(rateLimitFactory(createMemoryCounter()));

  try {
    const invalidResponse = await fetch(`${api.baseUrl}/api/my-pools?userWallet=invalid`);
    assert.equal(invalidResponse.status, 400);
    assert.equal(api.calls.count, 0);

    const validResponse = await fetch(`${api.baseUrl}/api/my-pools?userWallet=${address}`);
    assert.equal(validResponse.status, 201);
    assert.equal(api.calls.count, 1);
  } finally {
    await api.close();
  }
});

