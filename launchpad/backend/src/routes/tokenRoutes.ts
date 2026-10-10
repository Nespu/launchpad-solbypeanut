import { Router } from 'express';
import {
  createToken,
  submitTransaction,
  withdrawLiquidity,
  createPool,
  submitPoolTransaction,
  getLpBalance,
  getMyPools,
} from '../controllers/tokenController';

const router = Router();

router.post('/create-token', createToken);
router.post('/submit-transaction', submitTransaction);
router.post('/create-pool', createPool);
router.post('/submit-pool-transaction', submitPoolTransaction);
router.post('/withdraw-liquidity', withdrawLiquidity);
router.get('/lp-balance', getLpBalance);
router.get('/my-pools', getMyPools);

export const tokenRouter = router;