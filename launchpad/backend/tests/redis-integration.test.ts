import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import Redis from 'ioredis';
import { createRateLimit, type RateLimitCounter } from '../src/middleware/rateLimit';

const testRedisUrl = process.env.TEST_REDIS_URL;
const integrationTest: typeof test = testRedisUrl ? test : test.skip;

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

integrationTest('Redis rate limit enforces its limit and expires its isolated key', async (t) => {
  const redis = new Redis(testRedisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const keys = new Set<string>();
  const prefix = `integration-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const counter: RateLimitCounter = async (key, windowMs) => {
    keys.add(key);
    return await redis.eval(incrementScript, 1, key, String(windowMs)) as [number | string, number | string];
  };
  const app = express();
  app.get('/limited', createRateLimit(prefix, 2, 60_000, counter), (_req, res) => res.status(200).json({ success: true }));
  const server: Server = createServer(app);

  await redis.connect();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (keys.size > 0) await redis.del(...keys);
    await redis.quit();
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/limited`;
  const first = await fetch(url);
  const second = await fetch(url);
  const third = await fetch(url);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('ratelimit-limit'), '2');
  assert.equal(third.headers.get('ratelimit-remaining'), '0');
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  assert.equal(keys.size, 1);
  assert.ok(Number(await redis.pttl([...keys][0])) > 0);
});
