import { createHash } from 'node:crypto';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
} from '@solana/spl-token';
import { OnlinePumpSdk, type CreatorVaultQuoteBalance } from '@pump-fun/pump-sdk';
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import type { Request, Response } from 'express';
import { sendInternalError } from '../utils/internalError';
import { PublicError } from '../utils/publicError';
import { connection } from '../utils/solana';
import { DEVNET_GENESIS_HASH } from '../utils/solanaNetwork';

const PUMP_CLAIM_COMPUTE_UNITS = 600_000;

type CreatorFeeSdk = Pick<
  OnlinePumpSdk,
  'fetchGlobal' | 'getCreatorVaultQuoteBalances' | 'collectCoinCreatorFeeV2Instructions'
>;

type CreatorFeeDependencies = {
  connection: Connection;
  createSdk: (connection: Connection) => CreatorFeeSdk;
  readMint: typeof getMint;
};

const defaultDependencies: CreatorFeeDependencies = {
  connection,
  createSdk: (rpc) => new OnlinePumpSdk(rpc),
  readMint: getMint,
};

function publicErrorResponse(res: Response, error: unknown, context: string): Response {
  if (error instanceof PublicError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  return sendInternalError(res, error, context);
}

function formatBalance(balance: CreatorVaultQuoteBalance, decimals: number, symbol: string) {
  return {
    mint: balance.mint.toBase58(),
    symbol,
    decimals,
    source: balance.source,
    pumpVaultRaw: balance.pumpVault.toString(),
    ammVaultRaw: balance.ammVault.toString(),
    totalRaw: balance.total.toString(),
  };
}

async function assertDevnet(rpc: Connection): Promise<void> {
  const genesisHash = await rpc.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new PublicError('Wire solo prepara estas operaciones en Solana Devnet.', 503);
  }
}

export function createPumpCreatorFeeHandlers(
  dependencies: CreatorFeeDependencies = defaultDependencies,
) {
  const { connection: rpc, createSdk, readMint } = dependencies;

  return {
    status: async (_req: Request, res: Response): Promise<Response> => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await assertDevnet(rpc);
        const global = await createSdk(rpc).fetchGlobal();
        return res.status(200).json({
          success: true,
          network: 'devnet',
          holderRewardsEnabled: global.isHolderRewardEnabled === true,
        });
      } catch (error) {
        return publicErrorResponse(res, error, 'Pump Devnet status lookup failed');
      }
    },

    balances: async (req: Request, res: Response): Promise<Response> => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await assertDevnet(rpc);
        const creator = new PublicKey(String(req.query.creator));
        const sdk = createSdk(rpc);
        const balances = await sdk.getCreatorVaultQuoteBalances(creator);
        const formatted = await Promise.all(balances.map(async (balance) => {
          if (balance.mint.equals(NATIVE_MINT)) return formatBalance(balance, 9, 'SOL');
          const mint = await readMint(rpc, balance.mint, 'confirmed', balance.quoteTokenProgram);
          const address = balance.mint.toBase58();
          return formatBalance(
            balance,
            mint.decimals,
            `${address.slice(0, 4)}…${address.slice(-4)}`,
          );
        }));
        return res.status(200).json({
          success: true,
          network: 'devnet',
          creator: creator.toBase58(),
          balances: formatted,
        });
      } catch (error) {
        return publicErrorResponse(res, error, 'Pump creator fee balance lookup failed');
      }
    },

    prepare: async (req: Request, res: Response): Promise<Response> => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await assertDevnet(rpc);
        const creator = new PublicKey(req.body.creator);
        const quoteMint = new PublicKey(req.body.quoteMint);
        const sdk = createSdk(rpc);
        const balances = await sdk.getCreatorVaultQuoteBalances(creator);
        const balance = balances.find((entry) => entry.mint.equals(quoteMint));
        if (!balance || balance.total.isZero()) {
          throw new PublicError('No hay comisiones disponibles para retirar en este activo.', 409);
        }

        const instructions = await sdk.collectCoinCreatorFeeV2Instructions(
          creator,
          quoteMint,
          balance.quoteTokenProgram,
          creator,
        );
        const pumpInstruction = instructions[0];
        const ammInstructions = instructions.slice(1);
        const selectedInstructions: TransactionInstruction[] = [];
        if (!balance.pumpVault.isZero()) {
          if (!pumpInstruction) throw new PublicError('No se pudo preparar el retiro de Pump.fun.', 409);
          selectedInstructions.push(pumpInstruction);
        }
        if (!balance.ammVault.isZero()) {
          if (ammInstructions.length !== 1) throw new PublicError('No se pudo preparar el retiro de PumpSwap.', 409);
          selectedInstructions.push(...ammInstructions);
        }
        if (selectedInstructions.length === 0) {
          throw new PublicError('No se pudieron preparar las instrucciones de retiro para este saldo.', 409);
        }

        let rentLamports = 0;
        if (!quoteMint.equals(NATIVE_MINT)) {
          const creatorTokenAccount = getAssociatedTokenAddressSync(
            quoteMint,
            creator,
            true,
            balance.quoteTokenProgram,
          );
          const accountInfo = await rpc.getAccountInfo(creatorTokenAccount, 'confirmed');
          if (accountInfo && !accountInfo.owner.equals(balance.quoteTokenProgram)) {
            throw new PublicError('La cuenta de destino del activo no tiene un formato compatible.', 409);
          }
          if (!accountInfo) {
            const mint = await readMint(rpc, quoteMint, 'confirmed', balance.quoteTokenProgram);
            rentLamports = await rpc.getMinimumBalanceForRentExemption(getAccountLenForMint(mint), 'confirmed');
            selectedInstructions.unshift(createAssociatedTokenAccountIdempotentInstruction(
              creator,
              creatorTokenAccount,
              creator,
              quoteMint,
              balance.quoteTokenProgram,
            ));
          }
        }

        const transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: PUMP_CLAIM_COMPUTE_UNITS }),
          ...selectedInstructions,
        );
        transaction.feePayer = creator;
        const latest = await rpc.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = latest.blockhash;
        const fee = await rpc.getFeeForMessage(transaction.compileMessage(), 'confirmed');
        if (fee.value === null) throw new PublicError('No se pudo estimar la comisión de red.', 503);

        return res.status(200).json({
          success: true,
          network: 'devnet',
          creator: creator.toBase58(),
          quoteMint: quoteMint.toBase58(),
          amountRaw: balance.total.toString(),
          decimals: quoteMint.equals(NATIVE_MINT)
            ? 9
            : (await readMint(rpc, quoteMint, 'confirmed', balance.quoteTokenProgram)).decimals,
          pumpAmountRaw: balance.pumpVault.toString(),
          pumpSwapAmountRaw: balance.ammVault.toString(),
          estimatedNetworkFeeLamports: fee.value,
          estimatedRentLamports: rentLamports,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
          transactionMessageHash: createHash('sha256').update(transaction.serializeMessage()).digest('hex'),
        });
      } catch (error) {
        return publicErrorResponse(res, error, 'Pump creator fee claim preparation failed');
      }
    },
  };
}
