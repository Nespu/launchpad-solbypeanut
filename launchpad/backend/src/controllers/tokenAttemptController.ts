import type { RequestHandler } from 'express';
import { logger } from '../utils/logger';

export const reportTokenAttemptOutcome: RequestHandler = (req, res) => {
  const { attemptId, userWallet, mintAddress, outcome } = req.body;
  logger.info({ attemptId, userWallet, mintAddress, outcome }, 'Token creation wallet signature rejected');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(202).json({ success: true });
};
