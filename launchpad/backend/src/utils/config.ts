import "dotenv/config";

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  rpcEndpoint: required("RPC_ENDPOINT"),
  rpcWebsocket: process.env.RPC_WEBSOCKET || "",
  platformFeeWallet: required("PLATFORM_FEE_WALLET"),
  serverWalletPrivateKey: required("SERVER_WALLET_PRIVATE_KEY"),
  pinataJwt: process.env.PINATA_JWT || "",
  pinataGateway: process.env.PINATA_GATEWAY || "gateway.pinata.cloud",
  databaseUrl: required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  coingeckoApiKey: process.env.COINGECKO_API_KEY || "",
  // Modelo de fee: base fija + un adicional por cada asset de seguridad activado
  baseFeeSol: Number(process.env.BASE_FEE_SOL || 0.5),
  assetFeeSol: Number(process.env.ASSET_FEE_SOL || 0.1),
};
