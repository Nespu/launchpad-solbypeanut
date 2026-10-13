import type { RequestHandler } from 'express';
import { logger } from '../utils/logger';
import { tokenAttemptCleanup } from '../services/tokenAttemptCleanupRuntime';

export const reportTokenAttemptOutcome: RequestHandler = async (req, res) => {
  const { attemptId, userWallet, mintAddress, outcome } = req.body;
  try {
    const cleaned = await tokenAttemptCleanup.cancel(attemptId, userWallet, mintAddress);
    logger.info({ attemptId, userWallet, mintAddress, outcome, cleaned }, 'Token creation wallet signature rejected');
  } catch (error) {
    logger.warn({
      attemptId,
      userWallet,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'Token creation rejected; IPFS cleanup will be retried');
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(202).json({ success: true });
};
