import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger';

type WithdrawalStore = Pick<PrismaClient, 'withdrawal'>;

export function createWithdrawalCleanup(prisma: WithdrawalStore, connection: Connection) {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let afterId: string | undefined;

  const sweepOnce = async () => {
    if (inFlight) return inFlight;
    const currentSweep = (async () => {
        const blockHeight = BigInt(await connection.getBlockHeight('confirmed'));
        const expired = await prisma.withdrawal.findMany({
          where: {
            status: { in: ['pending', 'expired_unverified'] },
            lastValidBlockHeight: { lt: blockHeight },
            OR: [
              { status: 'pending' },
              { status: 'expired_unverified', verifiedTxHash: { not: null } },
            ],
            ...(afterId ? { id: { gt: afterId } } : {}),
          },
          orderBy: { id: 'asc' },
          take: 50,
          select: {
            id: true,
            userWallet: true,
            poolAddress: true,
            transactionMessageHash: true,
            verifiedTxHash: true,
          },
        });

        for (const withdrawal of expired) {
          afterId = withdrawal.id;
          try {
            if (!withdrawal.verifiedTxHash) {
              await prisma.withdrawal.updateMany({
                where: { id: withdrawal.id, status: 'pending', verifiedTxHash: null },
                data: { status: 'expired_unverified' },
              });
              continue;
            }

            const [signatureStatus] = (await connection.getSignatureStatuses(
              [withdrawal.verifiedTxHash],
              { searchTransactionHistory: true },
            )).value;

            if (!signatureStatus) {
              await prisma.withdrawal.updateMany({
                where: { id: withdrawal.id, status: { in: ['pending', 'expired_unverified'] }, verifiedTxHash: withdrawal.verifiedTxHash },
                data: { status: 'expired_unverified', txHash: withdrawal.verifiedTxHash },
              });
              continue;
            }

            if (signatureStatus.confirmationStatus !== 'confirmed' && signatureStatus.confirmationStatus !== 'finalized') {
              continue;
            }

            const transaction = await connection.getTransaction(withdrawal.verifiedTxHash, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            });
            if (!transaction || !withdrawal.transactionMessageHash) continue;

            const message = transaction.transaction.message;
            const messageHash = createHash('sha256').update(message.serialize()).digest('hex');
            const accountKeys = message.staticAccountKeys;
            const signerCount = message.header.numRequiredSignatures;
            const walletSigned = accountKeys.slice(0, signerCount).some((key) => key.toBase58() === withdrawal.userWallet);
            const includesPool = accountKeys.some((key) => key.toBase58() === withdrawal.poolAddress);
            if (messageHash !== withdrawal.transactionMessageHash || !walletSigned || !includesPool) {
              logger.error({ withdrawalId: withdrawal.id, txHash: withdrawal.verifiedTxHash }, 'Expired withdrawal signature does not match its stored transaction');
              continue;
            }

            const status = transaction.meta?.err ? 'failed' : 'completed';
            await prisma.withdrawal.updateMany({
              where: { id: withdrawal.id, status: { in: ['pending', 'expired_unverified'] }, verifiedTxHash: withdrawal.verifiedTxHash },
              data: { status, txHash: withdrawal.verifiedTxHash },
            });
          } catch (error) {
            // A transient RPC or database error for one old withdrawal must not
            // prevent the rest of this bounded batch from being reconciled.
            logger.warn(
              { withdrawalId: withdrawal.id, errorName: error instanceof Error ? error.name : 'UnknownError' },
              'Could not reconcile expired withdrawal in this pass',
            );
          }
        }

        // Continue with later ids next time so an RPC-missing signature cannot
        // occupy the first page forever. Wrap around after a short final page.
        if (expired.length < 50) afterId = undefined;
    })();
    inFlight = currentSweep;
    try {
      await currentSweep;
    } finally {
      if (inFlight === currentSweep) inFlight = undefined;
    }
  };

  return {
    sweepOnce,
    start(onError: (error: unknown) => void, intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => { void sweepOnce().catch(onError); }, intervalMs);
      timer.unref();
      void sweepOnce().catch(onError);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight?.catch(() => undefined);
    },
  };
}
