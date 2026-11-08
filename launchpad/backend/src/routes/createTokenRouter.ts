import { Router, type RequestHandler } from 'express';
import { PublicKey } from '@solana/web3.js';
import { createRateLimit } from '../middleware/rateLimit';
import { validateBody, validateQuery } from '../middleware/validateRequest';
import {
  createTokenSchema,
  createPumpTokenSchema,
  submitPumpTokenSchema,
  submitTransactionSchema,
  createPoolSchema,
  submitPoolTransactionSchema,
  withdrawLiquiditySchema,
  prepareLpBurnSchema,
  updateWithdrawalResultSchema,
  lpBalanceQuerySchema,
} from '../utils/schemas';

export type TokenRouteHandlers = {
  createToken: RequestHandler;
  createPumpToken?: RequestHandler;
  submitPumpTokenTransaction?: RequestHandler;
  submitTransaction: RequestHandler;
  withdrawLiquidity: RequestHandler;
  prepareLpBurn: RequestHandler;
  prepareLpLock?: RequestHandler;
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
  rateLimitFactory: RateLimitFactory,
  resolveWalletSession: WalletSessionResolver,
): Router {
  const router = Router();
  // Pool preparation/signing may need a few retries during local Devnet testing.
  // Keep the stricter production ceiling unchanged.
  const poolAttemptLimit = process.env.NODE_ENV === 'production' ? 10 : 30;

  const requireWalletIdentity: RequestHandler = async (req, res, next) => {
    try {
      const sessionWallet = await resolveWalletSession(req);
      if (!sessionWallet) {
        return res.status(401).json({ success: false, error: 'Identifica tu wallet antes de crear el token.' });
      }
      const requestedWallet = new PublicKey(req.body.userWallet).toBase58();
      if (sessionWallet !== requestedWallet) {
        return res.status(403).json({ success: false, error: 'La sesión no corresponde a la wallet conectada.' });
      }
      res.locals.walletIdentity = sessionWallet;
      return next();
    } catch {
      return res.status(503).json({ success: false, error: 'No se pudo verificar la sesión de wallet. Intenta de nuevo.' });
    }
  };

  const requireWalletSession: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const sessionWallet = await resolveWalletSession(req);
      if (!sessionWallet) {
        return res.status(401).json({ success: false, error: 'Identifica tu wallet para consultar tus tokens y pools.' });
      }
      res.locals.walletIdentity = new PublicKey(sessionWallet).toBase58();
      return next();
    } catch {
      return res.status(503).json({ success: false, error: 'No se pudo verificar la sesión de wallet. Intenta de nuevo.' });
    }
  };

  const requireWalletSessionForBody: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const sessionWallet = await resolveWalletSession(req);
      if (!sessionWallet) {
        return res.status(401).json({ success: false, error: 'Identifica tu wallet para confirmar el retiro.' });
      }
      const requestedWallet = new PublicKey(req.body.userWallet).toBase58();
      if (sessionWallet !== requestedWallet) {
        return res.status(403).json({ success: false, error: 'La sesión no corresponde a la wallet conectada.' });
      }
      res.locals.walletIdentity = sessionWallet;
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
  if (handlers.createPumpToken && handlers.submitPumpTokenTransaction) {
    router.post(
      '/pump/create-token',
      rateLimitFactory('pump-create-token', 10, 15 * 60 * 1000),
      validateBody(createPumpTokenSchema),
      requireWalletIdentity,
      rateLimitFactory('pump-create-token-wallet', 5, 15 * 60 * 1000, undefined, (req) => req.body.userWallet),
      handlers.createPumpToken,
    );
    router.post(
      '/pump/submit-transaction',
      rateLimitFactory('pump-submit-transaction', 10, 15 * 60 * 1000),
      validateBody(submitPumpTokenSchema),
      requireWalletIdentity,
      handlers.submitPumpTokenTransaction,
    );
  }
  router.post(
    '/submit-transaction',
    rateLimitFactory('submit-transaction', 10, 15 * 60 * 1000),
    validateBody(submitTransactionSchema),
    requireWalletIdentity,
    handlers.submitTransaction,
  );
  router.post(
    '/create-pool',
    rateLimitFactory('create-pool', poolAttemptLimit, 15 * 60 * 1000),
    validateBody(createPoolSchema),
    requireWalletIdentity,
    handlers.createPool,
  );
  router.post(
    '/submit-pool-transaction',
    rateLimitFactory('submit-pool-transaction', poolAttemptLimit, 15 * 60 * 1000),
    validateBody(submitPoolTransactionSchema),
    requireWalletIdentity,
    handlers.submitPoolTransaction,
  );
  router.post(
    '/withdraw-liquidity',
    rateLimitFactory('withdraw-liquidity', 10, 15 * 60 * 1000),
    validateBody(withdrawLiquiditySchema),
    requireWalletIdentity,
    handlers.withdrawLiquidity,
  );
  router.post(
    '/prepare-lp-burn',
    rateLimitFactory('prepare-lp-burn', 5, 15 * 60 * 1000),
    validateBody(prepareLpBurnSchema),
    requireWalletIdentity,
    handlers.prepareLpBurn,
  );
  if (handlers.prepareLpLock) {
    router.post(
      '/prepare-lp-lock',
      rateLimitFactory('prepare-lp-lock', 5, 15 * 60 * 1000),
      validateBody(prepareLpBurnSchema),
      requireWalletIdentity,
      handlers.prepareLpLock,
    );
  }
  router.post('/withdrawal-result', rateLimitFactory('withdrawal-result', 20, 15 * 60 * 1000), validateBody(updateWithdrawalResultSchema), requireWalletSessionForBody, handlers.updateWithdrawalResult);
  router.get('/lp-balance', validateQuery(lpBalanceQuerySchema), handlers.getLpBalance);
  router.get('/my-pools', requireWalletSession, handlers.getMyPools);
  router.get('/my-tokens', requireWalletSession, handlers.getMyTokens);
  router.get('/token/:mintAddress', handlers.getTokenDetails);

  return router;
}
