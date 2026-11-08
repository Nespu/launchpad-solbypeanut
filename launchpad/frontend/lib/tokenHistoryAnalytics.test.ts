import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateRecordedSwapResults,
  classifyTokenMovement,
  getOwnedTokenDeltas,
  type WalletSwapActivity,
  type WalletTokenMovement,
} from './tokenHistoryAnalytics';

const QUOTE_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_MINT = 'TokenMint11111111111111111111111111111111111';
const LP_MINT = 'LpMint11111111111111111111111111111111111111';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOURCE_WALLET = '11111111111111111111111111111111';
const DESTINATION_WALLET = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function swap({
  signature,
  slot,
  side,
  tokenAmountRaw,
  quoteAmountRaw,
}: {
  signature: string;
  slot: string;
  side: 'buy' | 'sell';
  tokenAmountRaw: string;
  quoteAmountRaw: string;
}): WalletSwapActivity {
  return {
    id: signature,
    signature,
    mintAddress: TOKEN_MINT,
    poolAddress: 'Pool111111111111111111111111111111111111111',
    venue: 'RAYDIUM',
    side,
    tokenAmountRaw,
    solAmountLamports: quoteAmountRaw,
    quoteAmountRaw,
    quoteMint: QUOTE_MINT,
    quoteDecimals: 0,
    tokenDecimals: 0,
    slot,
    blockTime: null,
    networkFeeLamports: '0',
    createdAt: new Date(Number(slot) * 1000).toISOString(),
  };
}

function movement({ signature, slot, amountRaw, kind = 'transfer' }: {
  signature: string;
  slot: string;
  amountRaw: string;
  kind?: WalletTokenMovement['kind'];
}): WalletTokenMovement {
  return { signature, slot, blockTime: null, mintAddress: TOKEN_MINT, decimals: 0, amountRaw, kind };
}

function calculate(swaps: WalletSwapActivity[], movements: WalletTokenMovement[] = []) {
  return calculateRecordedSwapResults(swaps, movements, false, movements.length > 0);
}

test('FIFO calculates realized proceeds against known buy lots', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
    swap({ signature: 'sell', slot: '2', side: 'sell', tokenAmountRaw: '4', quoteAmountRaw: '12' }),
  ]);

  assert.equal(result.realizedSwapGroups[0]?.realizedRaw, '4');
  assert.equal(result.realizedSwapGroups[0]?.salesWithBasis, 1);
  assert.equal(result.realizedSwapGroups[0]?.incomplete, false);
});

test('reports the reconstructed open inventory and separates known from unknown basis', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
    swap({ signature: 'sell', slot: '3', side: 'sell', tokenAmountRaw: '4', quoteAmountRaw: '12' }),
  ], [movement({ signature: 'external-transfer', slot: '2', amountRaw: '5' })]);

  assert.deepEqual(result.openPositionBases, [{
    mintAddress: TOKEN_MINT,
    quoteMint: QUOTE_MINT,
    quoteDecimals: 0,
    tokenDecimals: 0,
    reconstructedTokenAmountRaw: '11',
    knownTokenAmountRaw: '6',
    knownCostBasisRaw: '12',
    unknownTokenAmountRaw: '5',
    incomplete: true,
  }]);
});

test('does not report a reconstructed open position after the full inventory is sold', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
    swap({ signature: 'sell', slot: '2', side: 'sell', tokenAmountRaw: '10', quoteAmountRaw: '25' }),
  ]);

  assert.deepEqual(result.openPositionBases, []);
});

test('incoming transfer adds an unknown-basis lot and does not overstate realized PnL', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '2', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
    swap({ signature: 'sell', slot: '3', side: 'sell', tokenAmountRaw: '8', quoteAmountRaw: '16' }),
  ], [movement({ signature: 'incoming-transfer', slot: '1', amountRaw: '5' })]);

  assert.equal(result.realizedSwapGroups[0]?.realizedRaw, '0');
  assert.equal(result.realizedSwapGroups[0]?.salesWithBasis, 1);
  assert.equal(result.realizedSwapGroups[0]?.incomplete, true);
});

test('outgoing transfer consumes earlier lots before a later sale', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
    swap({ signature: 'sell', slot: '3', side: 'sell', tokenAmountRaw: '8', quoteAmountRaw: '24' }),
  ], [movement({ signature: 'outgoing-transfer', slot: '2', amountRaw: '-4' })]);

  assert.equal(result.realizedSwapGroups[0]?.realizedRaw, '6');
  assert.equal(result.realizedSwapGroups[0]?.salesWithBasis, 1);
  assert.equal(result.realizedSwapGroups[0]?.incomplete, true);
});

test('selected vault transfer carries the known FIFO cost to the destination wallet', () => {
  const senderResult = calculateRecordedSwapResults([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
  ], [
    { ...movement({ signature: 'vault-transfer', slot: '2', amountRaw: '-4' }), counterpartyAddress: DESTINATION_WALLET },
  ], false, true, {
    currentWalletAddress: SOURCE_WALLET,
    associatedWalletAddresses: [DESTINATION_WALLET],
    allowTransferBasisExport: true,
  });

  assert.deepEqual(senderResult.transferBasisLots.map(({ tokenAmountRaw, quoteAmountRaw, sourceWalletAddress, destinationWalletAddress }) => ({
    tokenAmountRaw, quoteAmountRaw, sourceWalletAddress, destinationWalletAddress,
  })), [{
    tokenAmountRaw: '4', quoteAmountRaw: '8', sourceWalletAddress: SOURCE_WALLET, destinationWalletAddress: DESTINATION_WALLET,
  }]);

  const receiverResult = calculateRecordedSwapResults([
    swap({ signature: 'receiver-sale', slot: '3', side: 'sell', tokenAmountRaw: '4', quoteAmountRaw: '12' }),
  ], [
    { ...movement({ signature: 'vault-transfer', slot: '2', amountRaw: '4' }), counterpartyAddress: SOURCE_WALLET },
  ], false, true, {
    currentWalletAddress: DESTINATION_WALLET,
    associatedWalletAddresses: [SOURCE_WALLET],
    incomingTransferBasis: senderResult.transferBasisLots,
  });

  assert.equal(receiverResult.realizedSwapGroups[0]?.realizedRaw, '4');
  assert.equal(receiverResult.realizedSwapGroups[0]?.salesWithBasis, 1);
  assert.equal(receiverResult.realizedSwapGroups[0]?.incomplete, true);
});

test('cross-wallet transfer preserves the order of multiple source FIFO lots', () => {
  const senderResult = calculateRecordedSwapResults([
    swap({ signature: 'buy-low-cost', slot: '1', side: 'buy', tokenAmountRaw: '4', quoteAmountRaw: '4' }),
    swap({ signature: 'buy-high-cost', slot: '2', side: 'buy', tokenAmountRaw: '6', quoteAmountRaw: '24' }),
  ], [
    { ...movement({ signature: 'multi-lot-transfer', slot: '3', amountRaw: '-8' }), counterpartyAddress: DESTINATION_WALLET },
  ], false, true, {
    currentWalletAddress: SOURCE_WALLET,
    associatedWalletAddresses: [DESTINATION_WALLET],
    allowTransferBasisExport: true,
  });

  assert.deepEqual(senderResult.transferBasisLots.map(({ lotIndex, tokenAmountRaw, quoteAmountRaw }) => ({
    lotIndex, tokenAmountRaw, quoteAmountRaw,
  })), [
    { lotIndex: 0, tokenAmountRaw: '4', quoteAmountRaw: '4' },
    { lotIndex: 1, tokenAmountRaw: '4', quoteAmountRaw: '16' },
  ]);

  const receiverResult = calculateRecordedSwapResults([
    swap({ signature: 'receiver-sale', slot: '4', side: 'sell', tokenAmountRaw: '6', quoteAmountRaw: '18' }),
  ], [
    { ...movement({ signature: 'multi-lot-transfer', slot: '3', amountRaw: '8' }), counterpartyAddress: SOURCE_WALLET },
  ], false, true, {
    currentWalletAddress: DESTINATION_WALLET,
    associatedWalletAddresses: [SOURCE_WALLET],
    incomingTransferBasis: senderResult.transferBasisLots,
  });

  assert.equal(receiverResult.realizedSwapGroups[0]?.realizedRaw, '6');
  assert.equal(receiverResult.realizedSwapGroups[0]?.salesWithBasis, 1);
});

test('unselected counterparty transfer stays unknown and creates no shared basis record', () => {
  const result = calculateRecordedSwapResults([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
  ], [
    { ...movement({ signature: 'transfer', slot: '2', amountRaw: '-4' }), counterpartyAddress: DESTINATION_WALLET },
  ], false, true, {
    currentWalletAddress: SOURCE_WALLET,
    associatedWalletAddresses: [],
  });

  assert.equal(result.transferBasisLots.length, 0);
});

test('incoming transfer cannot consume more basis than the confirmed received amount', () => {
  const result = calculateRecordedSwapResults([
    swap({ signature: 'sale', slot: '3', side: 'sell', tokenAmountRaw: '4', quoteAmountRaw: '12' }),
  ], [
    { ...movement({ signature: 'transfer', slot: '2', amountRaw: '4' }), counterpartyAddress: SOURCE_WALLET },
  ], false, true, {
    currentWalletAddress: DESTINATION_WALLET,
    associatedWalletAddresses: [SOURCE_WALLET],
    incomingTransferBasis: [{
      signature: 'transfer', mintAddress: TOKEN_MINT, sourceWalletAddress: SOURCE_WALLET,
      destinationWalletAddress: DESTINATION_WALLET, quoteMint: QUOTE_MINT, quoteDecimals: 0,
      slot: '2', blockTime: null, lotIndex: 0, transferAmountRaw: '4',
      tokenAmountRaw: '5', quoteAmountRaw: '10',
    }],
  });

  assert.equal(result.realizedSwapGroups[0]?.realizedRaw, '0');
  assert.equal(result.realizedSwapGroups[0]?.salesWithBasis, 0);
});

test('burn removes inventory without inventing sale proceeds', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
    swap({ signature: 'sell', slot: '3', side: 'sell', tokenAmountRaw: '8', quoteAmountRaw: '24' }),
  ], [movement({ signature: 'burn', slot: '2', amountRaw: '-3', kind: 'burn' })]);

  assert.equal(result.realizedSwapGroups[0]?.realizedRaw, '7');
  assert.equal(result.realizedSwapGroups[0]?.salesWithBasis, 1);
  assert.equal(result.realizedSwapGroups[0]?.incomplete, true);
});

test('sale of only unknown-basis tokens contributes no invented realized profit', () => {
  const result = calculate([
    swap({ signature: 'sell', slot: '2', side: 'sell', tokenAmountRaw: '5', quoteAmountRaw: '50' }),
  ], [movement({ signature: 'mint', slot: '1', amountRaw: '5', kind: 'mint' })]);

  assert.equal(result.realizedSwapGroups[0]?.realizedRaw, '0');
  assert.equal(result.realizedSwapGroups[0]?.salesWithBasis, 0);
  assert.equal(result.realizedSwapGroups[0]?.incomplete, true);
});

test('tracked LP deposits consume underlying lots and record LP shares with unknown basis', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
  ], [
    movement({ signature: 'lp-deposit', slot: '2', amountRaw: '-4' }),
    {
      signature: 'lp-deposit', slot: '2', blockTime: null, mintAddress: LP_MINT,
      decimals: 9, amountRaw: '250', kind: 'transfer',
    },
  ]);

  assert.deepEqual(result.openPositionBases, [
    {
      mintAddress: TOKEN_MINT,
      quoteMint: QUOTE_MINT,
      quoteDecimals: 0,
      tokenDecimals: 0,
      reconstructedTokenAmountRaw: '6',
      knownTokenAmountRaw: '6',
      knownCostBasisRaw: '12',
      unknownTokenAmountRaw: '0',
      incomplete: true,
    },
    {
      mintAddress: LP_MINT,
      quoteMint: QUOTE_MINT,
      quoteDecimals: 0,
      tokenDecimals: 9,
      reconstructedTokenAmountRaw: '250',
      knownTokenAmountRaw: '0',
      knownCostBasisRaw: '0',
      unknownTokenAmountRaw: '250',
      incomplete: true,
    },
  ]);
  assert.equal(result.realizedHistoryIncomplete, true);
});

test('tracked LP withdrawal removes unknown LP shares and adds underlying inventory without assigning cost', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
  ], [
    movement({ signature: 'lp-deposit', slot: '2', amountRaw: '-4' }),
    { signature: 'lp-deposit', slot: '2', blockTime: null, mintAddress: LP_MINT, decimals: 9, amountRaw: '250', kind: 'transfer' },
    { signature: 'lp-withdrawal', slot: '3', blockTime: null, mintAddress: LP_MINT, decimals: 9, amountRaw: '-250', kind: 'transfer' },
    movement({ signature: 'lp-withdrawal', slot: '3', amountRaw: '3' }),
  ]);

  assert.deepEqual(result.openPositionBases, [{
    mintAddress: TOKEN_MINT,
    quoteMint: QUOTE_MINT,
    quoteDecimals: 0,
    tokenDecimals: 0,
    reconstructedTokenAmountRaw: '9',
    knownTokenAmountRaw: '6',
    knownCostBasisRaw: '12',
    unknownTokenAmountRaw: '3',
    incomplete: true,
  }]);
  assert.equal(result.realizedHistoryIncomplete, true);
});

test('movement-only LP inventory retains the registered USDC quote denomination', () => {
  const result = calculateRecordedSwapResults([], [{
    signature: 'usdc-pool-deposit',
    slot: '1',
    blockTime: null,
    mintAddress: LP_MINT,
    decimals: 9,
    amountRaw: '50',
    kind: 'transfer',
    quoteMint: USDC_MINT,
    quoteDecimals: 6,
  }], false, true);

  assert.deepEqual(result.openPositionBases, [{
    mintAddress: LP_MINT,
    quoteMint: USDC_MINT,
    quoteDecimals: 6,
    tokenDecimals: 9,
    reconstructedTokenAmountRaw: '50',
    knownTokenAmountRaw: '0',
    knownCostBasisRaw: '0',
    unknownTokenAmountRaw: '50',
    incomplete: true,
  }]);
});

test('same-slot swap and token movement keep the estimate explicitly partial', () => {
  const result = calculate([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
    swap({ signature: 'sell', slot: '2', side: 'sell', tokenAmountRaw: '4', quoteAmountRaw: '12' }),
  ], [movement({ signature: 'same-slot-transfer', slot: '2', amountRaw: '1' })]);

  assert.equal(result.realizedSwapGroups[0]?.incomplete, true);
});

test('classifies parsed transfer instructions plus safe setup instructions', () => {
  assert.equal(classifyTokenMovement({
    transaction: { message: { instructions: [
      { program: 'compute-budget', programId: 'ComputeBudget111111111111111111111111111111' },
      { program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'createAccount', info: {} } },
      { program: 'spl-associated-token-account', programId: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', parsed: { type: 'createIdempotent', info: {} } },
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'transferChecked', info: {} } },
    ] } },
    meta: { innerInstructions: [] },
  }), 'transfer');
  assert.equal(classifyTokenMovement({
    transaction: { message: { instructions: [] } },
    meta: { innerInstructions: [{ instructions: [
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'mintTo', info: {} } },
    ] }] },
  }), 'mint');
  assert.equal(classifyTokenMovement({
    transaction: { message: { instructions: [
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'burnChecked', info: {} } },
    ] } },
    meta: { innerInstructions: [] },
  }), 'burn');
});

test('does not call a token delta a simple transfer when another program is involved', () => {
  assert.equal(classifyTokenMovement({
    transaction: { message: { instructions: [
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'transfer', info: {} } },
      { program: 'unknown-dex', programId: 'Dex111111111111111111111111111111111111111' },
    ] } },
    meta: { innerInstructions: [] },
  }), 'other');
});

test('attributes exact opposite Devnet token deltas to one transfer counterparty', () => {
  const transaction = {
    transaction: { message: { instructions: [
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'transferChecked', info: {} } },
    ] } },
    meta: {
      preTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '10', decimals: 0 } },
        { owner: DESTINATION_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '2', decimals: 0 } },
      ],
      postTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '6', decimals: 0 } },
        { owner: DESTINATION_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '6', decimals: 0 } },
      ],
    },
  };

  assert.deepEqual(getOwnedTokenDeltas(transaction, SOURCE_WALLET), [{
    mintAddress: TOKEN_MINT, decimals: 0, amountRaw: '-4', counterpartyAddress: DESTINATION_WALLET,
  }]);
  assert.deepEqual(getOwnedTokenDeltas(transaction, DESTINATION_WALLET), [{
    mintAddress: TOKEN_MINT, decimals: 0, amountRaw: '4', counterpartyAddress: SOURCE_WALLET,
  }]);
});

test('does not infer one counterparty when same-mint transfer deltas are ambiguous', () => {
  const transaction = {
    transaction: { message: { instructions: [
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'transfer', info: {} } },
    ] } },
    meta: {
      preTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '10', decimals: 0 } },
        { owner: DESTINATION_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '0', decimals: 0 } },
        { owner: '11111111111111111111111111111112', mint: TOKEN_MINT, uiTokenAmount: { amount: '0', decimals: 0 } },
      ],
      postTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '6', decimals: 0 } },
        { owner: DESTINATION_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '4', decimals: 0 } },
        { owner: '11111111111111111111111111111112', mint: TOKEN_MINT, uiTokenAmount: { amount: '4', decimals: 0 } },
      ],
    },
  };

  assert.equal(getOwnedTokenDeltas(transaction, SOURCE_WALLET)?.[0]?.counterpartyAddress, null);
});

test('a SOL payment alongside an SPL transfer is not treated as an internal wallet transfer', () => {
  const transaction = {
    transaction: { message: { instructions: [
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'transferChecked', info: {} } },
      { program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: {} } },
    ] } },
    meta: {
      preTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '10', decimals: 0 } },
        { owner: DESTINATION_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '2', decimals: 0 } },
      ],
      postTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '6', decimals: 0 } },
        { owner: DESTINATION_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '6', decimals: 0 } },
      ],
    },
  };

  assert.equal(classifyTokenMovement(transaction), 'other');
  assert.equal(getOwnedTokenDeltas(transaction, SOURCE_WALLET)?.[0]?.counterpartyAddress, null);
});

test('does not infer a counterparty when RPC omits another owner for the mint', () => {
  const transaction = {
    transaction: { message: { instructions: [
      { program: 'spl-token', programId: TOKEN_PROGRAM, parsed: { type: 'transfer', info: {} } },
    ] } },
    meta: {
      preTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '10', decimals: 0 } },
        { mint: TOKEN_MINT, uiTokenAmount: { amount: '2', decimals: 0 } },
      ],
      postTokenBalances: [
        { owner: SOURCE_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '6', decimals: 0 } },
        { owner: DESTINATION_WALLET, mint: TOKEN_MINT, uiTokenAmount: { amount: '6', decimals: 0 } },
      ],
    },
  };

  assert.equal(getOwnedTokenDeltas(transaction, SOURCE_WALLET)?.[0]?.counterpartyAddress, null);
});

test('same-slot transfer never exports FIFO basis because transaction order is ambiguous', () => {
  const result = calculateRecordedSwapResults([
    swap({ signature: 'buy', slot: '1', side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20' }),
  ], [
    { ...movement({ signature: 'same-slot-transfer', slot: '1', amountRaw: '-4' }), counterpartyAddress: DESTINATION_WALLET },
  ], false, true, {
    currentWalletAddress: SOURCE_WALLET,
    associatedWalletAddresses: [DESTINATION_WALLET],
    allowTransferBasisExport: true,
  });

  assert.equal(result.transferBasisLots.length, 0);
  assert.equal(result.realizedHistoryIncomplete, true);
});
