import express from 'express';
import cors from 'cors';
import { tokenRouter, walletAuthService } from './routes/tokenRoutes';
import { apiRateLimit, connectRateLimitStore, disconnectRateLimitStore, getRedisClient } from './middleware/rateLimit';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { createWalletAuthHandlers, createWalletSessionResolver } from './controllers/walletAuthController';
import { createWalletAuthRouter } from './routes/walletAuthRoutes';
import { createGetWalletHistoryHandler } from './controllers/walletHistoryController';
import { createWalletHistoryRouter } from './routes/walletHistoryRoutes';
import { prisma } from './utils/prisma';
import { createTokenAttemptRouter } from './routes/tokenAttemptRoutes';
import { reportTokenAttemptOutcome } from './controllers/tokenAttemptController';
import { tokenAttemptCleanup } from './services/tokenAttemptCleanupRuntime';

const app = express();
const allowedOrigins = new Set(config.corsOrigins);

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxyHops);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ success: false, error: 'Origin not allowed' });
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
      prisma.$queryRaw`SELECT 1`,
      getRedisClient().ping(),
    ]);
    return res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error({ err: error }, 'Readiness check failed');
    return res.status(503).json({ status: 'unavailable' });
  }
});

// Rutas
app.use('/api', tokenRouter);
app.use('/api/auth', createWalletAuthRouter(createWalletAuthHandlers(walletAuthService)));
app.use('/api/wallet-history', createWalletHistoryRouter(
  createGetWalletHistoryHandler(prisma, createWalletSessionResolver(walletAuthService)),
));
app.use('/api/token-attempt', createTokenAttemptRouter(reportTokenAttemptOutcome));

async function start() {
  try {
    await connectRateLimitStore();
    logger.info('Rate limit store connected');
  } catch (error) {
    logger.error({ err: error }, 'Rate limit store not available at startup, requests will return 503 until it connects');
  }
  tokenAttemptCleanup.start((error) => logger.error({ err: error }, 'Token attempt IPFS cleanup sweep failed'));

  const server = app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down server');
    tokenAttemptCleanup.stop();
    server.close(async (error) => {
      if (error) logger.error({ err: error }, 'HTTP server shutdown failed');
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
