import express from 'express';
import cors from 'cors';
import { tokenRouter } from './routes/tokenRoutes';
import { apiRateLimit, connectRateLimitStore } from './middleware/rateLimit';
import { config } from './utils/config';
import { logger } from './utils/logger';

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
  maxAge: 600,
}));
app.use('/api', apiRateLimit);
// Límite subido de los 100kb por defecto de Express: las imágenes de los
// tokens viajan como Base64 en el body JSON, y eso pesa bastante más que
// el archivo original (~33% más grande al codificarse en Base64).
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rutas
app.use('/api', tokenRouter);

async function start() {
  try {
    await connectRateLimitStore();
    logger.info('Rate limit store connected');
  } catch (error) {
    logger.error({ err: error }, 'Rate limit store not available at startup, requests will return 503 until it connects');
  }

  app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port}`);
  });
}

void start();