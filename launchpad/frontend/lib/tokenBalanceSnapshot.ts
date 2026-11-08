export type ParsedTokenBalance = {
  amountRaw: string;
  decimals: number;
};

/** Sum parsed balances from every successfully queried token program by mint. */
export function aggregateParsedTokenBalances(accountGroups: readonly (readonly unknown[])[]) {
  const totals = new Map<string, { amount: bigint; decimals: number }>();

  for (const accounts of accountGroups) {
    for (const candidate of accounts) {
      if (!candidate || typeof candidate !== 'object') throw new Error('Token account response is incomplete.');
      const account = (candidate as { account?: unknown }).account;
      if (!account || typeof account !== 'object') throw new Error('Token account response is incomplete.');
      const data = (account as { data?: unknown }).data;
      if (!data || typeof data !== 'object' || !('parsed' in data)) throw new Error('Token account response is incomplete.');

      const parsedData = data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } } };
      const info = parsedData.parsed?.info;
      const mintAddress = info?.mint;
      const rawAmount = info?.tokenAmount?.amount;
      const decimals = info?.tokenAmount?.decimals;
      if (typeof mintAddress !== 'string' || !mintAddress
        || typeof rawAmount !== 'string' || !/^\d+$/.test(rawAmount)
        || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
        throw new Error('Token account response is incomplete.');
      }

      const current = totals.get(mintAddress);
      if (current && current.decimals !== decimals) throw new Error('Token account decimals do not match.');
      totals.set(mintAddress, {
        amount: (current?.amount ?? 0n) + BigInt(rawAmount),
        decimals: decimals as number,
      });
    }
  }

  return new Map([...totals].map(([mintAddress, balance]) => [mintAddress, {
    amountRaw: balance.amount.toString(),
    decimals: balance.decimals,
  }] satisfies [string, ParsedTokenBalance]));
}
