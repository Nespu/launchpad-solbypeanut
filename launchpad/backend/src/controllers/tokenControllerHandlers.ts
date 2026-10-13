import { PublicKey, type Connection } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger';

type TokenStore = Pick<PrismaClient, 'token'>;
type WithdrawalStore = Pick<PrismaClient, 'withdrawal'>;

export const MY_TOKENS_LIMIT = 100;

export function createGetMyPoolsHandler(prisma: TokenStore) {
  return async (req: Request, res: Response): Promise<Response> => {
    try {
      const { userWallet } = req.query;

      if (typeof userWallet !== 'string' || !userWallet) {
        return res.status(400).json({
          success: false,
          error: 'Missing required query param: userWallet',
        });
      }

      let creatorWallet: string;
      try {
        creatorWallet = new PublicKey(userWallet).toBase58();
      } catch {
        return res.status(400).json({ success: false, error: 'Invalid userWallet' });
      }

      const pools = await prisma.token.findMany({
        where: {
          creatorWallet,
          poolAddress: { not: null, notIn: ['pending', ''] },
        },
        select: {
          mintAddress: true,
          name: true,
          symbol: true,
          imageUrl: true,
          poolAddress: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.status(200).json({ success: true, pools });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error fetching user pools');
      return res.status(500).json({
        success: false,
        error: error.message || 'Internal server error',
      });
    }
  };
}

export function createGetMyTokensHandler(prisma: TokenStore) {
  return async (req: Request, res: Response): Promise<Response> => {
    const { userWallet } = req.query;
    if (typeof userWallet !== 'string' || !userWallet) {
      return res.status(400).json({ success: false, error: 'Missing required query param: userWallet' });
    }

    let creatorWallet: string;
    try {
      creatorWallet = new PublicKey(userWallet).toBase58();
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid userWallet' });
    }

    try {
      const tokens = await prisma.token.findMany({
        where: { creatorWallet },
        select: {
          mintAddress: true,
          name: true,
          symbol: true,
          imageUrl: true,
          poolAddress: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: MY_TOKENS_LIMIT,
      });
      return res.status(200).json({ success: true, tokens });
    } catch (error) {
      logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Error fetching user tokens');
      return res.status(500).json({ success: false, error: 'Unable to fetch user tokens' });
    }
  };
}

export function createGetTokenDetailsHandler(prisma: TokenStore) {
  return async (req: Request, res: Response): Promise<Response> => {
    let mintAddress: string;
    try {
      mintAddress = new PublicKey(req.params.mintAddress).toBase58();
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid mintAddress' });
    }

    try {
      const token = await prisma.token.findUnique({
        where: { mintAddress },
        select: {
          mintAddress: true,
          name: true,
          symbol: true,
          description: true,
          imageUrl: true,
          totalSupply: true,
          liquiditySol: true,
          creatorWallet: true,
          createdAt: true,
          txHash: true,
          poolAddress: true,
          status: true,
        },
      });

      if (!token) return res.status(404).json({ success: false, error: 'Token not found' });

      return res.status(200).json({
        success: true,
        token: { ...token, totalSupply: token.totalSupply.toString() },
      });
    } catch (error: any) {
      logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Error fetching token details');
      return res.status(500).json({ success: false, error: 'Unable to fetch token details' });
    }
  };
}

export function createUpdateWithdrawalResultHandler(prisma: WithdrawalStore, connection: Connection) {
  return async (req: Request, res: Response): Promise<Response> => {
    try {
      const { withdrawalId, userWallet, txHash } = req.body;
      const wallet = new PublicKey(userWallet).toBase58();
      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!withdrawal) return res.status(404).json({ success: false, error: 'Withdrawal not found' });
      if (withdrawal.userWallet !== wallet) return res.status(403).json({ success: false, error: 'Wallet does not own this withdrawal' });

      if (txHash) {
        if (withdrawal.status === 'completed' && withdrawal.txHash === txHash) {
          return res.status(200).json({ success: true, status: 'completed', txHash });
        }
        if (withdrawal.status !== 'pending') return res.status(409).json({ success: false, error: 'Withdrawal is no longer pending' });

        let parsedTransaction: Awaited<ReturnType<typeof connection.getParsedTransaction>> = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          parsedTransaction = await connection.getParsedTransaction(txHash, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (parsedTransaction) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!parsedTransaction) {
          return res.status(400).json({ success: false, error: 'Withdrawal transaction is not confirmed successfully' });
        }
        if (parsedTransaction.meta?.err) {
          await prisma.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'failed', txHash } });
          return res.status(200).json({ success: true, status: 'failed', txHash });
        }
        const accountKeys = parsedTransaction.transaction.message.accountKeys;
        const walletSigned = accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer);
        const includesPool = accountKeys.some((key) => key.pubkey.toBase58() === withdrawal.poolAddress);
        if (!walletSigned || !includesPool) {
          return res.status(400).json({ success: false, error: 'Confirmed transaction does not match this wallet and pool' });
        }

        await prisma.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'completed', txHash } });
        return res.status(200).json({ success: true, status: 'completed', txHash });
      }

      if (withdrawal.status !== 'pending') return res.status(409).json({ success: false, error: 'Withdrawal is no longer pending' });
      await prisma.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'failed' } });
      return res.status(200).json({ success: true, status: 'failed' });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error updating withdrawal result');
      return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  };
}