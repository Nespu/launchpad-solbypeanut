import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { createWalletAuthService } from '../services/walletAuth';
import { logger } from '../utils/logger';
import { PublicError } from '../utils/publicError';

const COOKIE_NAME = 'wire_session';

type WalletAuthService = ReturnType<typeof createWalletAuthService>;

export function createWalletSessionResolver(service: WalletAuthService) {
  return (req: Request) => service.getSession(getCookie(req, COOKIE_NAME));
}

function getCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sendError(res: Response, error: unknown, context: string): Response {
  if (error instanceof PublicError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  const errorId = randomUUID();
  logger.error({ err: error, errorId }, context);
  return res.status(500).json({ success: false, error: 'No se pudo completar la identificación de la wallet.', errorId });
}

export function createWalletAuthHandlers(service: WalletAuthService): {
  challenge: RequestHandler;
  verify: RequestHandler;
  session: RequestHandler;
  logout: RequestHandler;
} {
  return {
    challenge: async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const result = await service.createChallenge(req.body.wallet, req.get('origin') || '');
        return res.json({ success: true, ...result });
      } catch (error) {
        return sendError(res, error, 'Wallet identity challenge failed');
      }
    },

    verify: async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const result = await service.verifyChallenge(
          req.body.wallet,
          req.get('origin') || '',
          req.body.message,
          req.body.signature,
        );
        res.setHeader('Set-Cookie', result.cookie);
        return res.json({ success: true, wallet: result.wallet, expiresInSeconds: result.expiresInSeconds });
      } catch (error) {
        return sendError(res, error, 'Wallet identity verification failed');
      }
    },

    session: async (req, res) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const wallet = await service.getSession(getCookie(req, COOKIE_NAME));
        return res.json({ success: true, authenticated: Boolean(wallet), wallet });
      } catch (error) {
        return sendError(res, error, 'Wallet identity session lookup failed');
      }
    },

    logout: async (req, res) => {
      try {
        res.setHeader('Set-Cookie', await service.logout(getCookie(req, COOKIE_NAME)));
        return res.json({ success: true });
      } catch (error) {
        return sendError(res, error, 'Wallet identity logout failed');
      }
    },
  };
}
