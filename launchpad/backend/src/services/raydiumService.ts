import { 
  Connection, 
  PublicKey, 
  Transaction, 
  SystemProgram,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { logger } from "../utils/logger";
import { PublicError } from "../utils/publicError";
import { calculateWithdrawalAmounts } from "./withdrawalMath";
import { parseDecimalToRaw, QUOTE_ASSETS, type QuoteAsset } from "./poolQuoteAsset";
import { calculateLiquidityPositionAmounts, type LiquidityPositionUnderlyingAmount } from "./liquidityPositionAmounts";

// ============================================================
// 0. CREACIÓN REAL DE POOL CPMM (Stage 2, SDK real de Raydium)
// ============================================================
export interface CreateCpmmPoolParams {
  userWallet: PublicKey;
  mintAddress: PublicKey;
  mintDecimals: number;
  tokenAmount: string;
  quoteAsset: QuoteAsset;
  quoteAmount: string;
}

export interface CreateCpmmPoolResult {
  transaction: Transaction;
  poolId: string;
  quoteMint: string;
}

export type RaydiumPoolKind = 'cpmm' | 'amm-v4' | 'amm-v5-model';

export type RaydiumLpPositionEstimate = {
  lpMint: string;
  lpAmountRaw: string;
  lpSupplyRaw: string;
  poolKind: 'cpmm' | 'amm-v4';
  assets: LiquidityPositionUnderlyingAmount[];
};

type PoolStateLayout = { span: number; decode(data: Buffer): { lpMint?: unknown; mintLp?: unknown } };
type RaydiumLpMintSdk = {
  CREATE_CPMM_POOL_PROGRAM: PublicKey;
  DEV_CREATE_CPMM_POOL_PROGRAM: PublicKey;
  AMM_V4: PublicKey;
  AMM_STABLE: PublicKey;
  LIQUIDITY_POOL_PROGRAM_ID_V5_MODEL: PublicKey;
  CLMM_PROGRAM_ID: PublicKey;
  CpmmPoolInfoLayout: PoolStateLayout;
  liquidityStateV4Layout: PoolStateLayout;
  liquidityStateV5Layout: PoolStateLayout;
};

/** Use the configured RPC when it can read accounts, otherwise use Devnet's public RPC. */
export async function getReliableDevnetConnection(connection: Connection): Promise<Connection> {
  if (!connection.rpcEndpoint.toLowerCase().includes('devnet')) return connection;

  try {
    const systemAccount = await connection.getAccountInfo(SystemProgram.programId, 'confirmed');
    if (systemAccount) return connection;
  } catch {
    // Retry this read against the public Devnet RPC below.
  }

  const fallbackConnection = new Connection(clusterApiUrl('devnet'), {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  try {
    const systemAccount = await fallbackConnection.getAccountInfo(SystemProgram.programId, 'confirmed');
    if (!systemAccount) throw new Error('Devnet System Program account was not found');
  } catch {
    throw new PublicError('No se pudo consultar Devnet. Revisa la conexión RPC del servidor e inténtalo de nuevo.', 502);
  }

  logger.warn(
    { fallback: 'public-devnet' },
    'Configured Devnet RPC could not read accounts; using the public Devnet RPC fallback'
  );
  return fallbackConnection;
}

/**
 * Prefer the configured RPC, with the public Devnet RPC as a read/build fallback
 * when the configured provider cannot return this pool account.
 */
export async function getRaydiumPoolConnection(connection: Connection, poolAddress: PublicKey): Promise<Connection> {
  let primaryInfo: Awaited<ReturnType<Connection['getAccountInfo']>> = null;
  let primaryFailed = false;
  try {
    primaryInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
  } catch {
    primaryFailed = true;
  }
  if (primaryInfo) return connection;

  if (!connection.rpcEndpoint.toLowerCase().includes('devnet')) {
    if (primaryFailed) {
      throw new PublicError('No se pudo consultar la pool en Solana. Revisa la conexión RPC del backend e inténtalo de nuevo.', 502);
    }
    throw new PublicError('No se encontró esta pool en la red seleccionada.', 404);
  }

  const fallbackConnection = new Connection(clusterApiUrl('devnet'), {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  try {
    const fallbackInfo = await fallbackConnection.getAccountInfo(poolAddress, 'confirmed');
    if (!fallbackInfo) throw new PublicError('No se encontró esta pool en Devnet.', 404);
    logger.warn(
      { poolAddress: poolAddress.toBase58(), reason: primaryFailed ? 'rpc-error' : 'account-not-found' },
      'Configured Devnet RPC could not read the pool; using the public Devnet RPC fallback'
    );
    return fallbackConnection;
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError('No se pudo consultar la pool en Devnet. Revisa la conexión del servidor e inténtalo de nuevo.', 502);
  }
}

function getRaydiumPoolKindFromOwner(owner: PublicKey, sdk: RaydiumLpMintSdk): RaydiumPoolKind {
  if (owner.equals(sdk.CREATE_CPMM_POOL_PROGRAM) || owner.equals(sdk.DEV_CREATE_CPMM_POOL_PROGRAM)) {
    return 'cpmm';
  }
  if (owner.equals(sdk.AMM_V4) || owner.equals(sdk.AMM_STABLE)) return 'amm-v4';
  if (owner.equals(sdk.LIQUIDITY_POOL_PROGRAM_ID_V5_MODEL)) return 'amm-v5-model';
  if (owner.equals(sdk.CLMM_PROGRAM_ID)) {
    throw new PublicError('Esta pool usa posiciones concentradas y no tiene tokens LP fungibles que Wire pueda retirar desde esta pantalla.', 422);
  }
  throw new PublicError('Wire puede leer saldos LP de pools Raydium CPMM, AMM V4 y AMM V5 model; solo puede preparar retiros CPMM y AMM V4. Esta pool usa otro programa.', 422);
}

/** Identify supported Raydium pool programs from the on-chain account owner. */
export async function getRaydiumPoolKind(connection: Connection, poolAddress: PublicKey): Promise<RaydiumPoolKind> {
  const accountInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
  if (!accountInfo) throw new PublicError('No se encontró esta pool en la red seleccionada.', 404);
  const sdk = await import('@raydium-io/raydium-sdk-v2');
  return getRaydiumPoolKindFromOwner(accountInfo.owner, sdk);
}

/** Read the LP mint directly from the on-chain pool state without fetching reserves or market data. */
export function decodeRaydiumLpMintFromAccount(
  accountInfo: { owner: PublicKey; data: Buffer },
  sdk: RaydiumLpMintSdk,
): PublicKey {
  const kind = getRaydiumPoolKindFromOwner(accountInfo.owner, sdk);
  const layout = kind === 'cpmm'
    ? sdk.CpmmPoolInfoLayout
    : kind === 'amm-v5-model'
      ? sdk.liquidityStateV5Layout
      : sdk.liquidityStateV4Layout;
  if (accountInfo.data.length < layout.span) {
    throw new PublicError('No se pudo interpretar la cuenta de esta pool Raydium. Comprueba la dirección e inténtalo de nuevo.', 422);
  }
  let decoded: { lpMint?: unknown; mintLp?: unknown };
  try {
    decoded = layout.decode(accountInfo.data);
  } catch {
    throw new PublicError('No se pudo interpretar la cuenta de esta pool Raydium. Comprueba la dirección e inténtalo de nuevo.', 422);
  }
  const lpMint = decoded.mintLp ?? decoded.lpMint;
  if (!(lpMint instanceof PublicKey) || lpMint.equals(PublicKey.default)) {
    throw new PublicError('La cuenta de esta pool no contiene un mint LP válido.', 422);
  }
  return lpMint;
}

/** Return the fungible LP mint for supported Raydium pool programs. */
export async function getRaydiumLpMint(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<{ lpMint: PublicKey; poolProgramId: PublicKey; connection: Connection }> {
  const poolConnection = await getRaydiumPoolConnection(connection, poolAddress);
  const accountInfo = await poolConnection.getAccountInfo(poolAddress, 'confirmed');
  if (!accountInfo) throw new PublicError('No se encontró esta pool en la red seleccionada.', 404);
  const sdk = await import('@raydium-io/raydium-sdk-v2');
  const lpMint = decodeRaydiumLpMintFromAccount(accountInfo, sdk);
  return { lpMint, poolProgramId: accountInfo.owner, connection: poolConnection };
}

/** Estimate the two underlying reserve quantities for an LP balance on Devnet. */
export async function getRaydiumLpPositionEstimate(
  connection: Connection,
  poolAddress: PublicKey,
  owner: PublicKey,
  lpAmountRaw: string,
): Promise<RaydiumLpPositionEstimate> {
  const poolKind = await getRaydiumPoolKind(connection, poolAddress);
  if (poolKind === 'amm-v5-model') {
    throw new PublicError('Wire todavía no calcula los activos subyacentes de pools Raydium AMM V5 model.', 422);
  }

  const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'devnet',
    disableLoadToken: true,
  });
  const poolId = poolAddress.toBase58();
  let poolInfo: any;
  let poolKeys: any;
  let rpcData: any;

  if (poolKind === 'cpmm') {
    const pool = await raydium.cpmm.getPoolInfoFromRpc(poolId);
    poolInfo = pool.poolInfo;
    poolKeys = pool.poolKeys;
    rpcData = pool.rpcData;
  } else {
    const pool = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
    poolInfo = pool.poolInfo;
    poolKeys = pool.poolKeys;
    rpcData = pool.poolRpcData;
  }

  const lpMint = new PublicKey(poolKeys.mintLp.address);
  const lpSupplyRaw = (await getMint(connection, lpMint, 'confirmed')).supply.toString();
  const mintA = poolInfo?.mintA;
  const mintB = poolInfo?.mintB;
  const reserveA = rpcData?.baseReserve?.toString();
  const reserveB = rpcData?.quoteReserve?.toString();
  if (!mintA?.address || !mintB?.address || reserveA === undefined || reserveB === undefined) {
    throw new Error('Raydium pool assets or reserves are unavailable.');
  }

  const reserveAsset = (mint: any, reserveRaw: string) => {
    const mintAddress = String(mint.address);
    return {
      mintAddress,
      symbol: typeof mint.symbol === 'string' && mint.symbol.trim()
        ? mint.symbol.trim()
        : `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}`,
      decimals: mint.decimals,
      reserveRaw,
    };
  };

  const assets = calculateLiquidityPositionAmounts({
    lpAmountRaw,
    lpSupplyRaw,
    reserves: [reserveAsset(mintA, reserveA), reserveAsset(mintB, reserveB)],
  });
  return { lpMint: lpMint.toBase58(), lpAmountRaw, lpSupplyRaw, poolKind, assets };
}

export async function createRaydiumCpmmPool(
  connection: Connection,
  params: CreateCpmmPoolParams
): Promise<CreateCpmmPoolResult> {
  const poolConnection = await getReliableDevnetConnection(connection);
  const {
    Raydium,
    DEVNET_PROGRAM_ID,
    CREATE_CPMM_POOL_PROGRAM,
    CREATE_CPMM_POOL_FEE_ACC,
    getCpmmPdaAmmConfigId,
    TxVersion,
  } = await import("@raydium-io/raydium-sdk-v2");

  const isDevnet = poolConnection.rpcEndpoint.includes("devnet");

  const raydium = await Raydium.load({
    connection: poolConnection,
    owner: params.userWallet,
    cluster: isDevnet ? "devnet" : "mainnet",
    disableLoadToken: true,
  });

  const mintA = {
    address: params.mintAddress.toBase58(),
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: params.mintDecimals,
  };
  const quoteAsset = QUOTE_ASSETS[params.quoteAsset];
  const quoteMintPublicKey = new PublicKey(quoteAsset.mintAddress);
  const quoteMintInfo = await getMint(poolConnection, quoteMintPublicKey, 'confirmed', TOKEN_PROGRAM_ID);
  if (quoteMintInfo.decimals !== quoteAsset.decimals) {
    throw new PublicError(`The Devnet ${quoteAsset.symbol} mint has an unexpected precision.`, 422);
  }
  const mintB = {
    address: quoteMintPublicKey.toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: quoteMintInfo.decimals,
    symbol: quoteAsset.symbol,
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
  const mintBAmount = new BN(parseDecimalToRaw(params.quoteAmount, quoteAsset.decimals).toString());

  logger.info(
    { mintA: mintA.address, tokenAmount: params.tokenAmount, quoteMint: mintB.address, quoteAmount: params.quoteAmount, quoteSymbol: quoteAsset.symbol },
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
    ownerInfo: { useSOLBalance: params.quoteAsset === 'SOL' },
    txVersion: TxVersion.LEGACY,
  });

  return {
    transaction: transaction as Transaction,
    poolId: extInfo.address.poolId.toBase58(),
    quoteMint: quoteMintPublicKey.toBase58(),
  };
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

function rawTokenAmountToDecimal(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function withdrawLiquidityWithFee(
  connection: Connection,
  poolAddress: PublicKey,
  userWallet: PublicKey,
  lpTokenAmount: string,
  platformFeeWallet: PublicKey
): Promise<{
  transaction: Transaction;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  totalQuoteOut: number;
  minimumQuoteOut: number;
  minimumQuoteOutRaw: string;
  userAmount: number;
  platformFee: number;
  quoteAmountRaw: string;
  platformFeeRaw: string;
  totalSolOut: number;
  minimumSolOut: number;
  tokenOutAmount: string;
  minimumTokenOutAmount: string;
  tokenSymbol: string;
  userAmountSol: number;
  platformFeeSol: number;
  userAmountLamports: string;
  platformFeeLamports: string;
}> {
  let withdrawalStage = 'load-sdk';
  try {
    const { Raydium, Percent, TxVersion } = await import("@raydium-io/raydium-sdk-v2");
    const isDevnet = connection.rpcEndpoint.includes("devnet");

    withdrawalStage = 'load-raydium';
    const poolConnection = await getRaydiumPoolConnection(connection, poolAddress);
    const poolId = poolAddress.toBase58();
    const poolKind = await getRaydiumPoolKind(poolConnection, poolAddress);
    if (poolKind === 'amm-v5-model') {
      throw new PublicError('Esta pool usa el programa Raydium AMM v5 de modelo. Wire puede leer su saldo LP, pero este flujo todavía no puede preparar un retiro para ese programa.', 422);
    }

    const raydium = await Raydium.load({
      connection: poolConnection,
      owner: userWallet,
      cluster: isDevnet ? "devnet" : "mainnet",
      disableLoadToken: true,
    });

    withdrawalStage = 'fetch-pool';
    let poolInfo: any;
    let poolKeys: any;
    let rpcData: any;
    let lpSupplyRaw: string;

    if (poolKind === 'cpmm') {
      const pool = await raydium.cpmm.getPoolInfoFromRpc(poolId);
      poolInfo = pool.poolInfo;
      poolKeys = pool.poolKeys;
      rpcData = pool.rpcData;
      lpSupplyRaw = pool.rpcData.lpAmount.toString();
    } else {
      const pool = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
      poolInfo = pool.poolInfo;
      poolKeys = pool.poolKeys;
      rpcData = pool.poolRpcData;
      const lpMint = new PublicKey(poolKeys.mintLp.address);
      lpSupplyRaw = (await getMint(poolConnection, lpMint)).supply.toString();
    }

    const mintAAddress = poolInfo?.mintA?.address;
    const mintBAddress = poolInfo?.mintB?.address;
    const quoteAsset = Object.values(QUOTE_ASSETS).find((asset) =>
      asset.mintAddress === mintAAddress || asset.mintAddress === mintBAddress,
    );
    if (!quoteAsset) throw new Error("Withdrawal pool does not contain a supported Devnet SOL or USDC quote asset");
    const quoteIsBase = mintAAddress === quoteAsset.mintAddress;

    const baseReserveRaw = rpcData?.baseReserve?.toString();
    const quoteReserveRaw = rpcData?.quoteReserve?.toString();
    if (baseReserveRaw === undefined || quoteReserveRaw === undefined || !lpSupplyRaw) {
      throw new Error("Pool reserves or LP supply are unavailable");
    }
    withdrawalStage = 'calculate-amounts';
    const amounts = calculateWithdrawalAmounts({
      lpAmountRaw: lpTokenAmount,
      lpSupplyRaw,
      baseReserveRaw,
      quoteReserveRaw,
      quoteIsBase,
      quoteDecimals: quoteAsset.decimals,
    });
    const lpAmountRaw = BigInt(lpTokenAmount);
    const lpSupply = BigInt(lpSupplyRaw);
    const tokenIsBase = !quoteIsBase;
    const tokenReserveRaw = BigInt(tokenIsBase ? baseReserveRaw : quoteReserveRaw);
    const tokenMint = tokenIsBase ? poolInfo.mintA : poolInfo.mintB;
    const tokenAmountRaw = (tokenReserveRaw * lpAmountRaw) / lpSupply;
    const minimumTokenAmountRaw = tokenIsBase ? amounts.baseMinAmountRaw : amounts.quoteMinAmountRaw;
    const tokenOutAmount = rawTokenAmountToDecimal(tokenAmountRaw, tokenMint.decimals);
    const minimumTokenOutAmount = rawTokenAmountToDecimal(minimumTokenAmountRaw, tokenMint.decimals);
    const tokenSymbol = tokenMint.symbol || `${tokenMint.address.slice(0, 4)}…${tokenMint.address.slice(-4)}`;

    logger.info(
      {
        poolId,
        lpTokenAmount,
        totalQuoteOut: amounts.totalQuoteOut,
        userAmount: amounts.userAmount,
        platformFee: amounts.platformFee,
        quoteSymbol: quoteAsset.symbol,
        tokenOutAmount,
        tokenSymbol,
        slippagePercent: 1,
        baseMinAmountRaw: amounts.baseMinAmountRaw.toString(),
        quoteMinAmountRaw: amounts.quoteMinAmountRaw.toString(),
      },
      "Preparing REAL withdrawal with 10% fee"
    );

    const lpAmount = new BN(lpTokenAmount);

    withdrawalStage = 'build-raydium-withdrawal';
    const { transaction } = poolKind === 'cpmm'
      ? await raydium.cpmm.withdrawLiquidity({
          poolInfo,
          poolKeys,
          payer: userWallet,
          lpAmount,
          slippage: new Percent(1, 100),
          txVersion: TxVersion.LEGACY,
        })
      : await raydium.liquidity.removeLiquidity({
          poolInfo,
          poolKeys,
          payer: userWallet,
          lpAmount,
          baseAmountMin: new BN(amounts.baseMinAmountRaw.toString()),
          quoteAmountMin: new BN(amounts.quoteMinAmountRaw.toString()),
          txVersion: TxVersion.LEGACY,
        });

    const tx = transaction as Transaction;

    withdrawalStage = 'add-platform-fee';
    if (quoteAsset.symbol === 'SOL') {
      if (amounts.platformFeeRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Platform fee exceeds the safe lamport range');
      }
      tx.add(SystemProgram.transfer({
        fromPubkey: userWallet,
        toPubkey: platformFeeWallet,
        lamports: Number(amounts.platformFeeRaw),
      }));
    } else {
      const quoteMint = new PublicKey(quoteAsset.mintAddress);
      const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, userWallet, false, TOKEN_PROGRAM_ID);
      const platformQuoteAta = getAssociatedTokenAddressSync(quoteMint, platformFeeWallet, false, TOKEN_PROGRAM_ID);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        userWallet, platformQuoteAta, platformFeeWallet, quoteMint, TOKEN_PROGRAM_ID,
      ));
      tx.add(createTransferCheckedInstruction(
        userQuoteAta,
        quoteMint,
        platformQuoteAta,
        userWallet,
        amounts.platformFeeRaw,
        quoteAsset.decimals,
        [],
        TOKEN_PROGRAM_ID,
      ));
    }

    const quoteMinimumRaw = quoteIsBase ? amounts.baseMinAmountRaw : amounts.quoteMinAmountRaw;
    const minimumQuoteOut = Number(quoteMinimumRaw) / (10 ** quoteAsset.decimals);
    const legacySolAmounts = quoteAsset.symbol === 'SOL'
      ? { totalSolOut: amounts.totalQuoteOut, minimumSolOut: minimumQuoteOut, userAmountSol: amounts.userAmount, platformFeeSol: amounts.platformFee }
      : { totalSolOut: 0, minimumSolOut: 0, userAmountSol: 0, platformFeeSol: 0 };

    return {
      transaction: tx,
      quoteMint: quoteAsset.mintAddress,
      quoteSymbol: quoteAsset.symbol,
      quoteDecimals: quoteAsset.decimals,
      totalQuoteOut: amounts.totalQuoteOut,
      minimumQuoteOut,
      minimumQuoteOutRaw: quoteMinimumRaw.toString(),
      userAmount: amounts.userAmount,
      platformFee: amounts.platformFee,
      quoteAmountRaw: amounts.totalQuoteOutRaw.toString(),
      platformFeeRaw: amounts.platformFeeRaw.toString(),
      ...legacySolAmounts,
      tokenOutAmount,
      minimumTokenOutAmount,
      tokenSymbol,
      userAmountSol: legacySolAmounts.userAmountSol,
      platformFeeSol: legacySolAmounts.platformFeeSol,
      userAmountLamports: quoteAsset.symbol === 'SOL' ? amounts.userAmountRaw.toString() : '0',
      platformFeeLamports: quoteAsset.symbol === 'SOL' ? amounts.platformFeeRaw.toString() : '0',
    };
  } catch (error: any) {
    logger.error(
      {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        stage: withdrawalStage,
        poolAddress: poolAddress.toBase58(),
      },
      "Error withdrawing liquidity with fee"
    );
    if (error instanceof PublicError) {
      Object.assign(error, { withdrawalStage });
      throw error;
    }
    const stageError = new Error(`Failed to withdraw liquidity: ${error.message}`) as Error & { withdrawalStage?: string };
    stageError.withdrawalStage = withdrawalStage;
    throw stageError;
  }
}

// ============================================================
// 3. EXPORT DEFAULT
// ============================================================

export default {
  createRaydiumCpmmPool,
  withdrawLiquidityWithFee,
};
