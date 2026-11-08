export function isWalletActivityCoveragePartial(input: {
  signatureBacklogCount: number;
  sourceHasMore: boolean;
  signatureScanIncomplete: boolean;
  transactionDetailsUnavailable: boolean;
}): boolean {
  return input.signatureBacklogCount > 0
    || input.sourceHasMore
    || input.signatureScanIncomplete
    || input.transactionDetailsUnavailable;
}
