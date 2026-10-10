import { Router, type RequestHandler } from 'express';
import { createRateLimit } from '../middleware/rateLimit';
import { validateBody, validateQuery } from '../middleware/validateRequest';
import {
  createTokenSchema,
  submitTransactionSchema,
  createPoolSchema,
  submitPoolTransactionSchema,
  withdrawLiquiditySchema,
  updateWithdrawalResultSchema,
  lpBalanceQuerySchema,
  myPoolsQuerySchema,
} from '../utils/schemas';

export type TokenRouteHandlers = {
  createToken: RequestHandler;
  submitTransaction: RequestHandler;
  withdrawLiquidity: RequestHandler;
  createPool: RequestHandler;
  submitPoolTransaction: RequestHandler;
  getLpBalance: RequestHandler;
  getMyPools: RequestHandler;
  updateWithdrawalResult: RequestHandler;
  getFeeConfig: RequestHandler;
};

export type RateLimitFactory = typeof createRateLimit;

export function createTokenRouter(
  handlers: TokenRouteHandlers,
  rateLimitFactory: RateLimitFactory = createRateLimit,
): Router {
  const router = Router();

  router.get('/fee-config', handlers.getFeeConfig);
  router.post('/create-token', rateLimitFactory('create-token', 10, 15 * 60 * 1000), validateBody(createTokenSchema), handlers.createToken);
  router.post('/submit-transaction', rateLimitFactory('submit-transaction', 10, 15 * 60 * 1000), validateBody(submitTransactionSchema), handlers.submitTransaction);
  router.post('/create-pool', rateLimitFactory('create-pool', 10, 15 * 60 * 1000), validateBody(createPoolSchema), handlers.createPool);
  router.post('/submit-pool-transaction', rateLimitFactory('submit-pool-transaction', 10, 15 * 60 * 1000), validateBody(submitPoolTransactionSchema), handlers.submitPoolTransaction);
  router.post('/withdraw-liquidity', rateLimitFactory('withdraw-liquidity', 10, 15 * 60 * 1000), validateBody(withdrawLiquiditySchema), handlers.withdrawLiquidity);
  router.post('/withdrawal-result', rateLimitFactory('withdrawal-result', 20, 15 * 60 * 1000), validateBody(updateWithdrawalResultSchema), handlers.updateWithdrawalResult);
  router.get('/lp-balance', validateQuery(lpBalanceQuerySchema), handlers.getLpBalance);
  router.get('/my-pools', validateQuery(myPoolsQuerySchema), handlers.getMyPools);

  return router;
}
