// Narrow-range grid market making with AI spacing tuning.
// Pure logic only; I/O (orders, wallet fills, K-lines, AI) lives in server.js.

export function buildGrid({ mid, spacingBps = 50, profitBps = 50, count = 12 }) {
  if (!(mid > 0) || !(count > 0)) return { levels: [], mid: 0, spacingBps, profitBps, count };
  const levels = [];
  for (let i = 1; i <= count; i++) {
    const buyPrice = mid * (1 - (i * spacingBps) / 10000);
    const sellPrice = buyPrice * (1 + profitBps / 10000);
    levels.push({ level: i, buyPrice, sellPrice, buyUsd: 0 });
  }
  return { levels, mid, spacingBps, profitBps, count };
}

export function allocateLevelUsd(grid, deployedUsd, ladderMax = 1) {
  if (!grid?.levels?.length) return grid;
  const n = grid.levels.length;
  const weights = grid.levels.map((_, idx) => {
    if (ladderMax <= 1 || n <= 1) return 1;
    return 1 + (idx / (n - 1)) * (ladderMax - 1);
  });
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  return {
    ...grid,
    levels: grid.levels.map((l, i) => ({ ...l, buyUsd: deployedUsd * weights[i] / totalWeight }))
  };
}

// When the wallet token balance grows, attribute the fill to the highest-price
// unfilled buy level first (the market dips through levels top-down).
export function attributeBuys(levels, positions, deltaUnits) {
  const filled = new Set(positions.map(p => p.level));
  const open = levels
    .filter(l => !filled.has(l.level))
    .sort((a, b) => b.buyPrice - a.buyPrice);
  const fills = [];
  let remaining = deltaUnits;
  for (const level of open) {
    if (remaining <= 0) break;
    const maxUnits = level.buyUsd > 0 ? level.buyUsd / level.buyPrice : 0;
    const take = Math.min(remaining, maxUnits);
    fills.push({ level: level.level, units: take, price: level.buyPrice });
    remaining -= take;
  }
  return { fills, remaining };
}

// When the wallet token balance shrinks, sell the lowest sell-target position
// first (price rises through lower targets before higher ones).
export function attributeSells(positions, deltaUnits) {
  const sorted = [...positions].sort((a, b) => a.sellPrice - b.sellPrice);
  const sells = [];
  let remaining = deltaUnits;
  for (const pos of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, pos.units);
    const unitCost = pos.units > 0 ? pos.costUsd / pos.units : 0;
    sells.push({ level: pos.level, units: take, price: pos.sellPrice, costUsd: take * unitCost });
    remaining -= take;
  }
  return { sells, remaining };
}

// Orders that should exist for the current grid state.
export function nextOrders({ levels, positions, activeOrders, buysPaused = false }) {
  const out = [];
  const filled = new Set(positions.map(p => p.level));
  const activeKey = order => `${order.side}:${order.level}`;
  const active = new Set(activeOrders.map(activeKey));
  for (const level of levels) {
    if (!filled.has(level.level) && !active.has(`buy:${level.level}`) && !buysPaused && level.buyUsd > 0) {
      out.push({ side: "buy", level: level.level, price: level.buyPrice, amountUsd: level.buyUsd });
    }
  }
  for (const pos of positions) {
    if (!active.has(`sell:${pos.level}`)) {
      out.push({ side: "sell", level: pos.level, price: pos.sellPrice, amountToken: pos.units });
    }
  }
  return out;
}

export function gridTotals(positions) {
  return positions.reduce(
    (acc, p) => ({ units: acc.units + p.units, costUsd: acc.costUsd + p.costUsd }),
    { units: 0, costUsd: 0 }
  );
}
