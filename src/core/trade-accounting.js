export function reconcileTradeAccounting(trades) {
  const lots = new Map();
  let realizedPnlUsd = 0;
  let realizedLossUsd = 0;
  let matchedCloses = 0;

  for (const trade of [...(trades || [])].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const token = trade.token;
    if (!token) continue;
    if (trade.action === "BUY") {
      const units = Number(trade.quote?.toAmount || trade.toAmount || 0);
      const costUsd = Number(trade.quote?.fromAmount || trade.amountUsd || 0);
      if (units > 0 && costUsd > 0) {
        const tokenLots = lots.get(token) || [];
        tokenLots.push({ units, costUsd });
        lots.set(token, tokenLots);
      }
      continue;
    }
    if (trade.action !== "SELL") continue;
    const tokenLots = lots.get(token) || [];
    const soldUnits = Number(trade.quote?.fromAmount || trade.fromAmount || 0);
    const proceedsUsd = Number(trade.quote?.toAmount || trade.amountUsd || 0);
    if (!tokenLots.length || !(soldUnits > 0) || !(proceedsUsd >= 0)) continue;
    let remainingUnits = soldUnits;
    let matchedUnitsTotal = 0;
    let allocatedCostUsdTotal = 0;
    while (remainingUnits > 1e-12 && tokenLots.length) {
      const lot = tokenLots[0];
      const matchedUnits = Math.min(lot.units, remainingUnits);
      const allocatedCostUsd = lot.costUsd * (matchedUnits / lot.units);
      matchedUnitsTotal += matchedUnits;
      allocatedCostUsdTotal += allocatedCostUsd;
      lot.units -= matchedUnits;
      lot.costUsd -= allocatedCostUsd;
      remainingUnits -= matchedUnits;
      if (lot.units <= 1e-12) tokenLots.shift();
    }
    if (matchedUnitsTotal > 0) {
      const allocatedProceedsUsd = proceedsUsd * (matchedUnitsTotal / soldUnits);
      const pnlUsd = allocatedProceedsUsd - allocatedCostUsdTotal;
      realizedPnlUsd += pnlUsd;
      realizedLossUsd += Math.max(0, -pnlUsd);
      matchedCloses += 1;
    }
    if (tokenLots.length) lots.set(token, tokenLots);
    else lots.delete(token);
  }

  return { realizedPnlUsd, realizedLossUsd, matchedCloses };
}
