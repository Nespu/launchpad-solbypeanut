import {
  createToken,
  submitTransaction,
  withdrawLiquidity,
  prepareLpBurn,
  prepareLpLock,
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
import { createRateLimit, getRedisClient } from '../middleware/rateLimit';
import { createWalletSessionResolver } from '../controllers/walletAuthController';
import { createWalletAuthService } from '../services/walletAuth';
import { config } from '../utils/config';
import { createPumpToken, submitPumpTokenTransaction } from '../controllers/pumpTokenController';

export const walletAuthService = createWalletAuthService(getRedisClient(), {
  allowedOrigins: config.corsOrigins,
  secureCookies: config.isProduction,
});
export const resolveWalletSession = createWalletSessionResolver(walletAuthService);

export const tokenRouter = createTokenRouter({
  createToken,
  createPumpToken,
  submitPumpTokenTransaction,
  submitTransaction,
  withdrawLiquidity,
  prepareLpBurn,
  prepareLpLock,
  createPool,
  submitPoolTransaction,
  getLpBalance,
  getMyPools,
  getMyTokens,
  getTokenDetails,
  updateWithdrawalResult,
  getFeeConfig,
}, createRateLimit, resolveWalletSession);
