import { Request, Response } from 'express';
import bs58 from 'bs58';
import { createHash, randomUUID } from 'node:crypto';
import { PublicKey, Transaction, TransactionMessage, VersionedTransaction, SystemProgram, SystemInstruction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, decodeInitializeMintInstruction, decodeMintToInstruction, getAccount, getMint } from '@solana/spl-token';
import { Metadata, PROGRAM_ID as METADATA_PROGRAM_ID } from '@metaplex-foundation/mpl-token-metadata';
import { Prisma } from '@prisma/client';
import { createRaydiumCpmmPool, getRaydiumLpMint, getRaydiumLpPositionEstimate, getRaydiumPoolConnection, getReliableDevnetConnection, withdrawLiquidityWithFee } from '../services/raydiumService';
import { confirmSignedTransaction, createTokenIdempotently } from '../services/tokenSubmission';
import { buildMintInstructions } from '../services/mintService';
import {
  buildRevokeMintInstruction,
  buildRevokeFreezeInstruction,
  buildRevokeUpdateInstruction,
} from '../services/authorityService';
import { uploadImageToIpfs, uploadMetadataToIpfs } from '../services/ipfsService';
import { tokenAttemptCleanup } from '../services/tokenAttemptCleanupRuntime';
import { PLACEHOLDER_IMAGE_URL, fetchTokenMetadata, getTrustedIpfsCid, parseImageDataUrl } from '../services/tokenMetadata';
import { logger } from '../utils/logger';
import { connection, getServerKeypair, platformFeeWallet } from '../utils/solana';
import { config } from '../utils/config';
import { cleanMetadataText } from '../utils/metadataText';
import { PublicError } from '../utils/publicError';
import { sendInternalError } from '../utils/internalError';
import { prisma } from '../utils/prisma';
import { parseQuoteAsset, QUOTE_ASSETS } from '../services/poolQuoteAsset';
import {
  buildLpBurnInstructions,
  buildTemporalLockInstruction,
  calculateTemporalLockTokenFeeRaw,
  getTemporalLockFeeQuote,
  TEMPORAL_LP_LOCK_DAYS,
  STREAMFLOW_DEVNET_PROGRAM_ID,
} from '../services/lpSecurityService';
import {
  createGetMyPoolsHandler,
  createGetMyTokensHandler,
  createGetTokenDetailsHandler,
  createUpdateWithdrawalResultHandler,
} from './tokenControllerHandlers';

async function recordTokenFeePayment(userWallet: string, tokenMint: string, txHash: string, amountLamports: bigint) {
  await prisma.feePayment.upsert({
    where: { tokenMint },
    create: {
      userWallet,
      tokenMint,
      amountSol: Number(amountLamports) / LAMPORTS_PER_SOL,
      amountLamports,
      txHash,
    },
    update: {},
  });
}

function poolTransactionIntentHash(transaction: Transaction): string {
  const message = transaction.compileMessage();
  const accountKeys = message.accountKeys.map((key) => key.toBase58());
  const computeBudgetProgramId = ComputeBudgetProgram.programId.toBase58();
  const requiredSignatures = message.header.numRequiredSignatures;
  const writableSignedCount = requiredSignatures - message.header.numReadonlySignedAccounts;
  const writableUnsignedEnd = accountKeys.length - message.header.numReadonlyUnsignedAccounts;
  let requestedUnits: number | null = null;
  let microLamportsPerUnit = BigInt(0);
  let sawUnitLimit = false;
  let sawUnitPrice = false;
  let sawHeapFrame = false;
  let sawLoadedAccountsLimit = false;
  const instructions = [] as Array<{ programId: string; accounts: string[]; data: string }>;

  for (const instruction of message.instructions) {
    const programId = accountKeys[instruction.programIdIndex];
    if (programId !== computeBudgetProgramId) {
      instructions.push({
        programId,
        accounts: instruction.accounts.map((index) => accountKeys[index]),
        data: Buffer.from(bs58.decode(instruction.data)).toString('hex'),
      });
      continue;
    }

    // Compiled legacy-message instructions store `data` as a base58 string.
    // Decode it before reading the Compute Budget discriminator byte.
    const data = Buffer.from(bs58.decode(instruction.data));
    const variant = data.length > 0 ? data[0] : -1;
    if ((variant === 1 && sawHeapFrame) || (variant === 2 && sawUnitLimit) || (variant === 3 && sawUnitPrice) || (variant === 4 && sawLoadedAccountsLimit)) {
      throw new Error(`La wallet duplicó la instrucción Compute Budget variante ${variant}; Solana rechazaría esa transacción.`);
    }
    if (data.length === 5 && data[0] === 1 && !sawHeapFrame) {
      const heapFrameBytes = data.readUInt32LE(1);
      sawHeapFrame = true;
      if (heapFrameBytes < 32_768 || heapFrameBytes > 262_144 || heapFrameBytes % 1_024 !== 0) {
        throw new Error('La wallet solicitó una memoria temporal no válida para la creación de pool.');
      }
      continue;
    }
    if (data.length === 5 && data[0] === 2 && !sawUnitLimit) {
      requestedUnits = data.readUInt32LE(1);
      sawUnitLimit = true;
      if (requestedUnits < 1 || requestedUnits > 1_400_000) {
        throw new Error('La wallet solicitó un límite de cómputo no válido para la creación de pool.');
      }
      continue;
    }
    if (data.length === 9 && data[0] === 3 && !sawUnitPrice) {
      microLamportsPerUnit = data.readBigUInt64LE(1);
      sawUnitPrice = true;
      continue;
    }
    if (data.length === 5 && data[0] === 4 && !sawLoadedAccountsLimit) {
      const loadedAccountsBytes = data.readUInt32LE(1);
      sawLoadedAccountsLimit = true;
      if (loadedAccountsBytes < 1 || loadedAccountsBytes > 64 * 1024 * 1024) {
        throw new Error('La wallet solicitó un límite de datos de cuentas no válido para la creación de pool.');
      }
      continue;
    }
    throw new Error(`La wallet añadió una instrucción Compute Budget desconocida o mal formada (variante ${variant}, ${data.length} bytes).`);
  }

  const effectiveUnits = BigInt(requestedUnits ?? Math.min(1_400_000, Math.max(1, instructions.length) * 200_000));
  const priorityFeeLamports = (effectiveUnits * microLamportsPerUnit + BigInt(999_999)) / BigInt(1_000_000);
  if (priorityFeeLamports > BigInt(10_000_000)) {
    throw new Error('La propina de prioridad añadida por la wallet supera el máximo permitido de 0.01 SOL.');
  }

  const intent = {
    feePayer: accountKeys[0],
    // Adding a Compute Budget program instruction can change compiled account
    // indexes/order. Compare each protected key by address and privileges,
    // not by the serialized message's positional account table.
    accounts: accountKeys.flatMap((address, index) => {
      if (address === computeBudgetProgramId) return [];
      const isSigner = index < requiredSignatures;
      const isWritable = isSigner
        ? index < writableSignedCount
        : index < writableUnsignedEnd;
      return [{ address, isSigner, isWritable }];
    }),
    recentBlockhash: message.recentBlockhash,
    instructions,
  };
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

async function getServerLamportSpend(transaction: Transaction, signature: string): Promise<number | null> {
  const confirmedTransaction = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!confirmedTransaction?.meta) return null;

  const serverAddress = getServerKeypair().publicKey;
  const serverIndex = transaction.compileMessage().accountKeys.findIndex((key) => key.equals(serverAddress));
  if (serverIndex < 0) return null;

  return confirmedTransaction.meta.preBalances[serverIndex] - confirmedTransaction.meta.postBalances[serverIndex];
}

export const createToken = async (req: Request, res: Response): Promise<Response> => {
  const attemptId = randomUUID();
  let imageBytes = 0;
  let metadataJsonBytes = 0;
  let pinataUploadCount = 0;
  let attemptStarted = false;
  const uploadedCids: string[] = [];
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

    const totalFee = config.baseFeeSol + securityAssets.length * config.assetFeeSol;

    const serverWallet = getServerKeypair();
    const userPublicKey = new PublicKey(userWallet);
    await tokenAttemptCleanup.begin(attemptId, userPublicKey.toBase58());
    attemptStarted = true;

    let imageUrl = '';
    if (imageBase64) {
      const parsedImage = parseImageDataUrl(imageBase64);
      imageBytes = parsedImage.buffer.byteLength;
      pinataUploadCount += 1;
      const uploadedImage = await uploadImageToIpfs(imageBase64);
      imageUrl = uploadedImage.url;
      uploadedCids.push(uploadedImage.cid);
      await tokenAttemptCleanup.addCid(attemptId, userPublicKey.toBase58(), uploadedImage.cid);
    } else {
      imageUrl = PLACEHOLDER_IMAGE_URL;
    }

    const offChainMetadata = { name, symbol, description: description || '', image: imageUrl };
    metadataJsonBytes = Buffer.byteLength(JSON.stringify({ pinataContent: offChainMetadata }), 'utf8');
    pinataUploadCount += 1;
    const uploadedMetadata = await uploadMetadataToIpfs(offChainMetadata);
    const metadataUri = uploadedMetadata.url;
    uploadedCids.push(uploadedMetadata.cid);
    await tokenAttemptCleanup.addCid(attemptId, userPublicKey.toBase58(), uploadedMetadata.cid);

    const {
      mintKeypair,
      instructions: mintInstructions,
      estimatedServerRentLamports,
      estimatedServerProtocolFeeLamports,
    } = await buildMintInstructions({
      userWallet: userPublicKey,
      name,
      symbol,
      metadataUri,
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
      toPubkey: platformFeeWallet,
      lamports: Math.floor(totalFee * LAMPORTS_PER_SOL),
    });
    transaction.add(feeInstruction);

    transaction.feePayer = userPublicKey;
    // Use a fresh confirmed blockhash so wallet signing starts with the full
    // normal transaction window instead of a potentially older finalized hash.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;

    transaction.partialSign(mintKeypair, serverWallet);
    await tokenAttemptCleanup.setMintAddress(
      attemptId,
      userPublicKey.toBase58(),
      mintKeypair.publicKey.toBase58(),
    );

    const totalEstimatedServerRentLamports = Object.values(estimatedServerRentLamports).reduce((total, amount) => total + amount, 0);
    const totalEstimatedServerProtocolFeeLamports = Object.values(estimatedServerProtocolFeeLamports).reduce((total, amount) => total + amount, 0);
    const totalEstimatedServerCostLamports = totalEstimatedServerRentLamports + totalEstimatedServerProtocolFeeLamports;
    const platformFeeLamports = Math.floor(totalFee * LAMPORTS_PER_SOL);
    logger.info({
      attemptId,
      userWallet: userPublicKey.toBase58(),
      mintAddress: mintKeypair.publicKey.toBase58(),
      platformFeeLamports,
      estimatedServerRentLamports,
      totalEstimatedServerRentLamports,
      totalEstimatedServerRentSol: totalEstimatedServerRentLamports / LAMPORTS_PER_SOL,
      estimatedServerProtocolFeeLamports,
      totalEstimatedServerProtocolFeeLamports,
      totalEstimatedServerProtocolFeeSol: totalEstimatedServerProtocolFeeLamports / LAMPORTS_PER_SOL,
      totalEstimatedServerCostLamports,
      totalEstimatedServerCostSol: totalEstimatedServerCostLamports / LAMPORTS_PER_SOL,
      estimatedGrossMarginBeforeIpfsAndInfrastructureLamports: platformFeeLamports - totalEstimatedServerCostLamports,
      estimatedGrossMarginBeforeIpfsAndInfrastructureSol: (platformFeeLamports - totalEstimatedServerCostLamports) / LAMPORTS_PER_SOL,
      pinataUploadCount,
      imageBytes,
      metadataJsonBytes,
      totalPinataContentBytes: imageBytes + metadataJsonBytes,
    }, 'Token creation cost estimate prepared before wallet signature');

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      attemptId,
      transaction: serializedTx.toString('base64'),
      lastValidBlockHeight,
      fee: totalFee,
      mintAddress: mintKeypair.publicKey.toBase58(),
      imageUrl,
      message: 'Token creation prepared',
    });

  } catch (error: any) {
    if (attemptStarted) {
      try {
        // Covers a CID returned by Pinata immediately before Redis failed to
        // persist it in the attempt record. A preparation failure can clean
        // immediately; a user cancellation uses the two-minute grace in cancel().
        await tokenAttemptCleanup.cleanupKnownCids(uploadedCids, attemptId);
        await tokenAttemptCleanup.complete(attemptId, new PublicKey(req.body.userWallet).toBase58());
      } catch (cleanupError) {
        logger.warn({ attemptId, errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError' }, 'Failed to clean token creation uploads after preparation error');
        try {
          await tokenAttemptCleanup.cancel(attemptId, new PublicKey(req.body.userWallet).toBase58());
        } catch {
          // Keep the tracked attempt in Redis so the cleanup sweeper can verify it.
        }
      }
    }
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    return sendInternalError(res, error, 'Token creation preparation failed', {
      attemptId,
      imageBytes,
      metadataJsonBytes,
      pinataUploadCount,
    });
  }
};

export const submitTransaction = async (req: Request, res: Response): Promise<Response> => {
  const attemptId = typeof req.body?.attemptId === 'string' ? req.body.attemptId : undefined;
  try {
    const { signedTransaction, mintAddress, userWallet, name, symbol, totalSupply, liquiditySol, copyFrom } = req.body;
    if (!signedTransaction || !mintAddress || !userWallet || !name || !symbol || !totalSupply || !liquiditySol) {
      return res.status(400).json({ success: false, error: 'Missing required fields for transaction confirmation' });
    }

    let creatorPublicKey: PublicKey;
    let mintPublicKey: PublicKey;
    try {
      creatorPublicKey = new PublicKey(userWallet);
      mintPublicKey = new PublicKey(mintAddress);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid creator wallet or mint address' });
    }

    const tx = Transaction.from(Buffer.from(signedTransaction, 'base64'));
    const creatorSignature = tx.signatures.find((item) => item.publicKey.equals(creatorPublicKey))?.signature;
    const serverPublicKey = getServerKeypair().publicKey;
    const serverSignature = tx.signatures.find((item) => item.publicKey.equals(serverPublicKey))?.signature;
    if (!tx.feePayer?.equals(creatorPublicKey) || !creatorSignature || !serverSignature || !tx.verifySignatures(true)) {
      return res.status(400).json({ success: false, error: 'Transaction must include valid creator and server signatures' });
    }

    const feeTransfers = tx.instructions.flatMap((instruction) => {
      if (!instruction.programId.equals(SystemProgram.programId)) return [];
      try {
        const transfer = SystemInstruction.decodeTransfer(instruction);
        return transfer.fromPubkey.equals(creatorPublicKey) && transfer.toPubkey.equals(platformFeeWallet)
          ? [transfer.lamports]
          : [];
      } catch {
        return [];
      }
    });
    const allowedFeeLamports = [0, 1, 2, 3].map((assetCount) =>
      BigInt(Math.floor((config.baseFeeSol + assetCount * config.assetFeeSol) * LAMPORTS_PER_SOL)),
    );
    if (feeTransfers.length !== 1 || !allowedFeeLamports.includes(feeTransfers[0])) {
      return res.status(400).json({ success: false, error: 'Transaction does not include the configured platform fee' });
    }

    const expectedSupply = BigInt(totalSupply) * BigInt(1_000_000_000);
    const createsMint = tx.instructions.some((instruction) => {
      if (!instruction.programId.equals(SystemProgram.programId)) return false;
      try {
        return SystemInstruction.decodeCreateAccount(instruction).newAccountPubkey.equals(mintPublicKey);
      } catch {
        return false;
      }
    });
    const initializesMint = tx.instructions.some((instruction) => {
      if (!instruction.programId.equals(TOKEN_PROGRAM_ID)) return false;
      try {
        const decoded = decodeInitializeMintInstruction(instruction);
        return decoded.keys.mint.pubkey.equals(mintPublicKey) && decoded.data.mintAuthority.equals(creatorPublicKey);
      } catch {
        return false;
      }
    });
    const mintsExpectedSupply = tx.instructions.some((instruction) => {
      if (!instruction.programId.equals(TOKEN_PROGRAM_ID)) return false;
      try {
        const decoded = decodeMintToInstruction(instruction);
        return decoded.keys.mint.pubkey.equals(mintPublicKey) &&
          decoded.keys.authority.pubkey.equals(creatorPublicKey) &&
          decoded.data.amount === expectedSupply;
      } catch {
        return false;
      }
    });
    if (!createsMint || !initializesMint || !mintsExpectedSupply) {
      return res.status(400).json({ success: false, error: 'Signed transaction does not create and mint the supplied token' });
    }

    const signature = bs58.encode(creatorSignature);
    const successPayload = {
      success: true,
      txId: signature,
      mintAddress: mintPublicKey.toBase58(),
      solanaUrl: `https://solscan.io/tx/${signature}`,
    };
    const existingToken = await prisma.token.findUnique({ where: { mintAddress: mintPublicKey.toBase58() } });
    if (existingToken) {
      if (existingToken.txHash === signature && existingToken.creatorWallet === creatorPublicKey.toBase58()) {
        await recordTokenFeePayment(creatorPublicKey.toBase58(), mintPublicKey.toBase58(), signature, BigInt(feeTransfers[0]));
        await tokenAttemptCleanup.complete(attemptId, creatorPublicKey.toBase58()).catch(() => undefined);
        logger.info({ attemptId, userWallet: creatorPublicKey.toBase58(), mintAddress: mintPublicKey.toBase58(), txHash: signature, outcome: 'already_registered' }, 'Token creation attempt registered idempotently');
        return res.status(200).json(successPayload);
      }
      return res.status(409).json({ success: false, error: 'Token is already registered' });
    }

    await tokenAttemptCleanup.markSubmitted(attemptId, creatorPublicKey.toBase58(), signature);
    await confirmSignedTransaction(connection, tx.serialize(), signature);
    try {
      const serverLamportSpend = await getServerLamportSpend(tx, signature);
      logger.info({
        attemptId,
        userWallet: creatorPublicKey.toBase58(),
        mintAddress: mintPublicKey.toBase58(),
        txHash: signature,
        serverLamportSpend,
        serverSolSpend: serverLamportSpend === null ? null : serverLamportSpend / LAMPORTS_PER_SOL,
      }, 'Token creation transaction confirmed; actual server on-chain cost measured');
    } catch (costError) {
      logger.warn({
        attemptId,
        mintAddress: mintPublicKey.toBase58(),
        errorName: costError instanceof Error ? costError.name : 'UnknownError',
      }, 'Token creation confirmed, but actual server on-chain cost could not be read');
    }

    const [metadataAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintPublicKey.toBuffer()],
      METADATA_PROGRAM_ID,
    );
    const onChainMetadata = await Metadata.fromAccountAddress(connection, metadataAddress, 'confirmed');
    if (!onChainMetadata.mint.equals(mintPublicKey) || !onChainMetadata.updateAuthority.equals(creatorPublicKey)) {
      throw new PublicError('On-chain metadata does not match the submitted mint and creator', 400);
    }

    // La descripcion y la imagen salen del JSON al que apunta la metadata
    // on-chain, no de lo que mande el cliente.
    const offChainMetadata = await fetchTokenMetadata(
      cleanMetadataText(onChainMetadata.data.uri),
      config.pinataGateway,
    );
    const metadataCid = getTrustedIpfsCid(cleanMetadataText(onChainMetadata.data.uri), config.pinataGateway);

    await createTokenIdempotently(prisma.token, {
      mintAddress: mintPublicKey.toBase58(),
      name: cleanMetadataText(onChainMetadata.data.name),
      symbol: cleanMetadataText(onChainMetadata.data.symbol),
      description: offChainMetadata.description || null,
      imageUrl: offChainMetadata.image,
      metadataCid,
      totalSupply: BigInt(totalSupply),
      liquiditySol,
      creatorWallet: creatorPublicKey.toBase58(),
      copiedFrom: copyFrom || null,
      txHash: signature,
      status: 'completed',
      poolAddress: null,
    });
    await recordTokenFeePayment(creatorPublicKey.toBase58(), mintPublicKey.toBase58(), signature, BigInt(feeTransfers[0]));
    await tokenAttemptCleanup.complete(attemptId, creatorPublicKey.toBase58()).catch((cleanupError) => {
      logger.warn({ attemptId, errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError' }, 'Token registered but attempt cleanup state could not be removed');
    });

    logger.info({ attemptId, userWallet: creatorPublicKey.toBase58(), mintAddress: mintPublicKey.toBase58(), txHash: signature, outcome: 'registered' }, 'Token creation completed');

    return res.status(200).json(successPayload);

  } catch (error: any) {
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    return sendInternalError(res, error, 'Error submitting transaction', { attemptId });
  }
};

export const createPool = async (req: Request, res: Response): Promise<Response> => {
  let stage = 'validate-request';
  try {
    const { userWallet, mintAddress, tokenAmount, solAmount, quoteAmount: requestedQuoteAmount, quoteAsset: requestedQuoteAsset } = req.body;
    const quoteAsset = parseQuoteAsset(requestedQuoteAsset);
    const quoteAmount = typeof requestedQuoteAmount === 'string'
      ? requestedQuoteAmount
      : quoteAsset === 'SOL' && Number.isFinite(solAmount) ? Number(solAmount).toFixed(9).replace(/\.?0+$/, '') : '';

    if (!userWallet || !mintAddress || !tokenAmount || !quoteAmount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userWallet, mintAddress, tokenAmount, quoteAmount',
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
    if (token.launchPlatform !== 'RAYDIUM') {
      return res.status(409).json({ success: false, error: 'Este token se lanzó en Pump.fun; Wire no puede crearle una pool de Raydium desde este flujo.' });
    }
    if (token.poolAddress && token.poolAddress !== 'pending') {
      return res.status(409).json({ success: false, error: 'A pool is already associated with this token' });
    }
    stage = 'select-devnet-rpc';
    const poolConnection = await getReliableDevnetConnection(connection);
    stage = 'check-pending-pool';
    const currentBlockHeight = BigInt(await poolConnection.getBlockHeight('confirmed'));
    if (
      token.pendingPoolMessageHash &&
      token.pendingPoolLastValidBlockHeight !== null &&
      token.pendingPoolLastValidBlockHeight >= currentBlockHeight
    ) {
      return res.status(409).json({ success: false, error: 'A pool transaction is already awaiting signature. Submit it or wait for it to expire.' });
    }

    stage = 'build-raydium-transaction';
    const { transaction, poolId } = await createRaydiumCpmmPool(poolConnection, {
      userWallet: creatorPublicKey,
      mintAddress: mintPublicKey,
      mintDecimals: 9,
      tokenAmount: BigInt(tokenAmount).toString(),
      quoteAsset,
      quoteAmount,
    });

    transaction.feePayer = creatorPublicKey;
    stage = 'prepare-pool-transaction';
    const { blockhash, lastValidBlockHeight } = await poolConnection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    const transactionMessageHash = poolTransactionIntentHash(transaction);

    const reservation = await prisma.token.updateMany({
      where: {
        mintAddress: canonicalMint,
        creatorWallet: canonicalWallet,
        poolAddress: token.poolAddress,
        OR: [
          { pendingPoolMessageHash: null },
          { pendingPoolLastValidBlockHeight: { lt: currentBlockHeight } },
        ],
      },
      data: {
        pendingPoolAddress: poolId,
        pendingPoolQuoteMint: QUOTE_ASSETS[quoteAsset].mintAddress,
        pendingPoolMessageHash: transactionMessageHash,
        pendingPoolLastValidBlockHeight: BigInt(lastValidBlockHeight),
      },
    });
    if (reservation.count !== 1) {
      return res.status(409).json({ success: false, error: 'A pool transaction was prepared in another session. Refresh and try again.' });
    }

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString('base64'),
      poolId,
      quoteMint: QUOTE_ASSETS[quoteAsset].mintAddress,
      lastValidBlockHeight,
      message: 'Pool creation prepared',
    });
  } catch (error: any) {
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    return sendInternalError(res, error, 'Error creating pool', { stage });
  }
};

export const submitPoolTransaction = async (req: Request, res: Response): Promise<Response> => {
  let stage = 'validate-request';
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
    if (token.pendingPoolAddress !== canonicalPool || !token.pendingPoolQuoteMint || !token.pendingPoolMessageHash || token.pendingPoolLastValidBlockHeight === null) {
      return res.status(409).json({ success: false, error: 'This pool transaction was not prepared by Wire. Prepare it again.' });
    }

    const transaction = Transaction.from(Buffer.from(signedTransaction, 'base64'));
    const creatorSignature = transaction.signatures.find((item) =>
      item.publicKey.equals(creatorPublicKey)
    )?.signature;
    if (
      !transaction.feePayer?.equals(creatorPublicKey) ||
      !creatorSignature ||
      !transaction.verifySignatures(true)
    ) {
      return res.status(400).json({ success: false, error: 'Transaction is not signed by the creator wallet' });
    }
    let signedMessageHash: string;
    try {
      signedMessageHash = poolTransactionIntentHash(transaction);
    } catch (error) {
      await prisma.token.updateMany({
        where: {
          mintAddress: canonicalMint,
          creatorWallet: canonicalWallet,
          pendingPoolAddress: canonicalPool,
          pendingPoolMessageHash: token.pendingPoolMessageHash,
        },
        data: {
          pendingPoolAddress: null,
          pendingPoolQuoteMint: null,
          pendingPoolMessageHash: null,
          pendingPoolLastValidBlockHeight: null,
        },
      });
      return res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'The wallet added unsupported instructions.' });
    }
    if (signedMessageHash !== token.pendingPoolMessageHash) {
      await prisma.token.updateMany({
        where: {
          mintAddress: canonicalMint,
          creatorWallet: canonicalWallet,
          pendingPoolAddress: canonicalPool,
          pendingPoolMessageHash: token.pendingPoolMessageHash,
        },
        data: {
          pendingPoolAddress: null,
          pendingPoolQuoteMint: null,
          pendingPoolMessageHash: null,
          pendingPoolLastValidBlockHeight: null,
        },
      });
      return res.status(400).json({
        success: false,
        error: 'La wallet modificó instrucciones protegidas de la creación de pool. No se envió la transacción; prepara el intento de nuevo.',
      });
    }

    const signature = bs58.encode(creatorSignature);
    stage = 'select-devnet-rpc';
    const poolConnection = await getReliableDevnetConnection(connection);
    stage = 'check-transaction-status';
    const [existingStatus] = (await poolConnection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })).value;
    if (existingStatus?.err) {
      return res.status(400).json({ success: false, error: 'The prepared pool transaction failed on Solana.' });
    }
    if (existingStatus?.confirmationStatus !== 'confirmed' && existingStatus?.confirmationStatus !== 'finalized') {
      if (!existingStatus) {
        stage = 'send-signed-transaction';
        await poolConnection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
      }
      stage = 'confirm-transaction';
      const confirmation = await poolConnection.confirmTransaction({
        signature,
        blockhash: transaction.recentBlockhash!,
        lastValidBlockHeight: Number(token.pendingPoolLastValidBlockHeight),
      }, 'confirmed');
      if (confirmation.value.err) {
        throw new Error('Pool transaction failed: ' + JSON.stringify(confirmation.value.err));
      }
    }

    const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
    stage = 'verify-created-pool';
    const isDevnet = poolConnection.rpcEndpoint.includes('devnet');
    const raydium = await Raydium.load({
      connection: poolConnection,
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
    if (!poolMints.includes(canonicalMint) || !poolMints.includes(token.pendingPoolQuoteMint)) {
      return res.status(400).json({
        success: false,
        error: 'Confirmed pool does not match this token and its selected quote asset',
      });
    }

    stage = 'save-pool-association';
    const updateResult = await prisma.token.updateMany({
      where: {
        mintAddress: canonicalMint,
        creatorWallet: canonicalWallet,
        poolAddress: token.poolAddress,
        pendingPoolAddress: canonicalPool,
        pendingPoolMessageHash: token.pendingPoolMessageHash,
      },
      data: {
        poolAddress: canonicalPool,
        poolQuoteMint: token.pendingPoolQuoteMint,
        pendingPoolAddress: null,
        pendingPoolQuoteMint: null,
        pendingPoolMessageHash: null,
        pendingPoolLastValidBlockHeight: null,
      },
    });
    if (updateResult.count !== 1) {
      const latestToken = await prisma.token.findUnique({ where: { mintAddress: canonicalMint } });
      if (latestToken?.poolAddress === canonicalPool) {
        return res.status(200).json({ success: true, txId: signature, mintAddress: canonicalMint, poolId: canonicalPool });
      }
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
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    return sendInternalError(res, error, 'Error submitting pool transaction', { stage });
  }
};
export const getMyPools = createGetMyPoolsHandler(prisma);
export const getMyTokens = createGetMyTokensHandler(prisma);
export const getTokenDetails = createGetTokenDetailsHandler(prisma);
export const withdrawLiquidity = async (req: Request, res: Response): Promise<Response> => {
  let withdrawalStage = 'validate-request';
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
    const feeWallet = platformFeeWallet;
    const poolConnection = await getRaydiumPoolConnection(connection, poolPublicKey);

    withdrawalStage = 'build-withdrawal-transaction';
    const {
      transaction, quoteMint, quoteSymbol, quoteDecimals, totalQuoteOut, minimumQuoteOut, minimumQuoteOutRaw,
      tokenOutAmount, minimumTokenOutAmount, tokenSymbol, userAmount, platformFee,
      quoteAmountRaw, platformFeeRaw, userAmountLamports, platformFeeLamports,
      totalSolOut, minimumSolOut, userAmountSol, platformFeeSol,
    } = await withdrawLiquidityWithFee(
      poolConnection,
      poolPublicKey,
      userPublicKey,
      String(lpTokenAmount),
      feeWallet
    );

    withdrawalStage = 'serialize-withdrawal-transaction';
    // Phantom adds its own priority-fee instructions when a legacy Solana
    // transaction has no compute-budget instruction. Include an explicit
    // limit so the wallet signs the exact message prepared and hash-checked here.
    const hasComputeUnitLimit = transaction.instructions.some((instruction) =>
      instruction.programId.equals(ComputeBudgetProgram.programId) && instruction.data[0] === 2
    );
    const hasComputeUnitPrice = transaction.instructions.some((instruction) =>
      instruction.programId.equals(ComputeBudgetProgram.programId) && instruction.data[0] === 3
    );
    const explicitComputeBudget = [];
    if (!hasComputeUnitLimit) {
      explicitComputeBudget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
    }
    if (!hasComputeUnitPrice) {
      // An explicit zero price prevents Phantom from adding its own priority-fee instruction.
      // It keeps the standard Solana signature fee and does not add a priority fee.
      explicitComputeBudget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
    }
    transaction.instructions.unshift(...explicitComputeBudget);
    transaction.feePayer = userPublicKey;
    const { blockhash, lastValidBlockHeight } = await poolConnection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    const transactionMessageHash = createHash('sha256')
      .update(transaction.compileMessage().serialize())
      .digest('hex');

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    withdrawalStage = 'save-pending-withdrawal';
    const withdrawal = await prisma.withdrawal.create({
      data: {
        userWallet,
        poolAddress,
        lpTokenAmount: Number(lpTokenAmount),
        lpTokenAmountRaw: new Prisma.Decimal(lpTokenAmount),
        userAmount,
        platformFee,
        userAmountLamports: BigInt(userAmountLamports),
        platformFeeLamports: BigInt(platformFeeLamports),
        quoteAmountRaw: BigInt(quoteAmountRaw),
        platformFeeRaw: BigInt(platformFeeRaw),
        quoteMint,
        quoteDecimals,
        status: 'pending',
        transactionMessageHash,
        lastValidBlockHeight: BigInt(lastValidBlockHeight),
      },
    });

    return res.status(200).json({
      success: true,
      transaction: serializedTx.toString('base64'),
      transactionMessageHash,
      withdrawalId: withdrawal.id,
      lastValidBlockHeight,
      quoteMint,
      quoteSymbol,
      quoteDecimals,
      totalQuoteOut,
      minimumQuoteOut,
      minimumQuoteOutRaw,
      quoteAmountRaw,
      platformFeeRaw,
      tokenOutAmount,
      minimumTokenOutAmount,
      tokenSymbol,
      userAmount,
      platformFee,
      userAmountSol,
      platformFeeSol,
      totalSolOut,
      minimumSolOut,
      feePercentage: 10,
      message: `Withdrawal prepared: platform fee is 10% of estimated ${quoteSymbol} output and is transferred in the same transaction.`,
    });
  } catch (error: any) {
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    const stage = typeof error?.withdrawalStage === 'string' ? error.withdrawalStage : withdrawalStage;
    return sendInternalError(res, error, 'Error in withdrawLiquidity', { stage });
  }
};

export const updateWithdrawalResult = createUpdateWithdrawalResultHandler(prisma, connection);

export const getFeeConfig = (_req: Request, res: Response): Response => {
  return res.status(200).json({ success: true, baseFeeSol: config.baseFeeSol, assetFeeSol: config.assetFeeSol });
};

export const getLpBalance = async (req: Request, res: Response): Promise<Response> => {
  let stage = 'validate-query';
  try {
    const { userWallet, poolAddress } = req.query;
    const includePosition = req.query.includePosition === 'true';

    if (!userWallet || !poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query params: userWallet, poolAddress',
      });
    }

    const userPublicKey = new PublicKey(String(userWallet));
    stage = 'resolve-pool-lp-mint';
    const { lpMint, poolProgramId, connection: poolConnection } = await getRaydiumLpMint(connection, new PublicKey(String(poolAddress)));

    stage = 'read-lp-token-accounts';
    const tokenAccounts = await poolConnection.getParsedTokenAccountsByOwner(userPublicKey, {
      mint: lpMint,
    });

    // A wallet may hold several token accounts for the same LP mint. Sum all
    // raw amounts so lifecycle checks and withdrawals use the wallet total.
    let totalRawBalance = BigInt(0);
    let decimals = 9;
    for (const tokenAccount of tokenAccounts.value) {
      const amount = tokenAccount.account.data.parsed.info.tokenAmount;
      totalRawBalance += BigInt(amount.amount);
      decimals = amount.decimals;
    }
    const rawBalance = totalRawBalance.toString();
    const uiBalance = Number(totalRawBalance) / (10 ** decimals);
    let positionEstimate: Awaited<ReturnType<typeof getRaydiumLpPositionEstimate>> | null = null;
    let positionEstimateStatus: 'ready' | 'unavailable' | 'zero-balance' = 'zero-balance';
    if (includePosition && totalRawBalance > 0n) {
      try {
        positionEstimateStatus = 'unavailable';
        positionEstimate = await getRaydiumLpPositionEstimate(
          poolConnection,
          new PublicKey(String(poolAddress)),
          userPublicKey,
          rawBalance,
        );
        positionEstimateStatus = 'ready';
      } catch (error) {
        logger.warn({ poolAddress: String(poolAddress), err: error }, 'Could not estimate underlying Raydium LP position');
      }
    }

    let canonicalRawBalance = '0';
    if (poolProgramId && lpMint && (await poolConnection.getAccountInfo(lpMint, 'confirmed'))?.owner.equals(TOKEN_PROGRAM_ID)) {
      const { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
      const canonicalLpAta = getAssociatedTokenAddressSync(lpMint, userPublicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const canonicalLpAccount = await poolConnection.getAccountInfo(canonicalLpAta, 'confirmed');
      if (canonicalLpAccount?.owner.equals(TOKEN_PROGRAM_ID)) {
        const { getAccount } = await import('@solana/spl-token');
        canonicalRawBalance = (await getAccount(poolConnection, canonicalLpAta, 'confirmed', TOKEN_PROGRAM_ID)).amount.toString();
      }
    }

    return res.status(200).json({
      success: true,
      lpMint: lpMint.toBase58(),
      poolProgramId: poolProgramId.toBase58(),
      rawBalance,
      canonicalRawBalance,
      uiBalance,
      decimals,
      ...(includePosition ? { positionEstimate, positionEstimateStatus } : {}),
    });
  } catch (error: any) {
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    return sendInternalError(res, error, 'Error fetching LP balance', { stage });
  }
};

export const prepareLpLock = async (req: Request, res: Response): Promise<Response> => {
  let stage = 'validate-request';
  try {
    const { userWallet, poolAddress, lpTokenAmount } = req.body as {
      userWallet: string;
      poolAddress: string;
      lpTokenAmount: string;
    };
    const owner = new PublicKey(userWallet);
    const pool = new PublicKey(poolAddress);
    const canonicalWallet = owner.toBase58();
    const canonicalPool = pool.toBase58();
    const amount = BigInt(lpTokenAmount);

    stage = 'verify-registered-pool';
    const registeredPool = await prisma.token.findFirst({
      where: { creatorWallet: canonicalWallet, poolAddress: canonicalPool, launchPlatform: 'RAYDIUM' },
      select: { mintAddress: true },
    });
    if (!registeredPool) {
      return res.status(404).json({ success: false, error: 'La pool no está registrada para esta wallet creadora.' });
    }

    stage = 'select-devnet-rpc';
    const poolConnection = await getReliableDevnetConnection(connection);
    stage = 'verify-streamflow-program';
    const streamflowProgramAccount = await poolConnection.getAccountInfo(STREAMFLOW_DEVNET_PROGRAM_ID, 'confirmed');
    if (!streamflowProgramAccount?.executable) {
      throw new PublicError('Streamflow no está disponible en la red Devnet configurada.', 503);
    }

    stage = 'resolve-lp-mint';
    const { lpMint, connection: verifiedPoolConnection } = await getRaydiumLpMint(poolConnection, pool);
    const mintAccount = await verifiedPoolConnection.getAccountInfo(lpMint, 'confirmed');
    if (!mintAccount || !mintAccount.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new PublicError('Wire solo puede bloquear LP fungible del programa SPL Token clásico.', 422);
    }
    const mintInfo = await getMint(verifiedPoolConnection, lpMint, 'confirmed', TOKEN_PROGRAM_ID);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const unlockTimestamp = nowSeconds + TEMPORAL_LP_LOCK_DAYS * 24 * 60 * 60;

    stage = 'read-canonical-lp-account';
    const provisional = buildTemporalLockInstruction({ userWallet: owner, lpMint, lpDecimals: mintInfo.decimals, tokenProgramId: TOKEN_PROGRAM_ID }, amount, unlockTimestamp, 0);
    const sourceAccountInfo = await verifiedPoolConnection.getAccountInfo(provisional.senderTokenAddress, 'confirmed');
    if (!sourceAccountInfo || !sourceAccountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new PublicError('No existe la cuenta LP canónica que Streamflow requiere para crear el bloqueo.', 409);
    }
    const sourceAccount = await getAccount(verifiedPoolConnection, provisional.senderTokenAddress, 'confirmed', TOKEN_PROGRAM_ID);
    if (!sourceAccount.owner.equals(owner) || !sourceAccount.mint.equals(lpMint)) {
      throw new PublicError('La cuenta LP disponible no coincide con esta wallet y esta pool.', 409);
    }
    if (sourceAccount.amount === 0n) {
      throw new PublicError('La cuenta LP canónica de esta wallet no tiene saldo para bloquear.', 409);
    }
    if (amount > sourceAccount.amount) {
      throw new PublicError('La cantidad supera el saldo LP canónico disponible para bloquear.', 400);
    }

    stage = 'quote-streamflow-fees';
    const feeQuote = await getTemporalLockFeeQuote(verifiedPoolConnection);
    let lock = provisional;
    let selectedNonce = 0;
    for (; selectedNonce < 100; selectedNonce += 1) {
      const candidate = buildTemporalLockInstruction({ userWallet: owner, lpMint, lpDecimals: mintInfo.decimals, tokenProgramId: TOKEN_PROGRAM_ID }, amount, unlockTimestamp, selectedNonce);
      const metadataAccount = await verifiedPoolConnection.getAccountInfo(candidate.metadataAddress, 'confirmed');
      if (!metadataAccount) {
        lock = candidate;
        break;
      }
    }
    if (selectedNonce >= 100) throw new PublicError('No se encontró un espacio libre para crear el bloqueo Streamflow.', 409);

    stage = 'build-and-simulate-lock';
    const { blockhash, lastValidBlockHeight } = await verifiedPoolConnection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(lock.instruction);
    const feeResponse = await verifiedPoolConnection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
    if (feeResponse.value === null || !Number.isSafeInteger(feeResponse.value) || feeResponse.value < 0) {
      throw new PublicError('No se pudo estimar la tarifa de red en Devnet.', 503);
    }

    const balanceBeforeLamports = await verifiedPoolConnection.getBalance(owner, 'confirmed');
    const versionedMessage = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [lock.instruction] }).compileToV0Message();
    const simulation = await verifiedPoolConnection.simulateTransaction(new VersionedTransaction(versionedMessage), {
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [owner.toBase58()] },
    });
    if (simulation.value.err) {
      const logs = simulation.value.logs?.join('\n') ?? '';
      if (/insufficient (?:funds|lamports)|not enough lamports/i.test(logs)) {
        throw new PublicError('La wallet no tiene SOL suficiente para crear el bloqueo y sus cuentas en Devnet.', 409);
      }
      logger.warn({ poolAddress: canonicalPool, err: simulation.value.err, logs: simulation.value.logs }, 'Streamflow LP lock simulation failed');
      throw new PublicError('Streamflow no pudo validar el bloqueo en Devnet. No se preparó ninguna firma ni se envió una transacción.', 422);
    }
    const simulatedWalletAccount = simulation.value.accounts?.[0];
    if (!simulatedWalletAccount) throw new PublicError('Devnet no devolvió el balance simulado de la wallet; no se preparó el bloqueo.', 503);
    const estimatedWalletSolDeltaLamports = balanceBeforeLamports - simulatedWalletAccount.lamports;
    if (estimatedWalletSolDeltaLamports < feeResponse.value) {
      throw new PublicError('La simulación de Devnet devolvió un costo de SOL no válido.', 503);
    }

    const transactionMessageHash = createHash('sha256').update(transaction.compileMessage().serialize()).digest('hex');
    const tokenLockFeeRaw = calculateTemporalLockTokenFeeRaw(amount, feeQuote.tokenLockFeePercent);
    return res.status(200).json({
      success: true,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      transactionMessageHash,
      lastValidBlockHeight,
      poolAddress: canonicalPool,
      lpMint: lpMint.toBase58(),
      lpTokenAmount: amount.toString(),
      availableLpAmount: sourceAccount.amount.toString(),
      decimals: mintInfo.decimals,
      metadataAddress: lock.metadataAddress.toBase58(),
      unlockAt: new Date(unlockTimestamp * 1000).toISOString(),
      unlockTimestamp,
      nonce: selectedNonce,
      lockDurationDays: TEMPORAL_LP_LOCK_DAYS,
      estimatedNetworkFeeLamports: feeResponse.value,
      estimatedWalletSolDeltaLamports,
      streamflowCreationFeeLamports: feeQuote.creationFeeLamports,
      streamflowTokenFeePercent: feeQuote.tokenLockFeePercent,
      streamflowTokenFeeRaw: tokenLockFeeRaw.toString(),
      feeQuoteWallet: feeQuote.feeConfigWallet,
      feeQuotedAt: feeQuote.quotedAt,
      sourceAccount: lock.senderTokenAddress.toBase58(),
      treasuryTokenAddress: lock.treasuryTokenAddress.toBase58(),
      escrowAddress: lock.escrowAddress.toBase58(),
    });
  } catch (error) {
    if (error instanceof PublicError) return res.status(error.status).json({ success: false, error: error.message });
    return sendInternalError(res, error, 'Error preparing LP lock', { stage });
  }
};

export const prepareLpBurn = async (req: Request, res: Response): Promise<Response> => {
  let stage = 'validate-request';
  try {
    const { userWallet, poolAddress, lpTokenAmount } = req.body as {
      userWallet: string;
      poolAddress: string;
      lpTokenAmount: string;
    };
    const owner = new PublicKey(userWallet);
    const pool = new PublicKey(poolAddress);
    const canonicalWallet = owner.toBase58();
    const canonicalPool = pool.toBase58();
    const amount = BigInt(lpTokenAmount);

    stage = 'verify-registered-pool';
    const registeredPool = await prisma.token.findFirst({
      where: { creatorWallet: canonicalWallet, poolAddress: canonicalPool, launchPlatform: 'RAYDIUM' },
      select: { mintAddress: true },
    });
    if (!registeredPool) {
      return res.status(404).json({ success: false, error: 'La pool no está registrada para esta wallet creadora.' });
    }

    stage = 'select-devnet-rpc';
    const poolConnection = await getReliableDevnetConnection(connection);
    stage = 'resolve-lp-mint';
    const { lpMint, connection: verifiedPoolConnection } = await getRaydiumLpMint(poolConnection, pool);
    const mintAccount = await verifiedPoolConnection.getAccountInfo(lpMint, 'confirmed');
    if (!mintAccount || !mintAccount.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new PublicError('Wire solo puede quemar LP fungible del programa SPL Token clásico.', 422);
    }
    const mintInfo = await getMint(verifiedPoolConnection, lpMint, 'confirmed', TOKEN_PROGRAM_ID);

    stage = 'read-wallet-lp-accounts';
    const tokenAccounts = await verifiedPoolConnection.getParsedTokenAccountsByOwner(owner, { mint: lpMint }, 'confirmed');
    const sources = tokenAccounts.value.map(({ pubkey, account }) => {
      if (!account.owner.equals(TOKEN_PROGRAM_ID)) {
        throw new PublicError('La pool usa cuentas LP de un programa SPL no compatible con esta acción.', 422);
      }
      const tokenAmount = account.data.parsed.info.tokenAmount;
      if (!/^\d+$/.test(tokenAmount.amount) || !Number.isInteger(tokenAmount.decimals)) {
        throw new PublicError('Solana devolvió datos LP no válidos; no se preparó la quema.', 502);
      }
      return { address: pubkey, amount: BigInt(tokenAmount.amount), decimals: tokenAmount.decimals };
    });
    const availableRaw = sources.reduce((sum, source) => sum + source.amount, 0n);
    if (availableRaw === 0n) {
      throw new PublicError('Esta wallet no tiene saldo LP disponible para quemar.', 409);
    }
    if (amount > availableRaw) {
      throw new PublicError('La cantidad supera el saldo LP disponible en esta wallet.', 400);
    }

    stage = 'build-lp-burn';
    const instructions = buildLpBurnInstructions({
      userWallet: owner,
      lpMint,
      lpDecimals: mintInfo.decimals,
      tokenProgramId: TOKEN_PROGRAM_ID,
    }, amount, sources);
    const { blockhash, lastValidBlockHeight } = await verifiedPoolConnection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(...instructions);
    const transactionMessageHash = createHash('sha256')
      .update(transaction.compileMessage().serialize())
      .digest('hex');

    return res.status(200).json({
      success: true,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      transactionMessageHash,
      lastValidBlockHeight,
      poolAddress: canonicalPool,
      lpMint: lpMint.toBase58(),
      lpTokenAmount: amount.toString(),
      availableLpAmount: availableRaw.toString(),
      decimals: mintInfo.decimals,
      sourceAccountCount: instructions.length,
    });
  } catch (error) {
    if (error instanceof PublicError) return res.status(error.status).json({ success: false, error: error.message });
    return sendInternalError(res, error, 'Error preparing LP burn', { stage });
  }
};
