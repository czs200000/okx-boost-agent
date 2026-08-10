#!/usr/bin/env node
// Backtest the OKB native grid strategy on X Layer over recent candles.
// Model mirrors src/core/grid.js + the maker grid cycle:
//   - N levels, spacingBps apart, +profitBps take-profit per level
//   - ladder allocation (1x -> ladderMax x across levels)
//   - deployPct of starting USDT, 0.08% service fee + gas on sells
//   - re-anchor when flat and price drifts > reanchorBps from mid
// Usage:
//   node scripts/backtest-okb-grid.mjs [--days 3] [--levels 10] [--spacing-bps 50]
//       [--profit-bps 50] [--deploy-pct 90] [--capital 1500]
//       [--fee-rate 0.0008] [--gas-usd 0.01] [--ladder-max 2] [--bar 15m]
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.ONCHAINOS_CLI || "onchainos";
const NATIVE_OKB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const params = {
  mode: arg("mode", "grid"),
  days: Number(arg("days", 3)),
  skipDays: Number(arg("skip-days", 0)),
  from: arg("from", ""),
  to: arg("to", ""),
  bar: arg("bar", "15m"),
  levels: Number(arg("levels", 10)),
  seedLevels: Number(arg("seed-levels", 0)),
  buyLevels: Number(arg("buy-levels", 8)),
  sellLevels: Number(arg("sell-levels", 8)),
  spacingBps: Number(arg("spacing-bps", 50)),
  profitBps: Number(arg("profit-bps", 50)),
  deployPct: Number(arg("deploy-pct", 90)),
  capital: Number(arg("capital", 1500)),
  feeRate: Number(arg("fee-rate", 0.0008)),
  gasUsd: Number(arg("gas-usd", 0.01)),
  ladderMax: Number(arg("ladder-max", 2)),
  reanchorBps: Number(arg("reanchor-bps", 20))
};

const barsPerDay = 24 * 60 / barMinutes(params.bar);
const barsNeeded = Math.max(1, Math.round((params.days + params.skipDays) * barsPerDay));
const fromTs = params.from ? Date.parse(`${params.from}T00:00:00Z`) : 0;
const toTs = params.to ? Date.parse(`${params.to}T00:00:00Z`) + 86400000 : 0;

function barMinutes(bar) {
  const m = /^(\d+)(m|h|H|d|D|w|W)$/.exec(bar);
  if (!m) return 60;
  const n = Number(m[1]);
  return m[2] === "m" ? n : m[2].toLowerCase() === "h" ? n * 60 : n * 1440;
}

async function fetchKlines(limit) {
  const { stdout } = await execFileAsync(
    cli, ["market", "kline", "--address", NATIVE_OKB, "--chain", "xlayer", "--bar", params.bar, "--limit", String(limit)],
    { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }
  );
  const payload = JSON.parse(stdout);
  if (!payload?.ok) throw new Error(payload?.error || "kline fetch failed");
  return (payload.data || [])
    .filter(c => Number(c.confirm) === 1)
    .map(c => ({ ts: Number(c.ts), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), vol: Number(c.vol || 0) }))
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit);
}

function buildGrid(mid, levels, spacingBps, profitBps, deployedUsd, ladderMax) {
  const n = levels.length;
  const weights = levels.map((_, idx) => {
    if (ladderMax <= 1 || n <= 1) return 1;
    return 1 + (idx / (n - 1)) * (ladderMax - 1);
  });
  const total = weights.reduce((s, w) => s + w, 0);
  return levels.map((level, i) => {
    const buyPrice = mid * (1 - ((i + 1) * spacingBps) / 10000);
    return {
      level,
      buyPrice,
      sellPrice: buyPrice * (1 + profitBps / 10000),
      buyUsd: deployedUsd * weights[i] / total,
      position: null
    };
  });
}

function run() {
  if (params.mode === "symmetric") return runSymmetric();
  let mid = null;
  const levels = [];
  let usdt = params.capital;
  let okbReserve = 0.05;
  let okbInventory = 0;
  let grid = null;
  let realized = 0;
  let wins = 0;
  let sells = 0;
  let buys = 0;
  let volume = 0;
  let skippedForUsdt = 0;
  let reanchors = 0;

  for (const candle of candles) {
    if (!grid) {
      grid = buildGrid(
        candle.c,
        Array.from({ length: params.levels }, (_, i) => i + 1),
        params.spacingBps, params.profitBps,
        params.capital * params.deployPct / 100, params.ladderMax
      );
      mid = candle.c;
      continue;
    }

    // Fills within the candle: level order L1 -> LN (price falls through buys,
    // rises through sells).
    for (const level of grid) {
      if (level.position) {
        if (candle.h >= level.sellPrice) {
          const pos = level.position;
          const proceeds = pos.units * level.sellPrice * (1 - params.feeRate) - params.gasUsd;
          const pnl = proceeds - pos.costUsd;
          realized += pnl;
          sells += 1;
          if (pnl > 0) wins += 1;
          volume += pos.units * level.sellPrice;
          usdt += proceeds;
          okbInventory -= pos.units;
          level.position = null;
        }
      } else if (candle.l <= level.buyPrice && level.buyUsd > 0) {
        if (usdt >= level.buyUsd) {
          const units = level.buyUsd / (level.buyPrice * (1 + params.feeRate));
          level.position = { units, costUsd: units * level.buyPrice * (1 + params.feeRate) };
          usdt -= level.buyUsd;
          okbInventory += units;
          buys += 1;
          volume += units * level.buyPrice;
        } else {
          skippedForUsdt += 1;
        }
      }
    }

    // Re-anchor when flat and the price drifted away from the mid.
    const flat = grid.every(l => !l.position);
    if (flat && Math.abs(candle.c / mid - 1) > params.reanchorBps / 10000) {
      const deployedUsd = grid.reduce((s, l) => s + l.buyUsd, 0);
      grid = buildGrid(
        candle.c,
        grid.map(l => l.level),
        params.spacingBps, params.profitBps, deployedUsd, params.ladderMax
      );
      mid = candle.c;
      reanchors += 1;
    }
  }

  const lastPrice = candles.length ? candles[candles.length - 1].c : 0;
  const okbHeld = okbReserve + okbInventory;
  const holdingsValue = okbHeld * lastPrice;
  const unrealized = grid.reduce((s, l) => s + (l.position ? l.position.units * lastPrice - l.position.costUsd : 0), 0);
  const netValue = usdt + holdingsValue;
  const roundTrips = sells;

  console.log("=== OKB 网格回测（原生 OKB / X Layer）===");
  console.log(`参数: ${params.levels} 档 × ${params.spacingBps}bps 间距 / +${params.profitBps}bps 止盈, 部署 ${params.deployPct}% ($${params.capital} 本金), 阶梯 1→${params.ladderMax}, 费率 ${params.feeRate * 100}% + $${params.gasUsd}/笔`);
  console.log(`行情: ${params.days} 天 ${params.bar} K线, ${candles.length} 根, ${new Date(candles[0].ts).toISOString().slice(0, 10)} ~ ${new Date(candles[candles.length - 1].ts).toISOString().slice(0, 10)}`);
  console.log(`价格区间: $${Math.min(...candles.map(c => c.l)).toFixed(2)} ~ $${Math.max(...candles.map(c => c.h)).toFixed(2)} (收盘 ${lastPrice.toFixed(2)})`);
  console.log("--- 结果 ---");
  console.log(`成交: ${buys} 买 / ${sells} 卖 (${roundTrips} 轮), 胜率 ${sells ? (wins / sells * 100).toFixed(1) : "—"}%`);
  console.log(`交易量(双边): $${volume.toFixed(0)}`);
  console.log(`已实现盈亏: $${realized.toFixed(2)}`);
  console.log(`浮动盈亏: $${unrealized.toFixed(2)}`);
  console.log(`净盈亏: $${(realized + unrealized).toFixed(2)} (${((realized + unrealized) / params.capital * 100).toFixed(2)}%)`);
  console.log(`期末: USDT $${usdt.toFixed(2)} + OKB ${okbHeld.toFixed(4)} ($${holdingsValue.toFixed(2)}) = $${netValue.toFixed(2)}`);
  console.log(`网格重锚: ${reanchors} 次, 因 USDT 不足跳过的买入: ${skippedForUsdt} 次`);
}

// Symmetric grid: seed inventory at the start price, buy ladder below and
// sell ladder above (classic grid trading).
function runSymmetric() {
  const deployedUsd = params.capital * params.deployPct / 100;
  const totalLots = params.buyLevels + params.seedLevels;
  const lotUsd = deployedUsd / Math.max(1, totalLots);
  const spacing = params.spacingBps / 10000;
  let mid = candles[0].c;
  let usdt = params.capital;
  let inventory = 0; // units held
  const lotCosts = []; // FIFO queue of lot cost basis (USDT per lot)
  let realized = 0;
  let sells = 0;
  let buys = 0;
  let wins = 0;
  let volume = 0;
  let reanchors = 0;

  // Seed: buy seedLevels lots at the start price.
  const seedUnits = lotUsd / mid;
  usdt -= lotUsd * params.seedLevels;
  inventory += seedUnits * params.seedLevels;
  for (let i = 0; i < params.seedLevels; i++) lotCosts.push(lotUsd);

  for (const candle of candles) {
    // Sells first (price rose through sell levels).
    for (let k = 1; k <= params.sellLevels; k++) {
      const sellPrice = mid * (1 + k * spacing);
      if (lotCosts.length > 0 && candle.h >= sellPrice) {
        const cost = lotCosts.shift();
        const units = cost / mid; // a lot's units at the mid (buy/seed price basis)
        const proceeds = units * sellPrice * (1 - params.feeRate) - params.gasUsd;
        const pnl = proceeds - cost;
        realized += pnl;
        sells += 1;
        if (pnl > 0) wins += 1;
        volume += units * sellPrice;
        usdt += proceeds;
        inventory -= units;
      }
    }
    // Buys (price fell through buy levels).
    for (let k = 1; k <= params.buyLevels; k++) {
      const buyPrice = mid * (1 - k * spacing);
      if (usdt >= lotUsd && candle.l <= buyPrice) {
        const units = lotUsd / buyPrice;
        usdt -= lotUsd;
        inventory += units;
        lotCosts.push(lotUsd);
        buys += 1;
        volume += lotUsd;
      }
    }
    // Re-center when flat.
    if (inventory === 0 && Math.abs(candle.c / mid - 1) > spacing) {
      mid = candle.c;
      reanchors += 1;
    }
  }

  const lastPrice = candles[candles.length - 1].c;
  const endValue = usdt + inventory * lastPrice;
  console.log("=== OKB 对称网格回测（预持仓 + 上下阶梯）===");
  console.log(`参数: 买入 ${params.buyLevels} 格下方 + 卖出 ${params.sellLevels} 格上方 × ${params.spacingBps}bps 间距, 预持仓 ${params.seedLevels} 格, 单格 $${lotUsd.toFixed(2)}, 部署 ${params.deployPct}% ($${params.capital} 本金), 费率 ${params.feeRate * 100}% + $${params.gasUsd}/笔`);
  console.log(`行情: ${candles.length} 根 ${params.bar} K线, ${new Date(candles[0].ts).toISOString().slice(0, 10)} ~ ${new Date(candles[candles.length - 1].ts).toISOString().slice(0, 10)}`);
  console.log(`价格区间: $${Math.min(...candles.map(c => c.l)).toFixed(2)} ~ $${Math.max(...candles.map(c => c.h)).toFixed(2)} (收盘 ${lastPrice.toFixed(2)})`);
  console.log("--- 结果 ---");
  console.log(`成交: ${buys} 买 / ${sells} 卖, 胜率 ${sells ? (wins / sells * 100).toFixed(1) : "—"}%`);
  console.log(`交易量(双边): $${volume.toFixed(0)}`);
  console.log(`已实现盈亏: $${realized.toFixed(2)}`);
  console.log(`净盈亏: $${realized.toFixed(2)} (${(realized / params.capital * 100).toFixed(2)}%)`);
  console.log(`期末: USDT $${usdt.toFixed(2)} + 持仓 ${inventory.toFixed(4)} OKB ($${(inventory * lastPrice).toFixed(2)}) = $${endValue.toFixed(2)}`);
  console.log(`网格重锚: ${reanchors} 次`);
}

let candles;
try {
  const fetchLimit = fromTs
    ? Math.min(299, Math.max(10, Math.ceil((Date.now() - fromTs) / (barMinutes(params.bar) * 60000))))
    : Math.min(barsNeeded, 299);
  candles = await fetchKlines(fetchLimit);
} catch (error) {
  console.error("K线获取失败:", error.message);
  process.exit(1);
}
if (fromTs) candles = candles.filter(c => c.ts >= fromTs);
if (toTs) candles = candles.filter(c => c.ts < toTs);
if (!fromTs && !toTs) {
  if (params.skipDays > 0) {
    const skipBars = Math.round(params.skipDays * barsPerDay);
    candles = candles.slice(0, Math.max(0, candles.length - skipBars));
  }
  candles = candles.slice(-Math.round(params.days * barsPerDay));
}
if (candles.length < 2) {
  console.error("K线数据不足");
  process.exit(1);
}
run();
