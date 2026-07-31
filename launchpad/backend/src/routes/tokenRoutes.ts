import { Router } from 'express';
import { createToken, submitTransaction, withdrawLiquidity } from '../controllers/tokenController';

const router = Router();

// Rutas existentes
router.post('/create-token', createToken);
router.post('/submit-transaction', submitTransaction);

// Nueva ruta: retiro con comisión del 10%
router.post('/withdraw-liquidity', withdrawLiquidity);

export const tokenRouter = router;