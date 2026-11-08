import { Router, type RequestHandler } from 'express';
import { PublicKey } from '@solana/web3.js';
import { createRateLimit } from '../middleware/rateLimit';
import { validateBody, validateQuery } from '../middleware/validateRequest';
import { portfolioExitQuoteSchema, prepareSwapSchema, recordSwapSchema, swapQuoteQuerySchema } from '../utils/schemas';

type RateLimitFactory = typeof createRateLimit;
type WalletSessionResolver = (req: import('express').Request) => Promise<string | null>;

export function createSwapRouter(
  handlers: { quote: RequestHandler; portfolioQuote?: RequestHandler; prepare: RequestHandler; record: RequestHandler },
  resolveWalletSession: WalletSessionResolver,
  rateLimitFactory: RateLimitFactory = createRateLimit,
): Router {
  const router = Router();

  const requireWalletIdentity: RequestHandler = async (req, res, next) => {
    try {
      const sessionWallet = await resolveWalletSession(req);
      if (!sessionWallet) return res.status(401).json({ success: false, error: 'Identify your wallet before preparing a swap.' });
      const requestedWallet = new PublicKey(req.body.userWallet).toBase58();
      if (sessionWallet !== requestedWallet) return res.status(403).json({ success: false, error: 'Wallet session does not match this swap.' });
      res.locals.walletIdentity = sessionWallet;
      return next();
    } catch {
      return res.status(503).json({ success: false, error: 'Could not verify the wallet session. Try again.' });
    }
  };

  router.get('/quote', rateLimitFactory('swap-quote', 60, 60 * 1000), validateQuery(swapQuoteQuerySchema), handlers.quote);
  if (handlers.portfolioQuote) {
    router.post(
      '/portfolio-quote',
      rateLimitFactory('swap-portfolio-quote', 10, 60 * 1000),
      validateBody(portfolioExitQuoteSchema),
      handlers.portfolioQuote,
    );
  }
  router.post(
    '/prepare',
    rateLimitFactory('swap-prepare', 20, 5 * 60 * 1000),
    validateBody(prepareSwapSchema),
    requireWalletIdentity,
    rateLimitFactory('swap-prepare-wallet', 10, 5 * 60 * 1000, undefined, (req) => req.body.userWallet),
    handlers.prepare,
  );
  router.post(
    '/record',
    rateLimitFactory('swap-record', 20, 5 * 60 * 1000),
    validateBody(recordSwapSchema),
    requireWalletIdentity,
    rateLimitFactory('swap-record-wallet', 10, 5 * 60 * 1000, undefined, (req) => req.body.userWallet),
    handlers.record,
  );

  // Project-wallet swaps are signed locally by the encrypted browser vault. The prepare
  // route only returns an unsigned transaction; record still verifies the confirmed
  // Raydium event on Devnet before writing history.
  const markProjectWalletFlow: RequestHandler = (_req, res, next) => {
    res.locals.projectWalletFlow = true;
    next();
  };
  router.post(
    '/prepare-project',
    rateLimitFactory('swap-project-prepare', 20, 5 * 60 * 1000),
    validateBody(prepareSwapSchema),
    rateLimitFactory('swap-project-prepare-wallet', 10, 5 * 60 * 1000, undefined, (req) => req.body.userWallet),
    markProjectWalletFlow,
    handlers.prepare,
  );
  router.post(
    '/record-project',
    rateLimitFactory('swap-project-record', 20, 5 * 60 * 1000),
    validateBody(recordSwapSchema),
    rateLimitFactory('swap-project-record-wallet', 10, 5 * 60 * 1000, undefined, (req) => req.body.userWallet),
    markProjectWalletFlow,
    handlers.record,
  );

  return router;
}
