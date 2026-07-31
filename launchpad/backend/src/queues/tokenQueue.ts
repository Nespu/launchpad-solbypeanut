import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../utils/config";

/**
 * This queue is NOT wired into the request flow yet — tokenController.ts
 * currently builds transactions synchronously per-request, which is fine for
 * an MVP with low traffic and a single RPC provider.
 *
 * Once you're getting rate-limited by your RPC provider, move the "build
 * transaction" step (image upload, metadata upload, instruction building)
 * into a job here, and have the frontend poll GET /api/token-info/:mintAddress
 * or listen over SSE/WebSocket for status updates instead of waiting on the
 * HTTP response.
 */
export const connectionOptions = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export const tokenCreationQueue = new Queue("token-creation", {
  connection: connectionOptions,
});
