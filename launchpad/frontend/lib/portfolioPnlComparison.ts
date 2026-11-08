export type PortfolioFifoPosition = {
  quoteMint: string;
  quoteDecimals: number;
  tokenDecimals: number | null;
  reconstructedTokenAmountRaw: string;
  knownTokenAmountRaw: string;
  knownCostBasisRaw: string;
  unknownTokenAmountRaw: string;
  incomplete: boolean;
};

export type PortfolioExitValue = {
  quoteMint: string;
  quoteDecimals: number;
  amountOutRaw: string;
};

export type PortfolioActivityCoverage = {
  externalActivityIncomplete: boolean;
  swapsUnavailable: boolean;
  swapsHasMore: boolean;
  withdrawalsUnavailable: boolean;
  withdrawalAmountsApproximate: boolean;
};

export type PortfolioPnlComparison =
  | { status: 'comparable'; quoteMint: string; quoteDecimals: number; differenceRaw: string }
  | { status: 'unavailable'; reason: 'no-position' | 'incomplete-history' | 'incomplete-basis' | 'balance-mismatch' | 'quote-mismatch' | 'invalid-data' };

function isRawInteger(value: string): boolean {
  return /^\d+$/.test(value);
}

export function isPortfolioActivityComplete(coverage: PortfolioActivityCoverage): boolean {
  return !coverage.externalActivityIncomplete
    && !coverage.swapsUnavailable
    && !coverage.swapsHasMore
    && !coverage.withdrawalsUnavailable
    && !coverage.withdrawalAmountsApproximate;
}

/** Compare a full-balance exit quote only when every quoted unit has matching, known FIFO cost. */
export function comparePortfolioExitToFifo(input: {
  currentBalanceRaw: string;
  currentBalanceDecimals: number | null;
  position: PortfolioFifoPosition | null;
  quote: PortfolioExitValue;
  activityComplete: boolean;
}): PortfolioPnlComparison {
  const { currentBalanceRaw, currentBalanceDecimals, position, quote, activityComplete } = input;
  if (!position) return { status: 'unavailable', reason: 'no-position' };
  if (!activityComplete) return { status: 'unavailable', reason: 'incomplete-history' };
  if (position.incomplete || position.unknownTokenAmountRaw !== '0') {
    return { status: 'unavailable', reason: 'incomplete-basis' };
  }
  if (currentBalanceDecimals === null || position.tokenDecimals === null
    || currentBalanceDecimals !== position.tokenDecimals
    || currentBalanceRaw !== position.reconstructedTokenAmountRaw
    || currentBalanceRaw !== position.knownTokenAmountRaw) {
    return { status: 'unavailable', reason: 'balance-mismatch' };
  }
  if (position.quoteMint !== quote.quoteMint || position.quoteDecimals !== quote.quoteDecimals) {
    return { status: 'unavailable', reason: 'quote-mismatch' };
  }
  if (!isRawInteger(currentBalanceRaw) || !isRawInteger(position.knownCostBasisRaw)
    || !isRawInteger(quote.amountOutRaw) || !Number.isInteger(quote.quoteDecimals)
    || quote.quoteDecimals < 0 || quote.quoteDecimals > 18) {
    return { status: 'unavailable', reason: 'invalid-data' };
  }

  return {
    status: 'comparable',
    quoteMint: quote.quoteMint,
    quoteDecimals: quote.quoteDecimals,
    differenceRaw: (BigInt(quote.amountOutRaw) - BigInt(position.knownCostBasisRaw)).toString(),
  };
}
