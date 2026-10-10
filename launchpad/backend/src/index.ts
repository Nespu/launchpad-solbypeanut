import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { tokenRouter } from './routes/tokenRoutes';
import { logger } from './utils/logger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
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

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
