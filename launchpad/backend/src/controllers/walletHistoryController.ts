import type { PrismaClient } from '@prisma/client';
import type { Request, RequestHandler } from 'express';
import bs58 from 'bs58';
import { logger } from '../utils/logger';

type HistoryStore = Pick<PrismaClient, 'token' | 'withdrawal' | '$queryRaw'>;
type WalletResolver = (req: Request) => Promise<string | null>;
type WalletSwapHistoryRow = {
  id: string;
  signature: string;
  mintAddress: string;
  poolAddress: string;
  venue: string;
  side: string;
  tokenAmountRaw: string;
  solAmountLamports: string | null;
  quoteAmountRaw: string | null;
  quoteMint: string;
  quoteDecimals: number;
  tokenDecimals: number;
  slot: string;
  blockTime: Date | null;
  networkFeeLamports: string | null;
  createdAt: Date;
};
const SWAP_HISTORY_PAGE_SIZE = 200;

function parseSwapHistoryCursor(req: Request): { slot: string; signature: string } | null | false {
  const slot = req.query.beforeSlot;
  const signature = req.query.beforeSignature;
  if (slot === undefined && signature === undefined) return null;
  if (typeof slot !== 'string' || !/^\d{1,20}$/.test(slot)
    || typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature)) return false;
  try {
    if (BigInt(slot) > 9_223_372_036_854_775_807n || bs58.decode(signature).length !== 64) return false;
  } catch {
    return false;
  }
  return { slot, signature };
}

function errorDetails(error: unknown) {
  if (!(error instanceof Error)) return { errorName: 'UnknownError' };

  const prismaError = error as Error & { code?: unknown; meta?: unknown };
  const databaseCode = typeof prismaError.meta === 'object' && prismaError.meta !== null && 'code' in prismaError.meta
    ? (prismaError.meta as { code?: unknown }).code
    : undefined;

  return {
    errorName: error.name,
    ...(typeof prismaError.code === 'string' ? { errorCode: prismaError.code } : {}),
    ...(typeof databaseCode === 'string' ? { databaseCode } : {}),
  };
}

export function createGetWalletHistoryHandler(prisma: HistoryStore, resolveWallet: WalletResolver): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const wallet = await resolveWallet(req);
      if (!wallet) return res.status(401).json({ success: false, error: 'Identifica tu wallet para ver el historial.' });
      const cursor = parseSwapHistoryCursor(req);
      if (cursor === false) return res.status(400).json({ success: false, error: 'El cursor del historial de swaps no es válido.' });

      const [tokens, withdrawalResult] = await Promise.all([
        prisma.token.findMany({
          where: { creatorWallet: wallet },
          select: {
            mintAddress: true,
            name: true,
            symbol: true,
            imageUrl: true,
            poolAddress: true,
            poolQuoteMint: true,
            launchPlatform: true,
            bondingCurveAddress: true,
            status: true,
            createdAt: true,
            txHash: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        (async () => {
          try {
            return {
              rows: await prisma.withdrawal.findMany({
                where: { userWallet: wallet },
                select: {
                  id: true,
                  poolAddress: true,
                  lpTokenAmount: true,
                  lpTokenAmountRaw: true,
                  userAmount: true,
                  userAmountLamports: true,
                  platformFee: true,
                  platformFeeLamports: true,
                  quoteAmountRaw: true,
                  platformFeeRaw: true,
                  quoteMint: true,
                  quoteDecimals: true,
                  status: true,
                  txHash: true,
                  createdAt: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 100,
              }),
              unavailable: false,
              amountsApproximate: false,
            };
          } catch (error) {
            logger.warn(errorDetails(error), 'Exact wallet withdrawal history is unavailable; retrying legacy fields');
            try {
              const rows = await prisma.withdrawal.findMany({
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
              });
              return {
                rows: rows.map((row) => ({
                  ...row,
                  lpTokenAmountRaw: null,
                  userAmountLamports: null,
                  platformFeeLamports: null,
                  quoteAmountRaw: null,
                  platformFeeRaw: null,
                  quoteMint: 'So11111111111111111111111111111111111111112',
                  quoteDecimals: 9,
                })),
                unavailable: false,
                amountsApproximate: true,
              };
            } catch (legacyError) {
              logger.error(errorDetails(legacyError), 'Wallet withdrawal history is unavailable');
              return { rows: [], unavailable: true, amountsApproximate: false };
            }
          }
        })(),
      ]);
      const withdrawals = withdrawalResult.rows;

      let swapRows: WalletSwapHistoryRow[] = [];
      let swapsHasMore = false;
      let swapsUnavailable = false;
      try {
        const fetchedRows = cursor
          ? await prisma.$queryRaw<WalletSwapHistoryRow[]>`
          SELECT
            "id", "signature", "mintAddress", "poolAddress", "venue", "side",
            "tokenAmountRaw"::text AS "tokenAmountRaw", "solAmountLamports"::text AS "solAmountLamports",
            "quoteAmountRaw"::text AS "quoteAmountRaw", "quoteMint", "quoteDecimals", "tokenDecimals", "slot"::text AS "slot",
            "blockTime", "networkFeeLamports"::text AS "networkFeeLamports", "createdAt"
          FROM "Swap"
          WHERE "userWallet" = ${wallet}
            AND ("slot" < ${cursor.slot}::bigint OR ("slot" = ${cursor.slot}::bigint AND "signature" < ${cursor.signature}))
          ORDER BY "slot" DESC, "signature" DESC
          LIMIT ${SWAP_HISTORY_PAGE_SIZE + 1}
        `
          : await prisma.$queryRaw<WalletSwapHistoryRow[]>`
          SELECT
            "id", "signature", "mintAddress", "poolAddress", "venue", "side",
            "tokenAmountRaw"::text AS "tokenAmountRaw", "solAmountLamports"::text AS "solAmountLamports",
            "quoteAmountRaw"::text AS "quoteAmountRaw", "quoteMint", "quoteDecimals", "tokenDecimals", "slot"::text AS "slot",
            "blockTime", "networkFeeLamports"::text AS "networkFeeLamports", "createdAt"
          FROM "Swap"
          WHERE "userWallet" = ${wallet}
          ORDER BY "slot" DESC, "signature" DESC
          LIMIT ${SWAP_HISTORY_PAGE_SIZE + 1}
        `;
        swapsHasMore = fetchedRows.length > SWAP_HISTORY_PAGE_SIZE;
        swapRows = fetchedRows.slice(0, SWAP_HISTORY_PAGE_SIZE);
      } catch (error) {
        swapsUnavailable = true;
        logger.warn(errorDetails(error), 'Wallet swap history is unavailable');
      }

      const serializedWithdrawals = withdrawals.map((withdrawal) => ({
        ...withdrawal,
        lpTokenAmountRaw: withdrawal.lpTokenAmountRaw?.toFixed(0) ?? null,
        userAmountLamports: withdrawal.userAmountLamports?.toString() ?? null,
        platformFeeLamports: withdrawal.platformFeeLamports?.toString() ?? null,
        quoteAmountRaw: withdrawal.quoteAmountRaw?.toString() ?? null,
        platformFeeRaw: withdrawal.platformFeeRaw?.toString() ?? null,
      }));
      const serializedSwaps = swapRows.map((swap) => ({ ...swap, side: swap.side === 'sell' ? 'sell' : 'buy' }));
      return res.status(200).json({
        success: true,
        tokens,
        withdrawals: serializedWithdrawals,
        swaps: serializedSwaps,
        swapsHasMore,
        swapsUnavailable,
        withdrawalsUnavailable: withdrawalResult.unavailable,
        withdrawalAmountsApproximate: withdrawalResult.amountsApproximate,
      });
    } catch (error) {
      logger.error(errorDetails(error), 'Error fetching wallet history');
      return res.status(500).json({ success: false, error: 'No se pudo cargar el historial de la wallet.' });
    }
  };
}
