import { createHash, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  bondingCurvePda,
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  pumpIdl,
} from '@pump-fun/pump-sdk';
import type { Request, Response } from 'express';
import { confirmSignedTransaction, createTokenIdempotently } from '../services/tokenSubmission';
import { tokenAttemptCleanup } from '../services/tokenAttemptCleanupRuntime';
import { uploadImageToIpfs, uploadMetadataToIpfs } from '../services/ipfsService';
import { parseImageDataUrl } from '../services/tokenMetadata';
import { cleanMetadataText } from '../utils/metadataText';
import { config } from '../utils/config';
import { connection, platformFeeWallet } from '../utils/solana';
import { logger } from '../utils/logger';
import { PublicError } from '../utils/publicError';
import { sendInternalError } from '../utils/internalError';
import { prisma } from '../utils/prisma';

const PUMP_FIXED_SUPPLY = 1_000_000_000n;
const PUMP_DECIMALS = 6;
const PUMP_CREATE_COMPUTE_UNITS = 200_000;
const PUMP_CREATE_V2_DISCRIMINATOR = Buffer.from(
  (pumpIdl as unknown as { instructions: Array<{ name: string; discriminator: number[] }> })
    .instructions.find((instruction) => instruction.name === 'create_v2')?.discriminator ?? [],
);

if (PUMP_CREATE_V2_DISCRIMINATOR.length !== 8) {
  throw new Error('The installed Pump SDK does not expose the expected create_v2 instruction');
}

function transactionMessageHash(transaction: Transaction): string {
  return createHash('sha256').update(transaction.serializeMessage()).digest('hex');
}

function getPumpCreateInstruction(
  transaction: Transaction,
  mint: PublicKey,
  user: PublicKey,
) {
  const instructions = transaction.instructions.filter((instruction) => instruction.programId.equals(PUMP_PROGRAM_ID));
  if (instructions.length !== 1) return null;
  const [instruction] = instructions;
  if (
    instruction.data.length < PUMP_CREATE_V2_DISCRIMINATOR.length ||
    !instruction.data.subarray(0, PUMP_CREATE_V2_DISCRIMINATOR.length).equals(PUMP_CREATE_V2_DISCRIMINATOR) ||
    !instruction.keys[0]?.pubkey.equals(mint) ||
    !instruction.keys[0]?.isSigner ||
    !instruction.keys[5]?.pubkey.equals(user) ||
    !instruction.keys[5]?.isSigner
  ) return null;
  return instruction;
}

async function recordPumpFeePayment(userWallet: string, mintAddress: string, signature: string, amountLamports: bigint) {
  await prisma.feePayment.upsert({
    where: { tokenMint: mintAddress },
    create: {
      userWallet,
      tokenMint: mintAddress,
      amountSol: Number(amountLamports) / LAMPORTS_PER_SOL,
      amountLamports,
      txHash: signature,
    },
    update: {},
  });
}

export const createPumpToken = async (req: Request, res: Response): Promise<Response> => {
  const attemptId = randomUUID();
  const uploadedCids: string[] = [];
  let attemptStarted = false;
  let imageBytes = 0;

  try {
    const userWallet = new PublicKey(req.body.userWallet);
    const name = cleanMetadataText(req.body.name);
    const symbol = cleanMetadataText(req.body.symbol).toUpperCase();
    const description = cleanMetadataText(req.body.description ?? '');
    const imageDataUrl = req.body.imageBase64 as string;
    const holderReward = req.body.holderReward === true;
    const twitter = typeof req.body.twitter === 'string' ? req.body.twitter.trim() : '';
    const telegram = typeof req.body.telegram === 'string' ? req.body.telegram.trim() : '';

    if (holderReward) {
      const global = await new OnlinePumpSdk(connection).fetchGlobal();
      if (!global.isHolderRewardEnabled) {
        return res.status(409).json({
          success: false,
          error: 'Pump tiene desactivadas las nuevas monedas Holder Rewards en Devnet. Puedes continuar con el lanzamiento normal.',
        });
      }
    }

    await tokenAttemptCleanup.begin(attemptId, userWallet.toBase58());
    attemptStarted = true;

    imageBytes = parseImageDataUrl(imageDataUrl).buffer.byteLength;
    const image = await uploadImageToIpfs(imageDataUrl);
    uploadedCids.push(image.cid);
    await tokenAttemptCleanup.addCid(attemptId, userWallet.toBase58(), image.cid);

    const metadata = await uploadMetadataToIpfs({
      name,
      symbol,
      description,
      image: image.url,
      ...(twitter ? { twitter } : {}),
      ...(telegram ? { telegram } : {}),
    });
    uploadedCids.push(metadata.cid);
    await tokenAttemptCleanup.addCid(attemptId, userWallet.toBase58(), metadata.cid);

    const mint = Keypair.generate();
    const createInstruction = await PUMP_SDK.createV2Instruction({
      mint: mint.publicKey,
      name,
      symbol,
      uri: metadata.url,
      creator: userWallet,
      user: userWallet,
      mayhemMode: false,
      cashback: false,
      holderReward,
    });
    const transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: PUMP_CREATE_COMPUTE_UNITS }),
      createInstruction,
    );
    const platformFeeLamports = BigInt(Math.floor(config.baseFeeSol * LAMPORTS_PER_SOL));
    if (platformFeeLamports > 0n) {
      transaction.add(SystemProgram.transfer({
        fromPubkey: userWallet,
        toPubkey: platformFeeWallet,
        lamports: Number(platformFeeLamports),
      }));
    }

    transaction.feePayer = userWallet;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.partialSign(mint);

    const curveAddress = bondingCurvePda(mint.publicKey).toBase58();
    await tokenAttemptCleanup.setPumpLaunchIntent(
      attemptId,
      userWallet.toBase58(),
      mint.publicKey.toBase58(),
      {
        messageHash: transactionMessageHash(transaction),
        lastValidBlockHeight,
        holderReward,
        name,
        symbol,
        description,
        imageUrl: image.url,
        metadataCid: metadata.cid,
      },
    );

    logger.info({
      attemptId,
      userWallet: userWallet.toBase58(),
      mintAddress: mint.publicKey.toBase58(),
      platformFeeLamports: platformFeeLamports.toString(),
      imageBytes,
      launchPlatform: 'PUMP_FUN',
    }, 'Pump.fun Devnet launch transaction prepared');

    return res.status(200).json({
      success: true,
      attemptId,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      lastValidBlockHeight,
      fee: config.baseFeeSol,
      mintAddress: mint.publicKey.toBase58(),
      bondingCurveAddress: curveAddress,
      holderReward,
      launchPlatform: 'PUMP_FUN',
      totalSupply: PUMP_FIXED_SUPPLY.toString(),
      decimals: PUMP_DECIMALS,
      message: 'Pump.fun launch prepared',
    });
  } catch (error) {
    if (attemptStarted) {
      try {
        await tokenAttemptCleanup.cleanupKnownCids(uploadedCids, attemptId);
        await tokenAttemptCleanup.complete(attemptId, new PublicKey(req.body.userWallet).toBase58());
      } catch (cleanupError) {
        logger.warn({ attemptId, errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError' }, 'Could not clean abandoned Pump.fun metadata uploads');
        try { await tokenAttemptCleanup.cancel(attemptId, new PublicKey(req.body.userWallet).toBase58()); } catch { /* The cleanup sweep retains the attempt. */ }
      }
    }
    return sendInternalError(res, error, 'Pump.fun launch preparation failed', { attemptId, imageBytes });
  }
};

export const submitPumpTokenTransaction = async (req: Request, res: Response): Promise<Response> => {
  const { attemptId, signedTransaction, mintAddress, userWallet } = req.body;
  try {
    const creator = new PublicKey(userWallet);
    const mint = new PublicKey(mintAddress);
    const transaction = Transaction.from(Buffer.from(signedTransaction, 'base64'));
    const creatorSignature = transaction.signatures.find((entry) => entry.publicKey.equals(creator))?.signature;
    const mintSignature = transaction.signatures.find((entry) => entry.publicKey.equals(mint))?.signature;
    if (
      !transaction.feePayer?.equals(creator) ||
      !creatorSignature ||
      !mintSignature ||
      !transaction.verifySignatures(true) ||
      !getPumpCreateInstruction(transaction, mint, creator)
    ) {
      return res.status(400).json({ success: false, error: 'La transacción no contiene las firmas y la instrucción de lanzamiento Pump.fun esperadas.' });
    }

    const signature = bs58.encode(creatorSignature);
    const existing = await prisma.token.findUnique({ where: { mintAddress: mint.toBase58() } });
    if (existing) {
      if (existing.txHash === signature && existing.creatorWallet === creator.toBase58() && existing.launchPlatform === 'PUMP_FUN') {
        await tokenAttemptCleanup.complete(attemptId, creator.toBase58()).catch(() => undefined);
        return res.status(200).json({ success: true, txId: signature, mintAddress: mint.toBase58(), launchPlatform: 'PUMP_FUN' });
      }
      return res.status(409).json({ success: false, error: 'El token ya está registrado.' });
    }

    const attempt = await tokenAttemptCleanup.getPumpLaunchIntent(attemptId, creator.toBase58());
    const intent = attempt?.pumpLaunch;
    if (!attempt || attempt.mintAddress !== mint.toBase58() || !intent) {
      return res.status(409).json({ success: false, error: 'La preparación de Pump.fun venció o no coincide. Vuelve a prepararla.' });
    }
    if (transactionMessageHash(transaction) !== intent.messageHash) {
      return res.status(400).json({ success: false, error: 'La transacción firmada cambió respecto a la revisión preparada por Wire.' });
    }

    const expectedFee = BigInt(Math.floor(config.baseFeeSol * LAMPORTS_PER_SOL));
    const feeTransfers = transaction.instructions.flatMap((instruction) => {
      if (!instruction.programId.equals(SystemProgram.programId)) return [];
      try {
        const transfer = SystemInstruction.decodeTransfer(instruction);
        return transfer.fromPubkey.equals(creator) && transfer.toPubkey.equals(platformFeeWallet)
          ? [BigInt(transfer.lamports)]
          : [];
      } catch {
        return [];
      }
    });
    if ((expectedFee === 0n && feeTransfers.length !== 0) || (expectedFee > 0n && (feeTransfers.length !== 1 || feeTransfers[0] !== expectedFee))) {
      return res.status(400).json({ success: false, error: 'La transacción no incluye el costo de Wire preparado.' });
    }

    await tokenAttemptCleanup.markSubmitted(attemptId, creator.toBase58(), signature);
    await confirmSignedTransaction(connection, transaction.serialize(), signature);

    const curve = bondingCurvePda(mint);
    const curveAccount = await connection.getAccountInfo(curve, 'confirmed');
    if (!curveAccount || !curveAccount.owner.equals(PUMP_PROGRAM_ID)) {
      throw new PublicError('La transacción se confirmó, pero no pudimos verificar la bonding curve de Pump.fun en Devnet. Reintenta el registro.', 503);
    }

    await createTokenIdempotently(prisma.token, {
      mintAddress: mint.toBase58(),
      name: intent.name,
      symbol: intent.symbol,
      description: intent.description || null,
      imageUrl: intent.imageUrl,
      metadataCid: intent.metadataCid,
      totalSupply: PUMP_FIXED_SUPPLY,
      liquiditySol: 0,
      creatorWallet: creator.toBase58(),
      copiedFrom: null,
      txHash: signature,
      status: 'completed',
      poolAddress: null,
      launchPlatform: 'PUMP_FUN',
      bondingCurveAddress: curve.toBase58(),
      holderReward: intent.holderReward === true,
    });
    await recordPumpFeePayment(creator.toBase58(), mint.toBase58(), signature, expectedFee);
    await tokenAttemptCleanup.complete(attemptId, creator.toBase58()).catch((error) => {
      logger.warn({ attemptId, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Pump.fun launch saved but metadata cleanup record could not be removed');
    });

    logger.info({ attemptId, userWallet: creator.toBase58(), mintAddress: mint.toBase58(), txHash: signature }, 'Pump.fun Devnet token launch registered');
    return res.status(200).json({
      success: true,
      txId: signature,
      mintAddress: mint.toBase58(),
      bondingCurveAddress: curve.toBase58(),
      holderReward: intent.holderReward === true,
      launchPlatform: 'PUMP_FUN',
      solanaUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  } catch (error) {
    if (error instanceof PublicError) return res.status(error.status).json({ success: false, error: error.message });
    return sendInternalError(res, error, 'Pump.fun transaction registration failed', { attemptId });
  }
};
