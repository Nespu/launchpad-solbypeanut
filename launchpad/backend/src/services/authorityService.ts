import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createSetAuthorityInstruction, AuthorityType } from "@solana/spl-token";
// ⚠️ Mismo aviso que en mintService.ts: requiere mpl-token-metadata ^2.x fijado
// en package.json. La v3 usa Umi y no expone createUpdateMetadataAccountV2Instruction
// como función suelta — no subir de mayor versión sin reescribir esto.
import {
  PROGRAM_ID as METADATA_PROGRAM_ID,
  createUpdateMetadataAccountV2Instruction,
} from "@metaplex-foundation/mpl-token-metadata";

/**
 * A diferencia de raydiumService.ts y el bloqueo temporal en lpSecurityService.ts,
 * estas SÍ son implementaciones reales y completas: setAuthority es una instrucción
 * núcleo de SPL Token (estable desde hace años) y UpdateMetadataAccountV2 es la
 * instrucción estándar de Metaplex para metadata desde hace igual de tiempo. No son
 * SDKs que cambien de forma agresiva como Raydium o Streamflow.
 *
 * Aun así, antes de producción: confirma que la versión de
 * @metaplex-foundation/mpl-token-metadata instalada expone
 * `createUpdateMetadataAccountV2Instruction` con esta misma firma — los paquetes de
 * Metaplex sí reorganizan named exports entre versiones mayores de tanto en tanto.
 */

/** Revoca la autoridad de mint: nadie podrá acuñar más supply de este token nunca. */
export function buildRevokeMintInstruction(
  mint: PublicKey,
  currentMintAuthority: PublicKey
): TransactionInstruction {
  return createSetAuthorityInstruction(
    mint,
    currentMintAuthority,
    AuthorityType.MintTokens,
    null
  );
}

/** Revoca la autoridad de freeze: nadie podrá congelar cuentas de holders de este token. */
export function buildRevokeFreezeInstruction(
  mint: PublicKey,
  currentFreezeAuthority: PublicKey
): TransactionInstruction {
  return createSetAuthorityInstruction(
    mint,
    currentFreezeAuthority,
    AuthorityType.FreezeAccount,
    null
  );
}

/**
 * Revoca la autoridad de actualización de metadata (isMutable = false): el nombre,
 * símbolo, imagen y descripción quedan congelados para siempre, nadie —ni el
 * creador— podrá cambiarlos después de esto.
 */
export function buildRevokeUpdateInstruction(
  mint: PublicKey,
  currentUpdateAuthority: PublicKey
): TransactionInstruction {
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );

  return createUpdateMetadataAccountV2Instruction(
    {
      metadata: metadataPda,
      updateAuthority: currentUpdateAuthority,
    },
    {
      updateMetadataAccountArgsV2: {
        data: null, // no tocar nombre/símbolo/uri, solo bloquear futuras ediciones
        updateAuthority: currentUpdateAuthority,
        primarySaleHappened: null,
        isMutable: false,
      },
    }
  );
}
