import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { resolveWalletSession, tokenRouter, walletAuthService } from './routes/tokenRoutes';
import { apiRateLimit, connectRateLimitStore, disconnectRateLimitStore, getRedisClient } from './middleware/rateLimit';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { createWalletAuthHandlers, createWalletSessionResolver } from './controllers/walletAuthController';
import { createWalletAuthRouter } from './routes/walletAuthRoutes';
import { createGetWalletHistoryHandler } from './controllers/walletHistoryController';
import { createWalletHistoryRouter } from './routes/walletHistoryRoutes';
import { prisma } from './utils/prisma';
import { connection } from './utils/solana';
import { createTokenAttemptRouter } from './routes/tokenAttemptRoutes';
import { reportTokenAttemptOutcome } from './controllers/tokenAttemptController';
import { tokenAttemptCleanup } from './services/tokenAttemptCleanupRuntime';
import { createWithdrawalCleanup } from './services/withdrawalCleanup';
import { sendInternalError } from './utils/internalError';
import { createSwapHandlers } from './controllers/swapController';
import { createSwapRouter } from './routes/swapRoutes';
import { createPumpCreatorFeeHandlers } from './controllers/pumpCreatorFeeController';
import { createPumpCreatorFeeRouter } from './routes/pumpCreatorFeeRoutes';
import { createPumpFeeSharingHandlers } from './controllers/pumpFeeSharingController';
import { createPumpFeeSharingRouter } from './routes/pumpFeeSharingRoutes';

const app = express();
const allowedOrigins = new Set(config.corsOrigins);
const withdrawalCleanup = createWithdrawalCleanup(prisma, connection);

function withDependencyTimeout<T>(dependency: string, operation: Promise<T>, timeoutMs = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${dependency} readiness check timed out`)), timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxyHops);
app.use((req, res, next) => {
  const origin = req.get('origin');
  const changesState = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (changesState && !origin) {
    return res.status(403).json({ success: false, error: 'Se requiere un origen de navegador permitido.' });
  }
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ success: false, error: 'El origen de esta solicitud no está permitido.' });
  }
  return next();
});
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
  maxAge: 600,
}));
app.use('/api', apiRateLimit);
// Límite subido de los 100kb por defecto de Express: las imágenes de los
// tokens viajan como Base64 en el body JSON, y eso pesa bastante más que
// el archivo original (~33% más grande al codificarse en Base64).
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Liveness does not depend on external services.
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/health/ready', async (_req, res) => {
  try {
    await Promise.all([
      withDependencyTimeout('PostgreSQL', prisma.$queryRaw`SELECT 1`),
      withDependencyTimeout('Redis', getRedisClient().ping()),
      withDependencyTimeout('Solana RPC', connection.getVersion()),
    ]);
    return res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    // Dependency errors can include connection URLs. Keep them out of logs so
    // credentials in database, Redis, or RPC URLs are never exposed.
    logger.warn('Readiness check failed');
    return res.status(503).json({ status: 'unavailable' });
  }
});

// Rutas
app.use('/api', tokenRouter);
app.use('/api/swap', createSwapRouter(createSwapHandlers(prisma, connection), resolveWalletSession));
app.use('/api/pump/creator-fees', createPumpCreatorFeeRouter(createPumpCreatorFeeHandlers()));
app.use('/api/pump/fee-sharing', createPumpFeeSharingRouter(createPumpFeeSharingHandlers()));
app.use('/api/auth', createWalletAuthRouter(createWalletAuthHandlers(walletAuthService)));
app.use('/api/wallet-history', createWalletHistoryRouter(
  createGetWalletHistoryHandler(prisma, createWalletSessionResolver(walletAuthService)),
));
app.use('/api/token-attempt', createTokenAttemptRouter(reportTokenAttemptOutcome));

// Keep parser and unexpected request errors in the same safe JSON envelope.
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const parserError = error as { type?: string; status?: number } | null;
  if (parserError?.type === 'entity.too.large' || parserError?.status === 413) {
    return res.status(413).json({ success: false, error: 'El cuerpo de la solicitud supera el límite permitido.' });
  }
  if (parserError?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'El JSON de la solicitud no es válido.' });
  }
  return sendInternalError(res, error, 'Unhandled request error');
});

async function start() {
  try {
    await connectRateLimitStore();
    logger.info('Rate limit store connected');
  } catch (error) {
    logger.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Rate limit store not available at startup, requests will return 503 until it connects',
    );
  }
  tokenAttemptCleanup.start((error) => logger.error(
    { errorName: error instanceof Error ? error.name : 'UnknownError' },
    'Token attempt IPFS cleanup sweep failed',
  ));
  withdrawalCleanup.start((error) => logger.error(
    { errorName: error instanceof Error ? error.name : 'UnknownError' },
    'Withdrawal reconciliation sweep failed',
  ));

  const server = app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down server');
    tokenAttemptCleanup.stop();
    withdrawalCleanup.stop();
    server.close(async (error) => {
      if (error) logger.error({ err: error }, 'HTTP server shutdown failed');
      await Promise.all([tokenAttemptCleanup.stop(), withdrawalCleanup.stop()]);
      const results = await Promise.allSettled([prisma.$disconnect(), disconnectRateLimitStore()]);
      for (const result of results) {
        if (result.status === 'rejected') logger.error({ err: result.reason }, 'Service shutdown failed');
      }
      process.exitCode = error || results.some((result) => result.status === 'rejected') ? 1 : 0;
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void start();
