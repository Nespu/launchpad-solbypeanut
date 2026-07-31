import { config } from "../utils/config";
import { logger } from "../utils/logger";

let cachedPrice: { value: number; ts: number } | null = null;
const CACHE_MS = 30_000;

export async function getSolPriceUsd(): Promise<number> {
  if (cachedPrice && Date.now() - cachedPrice.ts < CACHE_MS) {
    return cachedPrice.value;
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd" +
        (config.coingeckoApiKey ? `&x_cg_demo_api_key=${config.coingeckoApiKey}` : "")
    );
    const data = (await res.json()) as { solana: { usd: number } };
    cachedPrice = { value: data.solana.usd, ts: Date.now() };
    return data.solana.usd;
  } catch (err) {
    logger.error({ err }, "Failed to fetch SOL price, using fallback");
    // Fallback so the platform doesn't hard-fail if CoinGecko is down.
    // Adjust this fallback periodically.
    return cachedPrice?.value ?? 150;
  }
}

/**
 * Ya no se usa para calcular el fee obligatorio (el fee ahora es fijo en SOL,
 * ver config.baseFeeSol / config.assetFeeSol). Se deja disponible por si
 * quieres mostrar el equivalente en USD en la UI como referencia.
 */
export async function getUsdEquivalent(amountSol: number): Promise<number> {
  const price = await getSolPriceUsd();
  return amountSol * price;
}
