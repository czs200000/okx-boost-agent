import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk } from "../src/core/risk.js";
import { autonomousPlan, deterministicPlan } from "../src/core/strategy.js";
import { assessTradeEconomics } from "../src/core/economics.js";
import { AgenticWalletExecutor } from "../src/executors/agentic.js";

const limits = {
  totalCapitalUsd: 1000,
  maxTradeUsd: 50,
  maxTotalRwaExposurePct: 30,
  maxTokenPositionPct: 10,
  maxSlippageBps: 15,
  dailyLossLimitPct: 2,
  maxTradesPerHour: 6
};

test("strategy buys a sufficiently discounted token", () => {
  const plan = deterministicPlan({ tokens: { NVDAx: { deviationBps: -40, slippageBps: 6 } } }, limits);
  assert.equal(plan.action, "BUY");
  assert.equal(plan.token, "NVDAx");
});

test("risk blocks execution before attribution verification", () => {
  const result = evaluateRisk(
    { action: "BUY", amountUsd: 25, maxSlippageBps: 10 },
    { attributionVerified: false, campaignActive: true, dailyPnlUsd: 0, tradesLastHour: 0, rwaExposurePct: 0 },
    limits
  );
  assert.equal(result.approved, false);
  assert.ok(result.reasons.includes("campaign_attribution_unverified"));
});

test("risk approves an in-policy attributed trade", () => {
  const result = evaluateRisk(
    { action: "SELL", amountUsd: 25, maxSlippageBps: 10 },
    { attributionVerified: true, campaignActive: true, dailyPnlUsd: 0, tradesLastHour: 0, rwaExposurePct: 10 },
    limits
  );
  assert.equal(result.approved, true);
});

test("zero disables hourly and daily loss limits", () => {
  const result = evaluateRisk(
    { action: "BUY", amountUsd: 20, maxSlippageBps: 10 },
    {
      attributionVerified: true, campaignActive: true, dailyPnlUsd: -100,
      tradesLastHour: 999, rwaExposurePct: 10, tokenPositionPct: 10,
      boostVolumeUsd: 10, targetVolumeUsd: 650, tradingCostsUsd: 0, maxCampaignCostsUsd: 10
    },
    { ...limits, maxTradeUsd: 20, dailyLossLimitPct: 0, maxTradesPerHour: 0, maxTokenPositionPct: 80 }
  );
  assert.equal(result.approved, true);
});

test("reaching the reference volume does not stop trading", () => {
  const result = evaluateRisk(
    { action: "BUY", amountUsd: 20, maxSlippageBps: 10 },
    {
      attributionVerified: true, campaignActive: true, dailyPnlUsd: 0,
      tradesLastHour: 10, rwaExposurePct: 10, tokenPositionPct: 10,
      boostVolumeUsd: 700, targetVolumeUsd: 650, tradingCostsUsd: 1, maxCampaignCostsUsd: 10
    },
    { ...limits, maxTradeUsd: 20, dailyLossLimitPct: 0, maxTradesPerHour: 0, maxTokenPositionPct: 80 }
  );
  assert.equal(result.approved, true);
});

test("broadcast cooldown blocks a new entry but never delays an exit", () => {
  const state = {
    attributionVerified: true, campaignActive: true, dailyPnlUsd: 0,
    tradesLastHour: 1, rwaExposurePct: 10, tokenPositionPct: 10,
    tradingCostsUsd: 0, maxCampaignCostsUsd: 10,
    lastBroadcastAt: new Date().toISOString()
  };
  const configured = { ...limits, minBroadcastIntervalMs: 60000 };
  const buy = evaluateRisk({ action: "BUY", amountUsd: 20, maxSlippageBps: 10, reason: "entry" }, state, configured);
  const exit = evaluateRisk({ action: "SELL", amountUsd: 20, maxSlippageBps: 10, reason: "Exit stop loss" }, state, configured);
  assert.ok(buy.reasons.includes("broadcast_cooldown"));
  assert.equal(exit.approved, true);
});

test("autonomous strategy exits a position at its stop loss", () => {
  const plan = autonomousPlan(
    { prices: { NVDAx: 99 }, wallet: { assets: [] } },
    { position: { token: "NVDAx", amount: 0.1, entryPrice: 100, openedAt: new Date().toISOString() }, priceHistory: {} },
    { tradeUsd: 15, maxSlippageBps: 15, takeProfitBps: 22, stopLossBps: 35, maxPositionMinutes: 45, minSignalBps: 18 }
  );
  assert.equal(plan.action, "SELL");
  assert.match(plan.reason, /Stop loss/);
});

test("autonomous strategy waits for enough price history", () => {
  const plan = autonomousPlan(
    { prices: { NVDAx: 100, SNDKx: 100, SPCXx: 100 }, wallet: { assets: [] } },
    { position: null, priceHistory: {} },
    { tradeUsd: 15, maxSlippageBps: 15, takeProfitBps: 22, stopLossBps: 35, maxPositionMinutes: 45, minSignalBps: 18 }
  );
  assert.equal(plan.action, "HOLD");
});

test("autonomous strategy rejects a discount that is still trending down", () => {
  const plan = autonomousPlan(
    { prices: { NVDAx: 98, SNDKx: 100, SPCXx: 100 }, wallet: { assets: [] } },
    { position: null, priceHistory: { NVDAx: [{ price: 100 }, { price: 99.5 }, { price: 99 }, { price: 98 }] } },
    { tradeUsd: 50, maxSlippageBps: 15, takeProfitBps: 10, stopLossBps: 20, maxPositionMinutes: 10, minSignalBps: 5, maxEntryDowntrendBps: 5 }
  );
  assert.equal(plan.action, "HOLD");
});

test("expired positions become breakeven probes instead of forced exits", () => {
  const plan = autonomousPlan(
    { prices: { NVDAx: 100 }, wallet: { assets: [] } },
    { position: { token: "NVDAx", amount: 1, entryPrice: 100, openedAt: new Date(Date.now() - 11 * 60000).toISOString() }, priceHistory: {} },
    { tradeUsd: 50, maxSlippageBps: 15, takeProfitBps: 10, stopLossBps: 20, maxPositionMinutes: 10, minSignalBps: 5 }
  );
  assert.equal(plan.action, "SELL");
  assert.match(plan.reason, /Breakeven probe/);
});

test("reward-adjusted economics accepts a low-cost genuine edge", () => {
  const result = assessTradeEconomics(
    { action: "BUY", amountUsd: 15, expectedEdgeBps: 12, reason: "mean reversion" },
    { priceImpactPct: 0.03, tradeFeeUsd: 0.001 },
    { targetVolumeUsd: 650, boostVolumeUsd: 5, maxCampaignCostsUsd: 10, tradingCostsUsd: 0 },
    { maxExecutionCostBps: 150, maxEffectiveCostBps: 5, maxRewardSubsidyBps: 150, minNetEdgeBps: 1 }
  );
  assert.equal(result.approved, true);
});

test("reward-adjusted economics rejects expensive volume", () => {
  const result = assessTradeEconomics(
    { action: "BUY", amountUsd: 15, expectedEdgeBps: 2, reason: "weak signal" },
    { priceImpactPct: 2, tradeFeeUsd: 0.02 },
    { targetVolumeUsd: 650, boostVolumeUsd: 5, maxCampaignCostsUsd: 10, tradingCostsUsd: 0 },
    { maxExecutionCostBps: 150, maxEffectiveCostBps: 5, maxRewardSubsidyBps: 150, minNetEdgeBps: 1 }
  );
  assert.equal(result.approved, false);
});

test("risk exits are never trapped by the profit economics gate", () => {
  const result = assessTradeEconomics(
    { action: "SELL", amountUsd: 330, expectedEdgeBps: 35, reason: "Stop loss SPCXx" },
    { priceImpactPct: 0.08, tradeFeeUsd: 0.001 },
    { targetVolumeUsd: 8000, boostVolumeUsd: 6500, maxCampaignCostsUsd: 10, tradingCostsUsd: 9.9 },
    { maxExecutionCostBps: 5, maxEffectiveCostBps: 1, maxRewardSubsidyBps: 0, minNetEdgeBps: 1 }
  );
  assert.equal(result.approved, true);
});

test("breakeven probes still require positive economics", () => {
  const result = assessTradeEconomics(
    { action: "SELL", amountUsd: 330, expectedEdgeBps: 0, reason: "Breakeven probe NVDAx" },
    { priceImpactPct: 0.08, tradeFeeUsd: 0.001 },
    { targetVolumeUsd: 8000, boostVolumeUsd: 6500, maxCampaignCostsUsd: 10, tradingCostsUsd: 0 },
    { maxExecutionCostBps: 5, maxEffectiveCostBps: 1, maxRewardSubsidyBps: 0, minNetEdgeBps: 1 }
  );
  assert.equal(result.approved, false);
});

test("favorable price impact never creates negative trading cost", () => {
  const result = assessTradeEconomics(
    { action: "BUY", amountUsd: 20, expectedEdgeBps: 10, reason: "signal" },
    { priceImpactPct: -0.1, tradeFeeUsd: 0 },
    { targetVolumeUsd: 650, boostVolumeUsd: 50, maxCampaignCostsUsd: 10, tradingCostsUsd: 0 },
    { maxExecutionCostBps: 150, maxEffectiveCostBps: 5, maxRewardSubsidyBps: 150, minNetEdgeBps: 1 }
  );
  assert.equal(result.expectedCostUsd, 0);
});

test("sell amount is rounded down below the wallet balance", () => {
  const executor = new AgenticWalletExecutor({ tokens: { NVDAx: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d" } });
  const pair = executor.resolve(
    { action: "SELL", token: "NVDAx", amountUsd: 10 },
    { prices: { NVDAx: 200 }, wallet: { assets: [{ tokenAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", balance: "0.024753336649506561" }] } }
  );
  assert.ok(Number(pair.amount) <= 0.024753336649506561);
  assert.equal(pair.amount, "0.024753336649");
});
