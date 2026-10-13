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
    const tokens = await prisma.token.findMany({ select: { mintAddress: true, imageUrl: true } });
    if (tokens.some((token) => token.imageUrl.includes(`/ipfs/${cid}`))) return true;

    for (const token of tokens) {
      const mint = new PublicKey(token.mintAddress);
      const [metadataAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        METADATA_PROGRAM_ID,
      );
      const metadata = await Metadata.fromAccountAddress(connection, metadataAddress, 'confirmed');
      if (cleanMetadataText(metadata.data.uri).includes(`/ipfs/${cid}`)) return true;
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
    logger.warn({ attemptId, err: error }, 'Deferred cleanup of abandoned token uploads');
  },
});
