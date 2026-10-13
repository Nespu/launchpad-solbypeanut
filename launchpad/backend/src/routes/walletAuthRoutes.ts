import { Router, type RequestHandler } from 'express';
import { createRateLimit } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validateRequest';
import { walletAuthChallengeSchema, walletAuthVerifySchema } from '../utils/schemas';

export type WalletAuthHandlers = {
  challenge: RequestHandler;
  verify: RequestHandler;
  session: RequestHandler;
  logout: RequestHandler;
};

export function createWalletAuthRouter(handlers: WalletAuthHandlers): Router {
  const router = Router();
  router.post('/challenge', createRateLimit('wallet-auth-challenge', 10, 15 * 60 * 1000), validateBody(walletAuthChallengeSchema), handlers.challenge);
  router.post('/verify', createRateLimit('wallet-auth-verify', 20, 15 * 60 * 1000), validateBody(walletAuthVerifySchema), handlers.verify);
  router.get('/session', handlers.session);
  router.post('/logout', handlers.logout);
  return router;
}
