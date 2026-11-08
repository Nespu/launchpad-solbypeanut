export type TokenMovementKind = 'transfer' | 'mint' | 'burn' | 'other';

export type WalletSwapActivity = {
  id: string;
  signature: string;
  mintAddress: string;
  poolAddress: string;
  venue: 'RAYDIUM' | 'RAYDIUM_AMM_V4' | 'RAYDIUM_AMM_STABLE' | 'RAYDIUM_CLMM' | 'PUMP_FUN' | 'PUMP_SWAP';
  side: 'buy' | 'sell';
  tokenAmountRaw: string;
  solAmountLamports: string | null;
  quoteAmountRaw: string | null;
  quoteMint: string;
  quoteDecimals: number;
  tokenDecimals: number;
  slot: string;
  blockTime: string | null;
  networkFeeLamports: string | null;
  createdAt: string;
};

export type WalletTokenMovement = {
  signature: string;
  slot: string;
  blockTime: number | null;
  mintAddress: string;
  decimals: number | null;
  amountRaw: string;
  kind: Exclude<TokenMovementKind, 'other'>;
  counterpartyAddress?: string | null;
  quoteMint?: string;
  quoteDecimals?: number | null;
};

export type WalletTransferBasisLot = {
  signature: string;
  slot: string;
  blockTime: number | null;
  mintAddress: string;
  sourceWalletAddress: string;
  destinationWalletAddress: string;
  quoteMint: string;
  quoteDecimals: number;
  lotIndex: number;
  tokenAmountRaw: string;
  transferAmountRaw: string;
  quoteAmountRaw: string;
};

export type WalletFifoOptions = {
  currentWalletAddress?: string;
  associatedWalletAddresses?: string[];
  incomingTransferBasis?: WalletTransferBasisLot[];
  allowTransferBasisExport?: boolean;
};

export type RealizedSwapGroup = {
  quoteMint: string;
  quoteDecimals: number;
  realizedRaw: string;
  salesWithBasis: number;
  incomplete: boolean;
};

export type OpenPositionBasis = {
  mintAddress: string;
  quoteMint: string;
  quoteDecimals: number;
  tokenDecimals: number | null;
  reconstructedTokenAmountRaw: string;
  knownTokenAmountRaw: string;
  knownCostBasisRaw: string;
  unknownTokenAmountRaw: string;
  incomplete: boolean;
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SAFE_SYSTEM_SETUP_TYPES = new Set(['createaccount', 'createaccountwithseed', 'allocate', 'allocatewithseed', 'assign', 'assignwithseed']);
const SAFE_ASSOCIATED_TOKEN_SETUP_TYPES = new Set(['create', 'createidempotent', 'recovernested']);

export function classifyTokenMovement(transaction: unknown): TokenMovementKind {
  if (!transaction || typeof transaction !== 'object') return 'other';
  const root = transaction as {
    transaction?: { message?: { instructions?: unknown } };
    meta?: { innerInstructions?: unknown };
  };
  const instructions: unknown[] = [];
  if (Array.isArray(root.transaction?.message?.instructions)) instructions.push(...root.transaction.message.instructions);
  if (Array.isArray(root.meta?.innerInstructions)) {
    for (const group of root.meta.innerInstructions) {
      if (group && typeof group === 'object' && Array.isArray((group as { instructions?: unknown }).instructions)) {
        instructions.push(...(group as { instructions: unknown[] }).instructions);
      }
    }
  }
  if (!instructions.length) return 'other';

  const detectedKinds = new Set<TokenMovementKind>();
  let hasUnclassifiedInstruction = false;
  for (const candidate of instructions) {
    if (!candidate || typeof candidate !== 'object') {
      hasUnclassifiedInstruction = true;
      continue;
    }
    const instruction = candidate as { program?: unknown; programId?: unknown; parsed?: unknown };
    const program = typeof instruction.program === 'string' ? instruction.program.toLowerCase() : '';
    const programId = String(instruction.programId ?? '');
    if (programId === COMPUTE_BUDGET_PROGRAM_ID || program === 'compute-budget') continue;

    const parsed = instruction.parsed && typeof instruction.parsed === 'object'
      ? instruction.parsed as { type?: unknown }
      : null;
    const parsedType = typeof parsed?.type === 'string' ? parsed.type.toLowerCase().replace(/[_-]/g, '') : '';
    if (programId === SYSTEM_PROGRAM_ID || program === 'system') {
      if (SAFE_SYSTEM_SETUP_TYPES.has(parsedType)) continue;
      hasUnclassifiedInstruction = true;
      continue;
    }
    if (programId === ASSOCIATED_TOKEN_PROGRAM_ID || program === 'spl-associated-token-account') {
      if (SAFE_ASSOCIATED_TOKEN_SETUP_TYPES.has(parsedType)) continue;
      hasUnclassifiedInstruction = true;
      continue;
    }

    if (!TOKEN_PROGRAM_IDS.has(programId) && program !== 'spl-token' && program !== 'spl-token-2022') {
      hasUnclassifiedInstruction = true;
      continue;
    }
    if (!parsed) {
      hasUnclassifiedInstruction = true;
      continue;
    }

    if (!parsedType) {
      hasUnclassifiedInstruction = true;
      continue;
    }
    const normalizedType = parsedType;
    if (normalizedType === 'transfer' || normalizedType === 'transferchecked' || normalizedType === 'transfercheckedwithfee') {
      detectedKinds.add('transfer');
    } else if (normalizedType === 'mintto' || normalizedType === 'minttochecked') {
      detectedKinds.add('mint');
    } else if (normalizedType === 'burn' || normalizedType === 'burnchecked') {
      detectedKinds.add('burn');
    } else {
      hasUnclassifiedInstruction = true;
    }
  }

  if (hasUnclassifiedInstruction || detectedKinds.size !== 1) return 'other';
  return detectedKinds.values().next().value ?? 'other';
}

export function getOwnedTokenDeltas(
  transaction: unknown,
  walletAddress: string,
): Array<{ mintAddress: string; decimals: number | null; amountRaw: string; counterpartyAddress: string | null }> | null {
  if (!transaction || typeof transaction !== 'object') return null;
  const meta = (transaction as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  const details = meta as { preTokenBalances?: unknown; postTokenBalances?: unknown };
  const totals = new Map<string, Map<string, { amount: bigint; decimals: number | null }>>();
  const mintsWithUnattributedOwners = new Set<string>();
  const applyBalances = (balances: unknown, sign: 1n | -1n) => {
    if (!Array.isArray(balances)) return;
    for (const candidate of balances) {
      if (!candidate || typeof candidate !== 'object') continue;
      const balance = candidate as {
        owner?: unknown;
        mint?: unknown;
        uiTokenAmount?: { amount?: unknown; decimals?: unknown };
      };
      if (typeof balance.mint !== 'string' || typeof balance.uiTokenAmount?.amount !== 'string'
        || !/^\d+$/.test(balance.uiTokenAmount.amount)) continue;
      if (typeof balance.owner !== 'string' || !balance.owner) {
        mintsWithUnattributedOwners.add(balance.mint);
        continue;
      }
      let walletTotals = totals.get(balance.owner);
      if (!walletTotals) {
        walletTotals = new Map();
        totals.set(balance.owner, walletTotals);
      }
      let entry = walletTotals.get(balance.mint);
      if (!entry) {
        entry = { amount: 0n, decimals: Number.isInteger(balance.uiTokenAmount.decimals)
          && (balance.uiTokenAmount.decimals as number) >= 0 && (balance.uiTokenAmount.decimals as number) <= 18
          ? balance.uiTokenAmount.decimals as number : null };
        walletTotals.set(balance.mint, entry);
      }
      if (!Number.isInteger(balance.uiTokenAmount.decimals) || balance.uiTokenAmount.decimals !== entry.decimals) entry.decimals = null;
      entry.amount += sign * BigInt(balance.uiTokenAmount.amount);
    }
  };
  applyBalances(details.preTokenBalances, -1n);
  applyBalances(details.postTokenBalances, 1n);

  const ownedBalances = totals.get(walletAddress);
  if (!ownedBalances) return [];
  const canIdentifyCounterparty = classifyTokenMovement(transaction) === 'transfer';
  return [...ownedBalances.entries()]
    .filter(([, entry]) => entry.amount !== 0n)
    .map(([mintAddress, entry]) => {
      const oppositeOwners = canIdentifyCounterparty && !mintsWithUnattributedOwners.has(mintAddress)
        ? [...totals.entries()].filter(([owner, balances]) => owner !== walletAddress
          && balances.get(mintAddress)?.amount === -entry.amount)
        : [];
      const otherOwnersWithMovement = canIdentifyCounterparty && !mintsWithUnattributedOwners.has(mintAddress)
        ? [...totals.entries()].filter(([owner, balances]) => owner !== walletAddress
          && (balances.get(mintAddress)?.amount ?? 0n) !== 0n)
        : [];
      return {
        mintAddress,
        decimals: entry.decimals,
        amountRaw: entry.amount.toString(),
        counterpartyAddress: oppositeOwners.length === 1 && otherOwnersWithMovement.length === 1
          ? oppositeOwners[0][0]
          : null,
      };
    });
}

export function calculateRecordedSwapResults(
  swaps: WalletSwapActivity[],
  tokenMovements: WalletTokenMovement[],
  swapHistoryIncomplete: boolean,
  externalActivityIncomplete: boolean,
  options: WalletFifoOptions = {},
) {
  const realizedHistoryIncomplete = swapHistoryIncomplete || externalActivityIncomplete;
  type MutableGroup = {
    quoteMint: string;
    quoteDecimals: number | null;
    realizedRaw: bigint;
    salesWithBasis: number;
    incomplete: boolean;
  };
  type Lot = { tokensRemaining: bigint; quoteRemaining: bigint; basisKnown: boolean };
  type FifoEvent = {
    slot: bigint | null;
    timestamp: number;
    signature: string;
    swap?: WalletSwapActivity;
    movement?: WalletTokenMovement;
  };

  const groups = new Map<string, MutableGroup>();
  const transferBasisLots: WalletTransferBasisLot[] = [];
  const openPositionBases: OpenPositionBasis[] = [];
  const transferBasisTransferKeys = new Set<string>();
  const transferLotIndexes = new Map<string, number>();
  const associatedWalletAddresses = new Set(options.associatedWalletAddresses ?? []);
  const incomingTransferBasis = options.incomingTransferBasis ?? [];
  const getGroup = (quoteMint: string) => {
    let group = groups.get(quoteMint);
    if (!group) {
      group = { quoteMint, quoteDecimals: null, realizedRaw: 0n, salesWithBasis: 0, incomplete: false };
      groups.set(quoteMint, group);
    }
    return group;
  };
  const swapsByMint = new Map<string, WalletSwapActivity[]>();
  const movementsByMint = new Map<string, WalletTokenMovement[]>();
  let networkFeeLamports = 0n;
  let networkFeeIncomplete = swapHistoryIncomplete;

  for (const swap of swaps) {
    if (swap.networkFeeLamports === null || !/^\d+$/.test(swap.networkFeeLamports)) networkFeeIncomplete = true;
    else networkFeeLamports += BigInt(swap.networkFeeLamports);
    const rows = swapsByMint.get(swap.mintAddress) ?? [];
    rows.push(swap);
    swapsByMint.set(swap.mintAddress, rows);
  }
  for (const movement of tokenMovements) {
    const rows = movementsByMint.get(movement.mintAddress) ?? [];
    rows.push(movement);
    movementsByMint.set(movement.mintAddress, rows);
  }

  const allTrackedMints = new Set([...swapsByMint.keys(), ...movementsByMint.keys()]);
  for (const mintAddress of allTrackedMints) {
    const rows = swapsByMint.get(mintAddress) ?? [];
    const movements = movementsByMint.get(mintAddress) ?? [];
    const quoteMints = new Set(rows.map((swap) => swap.quoteMint));
    if (rows.length > 0 && quoteMints.size !== 1) {
      for (const quoteMint of quoteMints) {
        const group = getGroup(quoteMint);
        const matchingDecimals = rows.find((swap) => swap.quoteMint === quoteMint)?.quoteDecimals;
        if (group.quoteDecimals === null && Number.isInteger(matchingDecimals) && matchingDecimals >= 0 && matchingDecimals <= 18) {
          group.quoteDecimals = matchingDecimals;
        }
        group.incomplete = true;
      }
      continue;
    }

    const hasSwapHistory = rows.length > 0;
    const movementQuoteMints = new Set(movements.flatMap((movement) => movement.quoteMint ? [movement.quoteMint] : []));
    const quoteMint = rows[0]?.quoteMint ?? (movementQuoteMints.size === 1 ? [...movementQuoteMints][0] ?? SOL_MINT : SOL_MINT);
    const group = getGroup(quoteMint);
    const movementQuoteDecimals = new Set(movements.flatMap((movement) =>
      Number.isInteger(movement.quoteDecimals) && movement.quoteDecimals! >= 0 && movement.quoteDecimals! <= 18
        ? [movement.quoteDecimals as number]
        : [],
    ));
    const movementOnlyQuoteDecimals = group.quoteDecimals
      ?? (movementQuoteDecimals.size === 1 ? [...movementQuoteDecimals][0] : quoteMint === SOL_MINT ? 9 : null);
    const tokenDecimals = new Set(rows.map((swap) => swap.tokenDecimals));
    for (const movement of movements) {
      if (movement.decimals === null || !Number.isInteger(movement.decimals) || movement.decimals < 0 || movement.decimals > 18) {
        group.incomplete = true;
      } else {
        tokenDecimals.add(movement.decimals);
      }
    }
    const quoteDecimals = new Set(rows.map((swap) => swap.quoteDecimals));
    if (!hasSwapHistory) quoteDecimals.add(movementOnlyQuoteDecimals);
    if (tokenDecimals.size !== 1 || quoteDecimals.size !== 1) group.incomplete = true;
    const decimals = rows[0]?.quoteDecimals ?? movementOnlyQuoteDecimals;
    if (!hasSwapHistory && movementQuoteMints.size > 1) group.incomplete = true;
    if (hasSwapHistory && movements.some((movement) => movement.quoteMint && movement.quoteMint !== quoteMint)) group.incomplete = true;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      group.incomplete = true;
      continue;
    }
    if (group.quoteDecimals !== null && group.quoteDecimals !== decimals) {
      group.incomplete = true;
      continue;
    }
    group.quoteDecimals = decimals;
    if (movementQuoteDecimals.size > 0 && !movementQuoteDecimals.has(decimals)) group.incomplete = true;
    if (!hasSwapHistory) group.incomplete = true;

    const events: FifoEvent[] = [
      ...rows.map((swap) => {
        let slot: bigint | null = null;
        try { if (/^\d+$/.test(swap.slot)) slot = BigInt(swap.slot); } catch { slot = null; }
        if (slot === null) group.incomplete = true;
        const parsedTime = new Date(swap.blockTime ?? swap.createdAt).getTime();
        return { slot, timestamp: Number.isFinite(parsedTime) ? parsedTime : 0, signature: swap.signature, swap };
      }),
      ...movements.map((movement) => {
        let slot: bigint | null = null;
        try { if (/^\d+$/.test(movement.slot)) slot = BigInt(movement.slot); } catch { slot = null; }
        if (slot === null) group.incomplete = true;
        return {
          slot,
          timestamp: movement.blockTime === null ? 0 : movement.blockTime * 1000,
          signature: movement.signature,
          movement,
        };
      }),
    ];
    const slotCounts = new Map<string, number>();
    for (const event of events) {
      if (event.slot === null) continue;
      const slot = event.slot.toString();
      slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1);
    }
    const ambiguousSlots = new Set([...slotCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([slot]) => slot));
    if (ambiguousSlots.size > 0) group.incomplete = true;
    if (realizedHistoryIncomplete) group.incomplete = true;
    events.sort((a, b) => {
      if (a.slot !== null && b.slot !== null && a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
      if ((a.slot === null || b.slot === null) && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.signature.localeCompare(b.signature);
    });

    const lots: Lot[] = [];
    const removeFromInventory = (amount: bigint, transferMovement?: WalletTokenMovement) => {
      let tokensToRemove = amount;
      while (tokensToRemove > 0n && lots.length > 0) {
        const lot = lots[0];
        const removed = tokensToRemove < lot.tokensRemaining ? tokensToRemove : lot.tokensRemaining;
        const removedCost = lot.basisKnown
          ? removed === lot.tokensRemaining ? lot.quoteRemaining : (lot.quoteRemaining * removed) / lot.tokensRemaining
          : 0n;
        lot.tokensRemaining -= removed;
        lot.quoteRemaining -= removedCost;
        tokensToRemove -= removed;
        if (removed > 0n && lot.basisKnown && transferMovement?.counterpartyAddress && options.currentWalletAddress) {
          const transferKey = [transferMovement.signature, mintAddress, options.currentWalletAddress, transferMovement.counterpartyAddress, quoteMint].join(':');
          const lotIndex = transferLotIndexes.get(transferKey) ?? 0;
          transferLotIndexes.set(transferKey, lotIndex + 1);
          transferBasisLots.push({
            signature: transferMovement.signature,
            slot: transferMovement.slot,
            blockTime: transferMovement.blockTime,
            mintAddress,
            sourceWalletAddress: options.currentWalletAddress,
            destinationWalletAddress: transferMovement.counterpartyAddress,
            quoteMint,
            quoteDecimals: decimals,
            lotIndex,
            tokenAmountRaw: removed.toString(),
            transferAmountRaw: (-BigInt(transferMovement.amountRaw)).toString(),
            quoteAmountRaw: removedCost.toString(),
          });
        }
        if (lot.tokensRemaining === 0n) lots.shift();
      }
      if (tokensToRemove > 0n) group.incomplete = true;
    };

    for (const event of events) {
      if (event.movement) {
        const movement = event.movement;
        const expectedTokenDecimals = rows[0]?.tokenDecimals ?? (tokenDecimals.size === 1 ? [...tokenDecimals][0] : null);
        if (movement.decimals === null || expectedTokenDecimals === null || movement.decimals !== expectedTokenDecimals
          || !/^-?\d+$/.test(movement.amountRaw) || BigInt(movement.amountRaw) === 0n) {
          group.incomplete = true;
          continue;
        }
        group.incomplete = true;
        const eventOrderAmbiguous = event.slot !== null && ambiguousSlots.has(event.slot.toString());
        const delta = BigInt(movement.amountRaw);
        if ((movement.kind === 'mint' && delta < 0n) || (movement.kind === 'burn' && delta > 0n)) group.incomplete = true;
        if (delta > 0n && !eventOrderAmbiguous && movement.kind === 'transfer' && movement.counterpartyAddress
          && options.currentWalletAddress && associatedWalletAddresses.has(movement.counterpartyAddress)) {
          const matchedLots = incomingTransferBasis.filter((basis) => basis.signature === movement.signature
            && basis.mintAddress === movement.mintAddress
            && basis.sourceWalletAddress === movement.counterpartyAddress
            && basis.destinationWalletAddress === options.currentWalletAddress
            && basis.slot === movement.slot
            && basis.blockTime === movement.blockTime
            && basis.transferAmountRaw === delta.toString()
            && basis.quoteMint === quoteMint
            && basis.quoteDecimals === decimals
            && Number.isInteger(basis.lotIndex) && basis.lotIndex >= 0
            && /^\d+$/.test(basis.tokenAmountRaw) && BigInt(basis.tokenAmountRaw) > 0n
            && /^\d+$/.test(basis.quoteAmountRaw));
          matchedLots.sort((a, b) => a.lotIndex - b.lotIndex);
          const matchedTokens = matchedLots.reduce((sum, basis) => sum + BigInt(basis.tokenAmountRaw), 0n);
          if (matchedTokens <= delta) {
            for (const basis of matchedLots) {
              lots.push({ tokensRemaining: BigInt(basis.tokenAmountRaw), quoteRemaining: BigInt(basis.quoteAmountRaw), basisKnown: true });
            }
            if (delta > matchedTokens) lots.push({ tokensRemaining: delta - matchedTokens, quoteRemaining: 0n, basisKnown: false });
          } else {
            lots.push({ tokensRemaining: delta, quoteRemaining: 0n, basisKnown: false });
          }
        } else if (delta > 0n) {
          lots.push({ tokensRemaining: delta, quoteRemaining: 0n, basisKnown: false });
        } else {
          const destination = movement.kind === 'transfer' && movement.counterpartyAddress
            && associatedWalletAddresses.has(movement.counterpartyAddress)
            ? movement.counterpartyAddress
            : null;
          const canExport = Boolean(destination && options.currentWalletAddress && options.allowTransferBasisExport === true);
          if (canExport && destination && options.currentWalletAddress) {
            transferBasisTransferKeys.add([movement.signature, mintAddress, options.currentWalletAddress, destination, quoteMint].join(':'));
          }
          removeFromInventory(-delta, canExport && !eventOrderAmbiguous ? movement : undefined);
        }
        continue;
      }

      const swap = event.swap;
      if (!swap || swap.quoteMint !== quoteMint || swap.quoteDecimals !== decimals || !Number.isInteger(swap.tokenDecimals) || swap.tokenDecimals < 0 || swap.tokenDecimals > 18
        || swap.quoteAmountRaw === null || !/^\d+$/.test(swap.quoteAmountRaw)
        || !/^\d+$/.test(swap.tokenAmountRaw) || BigInt(swap.tokenAmountRaw) <= 0n || BigInt(swap.quoteAmountRaw) <= 0n
        || (swap.side !== 'buy' && swap.side !== 'sell')) {
        group.incomplete = true;
        continue;
      }

      const tokenAmount = BigInt(swap.tokenAmountRaw);
      const quoteAmount = BigInt(swap.quoteAmountRaw);
      if (swap.side === 'buy') {
        lots.push({ tokensRemaining: tokenAmount, quoteRemaining: quoteAmount, basisKnown: true });
        continue;
      }

      let tokensToMatch = tokenAmount;
      let knownMatchedTokens = 0n;
      let costBasis = 0n;
      while (tokensToMatch > 0n && lots.length > 0) {
        const lot = lots[0];
        const matched = tokensToMatch < lot.tokensRemaining ? tokensToMatch : lot.tokensRemaining;
        const allocatedCost = lot.basisKnown
          ? matched === lot.tokensRemaining ? lot.quoteRemaining : (lot.quoteRemaining * matched) / lot.tokensRemaining
          : 0n;
        lot.tokensRemaining -= matched;
        lot.quoteRemaining -= allocatedCost;
        tokensToMatch -= matched;
        if (lot.basisKnown) {
          knownMatchedTokens += matched;
          costBasis += allocatedCost;
        } else {
          group.incomplete = true;
        }
        if (lot.tokensRemaining === 0n) lots.shift();
      }
      if (tokensToMatch > 0n) group.incomplete = true;
      if (knownMatchedTokens > 0n) {
        const matchedProceeds = (quoteAmount * knownMatchedTokens) / tokenAmount;
        group.realizedRaw += matchedProceeds - costBasis;
        group.salesWithBasis += 1;
      }
    }

    if (rows.some((swap) => swap.networkFeeLamports === null || !/^\d+$/.test(swap.networkFeeLamports))) group.incomplete = true;
    const knownOpenLots = lots.filter((lot) => lot.basisKnown && lot.tokensRemaining > 0n);
    const unknownOpenLots = lots.filter((lot) => !lot.basisKnown && lot.tokensRemaining > 0n);
    const knownTokenAmount = knownOpenLots.reduce((sum, lot) => sum + lot.tokensRemaining, 0n);
    const knownCostBasis = knownOpenLots.reduce((sum, lot) => sum + lot.quoteRemaining, 0n);
    const unknownTokenAmount = unknownOpenLots.reduce((sum, lot) => sum + lot.tokensRemaining, 0n);
    const reconstructedTokenAmount = knownTokenAmount + unknownTokenAmount;
    if (reconstructedTokenAmount > 0n) {
      openPositionBases.push({
        mintAddress,
        quoteMint,
        quoteDecimals: decimals,
        tokenDecimals: tokenDecimals.size === 1 && Number.isInteger([...tokenDecimals][0])
          && [...tokenDecimals][0] >= 0 && [...tokenDecimals][0] <= 18 ? [...tokenDecimals][0] : null,
        reconstructedTokenAmountRaw: reconstructedTokenAmount.toString(),
        knownTokenAmountRaw: knownTokenAmount.toString(),
        knownCostBasisRaw: knownCostBasis.toString(),
        unknownTokenAmountRaw: unknownTokenAmount.toString(),
        incomplete: group.incomplete,
      });
    }

  }

  const realizedSwapGroups: RealizedSwapGroup[] = [...groups.values()]
    .filter((group) => group.quoteDecimals !== null)
    .map((group) => ({
      quoteMint: group.quoteMint,
      quoteDecimals: group.quoteDecimals as number,
      realizedRaw: group.realizedRaw.toString(),
      salesWithBasis: group.salesWithBasis,
      incomplete: group.incomplete,
    }))
    .sort((a, b) => Number(b.quoteMint === SOL_MINT) - Number(a.quoteMint === SOL_MINT) || a.quoteMint.localeCompare(b.quoteMint));

  return {
    realizedSwapGroups,
    realizedHistoryIncomplete: realizedHistoryIncomplete || [...groups.values()].some((group) => group.incomplete),
    networkFeeLamports: networkFeeLamports.toString(),
    networkFeeIncomplete,
    openPositionBases,
    transferBasisLots,
    transferBasisTransferKeys: [...transferBasisTransferKeys],
  };
}
