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
      if (units > 0 && costUsd > 0) lots.set(token, { units, costUsd });
      continue;
    }
    if (trade.action !== "SELL") continue;
    const lot = lots.get(token);
    const soldUnits = Number(trade.quote?.fromAmount || trade.fromAmount || 0);
    const proceedsUsd = Number(trade.quote?.toAmount || trade.amountUsd || 0);
    if (!lot || !(soldUnits > 0) || !(proceedsUsd >= 0)) continue;
    const matchedUnits = Math.min(lot.units, soldUnits);
    const ratio = matchedUnits / soldUnits;
    const allocatedCostUsd = lot.costUsd * (matchedUnits / lot.units);
    const allocatedProceedsUsd = proceedsUsd * ratio;
    const pnlUsd = allocatedProceedsUsd - allocatedCostUsd;
    realizedPnlUsd += pnlUsd;
    realizedLossUsd += Math.max(0, -pnlUsd);
    matchedCloses += 1;
    lot.units -= matchedUnits;
    lot.costUsd -= allocatedCostUsd;
    if (lot.units <= 1e-12) lots.delete(token);
    else lots.set(token, lot);
  }

  return { realizedPnlUsd, realizedLossUsd, matchedCloses };
}
