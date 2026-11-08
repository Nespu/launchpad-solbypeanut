import { PublicKey, type Connection } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { sendInternalError } from '../utils/internalError';
import { PublicError } from '../utils/publicError';
import { prepareRaydiumSwap, quoteRaydiumSwap, type SwapRequest } from '../services/swapService';
import { preparePumpSwap, quotePumpSwap } from '../services/pumpAmmSwapService';
import { quotePortfolioExit } from '../services/portfolioExitQuoteService';
import {
  verifyConfirmedExternalSwap,
  verifyConfirmedPumpSwap,
  verifyConfirmedRaydiumSwap,
  type VerifiedSwap,
} from '../services/swapHistoryService';

type SwapStore = Pick<PrismaClient, 'token' | '$queryRaw'>;
type LaunchMarket = {
  launchPlatform: string;
  poolAddress: string | null;
  quoteMint: string;
  bondingCurveAddress: string | null;
  symbol: string;
};

function sessionWallet(res: Response): string | null {
  const wallet = res.locals.walletIdentity;
  if (typeof wallet !== 'string') return null;
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    return null;
  }
}

async function findLaunchMarket(prisma: SwapStore, mintAddress: string): Promise<LaunchMarket | undefined> {
  const token = await prisma.token.findUnique({
    where: { mintAddress: new PublicKey(mintAddress).toBase58() },
    select: { launchPlatform: true, poolAddress: true, poolQuoteMint: true, bondingCurveAddress: true, symbol: true },
  });
  return token ? {
    launchPlatform: token.launchPlatform,
    poolAddress: token.poolAddress,
    quoteMint: token.poolQuoteMint,
    bondingCurveAddress: token.bondingCurveAddress,
    symbol: token.symbol,
  } : undefined;
}

function marketAddress(market: LaunchMarket): string | null {
  if (market.launchPlatform === 'PUMP_FUN') return market.bondingCurveAddress;
  if (market.launchPlatform === 'RAYDIUM') return market.poolAddress;
  return null;
}

function requireMarketAddress(market: LaunchMarket): string {
  const address = marketAddress(market);
  if (!address || address === 'pending') {
    if (market.launchPlatform === 'PUMP_FUN') throw new PublicError('La curva de Pump.fun todavía no está disponible.', 409);
    if (market.launchPlatform === 'RAYDIUM') throw new PublicError('Este token todavía no tiene una pool Raydium lista.', 409);
    throw new PublicError('Wire todavía no admite intercambios en este mercado.', 409);
  }
  return new PublicKey(address).toBase58();
}

function sendSwapError(res: Response, error: unknown, context: string): Response {
  if (error instanceof PublicError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  return sendInternalError(res, error, context);
}

function withPumpTokenSymbol<T extends { inputSymbol: string; outputSymbol: string }>(
  quote: T,
  market: LaunchMarket,
  side: SwapRequest['side'],
): T {
  return {
    ...quote,
    inputSymbol: side === 'buy' ? 'SOL' : market.symbol,
    outputSymbol: side === 'buy' ? market.symbol : 'SOL',
  };
}

export function createSwapHandlers(prisma: SwapStore, connection: Connection): {
  quote: RequestHandler;
  portfolioQuote: RequestHandler;
  prepare: RequestHandler;
  record: RequestHandler;
} {
  const quote: RequestHandler = async (req: Request, res: Response): Promise<Response> => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { mintAddress, side, amountIn, slippageBps } = req.query as Record<string, string>;
      const market = await findLaunchMarket(prisma, mintAddress);
      if (market === undefined) return res.status(404).json({ success: false, error: 'Token not found.' });
      const request: SwapRequest = { mintAddress, side: side as SwapRequest['side'], amountIn, slippageBps: Number(slippageBps) };

      if (market.launchPlatform === 'PUMP_FUN') {
        const quote = await quotePumpSwap(connection, request, market.bondingCurveAddress);
        return res.status(200).json({ success: true, quote: withPumpTokenSymbol(quote, market, request.side) });
      }

      const address = requireMarketAddress(market);
      const quote = await quoteRaydiumSwap(connection, address, request);
      return res.status(200).json({ success: true, quote });
    } catch (error) {
      return sendSwapError(res, error, 'Error quoting token swap');
    }
  };

  const portfolioQuote: RequestHandler = async (req: Request, res: Response): Promise<Response> => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { mintAddress, amountRaw } = req.body as { mintAddress: string; amountRaw: string };
      const estimate = await quotePortfolioExit(connection, mintAddress, amountRaw);
      return res.status(200).json(estimate);
    } catch (error) {
      return sendSwapError(res, error, 'Error quoting portfolio token exit');
    }
  };

  const prepare: RequestHandler = async (req: Request, res: Response): Promise<Response> => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { mintAddress, side, amountIn, slippageBps, userWallet } = req.body as {
        mintAddress: string;
        side: SwapRequest['side'];
        amountIn: string;
        slippageBps: number;
        userWallet: string;
      };
      const wallet = new PublicKey(userWallet);
      if (res.locals.projectWalletFlow !== true) {
        const identity = sessionWallet(res);
        if (!identity) return res.status(401).json({ success: false, error: 'Identify your wallet before preparing a swap.' });
        if (identity !== wallet.toBase58()) return res.status(403).json({ success: false, error: 'Wallet session does not match this swap.' });
      }

      const canonicalMint = new PublicKey(mintAddress).toBase58();
      const market = await findLaunchMarket(prisma, canonicalMint);
      if (market === undefined) return res.status(404).json({ success: false, error: 'Token not found.' });
      const request: SwapRequest = { mintAddress: canonicalMint, side, amountIn, slippageBps };

      if (market.launchPlatform === 'PUMP_FUN') {
        const prepared = await preparePumpSwap(connection, wallet, request, market.bondingCurveAddress);
        return res.status(200).json({ ...prepared, quote: withPumpTokenSymbol(prepared.quote, market, side), success: true });
      }

      const address = requireMarketAddress(market);
      const prepared = await prepareRaydiumSwap(connection, address, wallet, request);
      return res.status(200).json({ success: true, ...prepared });
    } catch (error) {
      return sendSwapError(res, error, 'Error preparing token swap');
    }
  };

  const record: RequestHandler = async (req: Request, res: Response): Promise<Response> => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { mintAddress, side, signature, userWallet } = req.body as {
        mintAddress: string;
        side: SwapRequest['side'];
        signature: string;
        userWallet: string;
      };
      const wallet = new PublicKey(userWallet).toBase58();
      if (res.locals.projectWalletFlow !== true) {
        const identity = sessionWallet(res);
        if (!identity) return res.status(401).json({ success: false, error: 'Identify your wallet before recording a swap.' });
        if (identity !== wallet) return res.status(403).json({ success: false, error: 'Wallet session does not match this swap.' });
      }

      const canonicalMint = new PublicKey(mintAddress).toBase58();
      const existing = await prisma.$queryRaw<Array<{ userWallet: string; mintAddress: string; poolAddress: string; venue: string; side: string }>>`
        SELECT "userWallet", "mintAddress", "poolAddress", "venue", "side" FROM "Swap" WHERE "signature" = ${signature} LIMIT 1
      `;
      if (existing.length) {
        const row = existing[0];
        if (row.userWallet !== wallet || row.mintAddress !== canonicalMint || row.side !== side
          || !['RAYDIUM', 'RAYDIUM_AMM_V4', 'RAYDIUM_AMM_STABLE', 'RAYDIUM_CLMM', 'PUMP_FUN', 'PUMP_SWAP'].includes(row.venue)) {
          return res.status(409).json({ success: false, error: 'This transaction is already associated with a different swap.' });
        }
        return res.status(200).json({ success: true, recorded: true, alreadyRecorded: true });
      }

      let venue: 'RAYDIUM' | 'RAYDIUM_AMM_V4' | 'RAYDIUM_AMM_STABLE' | 'RAYDIUM_CLMM' | 'PUMP_FUN' | 'PUMP_SWAP';
      let address: string;
      let verified: VerifiedSwap | null;
      const market = await findLaunchMarket(prisma, canonicalMint);
      if (market === undefined) {
        const externalSwap = await verifyConfirmedExternalSwap(connection, signature, wallet, canonicalMint, side);
        if (!externalSwap) return res.status(202).json({ success: true, recorded: false, pending: true });
        venue = externalSwap.venue;
        address = externalSwap.marketAddress;
        verified = externalSwap;
      } else if (market.launchPlatform === 'PUMP_FUN') {
        if (!market.bondingCurveAddress) throw new PublicError('La dirección de la curva no está registrada.', 409);
        const pumpSwap = await verifyConfirmedPumpSwap(connection, signature, wallet, canonicalMint, market.bondingCurveAddress, side);
        if (!pumpSwap) return res.status(202).json({ success: true, recorded: false, pending: true });
        venue = pumpSwap.venue;
        address = pumpSwap.marketAddress;
        verified = pumpSwap;
      } else if (market.launchPlatform === 'RAYDIUM') {
        address = requireMarketAddress(market);
        venue = 'RAYDIUM';
        verified = await verifyConfirmedRaydiumSwap(connection, signature, wallet, canonicalMint, market.quoteMint, address, side);
      } else {
        throw new PublicError('Wire todavía no admite este mercado.', 409);
      }
      if (!verified) return res.status(202).json({ success: true, recorded: false, pending: true });

      const inserted = await prisma.$queryRaw<Array<{ signature: string }>>`
        INSERT INTO "Swap" (
          "id", "signature", "userWallet", "mintAddress", "poolAddress", "venue", "side",
          "tokenAmountRaw", "solAmountLamports", "quoteAmountRaw", "quoteMint", "quoteDecimals", "tokenDecimals", "slot", "blockTime", "networkFeeLamports", "createdAt"
        ) VALUES (
          ${randomUUID()}, ${signature}, ${wallet}, ${canonicalMint}, ${address}, ${venue}, ${side},
          ${verified.tokenAmountRaw.toString()}::DECIMAL(30, 0), ${verified.solAmountLamports}, ${verified.quoteAmountRaw.toString()}::DECIMAL(30, 0),
          ${verified.quoteMint}, ${verified.quoteDecimals}, ${verified.tokenDecimals}, ${verified.slot},
          ${verified.blockTime}, ${verified.networkFeeLamports}, NOW()
        )
        ON CONFLICT ("signature") DO NOTHING
        RETURNING "signature"
      `;
      if (!inserted.length) {
        const concurrentRecord = await prisma.$queryRaw<Array<{ userWallet: string; mintAddress: string; poolAddress: string; venue: string; side: string }>>`
          SELECT "userWallet", "mintAddress", "poolAddress", "venue", "side" FROM "Swap" WHERE "signature" = ${signature} LIMIT 1
        `;
        const duplicate = concurrentRecord[0];
        if (!duplicate || duplicate.userWallet !== wallet || duplicate.mintAddress !== canonicalMint
          || duplicate.poolAddress !== address || duplicate.venue !== venue || duplicate.side !== side) {
          return res.status(409).json({ success: false, error: 'This transaction is already associated with a different swap.' });
        }
        return res.status(200).json({ success: true, recorded: true, alreadyRecorded: true });
      }
      return res.status(201).json({ success: true, recorded: true, signature: inserted[0].signature });
    } catch (error) {
      return sendSwapError(res, error, 'Error recording confirmed token swap');
    }
  };

  return { quote, portfolioQuote, prepare, record };
}
