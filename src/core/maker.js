// Maker rotation logic for the X Layer RWA competition, modeled on the
// top-200 leaderboard pattern: one token, strict BUY/SELL alternation,
// short order life, inventory neutral, small trigger offsets around mid.

export function makerDecision({
  price,
  inventoryUnits = 0,
  inventoryUsd = 0,
  usdtBalanceUsd = 0,
  activeOrder = false,
  pauseWindow = false,
  maxInventoryUsd = 240,
  legUsd = 200,
  buyTriggerBps = 3,
  sellTriggerBps = 3,
  fastExitTriggerBps = 2,
  stopLossBps = 15,
  inventorySince = 0,
  now = Date.now(),
  maxHoldMs = 120000,
  entryPrice = 0,
  minSellUsd = 1
}) {
  if (!Number.isFinite(price) || !(price > 0)) {
    return { action: "HOLD", reason: "no executable price" };
  }
  if (pauseWindow) {
    return { action: "HOLD", reason: "maintenance pause window" };
  }
  if (activeOrder) {
    return { action: "HOLD", reason: "order already active" };
  }
  if (inventoryUsd < 1 && usdtBalanceUsd >= legUsd) {
    return {
      action: "BUY",
      triggerPrice: price * (1 - Number(buyTriggerBps) / 10000),
      amountUsd: Math.min(legUsd, usdtBalanceUsd),
      amountToken: null,
      reason: `flat inventory, buy trigger ${buyTriggerBps} bps below mid`
    };
  }
  if (inventoryUsd >= minSellUsd && inventoryUnits > 0) {
    const heldMs = inventorySince > 0 ? now - inventorySince : 0;
    const lossBps = entryPrice > 0 ? (price / entryPrice - 1) * 10000 : Infinity;
    if (lossBps <= -Number(stopLossBps)) {
      return {
        action: "SELL",
        triggerPrice: price * (1 - 1 / 10000),
        amountUsd: null,
        amountToken: inventoryUnits,
        reason: `stop-loss exit: ${lossBps.toFixed(1)} bps below cost ${entryPrice.toFixed(4)}`,
        fastExit: true
      };
    }
    if (heldMs >= Number(maxHoldMs)) {
      return {
        action: "SELL",
        triggerPrice: price * (1 - Number(fastExitTriggerBps) / 10000),
        amountUsd: null,
        amountToken: inventoryUnits,
        reason: `stale inventory ${(heldMs / 1000).toFixed(0)}s — fast exit ${fastExitTriggerBps} bps below mid`,
        fastExit: true
      };
    }
    return {
      action: "SELL",
      triggerPrice: price * (1 + Number(sellTriggerBps) / 10000),
      amountUsd: null,
      amountToken: inventoryUnits,
      reason: `inventory $${inventoryUsd.toFixed(2)}, sell trigger ${sellTriggerBps} bps above mid`
    };
  }
  return {
    action: "HOLD",
    reason: inventoryUsd < 1
      ? `insufficient quote balance ($${usdtBalanceUsd.toFixed(2)} < $${legUsd})`
      : "inventory within tolerance"
  };
}

export function shouldCancelMakerOrder({
  placedAt = 0,
  now = Date.now(),
  orderTtlMs = 15000,
  price = 0,
  triggerPrice = 0,
  priceDriftGuardBps = 25
}) {
  const stale = placedAt > 0 && now - placedAt > Number(orderTtlMs);
  const drifted = price > 0 && triggerPrice > 0
    && Math.abs(price / triggerPrice - 1) * 10000 > Number(priceDriftGuardBps);
  return { stale, drifted, cancel: stale || drifted };
}
