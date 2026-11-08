export const MAX_TIMED_BUY_DELAY_SECONDS = 30;

export function chooseTimedBuyDelaySeconds(minSeconds: number, maxSeconds: number, randomUnit: number): number {
  if (!Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds)
    || minSeconds < 0 || maxSeconds > MAX_TIMED_BUY_DELAY_SECONDS || minSeconds > maxSeconds
    || !Number.isFinite(randomUnit) || randomUnit < 0 || randomUnit >= 1) {
    throw new Error('Timed Buy delay range is invalid');
  }
  return minSeconds + Math.floor(randomUnit * (maxSeconds - minSeconds + 1));
}
