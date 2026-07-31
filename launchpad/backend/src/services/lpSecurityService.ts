import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { logger } from "../utils/logger";

export interface LpContext {
  userWallet: PublicKey;
  lpMint: PublicKey; // mint address of the LP token, returned by pool creation
  lpDecimals: number; // usually 9, but confirm against what Raydium returns
}

/**
 * QUEMA TOTAL DE LP — implementación real.
 *
 * Quemar LP tokens es una instrucción SPL estándar (no depende de ningún SDK
 * externo), así que esto sí está completo. Requiere que ya exista el mint del
 * LP y que el usuario tenga esos LP tokens en su associated token account —
 * es decir, esto solo puede ejecutarse DESPUÉS de que la instrucción de
 * creación del pool de Raydium haya depositado los LP tokens en la wallet del
 * usuario, dentro de la misma transacción.
 *
 * Se usa createBurnCheckedInstruction (no createBurnInstruction) porque valida
 * los decimales on-chain, lo que evita quemar la cantidad equivocada por un
 * error de configuración.
 */
export function buildTotalBurnInstruction(ctx: LpContext): TransactionInstruction[] {
  const userLpAta = getAssociatedTokenAddressSync(ctx.lpMint, ctx.userWallet);

  // NOTA: aquí se quema el balance completo. Si tu integración de Raydium no
  // te da el monto exacto de LP minteado en la misma transacción, tendrás que
  // leer el balance de la ATA antes de construir esta instrucción (con
  // connection.getTokenAccountBalance) en vez de asumirlo.
  const burnIx = createBurnCheckedInstruction(
    userLpAta,
    ctx.lpMint,
    ctx.userWallet, // authority (el usuario firma esto)
    0n, // TODO: reemplazar por el monto real de LP tokens a quemar (ver nota arriba)
    ctx.lpDecimals
  );

  logger.info({ lpMint: ctx.lpMint.toBase58() }, "Built LP burn instruction");
  return [burnIx];
}

/**
 * BLOQUEO TEMPORAL (6 MESES) — stub, requiere integración con Streamflow.
 *
 * ⚠️ Al igual que con Raydium en raydiumService.ts, no quise dejarte una
 * integración "de memoria" con un SDK externo que cambia con el tiempo.
 * Streamflow es un protocolo de vesting/streaming de tokens en Solana; su
 * paquete de npm y la forma exacta de generar instrucciones (en vez de enviar
 * la transacción ellos mismos) pueden haber cambiado.
 *
 * Antes de implementar esto:
 *   1. Busca el paquete npm actual de Streamflow para Solana y confirma su
 *      versión más reciente.
 *   2. Revisa su documentación para el flujo de "crear un stream/lock" y
 *      confirma si expone un instruction builder (lo que necesitas para
 *      meterlo en la misma transacción) o si únicamente expone un método que
 *      envía su propia transacción (en cuyo caso el bloqueo temporal NO podría
 *      ir en la misma firma que el resto del flujo, y tendrías que pedirle al
 *      usuario una segunda firma solo para este paso).
 *   3. Reemplaza el cuerpo de esta función con la llamada real, manteniendo
 *      la firma (recibe LpContext + duración en días, devuelve instrucciones
 *      o lanza si no es posible componerlo en una sola transacción).
 */
export async function buildTemporalLockInstructions(
  ctx: LpContext,
  lockDurationDays: number = 180
): Promise<TransactionInstruction[]> {
  logger.warn(
    { lpMint: ctx.lpMint.toBase58(), lockDurationDays },
    "buildTemporalLockInstructions is a stub — falta integrar el SDK real de Streamflow"
  );

  throw new Error(
    "Bloqueo temporal no implementado todavía. Ver comentarios en lpSecurityService.ts."
  );
}
