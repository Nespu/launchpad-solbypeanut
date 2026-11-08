import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { logger } from './logger';

/** Return a safe error response without exposing provider, database, or RPC details. */
export function sendInternalError(
  res: Response,
  error: unknown,
  context: string,
  details: Record<string, string | number> = {},
): Response {
  const errorId = randomUUID();
  logger.error({ errorId, errorName: error instanceof Error ? error.name : 'UnknownError', ...details }, context);
  const stage = typeof details.stage === 'string' ? details.stage : undefined;
  return res.status(500).json({
    success: false,
    error: 'No se pudo completar la operación. Inténtalo de nuevo.',
    errorId,
    ...(stage ? { stage } : {}),
  });
}
