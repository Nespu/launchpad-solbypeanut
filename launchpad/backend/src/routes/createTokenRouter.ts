import { Router, type RequestHandler } from 'express';
import { PublicKey } from '@solana/web3.js';
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
  myTokensQuerySchema,
} from '../utils/schemas';

export type TokenRouteHandlers = {
  createToken: RequestHandler;
  submitTransaction: RequestHandler;
  withdrawLiquidity: RequestHandler;
  createPool: RequestHandler;
  submitPoolTransaction: RequestHandler;
  getLpBalance: RequestHandler;
  getMyPools: RequestHandler;
  getMyTokens: RequestHandler;
  getTokenDetails: RequestHandler;
  updateWithdrawalResult: RequestHandler;
  getFeeConfig: RequestHandler;
};

export type RateLimitFactory = typeof createRateLimit;
export type WalletSessionResolver = (req: import('express').Request) => Promise<string | null>;

export function createTokenRouter(
  handlers: TokenRouteHandlers,
  rateLimitFactory: RateLimitFactory = createRateLimit,
  resolveWalletSession?: WalletSessionResolver,
): Router {
  const router = Router();

  const requireWalletIdentity: RequestHandler = async (req, res, next) => {
    // The production router always provides a resolver; keeping it optional
    // allows the router to be mounted independently in isolated route tests.
    if (!resolveWalletSession) return next();
    try {
      const sessionWallet = await resolveWalletSession(req);
      if (!sessionWallet) {
        return res.status(401).json({ success: false, error: 'Identifica tu wallet antes de crear el token.' });
      }
      const requestedWallet = new PublicKey(req.body.userWallet).toBase58();
      if (sessionWallet !== requestedWallet) {
        return res.status(403).json({ success: false, error: 'La sesión no corresponde a la wallet conectada.' });
      }
      return next();
    } catch {
      return res.status(503).json({ success: false, error: 'No se pudo verificar la sesión de wallet. Intenta de nuevo.' });
    }
  };

  router.get('/fee-config', handlers.getFeeConfig);
  router.post(
    '/create-token',
    rateLimitFactory('create-token', 10, 15 * 60 * 1000),
    validateBody(createTokenSchema),
    requireWalletIdentity,
    rateLimitFactory('create-token-wallet', 5, 15 * 60 * 1000, undefined, (req) => req.body.userWallet),
    handlers.createToken,
  );
  router.post('/submit-transaction', rateLimitFactory('submit-transaction', 10, 15 * 60 * 1000), validateBody(submitTransactionSchema), handlers.submitTransaction);
  router.post('/create-pool', rateLimitFactory('create-pool', 10, 15 * 60 * 1000), validateBody(createPoolSchema), handlers.createPool);
  router.post('/submit-pool-transaction', rateLimitFactory('submit-pool-transaction', 10, 15 * 60 * 1000), validateBody(submitPoolTransactionSchema), handlers.submitPoolTransaction);
  router.post('/withdraw-liquidity', rateLimitFactory('withdraw-liquidity', 10, 15 * 60 * 1000), validateBody(withdrawLiquiditySchema), handlers.withdrawLiquidity);
  router.post('/withdrawal-result', rateLimitFactory('withdrawal-result', 20, 15 * 60 * 1000), validateBody(updateWithdrawalResultSchema), handlers.updateWithdrawalResult);
  router.get('/lp-balance', validateQuery(lpBalanceQuerySchema), handlers.getLpBalance);
  router.get('/my-pools', validateQuery(myPoolsQuerySchema), handlers.getMyPools);
  router.get('/my-tokens', validateQuery(myTokensQuerySchema), handlers.getMyTokens);
  router.get('/token/:mintAddress', handlers.getTokenDetails);

  return router;
}
