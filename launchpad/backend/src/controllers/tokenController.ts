import { Request, Response } from 'express';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import { createRaydiumCpmmPool, withdrawLiquidityWithFee } from '../services/raydiumService';
import { buildMintInstructions } from '../services/mintService';
import {
  buildRevokeMintInstruction,
  buildRevokeFreezeInstruction,
  buildRevokeUpdateInstruction,
} from '../services/authorityService';
import { uploadImageToIpfs } from '../services/ipfsService';
import { logger } from '../utils/logger';
import { connection, getServerKeypair } from '../utils/solana';

const prisma = new PrismaClient();

export const createToken = async (req: Request, res: Response): Promise<Response> => {
  try {
    const {
      userWallet,
      name,
      symbol,
      description,
      imageBase64,
      totalSupply,
      liquiditySol,
      copyFrom,
      securityAssets = [], // array de strings: 'mint' | 'freeze' | 'update'
    } = req.body;

    if (!userWallet || !name || !symbol || !totalSupply || !liquiditySol) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userWallet, name, symbol, totalSupply, liquiditySol',
      });
    }

    const BASE_FEE = 0.5;
    const ASSET_FEE = 0.1;
    const totalFee = BASE_FEE + (securityAssets.length * ASSET_FEE);

    const serverWallet = getServerKeypair();
    const userPublicKey = new PublicKey(userWallet);

    let imageUrl = '';
    if (imageBase64) {
      imageUrl = await uploadImageToIpfs(imageBase64);
    } else {
      imageUrl = 'https://via.placeholder.com/200x200?text=Memecoin';
    }

    const { mintKeypair, instructions: mintInstructions } = await buildMintInstructions({
      userWallet: userPublicKey,
      name,
      symbol,
      metadataUri: imageUrl,
      totalSupply: BigInt(totalSupply) * BigInt(1e9),
      decimals: 9,
    });

    const transaction = new Transaction();
    mintInstructions.forEach((ix) => transaction.add(ix));

    if (securityAssets.includes('mint')) {
      transaction.add(buildRevokeMintInstruction(mintKeypair.publicKey, userPublicKey));
    }
    if (securityAssets.includes('freeze')) {
      transaction.add(buildRevokeFreezeInstruction(mintKeypair.publicKey, userPublicKey));
    }
    if (securityAssets.includes('update')) {
      transaction.add(buildRevokeUpdateInstruction(mintKeypair.publicKey, userPublicKey));
    }

    const feeInstruction = SystemProgram.transfer({
      fromPubkey: userPublicKey,
      toPubkey: new PublicKey(process.env.PLATFORM_FEE_WALLET!),
      lamports: Math.floor(totalFee * LAMPORTS_PER_SOL),
    });
    transaction.add(feeInstruction);

    transaction.feePayer = userPublicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    transaction.partialSign(mintKeypair, serverWallet);

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    await prisma.token.create({
      data: {
        mintAddress: mintKeypair.publicKey.toBase58(),
        name,
        symbol,
        description,
        imageUrl,
        totalSupply: BigInt(totalSupply),
        liquiditySol,
        creatorWallet: userWallet,
        copiedFrom: copyFrom || null,
        txHash: 'pending',
        poolAddress: 'pending',
        status: 'processing',
      },
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString('base64'),
      fee: totalFee,
      mintAddress: mintKeypair.publicKey.toBase58(),
      message: 'Token creation prepared',
    });

  } catch (error: any) {
    logger.error({ error: error.message }, 'Error creating token');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
};

export const submitTransaction = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { signedTransaction, mintAddress } = req.body;

    if (!signedTransaction || !mintAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: signedTransaction, mintAddress',
      });
    }

    const tx = Transaction.from(Buffer.from(signedTransaction, 'base64'));

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const confirmation = await connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }

    await prisma.token.update({
      where: { mintAddress },
      data: {
        txHash: signature,
        status: 'completed',
      },
    });

    return res.status(200).json({
      success: true,
      txId: signature,
      mintAddress,
      solanaUrl: `https://solscan.io/tx/${signature}`,
    });

  } catch (error: any) {
    logger.error({ error: error.message }, 'Error submitting transaction');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
};

export const createPool = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { userWallet, mintAddress, tokenAmount, solAmount } = req.body;

    if (!userWallet || !mintAddress || !tokenAmount || !solAmount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userWallet, mintAddress, tokenAmount, solAmount',
      });
    }

    let creatorPublicKey: PublicKey;
    let mintPublicKey: PublicKey;
    try {
      creatorPublicKey = new PublicKey(userWallet);
      mintPublicKey = new PublicKey(mintAddress);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid userWallet or mintAddress' });
    }

    const canonicalWallet = creatorPublicKey.toBase58();
    const canonicalMint = mintPublicKey.toBase58();
    const token = await prisma.token.findUnique({ where: { mintAddress: canonicalMint } });
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }
    if (token.creatorWallet !== canonicalWallet) {
      return res.status(403).json({ success: false, error: 'Only the token creator can create its pool' });
    }
    if (token.poolAddress && token.poolAddress !== 'pending') {
      return res.status(409).json({ success: false, error: 'A pool is already associated with this token' });
    }

    const { transaction, poolId } = await createRaydiumCpmmPool(connection, {
      userWallet: creatorPublicKey,
      mintAddress: mintPublicKey,
      mintDecimals: 9,
      tokenAmount: BigInt(tokenAmount).toString(),
      solAmount: Number(solAmount),
    });

    transaction.feePayer = creatorPublicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString('base64'),
      poolId,
      message: 'Pool creation prepared',
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error creating pool');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
};

export const submitPoolTransaction = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { signedTransaction, userWallet, mintAddress, poolAddress } = req.body;

    if (!signedTransaction || !userWallet || !mintAddress || !poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: signedTransaction, userWallet, mintAddress, poolAddress',
      });
    }

    let creatorPublicKey: PublicKey;
    let mintPublicKey: PublicKey;
    let poolPublicKey: PublicKey;
    try {
      creatorPublicKey = new PublicKey(userWallet);
      mintPublicKey = new PublicKey(mintAddress);
      poolPublicKey = new PublicKey(poolAddress);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid wallet, mint, or pool address' });
    }

    const canonicalWallet = creatorPublicKey.toBase58();
    const canonicalMint = mintPublicKey.toBase58();
    const canonicalPool = poolPublicKey.toBase58();
    const token = await prisma.token.findUnique({ where: { mintAddress: canonicalMint } });
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }
    if (token.creatorWallet !== canonicalWallet) {
      return res.status(403).json({ success: false, error: 'Only the token creator can associate its pool' });
    }
    if (token.poolAddress && token.poolAddress !== 'pending') {
      return res.status(409).json({ success: false, error: 'A pool is already associated with this token' });
    }

    const transaction = Transaction.from(Buffer.from(signedTransaction, 'base64'));
    const creatorSignature = transaction.signatures.find((item) =>
      item.publicKey.equals(creatorPublicKey)
    )?.signature;
    if (
      !transaction.feePayer?.equals(creatorPublicKey) ||
      !creatorSignature ||
      !transaction.verifySignatures(false)
    ) {
      return res.status(400).json({ success: false, error: 'Transaction is not signed by the creator wallet' });
    }
    if (!transaction.compileMessage().accountKeys.some((key) => key.equals(poolPublicKey))) {
      return res.status(400).json({ success: false, error: 'Pool address is not part of the signed transaction' });
    }

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error('Pool transaction failed: ' + JSON.stringify(confirmation.value.err));
    }

    const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
    const isDevnet = connection.rpcEndpoint.includes('devnet');
    const raydium = await Raydium.load({
      connection,
      owner: creatorPublicKey,
      cluster: isDevnet ? 'devnet' : 'mainnet',
      disableLoadToken: true,
    });

    let poolInfo: any = null;
    let lastPoolInfoError: any = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await raydium.cpmm.getPoolInfoFromRpc(canonicalPool);
        poolInfo = result.poolInfo;
        break;
      } catch (error: any) {
        lastPoolInfoError = error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (!poolInfo) {
      throw lastPoolInfoError || new Error('Confirmed pool was not found on-chain');
    }

    const poolMints = [poolInfo?.mintA?.address, poolInfo?.mintB?.address];
    const solMint = 'So11111111111111111111111111111111111111112';
    if (!poolMints.includes(canonicalMint) || !poolMints.includes(solMint)) {
      return res.status(400).json({
        success: false,
        error: 'Confirmed pool does not match this token and wrapped SOL',
      });
    }

    const updateResult = await prisma.token.updateMany({
      where: {
        mintAddress: canonicalMint,
        creatorWallet: canonicalWallet,
        poolAddress: token.poolAddress,
      },
      data: { poolAddress: canonicalPool },
    });
    if (updateResult.count !== 1) {
      return res.status(409).json({ success: false, error: 'Token pool association changed before confirmation' });
    }

    return res.status(200).json({
      success: true,
      txId: signature,
      mintAddress: canonicalMint,
      poolId: canonicalPool,
      message: 'Pool transaction confirmed and saved',
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error submitting pool transaction');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
};
export const getMyPools = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { userWallet } = req.query;

    if (typeof userWallet !== 'string' || !userWallet) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query param: userWallet',
      });
    }

    let creatorWallet: string;
    try {
      creatorWallet = new PublicKey(userWallet).toBase58();
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid userWallet' });
    }

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
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json({ success: true, pools });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error fetching user pools');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
};
export const withdrawLiquidity = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { userWallet, poolAddress, lpTokenAmount } = req.body;

    if (!userWallet || !poolAddress || !lpTokenAmount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userWallet, poolAddress, lpTokenAmount',
      });
    }

    const userPublicKey = new PublicKey(userWallet);
    const poolPublicKey = new PublicKey(poolAddress);
    const feeWallet = new PublicKey(process.env.PLATFORM_FEE_WALLET!);

    const { transaction, userAmountSol, platformFeeSol } = await withdrawLiquidityWithFee(
      connection,
      poolPublicKey,
      userPublicKey,
      String(lpTokenAmount),
      feeWallet
    );

    transaction.feePayer = userPublicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const withdrawal = await prisma.withdrawal.create({
      data: {
        userWallet,
        poolAddress,
        lpTokenAmount: Number(lpTokenAmount),
        userAmount: userAmountSol,
        platformFee: platformFeeSol,
        status: 'pending',
      },
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString('base64'),
      withdrawalId: withdrawal.id,
      userAmountSol,
      platformFeeSol,
      feePercentage: 10,
      message: 'Withdrawal prepared: 90% to user, 10% platform fee',
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error in withdrawLiquidity');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
};

export const getLpBalance = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { userWallet, poolAddress } = req.query;

    if (!userWallet || !poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query params: userWallet, poolAddress',
      });
    }

    const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
    const isDevnet = connection.rpcEndpoint.includes('devnet');
    const userPublicKey = new PublicKey(String(userWallet));

    const raydium = await Raydium.load({
      connection,
      owner: userPublicKey,
      cluster: isDevnet ? 'devnet' : 'mainnet',
      disableLoadToken: true,
    });

    // El RPC puede tardar unos segundos en "ver" un pool recien creado
    // (retraso de propagacion/indexacion en Devnet) - reintentamos un par
    // de veces con pausas cortas antes de darnos por vencidos.
    let lpMint: PublicKey | null = null;
    let lastError: any = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const { poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(String(poolAddress));
        lpMint = new PublicKey(poolKeys.mintLp.address);
        break;
      } catch (err: any) {
        lastError = err;
        logger.warn(
          { attempt, poolAddress, error: err.message },
          'Pool not found yet, retrying (posible retraso de indexacion del RPC)'
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (!lpMint) {
      throw lastError || new Error('Pool not found after retries');
    }

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPublicKey, {
      mint: lpMint,
    });

    let rawBalance = '0';
    let uiBalance = 0;
    let decimals = 9;

    if (tokenAccounts.value.length > 0) {
      const info = tokenAccounts.value[0].account.data.parsed.info;
      rawBalance = info.tokenAmount.amount;
      uiBalance = info.tokenAmount.uiAmount || 0;
      decimals = info.tokenAmount.decimals;
    }

    return res.status(200).json({
      success: true,
      lpMint: lpMint.toBase58(),
      rawBalance,
      uiBalance,
      decimals,
    });
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error fetching LP balance');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
};