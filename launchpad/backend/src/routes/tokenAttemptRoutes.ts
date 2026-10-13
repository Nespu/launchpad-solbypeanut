import { Router, type RequestHandler } from 'express';
import { createRateLimit } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validateRequest';
import { tokenAttemptOutcomeSchema } from '../utils/schemas';

export function createTokenAttemptRouter(handler: RequestHandler): Router {
  const router = Router();
  router.post('/outcome', createRateLimit('token-attempt-outcome', 10, 15 * 60 * 1000), validateBody(tokenAttemptOutcomeSchema), handler);
  return router;
}
