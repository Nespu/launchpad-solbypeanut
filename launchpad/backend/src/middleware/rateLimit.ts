import { createHash } from 'crypto';
import type { RequestHandler } from 'express';
import type Redis from 'ioredis';
import { logger } from '../utils/logger';

export type RateLimitCounter = (key: string, windowMs: number) => Promise<[number | string, number | string]>;

let redis: Redis | undefined;

function getRedis(): Redis {
  if (!redis) {
    const { config } = require('../utils/config') as typeof import('../utils/config');
    const RedisClient = require('ioredis').default as typeof import('ioredis').default;
    redis = new RedisClient(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', (error) => {
      logger.error({ message: error.message }, 'Rate limit store connection error');
    });
  }

  return redis;
}

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

const redisCounter: RateLimitCounter = async (key, windowMs) => {
  return await getRedis().eval(incrementScript, 1, key, String(windowMs)) as [number | string, number | string];
};

export function createRateLimit(
  prefix: string,
  max: number,
  windowMs: number,
  counter: RateLimitCounter = redisCounter,
): RequestHandler {
  return async (req, res, next) => {
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const addressHash = createHash('sha256').update(address).digest('hex');
    const key = `wire:rate-limit:${prefix}:${addressHash}`;

    try {
      const result = await counter(key, windowMs);
      const count = Number(result[0]);
      const ttlMs = Math.max(0, Number(result[1]));
      const remaining = Math.max(0, max - count);
      const resetSeconds = Math.ceil(ttlMs / 1000);

      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(resetSeconds));

      if (count > max) {
        res.setHeader('Retry-After', String(Math.ceil(ttlMs / 1000)));
        return res.status(429).json({ success: false, error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' });
      }

      return next();
    } catch (error) {
      logger.error({ err: error }, 'Rate limit store unavailable');
      return res.status(503).json({ success: false, error: 'La protección temporalmente no está disponible. Intenta de nuevo.' });
    }
  };
}

export const apiRateLimit = createRateLimit('api', 300, 15 * 60 * 1000);
