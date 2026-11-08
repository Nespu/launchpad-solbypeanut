import { Router, type RequestHandler } from 'express';
import { createRateLimit } from '../middleware/rateLimit';
import { validateBody, validateQuery } from '../middleware/validateRequest';
import {
  preparePumpFeeSharingSchema,
  pumpFeeSharingStatusQuerySchema,
} from '../utils/schemas';

type RateLimitFactory = typeof createRateLimit;

export function createPumpFeeSharingRouter(
  handlers: { status: RequestHandler; prepare: RequestHandler },
  rateLimitFactory: RateLimitFactory = createRateLimit,
): Router {
  const router = Router();
  router.get(
    '/status',
    rateLimitFactory('pump-fee-sharing-status', 30, 60 * 1000),
    validateQuery(pumpFeeSharingStatusQuerySchema),
    handlers.status,
  );
  router.post(
    '/prepare',
    rateLimitFactory('pump-fee-sharing-prepare', 12, 5 * 60 * 1000),
    validateBody(preparePumpFeeSharingSchema),
    rateLimitFactory('pump-fee-sharing-prepare-wallet', 6, 5 * 60 * 1000, undefined, (req) => req.body.creator),
    handlers.prepare,
  );
  return router;
}
