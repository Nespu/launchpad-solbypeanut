import { Router, type RequestHandler } from 'express';
import { createRateLimit } from '../middleware/rateLimit';
import { validateBody, validateQuery } from '../middleware/validateRequest';
import {
  preparePumpCreatorFeeClaimSchema,
  pumpCreatorFeeBalancesQuerySchema,
} from '../utils/schemas';

type RateLimitFactory = typeof createRateLimit;

export function createPumpCreatorFeeRouter(
  handlers: { status: RequestHandler; balances: RequestHandler; prepare: RequestHandler },
  rateLimitFactory: RateLimitFactory = createRateLimit,
): Router {
  const router = Router();

  router.get('/status', rateLimitFactory('pump-feature-status', 30, 60 * 1000), handlers.status);
  router.get(
    '/balances',
    rateLimitFactory('pump-creator-fee-balances', 30, 60 * 1000),
    validateQuery(pumpCreatorFeeBalancesQuerySchema),
    handlers.balances,
  );
  router.post(
    '/prepare',
    rateLimitFactory('pump-creator-fee-prepare', 20, 5 * 60 * 1000),
    validateBody(preparePumpCreatorFeeClaimSchema),
    rateLimitFactory('pump-creator-fee-prepare-wallet', 10, 5 * 60 * 1000, undefined, (req) => req.body.creator),
    handlers.prepare,
  );

  return router;
}
