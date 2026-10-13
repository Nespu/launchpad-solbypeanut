import { Router, type RequestHandler } from 'express';
import { createRateLimit } from '../middleware/rateLimit';

export function createWalletHistoryRouter(handler: RequestHandler): Router {
  const router = Router();
  router.get('/', createRateLimit('wallet-history', 60, 60 * 1000), handler);
  return router;
}
