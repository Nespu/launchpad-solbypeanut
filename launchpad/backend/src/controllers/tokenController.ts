import { Request, Response } from 'express';
import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, mintTo, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { PrismaClient } from '@prisma/client';
import { buildRaydiumPoolInstructions, withdrawLiquidityWithFee } from '../services/raydiumService';
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
      securityAssets = []
    } = req.body;

    // Validar entrada
    if (!userWallet || !name || !symbol || !totalSupply || !liquiditySol) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userWallet, name, symbol, totalSupply, liquiditySol',
      });
    }

    // Calcular precios
    const BASE_FEE = 0.5;
    const ASSET_FEE = 0.1;
    const totalFee = BASE_FEE + (securityAssets.length * ASSET_FEE);
    const totalRequired = liquiditySol + totalFee + 0.001;

    const serverWallet = getServerKeypair();

    // Subir imagen a IPFS
    let imageUrl = '';
    if (imageBase64) {
      imageUrl = await uploadImageToIpfs(imageBase64);
    } else {
      imageUrl = 'https://via.placeholder.com/200x200?text=Memecoin';
    }

    // Crear el Mint
    const mintKeypair = new PublicKey(userWallet);
    const mint = await createMint(
      connection,
      serverWallet,
      new PublicKey(userWallet),
      null,
      9
    );

    // Acuñar tokens
    const userAta = await getOrCreateAssociatedTokenAccount(
      connection,
      serverWallet,
      mint,
      new PublicKey(userWallet)
    );

    await mintTo(
      connection,
      serverWallet,
      mint,
      userAta.address,
      serverWallet.publicKey,
      BigInt(totalSupply) * BigInt(1e9)
    );

    // Crear pool en Raydium
    const poolInstructions = await buildRaydiumPoolInstructions({
      userWallet: new PublicKey(userWallet),
      mint,
      liquiditySol,
      totalSupply
    });

    // Construir transacción
    const transaction = new Transaction();

    // Añadir fee
    const feeInstruction = SystemProgram.transfer({
      fromPubkey: new PublicKey(userWallet),
      toPubkey: new PublicKey(process.env.PLATFORM_FEE_WALLET!),
      lamports: totalFee * LAMPORTS_PER_SOL,
    });
    transaction.add(feeInstruction);

    // Añadir instrucciones del pool
    poolInstructions.forEach(ix => transaction.add(ix));

    // La transacción viaja sin firmar hasta el cliente, pero serialize()
    // igualmente requiere feePayer y recentBlockhash seteados o revienta.
    transaction.feePayer = new PublicKey(userWallet);
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // Serializar
    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    // Guardar en BD
    await prisma.token.create({
      data: {
        mintAddress: mint.toBase58(),
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
      mintAddress: mint.toBase58(),
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

// ============================================================
// NUEVO: Retiro de liquidez con comisión del 10%
// ============================================================

export const withdrawLiquidity = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { userWallet, poolAddress, lpTokenAmount } = req.body;

    if (!userWallet || !poolAddress || !lpTokenAmount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userWallet, poolAddress, lpTokenAmount',
      });
    }

    if (lpTokenAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'lpTokenAmount must be greater than 0',
      });
    }

    const userPublicKey = new PublicKey(userWallet);
    const poolPublicKey = new PublicKey(poolAddress);
    const feeWallet = new PublicKey(process.env.PLATFORM_FEE_WALLET!);

    // Reutilizamos la lógica ya existente en raydiumService, que calcula el
    // fee sobre el VALOR EN SOL real de los LP tokens (según las reservas del
    // pool), en vez de tratar lpTokenAmount como si ya fuera una cantidad de SOL.
    const { transaction, userAmount, platformFee } = await withdrawLiquidityWithFee(
      connection,
      poolPublicKey,
      userPublicKey,
      lpTokenAmount,
      feeWallet
    );

    // serialize() exige feePayer y recentBlockhash seteados, aunque la tx
    // todavía no esté firmada por el usuario.
    transaction.feePayer = userPublicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    // Dejamos registro del retiro (antes no se guardaba nada en la BD).
    const withdrawal = await prisma.withdrawal.create({
      data: {
        userWallet,
        poolAddress,
        lpTokenAmount,
        userAmount,
        platformFee,
        status: 'pending',
      },
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString('base64'),
      withdrawalId: withdrawal.id,
      userAmount,
      platformFee,
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