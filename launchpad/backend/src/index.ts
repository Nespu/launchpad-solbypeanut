import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { tokenRouter } from './routes/tokenRoutes';
import { logger } from './utils/logger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rutas
app.use('/api', tokenRouter);

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
