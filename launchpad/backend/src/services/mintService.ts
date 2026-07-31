import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
// ⚠️ Este import solo funciona con @metaplex-foundation/mpl-token-metadata en la
// serie 2.x (fijado como ^2.13.0 en package.json). La v3 de este paquete es una
// reescritura completa sobre la arquitectura Umi y YA NO exporta estas funciones
// como instruction builders sueltos — si alguien corre `npm update` sin fijar la
// versión, esto se rompe con "no exported member". No subir de mayor versión sin
// reescribir este archivo para Umi.
import {
  PROGRAM_ID as METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
} from "@metaplex-foundation/mpl-token-metadata";
import { connection, getServerKeypair } from "../utils/solana";

export interface BuildMintInstructionsParams {
  userWallet: PublicKey;
  name: string;
  symbol: string;
  metadataUri: string;
  totalSupply: bigint;
  decimals?: number;
}

export interface BuildMintInstructionsResult {
  mintKeypair: Keypair;
  instructions: import("@solana/web3.js").TransactionInstruction[];
}

/**
 * Builds (but does not send) all instructions needed to:
 *  1. Allocate the mint account
 *  2. Initialize it as an SPL token mint, with mint authority = user wallet
 *  3. Create the user's associated token account
 *  4. Mint the full supply to the user
 *  5. Attach Metaplex metadata (name/symbol/uri)
 *
 * These instructions get merged into the single transaction the user signs.
 *
 * NOTE: pin your @metaplex-foundation/mpl-token-metadata and @solana/spl-token
 * versions and check their current API before relying on this in production —
 * these packages change their instruction builders fairly often.
 */
export async function buildMintInstructions(
  params: BuildMintInstructionsParams
): Promise<BuildMintInstructionsResult> {
  const { userWallet, name, symbol, metadataUri, totalSupply, decimals = 9 } = params;

  const mintKeypair = Keypair.generate();
  const server = getServerKeypair();

  const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const ata = getAssociatedTokenAddressSync(mintKeypair.publicKey, userWallet);

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mintKeypair.publicKey.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );

  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: server.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports: rentExemptLamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      userWallet, // mint authority
      userWallet // freeze authority (or null if you don't want freeze)
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      server.publicKey, // payer
      ata,
      userWallet,
      mintKeypair.publicKey
    ),
    createMintToInstruction(
      mintKeypair.publicKey,
      ata,
      userWallet, // mint authority must sign — user signs this tx
      totalSupply
    ),
    createCreateMetadataAccountV3Instruction(
      {
        metadata: metadataPda,
        mint: mintKeypair.publicKey,
        mintAuthority: userWallet,
        payer: server.publicKey,
        updateAuthority: userWallet,
      },
      {
        createMetadataAccountArgsV3: {
          data: {
            name,
            symbol,
            uri: metadataUri,
            sellerFeeBasisPoints: 0,
            creators: null,
            collection: null,
            uses: null,
          },
          isMutable: true,
          collectionDetails: null,
        },
      }
    ),
  ];

  return { mintKeypair, instructions };
}
