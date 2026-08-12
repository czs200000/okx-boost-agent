#!/usr/bin/env node
// Multi-token pool grid backtest with dynamic level arming:
//   - Each coin starts with `minLevels` armed buy levels
//   - As a coin fills positions, more levels are armed (min + positions),
//     capped at `maxLevels` — capital flows to the coins actually trading
//   - Shared budget = deployPct of capital across all coins
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.ONCHAINOS_CLI || "onchainos";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const TOKENS = [
  { symbol: "NVDAx", address: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", fee: 0, gas: 0 },
  { symbol: "TSLAx", address: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", fee: 0, gas: 0 },
  { symbol: "OKB", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", fee: 0.0008, gas: 0.01 }
];

const params = {
  from: arg("from", "2026-08-01"),
  to: arg("to", "2026-08-11"),
  bar: arg("bar", "1H"),
  spacingBps: Number(arg("spacing-bps", 30)),
  profitBps: Number(arg("profit-bps", 100)),
  minLevels: Number(arg("min-levels", 2)),
  maxLevels: Number(arg("max-levels", 8)),
  buySlippageBps: Number(arg("buy-slippage-bps", 25)),
  sellSlippageBps: Number(arg("sell-slippage-bps", 25)),
  capital: Number(arg("capital", 1500)),
  deployPct: Number(arg("deploy-pct", 80))
};

async function klines(address) {
  const { stdout } = await execFileAsync(cli, ["market", "kline", "--address", address, "--chain", "xlayer", "--bar", params.bar, "--limit", "299"], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const payload = JSON.parse(stdout);
  return (payload?.data || [])
    .filter(c => Number(c.confirm) === 1)
    .map(c => ({ t: Number(c.ts), h: Number(c.h), l: Number(c.l), c: Number(c.c) }))
    .sort((a, b) => a.t - b.t)
    .filter(c => c.t >= Date.parse(`${params.from}T00:00:00Z`) && c.t < Date.parse(`${params.to}T00:00:00Z`) + 86400000);
}

const spacing = params.spacingBps / 10000;
const profit = params.profitBps / 10000;
const deployUsd = params.capital * params.deployPct / 100;

const all = await Promise.all(TOKENS.map(async t => ({ ...t, candles: await klines(t.address) })));
const n = Math.min(...all.map(t => t.candles.length));
if (n < 2) { console.error("K线数据不足"); process.exit(1); }

// state per token
const state = all.map(t => ({
  ...t,
  mid: t.candles[0].c,
  positions: [], // {level, units, cost, sellPrice}
  armed: params.minLevels,
  realized: 0,
  buys: 0,
  sells: 0,
  volume: 0
}));

let usdt = params.capital;
let totalRealized = 0;

for (let i = 0; i < n; i++) {
  for (const st of state) {
    const candle = st.candles[i];
    // sells first
    for (const pos of [...st.positions]) {
      if (candle.h >= pos.sellPrice) {
        const fillSell = pos.sellPrice * (1 - (st.sellSlippageBps || params.sellSlippageBps) / 10000);
        const proceeds = pos.units * fillSell * (1 - st.fee) - st.gas;
        const pnl = proceeds - pos.cost;
        st.realized += pnl;
        totalRealized += pnl;
        usdt += proceeds;
        st.sells += 1;
        st.volume += pos.units * fillSell;
        st.positions = st.positions.filter(p => p !== pos);
      }
    }
    // buys on armed levels (top-down)
    const levelPrice = l => st.mid * (1 - l * spacing);
    for (let lvl = 1; lvl <= st.armed; lvl++) {
      if (st.positions.some(p => p.level === lvl)) continue;
      const price = levelPrice(lvl);
      if (candle.l <= price) {
        const lotUsd = Math.min(deployUsd / Math.max(1, st.armed * 2), usdt * 0.2);
        if (usdt >= lotUsd && lotUsd > 0) {
          const fillBuy = price * (1 + (st.buySlippageBps || params.buySlippageBps) / 10000);
          const units = lotUsd / (fillBuy * (1 + st.fee));
          st.positions.push({ level: lvl, units, cost: lotUsd, sellPrice: price * (1 + profit) });
          usdt -= lotUsd;
          st.buys += 1;
          st.volume += units * fillBuy;
        }
      }
    }
    // dynamic arming: expand as positions fill, contract when flat
    st.armed = Math.max(params.minLevels, Math.min(params.maxLevels, params.minLevels + st.positions.length));
    // re-anchor when flat and price drifted
    if (st.positions.length === 0 && Math.abs(candle.c / st.mid - 1) > spacing) {
      st.mid = candle.c;
    }
  }
}

console.log("=== 池子动态加档回测 ===");
console.log(`参数: ${TOKENS.map(t => t.symbol).join("+")}, 间距 ${params.spacingBps}bps / 止盈 ${params.profitBps}bps, 基础 ${params.minLevels} 档 → 最多 ${params.maxLevels} 档, 部署 ${params.deployPct}% ($${params.capital})`);
console.log(`行情: ${n} 根 ${params.bar} K线, ${params.from} ~ ${params.to}`);
for (const st of state) {
  console.log(`${st.symbol}: ${st.buys}买/${st.sells}卖, 量 $${Math.round(st.volume)}, 已实现 $${st.realized.toFixed(2)}, 期末持仓 ${st.positions.length} 格`);
}
const endValue = usdt + state.reduce((s, st) => s + st.positions.reduce((a, p) => a + p.cost, 0), 0);
console.log(`合计: 已实现 $${totalRealized.toFixed(2)} (${(totalRealized / params.capital * 100).toFixed(2)}%), 期末现金 $${usdt.toFixed(2)}, 总资产 $${endValue.toFixed(2)}`);
