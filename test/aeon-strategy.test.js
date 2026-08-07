import test from "node:test";
import assert from "node:assert/strict";
import { aeonPlan } from "../src/core/strategy.js";

const settings = {
  maxTradeUsd: 150,
  maxExposureUsd: 400,
  entryDipBps: 30,
  exitGainBps: 100,
  gridSpacingBps: 60,
  maxGridLots: 1,
  maxOpenLots: 1,
  maxRoundTripLossBps: 40,
  minEntryNetEdgeBps: 15,
  minBidTrendBps: -5,
  maxQuoteAgeMs: 90000,
  minSamples: 3,
  sampleWindow: 24,
  maxSlippageBps: 20
};

const now = Date.now();
const history = (ask, bid, samples = 8, roundTripLossBps = 20) => Array.from({ length: samples }, (_, index) => ({
  at: new Date(now - (samples - index) * 5000).toISOString(),
  amountUsd: 150,
  askUnitUsd: ask,
  bidUnitUsd: bid,
  roundTripLossBps,
  gasUsdPerSwap: 0.4
}));

test("aeon holds until enough quote samples exist", () => {
  const plan = aeonPlan({}, { executableQuoteHistory: { AEON: history(1.0, 0.999, 2) }, positionLots: {} }, settings);
  assert.equal(plan.action, "HOLD");
});

test("aeon buys a discounted ask below the entry dip", () => {
  const state = {
    executableQuoteHistory: { AEON: history(1.0, 0.999, 8) },
    positionLots: {}
  };
  // Latest ask is ~3.3% below the rolling mean of the prior asks, with a
  // recovering bid (not a freefall), clearing the net-edge floor.
  const plan = aeonPlan({}, {
    ...state,
    executableQuoteHistory: {
      AEON: [
        ...history(1.05, 1.047, 7, 10),
        { at: new Date(now).toISOString(), amountUsd: 150, askUnitUsd: 1.01, bidUnitUsd: 1.05, roundTripLossBps: 10, gasUsdPerSwap: 0.4 }
      ]
    }
  }, settings);
  assert.equal(plan.action, "BUY");
  assert.equal(plan.token, "AEON");
  assert.equal(plan.amountUsd, 150);
});

test("aeon sells a lot when the executable bid clears the exit gain", () => {
  const lot = {
    id: "lot-1", token: "AEON", amount: 100, entryCostUsd: 150,
    entryAskUnitUsd: 1.5, openedAt: new Date(now - 600000).toISOString()
  };
  const plan = aeonPlan({}, {
    executableQuoteHistory: { AEON: history(1.62, 1.62, 8) },
    positionLots: { AEON: [lot] }
  }, settings);
  assert.equal(plan.action, "SELL");
  assert.equal(plan.lotId, "lot-1");
});

test("aeon triggers a stop-loss exit before the price falls further", () => {
  const lot = {
    id: "lot-1", token: "AEON", amount: 100, entryCostUsd: 150,
    entryAskUnitUsd: 1.5, openedAt: new Date(now - 600000).toISOString()
  };
  const plan = aeonPlan({}, {
    executableQuoteHistory: { AEON: history(1.2, 1.2, 8) },
    positionLots: { AEON: [lot] }
  }, settings);
  assert.equal(plan.action, "SELL");
  assert.equal(plan.lotId, "lot-1");
  assert.match(plan.reason, /stop loss/i);
});

test("aeon blocks a new entry when the exposure cap is reached", () => {
  const lot = {
    id: "lot-1", token: "AEON", amount: 100, entryCostUsd: 400,
    entryAskUnitUsd: 4.0, openedAt: new Date(now - 600000).toISOString()
  };
  const plan = aeonPlan({}, {
    executableQuoteHistory: { AEON: history(3.95, 3.95, 8) },
    positionLots: { AEON: [lot] }
  }, settings);
  assert.equal(plan.action, "HOLD");
});
