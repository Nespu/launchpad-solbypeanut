export type LiquidityPositionReserve = {
  mintAddress: string;
  symbol: string;
  decimals: number;
  reserveRaw: string;
};

export type LiquidityPositionUnderlyingAmount = LiquidityPositionReserve & {
  amountRaw: string;
};

function parseUnsignedInteger(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('Liquidity position amounts must be unsigned integers.');
  return BigInt(value);
}

/** Calculate the pro-rata reserve quantities represented by a fungible LP balance. */
export function calculateLiquidityPositionAmounts(input: {
  lpAmountRaw: string;
  lpSupplyRaw: string;
  reserves: [LiquidityPositionReserve, LiquidityPositionReserve];
}): LiquidityPositionUnderlyingAmount[] {
  const lpAmount = parseUnsignedInteger(input.lpAmountRaw);
  const lpSupply = parseUnsignedInteger(input.lpSupplyRaw);
  if (lpAmount <= 0n || lpSupply <= 0n || lpAmount > lpSupply) {
    throw new Error('The LP balance must be positive and cannot exceed total LP supply.');
  }

  return input.reserves.map((reserve) => {
    const reserveAmount = parseUnsignedInteger(reserve.reserveRaw);
    if (!Number.isInteger(reserve.decimals) || reserve.decimals < 0 || reserve.decimals > 18) {
      throw new Error('Pool asset decimals are invalid.');
    }
    if (!reserve.mintAddress || !reserve.symbol.trim()) {
      throw new Error('Pool asset identity is incomplete.');
    }
    return {
      ...reserve,
      amountRaw: ((reserveAmount * lpAmount) / lpSupply).toString(),
    };
  });
}
