import { PublicKey } from '@solana/web3.js';
import { Metadata, PROGRAM_ID as METADATA_PROGRAM_ID } from '@metaplex-foundation/mpl-token-metadata';
import { getRedisClient } from '../middleware/rateLimit';
import { prisma } from '../utils/prisma';
import { connection } from '../utils/solana';
import { cleanMetadataText } from '../utils/metadataText';
import { logger } from '../utils/logger';
import { unpinIpfsCid } from './ipfsService';
import { createTokenAttemptCleanupService } from './tokenAttemptCleanup';

export const tokenAttemptCleanup = createTokenAttemptCleanupService(getRedisClient(), {
  async isCidReferenced(cid) {
    const knownReference = await prisma.token.findFirst({
      where: {
        OR: [
          { metadataCid: cid },
          { imageUrl: { contains: `/ipfs/${cid}` } },
        ],
      },
      select: { id: true },
    });
    if (knownReference) return true;

    // Older rows predate metadataCid. Scan those in bounded pages and consult
    // chain metadata only for them, so each cleanup pass never materializes
    // the entire Token table in memory.
    const pageSize = 100;
    let afterId: string | undefined;
    while (true) {
      const legacyTokens = await prisma.token.findMany({
        where: {
          metadataCid: null,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: pageSize,
        select: { id: true, mintAddress: true },
      });
      if (legacyTokens.length === 0) break;

      for (const token of legacyTokens) {
        const mint = new PublicKey(token.mintAddress);
        const [metadataAddress] = PublicKey.findProgramAddressSync(
          [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
          METADATA_PROGRAM_ID,
        );
        const metadataAccount = await connection.getAccountInfo(metadataAddress, 'confirmed');
        if (!metadataAccount) continue;
        const metadata = await Metadata.fromAccountAddress(connection, metadataAddress, 'confirmed');
        if (cleanMetadataText(metadata.data.uri).includes(`/ipfs/${cid}`)) return true;
      }

      afterId = legacyTokens[legacyTokens.length - 1].id;
      if (legacyTokens.length < pageSize) break;
    }
    return false;
  },

  async unpin(cid) {
    await unpinIpfsCid(cid);
  },

  async getSignatureState(signature) {
    const status = (await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })).value[0];
    if (status?.err) return 'failed';
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return 'confirmed';
    if (status) return 'pending';
    return 'missing';
  },

  onCleanupError(attemptId, error) {
    logger.warn(
      { attemptId, errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Deferred cleanup of abandoned token uploads',
    );
  },
});
