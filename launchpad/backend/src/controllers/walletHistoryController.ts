import type { PrismaClient } from '@prisma/client';
import type { Request, RequestHandler } from 'express';
import { logger } from '../utils/logger';

type HistoryStore = Pick<PrismaClient, 'token' | 'withdrawal'>;
type WalletResolver = (req: Request) => Promise<string | null>;

export function createGetWalletHistoryHandler(prisma: HistoryStore, resolveWallet: WalletResolver): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const wallet = await resolveWallet(req);
      if (!wallet) return res.status(401).json({ success: false, error: 'Identifica tu wallet para ver el historial.' });

      const [tokens, withdrawals] = await Promise.all([
        prisma.token.findMany({
          where: { creatorWallet: wallet },
          select: {
            mintAddress: true,
            name: true,
            symbol: true,
            imageUrl: true,
            poolAddress: true,
            status: true,
            createdAt: true,
            txHash: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        prisma.withdrawal.findMany({
          where: { userWallet: wallet },
          select: {
            id: true,
            poolAddress: true,
            lpTokenAmount: true,
            userAmount: true,
            platformFee: true,
            status: true,
            txHash: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);

      return res.status(200).json({ success: true, tokens, withdrawals });
    } catch (error) {
      logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Error fetching wallet history');
      return res.status(500).json({ success: false, error: 'No se pudo cargar el historial de la wallet.' });
    }
  };
}
