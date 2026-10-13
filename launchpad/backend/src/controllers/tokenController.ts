import { Request, Response } from 'express';
import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';
import { PublicKey, Transaction, SystemProgram, SystemInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, decodeInitializeMintInstruction, decodeMintToInstruction } from '@solana/spl-token';
import { Metadata, PROGRAM_ID as METADATA_PROGRAM_ID } from '@metaplex-foundation/mpl-token-metadata';
import { PrismaClient } from '@prisma/client';
import { createRaydiumCpmmPool, withdrawLiquidityWithFee } from '../services/raydiumService';
import { confirmSignedTransaction, createTokenIdempotently } from '../services/tokenSubmission';
import { buildMintInstructions } from '../services/mintService';
import {
  buildRevokeMintInstruction,
  buildRevokeFreezeInstruction,
  buildRevokeUpdateInstruction,
} from '../services/authorityService';
import { uploadImageToIpfs, uploadMetadataToIpfs } from '../services/ipfsService';
import { PLACEHOLDER_IMAGE_URL, fetchTokenMetadata, parseImageDataUrl } from '../services/tokenMetadata';
import { logger } from '../utils/logger';
import { connection, getServerKeypair, platformFeeWallet } from '../utils/solana';
import { config } from '../utils/config';
import { cleanMetadataText } from '../utils/metadataText';
import { PublicError } from '../utils/publicError';
import {
  createGetMyPoolsHandler,
  createGetMyTokensHandler,
  createGetTokenDetailsHandler,
  createUpdateWithdrawalResultHandler,
} from './tokenControllerHandlers';

const prisma = new PrismaClient();

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

    let imageUrl = '';
    if (imageBase64) {
      const parsedImage = parseImageDataUrl(imageBase64);
      imageBytes = parsedImage.buffer.byteLength;
      pinataUploadCount += 1;
      imageUrl = await uploadImageToIpfs(imageBase64);
    } else {
      imageUrl = PLACEHOLDER_IMAGE_URL;
    }

    const offChainMetadata = { name, symbol, description: description || '', image: imageUrl };
    metadataJsonBytes = Buffer.byteLength(JSON.stringify({ pinataContent: offChainMetadata }), 'utf8');
    pinataUploadCount += 1;
    const metadataUri = await uploadMetadataToIpfs(offChainMetadata);

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
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

    transaction.partialSign(mintKeypair, serverWallet);

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
      fee: totalFee,
      mintAddress: mintKeypair.publicKey.toBase58(),
      imageUrl,
      message: 'Token creation prepared',
    });

  } catch (error: any) {
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    logger.error({
      attemptId,
      imageBytes,
      metadataJsonBytes,
      pinataUploadCount,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'Token creation preparation failed');
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
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
        logger.info({ attemptId, userWallet: creatorPublicKey.toBase58(), mintAddress: mintPublicKey.toBase58(), txHash: signature, outcome: 'already_registered' }, 'Token creation attempt registered idempotently');
        return res.status(200).json(successPayload);
      }
      return res.status(409).json({ success: false, error: 'Token is already registered' });
    }

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

    await createTokenIdempotently(prisma.token, {
      mintAddress: mintPublicKey.toBase58(),
      name: cleanMetadataText(onChainMetadata.data.name),
      symbol: cleanMetadataText(onChainMetadata.data.symbol),
      description: offChainMetadata.description || null,
      imageUrl: offChainMetadata.image,
      totalSupply: BigInt(totalSupply),
      liquiditySol,
      creatorWallet: creatorPublicKey.toBase58(),
      copiedFrom: copyFrom || null,
      txHash: signature,
      status: 'completed',
      poolAddress: null,
    });

    logger.info({ attemptId, userWallet: creatorPublicKey.toBase58(), mintAddress: mintPublicKey.toBase58(), txHash: signature, outcome: 'registered' }, 'Token creation completed');

    return res.status(200).json(successPayload);

  } catch (error: any) {
    if (error instanceof PublicError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    const errorId = randomUUID();
    logger.error({
      errorId,
      attemptId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
    }, 'Error submitting transaction');
    return res.status(500).json({
      success: false,
      error: 'No se pudo registrar el token. Conserva este código para soporte.',
      errorId,
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
export const getMyPools = createGetMyPoolsHandler(prisma);
export const getMyTokens = createGetMyTokensHandler(prisma);
export const getTokenDetails = createGetTokenDetailsHandler(prisma);
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
    const feeWallet = platformFeeWallet;

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

export const updateWithdrawalResult = createUpdateWithdrawalResultHandler(prisma, connection);

export const getFeeConfig = (_req: Request, res: Response): Response => {
  return res.status(200).json({ success: true, baseFeeSol: config.baseFeeSol, assetFeeSol: config.assetFeeSol });
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
