import { Prisma, PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import { PublicError } from '../utils/publicError';

type TokenDelegate = Pick<PrismaClient['token'], 'findUnique' | 'create'>;

export async function confirmSignedTransaction(
  connection: Connection,
  rawTransaction: Buffer,
  signature: string,
): Promise<void> {
  let status = (await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  })).value[0];

  if (status?.err) {
    throw new PublicError('La transacción falló en Solana.', 400);
  }

  if (!status) {
    try {
      const submittedSignature = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        maxRetries: 3,
      });
      if (submittedSignature !== signature) {
        throw new Error('Submitted transaction signature did not match the signed transaction');
      }
    } catch (error) {
      status = (await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })).value[0];
      if (status?.err) {
        throw new PublicError('La transacción falló en Solana.', 400);
      }
      if (!status) {
        if (isBlockhashExpired(error)) {
          throw new PublicError('La transacción expiró. Vuelve a firmar.', 400);
        }
        throw error;
      }
    }
  }

  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;

  try {
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new PublicError('La transacción falló en Solana.', 400);
    }
  } catch (error) {
    const currentStatus = (await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })).value[0];
    if (currentStatus?.err) {
      throw new PublicError('La transacción falló en Solana.', 400);
    }
    if (!currentStatus && isBlockhashExpired(error)) {
      throw new PublicError('La transacción expiró. Vuelve a firmar.', 400);
    }
    if (currentStatus?.confirmationStatus !== 'confirmed' && currentStatus?.confirmationStatus !== 'finalized') {
      throw error;
    }
  }
}

export async function createTokenIdempotently(
  token: TokenDelegate,
  data: Prisma.TokenUncheckedCreateInput,
) {
  const matches = (record: { txHash: string; creatorWallet: string } | null) =>
    record?.txHash === data.txHash && record.creatorWallet === data.creatorWallet;

  const existing = await token.findUnique({ where: { mintAddress: data.mintAddress } });
  if (existing) {
    if (matches(existing)) return existing;
    throw new PublicError('Token is already registered.', 409);
  }

  try {
    return await token.create({ data });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }

    const raced = await token.findUnique({ where: { mintAddress: data.mintAddress } });
    if (matches(raced)) return raced;
    throw new PublicError('Token is already registered.', 409);
  }
}

function isBlockhashExpired(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('blockhash not found') ||
    message.includes('blockhash expired') ||
    message.includes('block height exceeded') ||
    message.includes('transactionexpiredblockheightexceeded');
}
