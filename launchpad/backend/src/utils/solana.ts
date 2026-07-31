import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";

export const connection = new Connection(config.rpcEndpoint, {
  commitment: "confirmed",
  wsEndpoint: config.rpcWebsocket || undefined,
});

// The server wallet only pays network/compute fees for building transactions.
// It must be funded with a small amount of SOL and NEVER hold user funds.
export function getServerKeypair(): Keypair {
  const secret = bs58.decode(config.serverWalletPrivateKey);
  return Keypair.fromSecretKey(secret);
}

export const platformFeeWallet = new PublicKey(config.platformFeeWallet);
