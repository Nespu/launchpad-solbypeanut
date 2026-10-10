import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function required(name: string): string {
  const val = process.env[name]?.trim();
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

function integerFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonNegativeNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === "production";
const port = integerFromEnv("PORT", 4000, 1, 65535);
const trustProxyHops = integerFromEnv("TRUST_PROXY_HOPS", 0, 0, 10);
const platformFeeWallet = required("PLATFORM_FEE_WALLET");
const serverWalletPrivateKey = required("SERVER_WALLET_PRIVATE_KEY");

try {
  new PublicKey(platformFeeWallet);
} catch {
  throw new Error("PLATFORM_FEE_WALLET must be a valid Solana public key");
}

try {
  Keypair.fromSecretKey(bs58.decode(serverWalletPrivateKey));
} catch {
  throw new Error("SERVER_WALLET_PRIVATE_KEY must be a valid base58 Solana keypair");
}

const rpcEndpoint = required("RPC_ENDPOINT");
let parsedRpcEndpoint: URL;
try {
  parsedRpcEndpoint = new URL(rpcEndpoint);
} catch {
  throw new Error("RPC_ENDPOINT must be a valid URL");
}
if (!['https:', 'http:'].includes(parsedRpcEndpoint.protocol) || (isProduction && parsedRpcEndpoint.protocol !== 'https:')) {
  throw new Error("RPC_ENDPOINT must use HTTPS in production");
}
if (!isProduction && !/devnet/i.test(rpcEndpoint)) {
  throw new Error("RPC_ENDPOINT must target Devnet outside production");
}

const defaultCorsOrigins = "http://localhost:3000,http://127.0.0.1:3000";
const corsOriginsValue = process.env.CORS_ORIGINS?.trim() || (isProduction ? "" : defaultCorsOrigins);
if (isProduction && !corsOriginsValue) {
  throw new Error("CORS_ORIGINS is required in production");
}
const corsOrigins = corsOriginsValue ? corsOriginsValue.split(",").map((origin) => origin.trim()).filter(Boolean) : [];
for (const origin of corsOrigins) {
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("CORS_ORIGINS must contain comma-separated origin URLs");
  }
  if (parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password || (isProduction && parsedOrigin.protocol !== "https:")) {
    throw new Error("CORS_ORIGINS must contain valid HTTPS origins in production, without paths or credentials");
  }
}

const redisUrl = process.env.REDIS_URL?.trim() || (isProduction ? "" : "redis://localhost:6379");
if (!redisUrl) {
  throw new Error("REDIS_URL is required in production");
}
if (!/^rediss?:\/\//i.test(redisUrl) || (isProduction && !/^rediss:\/\//i.test(redisUrl))) {
  throw new Error("REDIS_URL must use rediss:// in production and redis:// or rediss:// otherwise");
}

export const config = {
  port,
  isProduction,
  trustProxyHops,
  corsOrigins,
  rpcEndpoint,
  rpcWebsocket: process.env.RPC_WEBSOCKET || "",
  platformFeeWallet,
  serverWalletPrivateKey,
  pinataJwt: process.env.PINATA_JWT || "",
  pinataGateway: process.env.PINATA_GATEWAY || "gateway.pinata.cloud",
  databaseUrl: required("DATABASE_URL"),
  redisUrl,
  coingeckoApiKey: process.env.COINGECKO_API_KEY || "",
  baseFeeSol: nonNegativeNumberFromEnv("BASE_FEE_SOL", 0.02),
  assetFeeSol: nonNegativeNumberFromEnv("ASSET_FEE_SOL", 0),
};
