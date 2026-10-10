import { 
  Connection, 
  PublicKey, 
  Transaction, 
  TransactionInstruction, 
  SystemProgram,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import BN from "bn.js";
import { logger } from "../utils/logger";

// ============================================================
// 0. CREACIÓN REAL DE POOL CPMM (Stage 2, SDK real de Raydium)
// ============================================================
export interface CreateCpmmPoolParams {
  userWallet: PublicKey;
  mintAddress: PublicKey;
  mintDecimals: number;
  tokenAmount: string;
  solAmount: number;
}

export interface CreateCpmmPoolResult {
  transaction: Transaction;
  poolId: string;
}

export async function createRaydiumCpmmPool(
  connection: Connection,
  params: CreateCpmmPoolParams
): Promise<CreateCpmmPoolResult> {
  const {
    Raydium,
    DEVNET_PROGRAM_ID,
    CREATE_CPMM_POOL_PROGRAM,
    CREATE_CPMM_POOL_FEE_ACC,
    getCpmmPdaAmmConfigId,
    TxVersion,
  } = await import("@raydium-io/raydium-sdk-v2");

  const isDevnet = connection.rpcEndpoint.includes("devnet");

  const raydium = await Raydium.load({
    connection,
    owner: params.userWallet,
    cluster: isDevnet ? "devnet" : "mainnet",
    disableLoadToken: true,
  });

  const mintA = {
    address: params.mintAddress.toBase58(),
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: params.mintDecimals,
  };
  const mintB = {
    address: "So11111111111111111111111111111111111111112",
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: 9,
  };

  const feeConfigs = await raydium.api.getCpmmConfigs();
  if (isDevnet) {
    feeConfigs.forEach((cfg: any) => {
      cfg.id = getCpmmPdaAmmConfigId(
        DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
        cfg.index
      ).publicKey.toBase58();
    });
  }

  const programId = isDevnet
    ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM
    : CREATE_CPMM_POOL_PROGRAM;
  const poolFeeAccount = isDevnet
    ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC
    : CREATE_CPMM_POOL_FEE_ACC;

  const mintAAmount = new BN(params.tokenAmount);
  const mintBAmount = new BN(Math.floor(params.solAmount * LAMPORTS_PER_SOL));

  logger.info(
    { mintA: mintA.address, tokenAmount: params.tokenAmount, solAmount: params.solAmount },
    "Building real Raydium CPMM pool creation transaction"
  );

  const { transaction, extInfo } = await raydium.cpmm.createPool({
    programId,
    poolFeeAccount,
    mintA,
    mintB,
    mintAAmount,
    mintBAmount,
    startTime: new BN(0),
    feeConfig: feeConfigs[0],
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.LEGACY,
  });

  return {
    transaction: transaction as Transaction,
    poolId: extInfo.address.poolId.toBase58(),
  };
}

// ============================================================
// 1. Stub legacy (ya no se usa en el flujo real)
// ============================================================

async function getRaydiumInstance() {
  logger.warn('Raydium SDK not fully configured yet (stub legacy)');
  return {
    liquidity: {
      getPoolInfo: async () => ({
        lpSupply: 1000000,
        solReserve: 100,
        tokenReserve: 1000000,
      }),
      withdraw: async () => new Transaction(),
    },
    createPool: async () => ({
      poolAddress: new PublicKey('So11111111111111111111111111111111111111112'),
      lpMint: new PublicKey('So11111111111111111111111111111111111111112'),
      tx: new Transaction(),
    }),
  };
}

export interface BuildPoolInstructionsParams {
  userWallet: PublicKey;
  mint: PublicKey;
  liquiditySol: number;
  totalSupply: number;
}

export async function buildRaydiumPoolInstructions(
  params: BuildPoolInstructionsParams
): Promise<TransactionInstruction[]> {
  try {
    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const dummyInstruction = new TransactionInstruction({
      keys: [
        { pubkey: params.userWallet, isSigner: true, isWritable: true },
      ],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(
        `launchpad-stub-pool:${params.mint.toBase58()}:${params.liquiditySol}SOL`,
        'utf-8'
      ),
    });
    logger.warn("Using dummy Raydium pool instructions (legacy, unused path)");
    return [dummyInstruction];
  } catch (error: any) {
    logger.error({ error: error.message }, "Failed to build Raydium pool instructions");
    throw new Error(`Failed to build Raydium pool: ${error.message}`);
  }
}

// ============================================================
// 2. RETIRO DE LIQUIDEZ CON COMISIÓN DEL 10% — AHORA REAL
// ============================================================
//
// FIX (07/10 #1): cálculo movido de BN.js a BigInt nativo (evita overflow
// de 53 bits en .toNumber()).
// FIX (07/10 #2): el SDK de Raydium reordena los mints internamente por
// dirección (no respeta el orden mintA/mintB que se usó al crear el pool).
// Por eso NO se puede asumir fijo que "baseReserve" o "quoteReserve" es
// SOL — hay que comparar contra la dirección real de Wrapped SOL
// (So11111111111111111111111111111111111111112) usando poolInfo.mintA /
// poolInfo.mintB para saber cuál lado es SOL en ESTE pool específico.
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

export async function withdrawLiquidityWithFee(
  connection: Connection,
  poolAddress: PublicKey,
  userWallet: PublicKey,
  lpTokenAmount: string,
  platformFeeWallet: PublicKey
): Promise<{
  transaction: Transaction;
  userAmountSol: number;
  platformFeeSol: number;
}> {
  try {
    const { Raydium, Percent, TxVersion } = await import("@raydium-io/raydium-sdk-v2");
    const isDevnet = connection.rpcEndpoint.includes("devnet");

    const raydium = await Raydium.load({
      connection,
      owner: userWallet,
      cluster: isDevnet ? "devnet" : "mainnet",
      disableLoadToken: true,
    });

    const poolId = poolAddress.toBase58();

    const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(poolId);

    const mintAAddress = (poolInfo as any)?.mintA?.address;
    const mintBAddress = (poolInfo as any)?.mintB?.address;
    const mintAIsSol = mintAAddress === SOL_MINT_ADDRESS;

    logger.info(
      {
        lpAmountRaw: lpTokenAmount,
        lpSupplyRaw: rpcData.lpAmount?.toString(),
        baseReserveRaw: (rpcData as any).baseReserve?.toString(),
        quoteReserveRaw: (rpcData as any).quoteReserve?.toString(),
        mintAAddress,
        mintBAddress,
        mintAIsSol,
      },
      "DEBUG withdraw raw values"
    );

    // --- Cálculo con BigInt nativo ---
    const lpAmountBig = BigInt(lpTokenAmount);
    const lpSupplyBig = BigInt(rpcData.lpAmount.toString());
    if (lpAmountBig <= BigInt(0) || lpSupplyBig <= BigInt(0)) {
      throw new Error("LP amount and pool supply must be greater than zero");
    }

    // Si mintA es SOL, la reserva de SOL está en "baseReserve".
    // Si no, mintB es SOL y la reserva está en "quoteReserve".
    const solVaultRaw = mintAIsSol
      ? (rpcData as any).baseReserve?.toString() ?? "0"
      : (rpcData as any).quoteReserve?.toString() ?? "0";
    const solVaultBig = BigInt(solVaultRaw);

    const proportionalLamportsBig =
      lpSupplyBig === BigInt(0) ? BigInt(0) : (solVaultBig * lpAmountBig) / lpSupplyBig;

    const baseReserveBig = BigInt((rpcData as any).baseReserve.toString());
    const quoteReserveBig = BigInt((rpcData as any).quoteReserve.toString());
    const baseMinAmountRaw = ((lpAmountBig * baseReserveBig) / lpSupplyBig * BigInt(99)) / BigInt(100);
    const quoteMinAmountRaw = ((lpAmountBig * quoteReserveBig) / lpSupplyBig * BigInt(99)) / BigInt(100);

    const totalSolOut = Number(proportionalLamportsBig) / LAMPORTS_PER_SOL;
    const platformFeeSol = totalSolOut * 0.10;
    const userAmountSol = totalSolOut * 0.90;
    // --- fin cálculo BigInt ---

    logger.info(
      { poolId, lpTokenAmount, totalSolOut, userAmountSol, platformFeeSol, slippagePercent: 1, baseMinAmountRaw: baseMinAmountRaw.toString(), quoteMinAmountRaw: quoteMinAmountRaw.toString() },
      "Preparing REAL withdrawal with 10% fee"
    );

    const lpAmount = new BN(lpTokenAmount);

    const { transaction } = await raydium.cpmm.withdrawLiquidity({
      poolInfo,
      poolKeys,
      payer: userWallet,
      lpAmount,
      slippage: new Percent(1, 100),
      txVersion: TxVersion.LEGACY,
    });

    const tx = transaction as Transaction;

    const feeInstruction = SystemProgram.transfer({
      fromPubkey: userWallet,
      toPubkey: platformFeeWallet,
      lamports: Math.max(0, Math.floor(platformFeeSol * LAMPORTS_PER_SOL)),
    });
    tx.add(feeInstruction);

    return {
      transaction: tx,
      userAmountSol,
      platformFeeSol,
    };
  } catch (error: any) {
    logger.error(
      { error: error.message, poolAddress: poolAddress.toBase58() },
      "Error withdrawing liquidity with fee"
    );
    throw new Error(`Failed to withdraw liquidity: ${error.message}`);
  }
}

// ============================================================
// 3. EXPORT DEFAULT
// ============================================================

export default {
  createRaydiumCpmmPool,
  buildRaydiumPoolInstructions,
  withdrawLiquidityWithFee,
};
