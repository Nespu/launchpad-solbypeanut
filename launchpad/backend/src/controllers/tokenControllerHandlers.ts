import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import { getRaydiumPoolConnection } from '../services/raydiumService';
import { logger } from '../utils/logger';
import { sendInternalError } from '../utils/internalError';
import { PublicError } from '../utils/publicError';

type TokenStore = Pick<PrismaClient, 'token'>;
type WithdrawalStore = Pick<PrismaClient, 'withdrawal'>;

export const MY_TOKENS_LIMIT = 100;

function getSessionWallet(res: Response): string | null {
  const wallet = res.locals.walletIdentity;
  if (typeof wallet !== 'string' || !wallet) return null;
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    return null;
  }
}

export function createGetMyPoolsHandler(prisma: TokenStore) {
  return async (_req: Request, res: Response): Promise<Response> => {
    try {
      const creatorWallet = getSessionWallet(res);
      if (!creatorWallet) return res.status(401).json({ success: false, error: 'Identifica tu wallet para consultar tus pools.' });

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
          poolQuoteMint: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.status(200).json({ success: true, pools });
    } catch (error: any) {
      return sendInternalError(res, error, 'Error fetching user pools');
    }
  };
}

export function createGetMyTokensHandler(prisma: TokenStore) {
  return async (_req: Request, res: Response): Promise<Response> => {
    const creatorWallet = getSessionWallet(res);
    if (!creatorWallet) return res.status(401).json({ success: false, error: 'Identifica tu wallet para consultar tus tokens.' });

    try {
      const tokens = await prisma.token.findMany({
        where: { creatorWallet },
        select: {
          mintAddress: true,
          name: true,
          symbol: true,
          imageUrl: true,
          poolAddress: true,
          poolQuoteMint: true,
          launchPlatform: true,
          bondingCurveAddress: true,
          holderReward: true,
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
          poolQuoteMint: true,
          launchPlatform: true,
          bondingCurveAddress: true,
          holderReward: true,
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
      const { withdrawalId, userWallet, signedTransaction, txHash, cancel } = req.body;
      const wallet = new PublicKey(userWallet).toBase58();
      const sessionWallet = getSessionWallet(res);
      if (!sessionWallet) return res.status(401).json({ success: false, error: 'Identify your wallet before confirming the withdrawal' });
      if (sessionWallet !== wallet) return res.status(403).json({ success: false, error: 'Wallet session does not match the withdrawal' });
      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!withdrawal) return res.status(404).json({ success: false, error: 'Withdrawal not found' });
      if (withdrawal.userWallet !== wallet) return res.status(403).json({ success: false, error: 'Wallet does not own this withdrawal' });
      if (cancel) {
        if (withdrawal.status === 'cancelled') {
          return res.status(200).json({ success: true, status: 'cancelled' });
        }
        if (withdrawal.status !== 'pending' || withdrawal.verifiedTxHash) {
          return res.status(409).json({ success: false, error: 'This withdrawal can no longer be cancelled' });
        }
        const cancelled = await prisma.withdrawal.updateMany({
          where: { id: withdrawalId, status: 'pending', verifiedTxHash: null },
          data: { status: 'cancelled' },
        });
        if (cancelled.count !== 1) return res.status(409).json({ success: false, error: 'This withdrawal can no longer be cancelled' });
        return res.status(200).json({ success: true, status: 'cancelled' });
      }
      if (!withdrawal.transactionMessageHash) {
        return res.status(409).json({ success: false, error: 'This withdrawal predates transaction verification. Prepare a new withdrawal.' });
      }

      const matchesExpectedMessage = (message: { serialize: () => Uint8Array }) => {
        const actualHash = createHash('sha256').update(message.serialize()).digest('hex');
        return actualHash === withdrawal.transactionMessageHash;
      };

      if (signedTransaction) {
        let transaction: Transaction;
        try {
          const bytes = Buffer.from(signedTransaction, 'base64');
          if (bytes.toString('base64') !== signedTransaction) throw new Error('Invalid base64');
          transaction = Transaction.from(bytes);
        } catch {
          return res.status(400).json({ success: false, error: 'Signed withdrawal transaction is invalid' });
        }

        if (withdrawal.status !== 'pending') {
          return res.status(409).json({ success: false, error: 'Esta preparación ya no está pendiente. Prepara el retiro de nuevo.' });
        }
        if (!transaction.feePayer?.equals(new PublicKey(wallet))) {
          return res.status(400).json({ success: false, error: 'La wallet que firmó no coincide con la wallet del retiro.' });
        }
        if (!matchesExpectedMessage(transaction.compileMessage())) {
          return res.status(400).json({ success: false, error: 'La transacción firmada cambió respecto a la preparada. Cancela la revisión y prepara el retiro de nuevo.' });
        }
        if (!transaction.verifySignatures(true) || !transaction.signature) {
          return res.status(400).json({ success: false, error: 'La firma de la transacción no es válida. Inténtalo de nuevo desde Phantom.' });
        }

        const signedTxHash = bs58.encode(transaction.signature);
        if (withdrawal.verifiedTxHash && withdrawal.verifiedTxHash !== signedTxHash) {
          return res.status(409).json({ success: false, error: 'A different signed transaction is already registered' });
        }

        const reserved = withdrawal.verifiedTxHash === signedTxHash
          ? { count: 1 }
          : await prisma.withdrawal.updateMany({
              where: { id: withdrawalId, status: 'pending', verifiedTxHash: null },
              data: { verifiedTxHash: signedTxHash },
            });
        if (reserved.count !== 1) {
          const latest = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
          if (latest?.status !== 'pending' || latest.verifiedTxHash !== signedTxHash) {
            return res.status(409).json({ success: false, error: 'Withdrawal is no longer available for signing' });
          }
        }

        return res.status(200).json({ success: true, status: 'pending', txHash: signedTxHash });
      }

      if (!txHash) return res.status(400).json({ success: false, error: 'Transaction signature is required' });
      if (withdrawal.txHash === txHash && (withdrawal.status === 'completed' || withdrawal.status === 'failed')) {
        return res.status(200).json({ success: true, status: withdrawal.status, txHash });
      }
      if (withdrawal.status !== 'pending' && withdrawal.status !== 'expired_unverified') {
        return res.status(409).json({ success: false, error: 'Withdrawal is no longer available for confirmation' });
      }
      if (withdrawal.verifiedTxHash !== txHash) {
        return res.status(403).json({ success: false, error: 'Transaction signature was not registered for this withdrawal' });
      }

      let verificationConnection = connection;
      try {
        verificationConnection = await getRaydiumPoolConnection(connection, new PublicKey(withdrawal.poolAddress));
      } catch (error) {
        if (error instanceof PublicError) return res.status(error.status).json({ success: false, error: error.message });
        throw error;
      }

      let confirmedTransaction: Awaited<ReturnType<typeof connection.getTransaction>> = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        confirmedTransaction = await verificationConnection.getTransaction(txHash, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
        if (confirmedTransaction) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!confirmedTransaction) {
        return res.status(202).json({ success: false, status: 'pending', error: 'Withdrawal is not confirmed yet' });
      }

      const message = confirmedTransaction.transaction.message;
      const accountKeys = message.staticAccountKeys;
      const requiredSignerCount = message.header.numRequiredSignatures;
      const walletSigned = accountKeys.slice(0, requiredSignerCount).some((key) => key.toBase58() === wallet);
      const includesPool = accountKeys.some((key) => key.toBase58() === withdrawal.poolAddress);
      if (!matchesExpectedMessage(message) || !walletSigned || !includesPool) {
        return res.status(400).json({ success: false, error: 'Confirmed transaction does not match this withdrawal' });
      }

      const status = confirmedTransaction.meta?.err ? 'failed' : 'completed';
      const updated = await prisma.withdrawal.updateMany({
        where: { id: withdrawalId, status: { in: ['pending', 'expired_unverified'] }, verifiedTxHash: txHash },
        data: { status, txHash },
      });
      if (updated.count !== 1) {
        const latest = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
        if (latest?.status === status && latest.txHash === txHash) {
          return res.status(200).json({ success: true, status, txHash });
        }
        return res.status(409).json({ success: false, error: 'Withdrawal was updated by another request' });
      }
      return res.status(200).json({ success: true, status, txHash });
    } catch (error: any) {
      if (error && typeof error === 'object' && error.code === 'P2002') {
        return res.status(409).json({ success: false, error: 'Transaction signature is already linked to another withdrawal' });
      }
      logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Error updating withdrawal result');
      return res.status(500).json({ success: false, error: 'Unable to update withdrawal result' });
    }
  };
}
