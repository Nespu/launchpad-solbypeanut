import {
  createToken,
  submitTransaction,
  withdrawLiquidity,
  createPool,
  submitPoolTransaction,
  getLpBalance,
  getMyPools,
  getMyTokens,
  getTokenDetails,
  updateWithdrawalResult,
  getFeeConfig,
} from '../controllers/tokenController';
import { createTokenRouter } from './createTokenRouter';

export const tokenRouter = createTokenRouter({
  createToken,
  submitTransaction,
  withdrawLiquidity,
  createPool,
  submitPoolTransaction,
  getLpBalance,
  getMyPools,
  getMyTokens,
  getTokenDetails,
  updateWithdrawalResult,
  getFeeConfig,
});
