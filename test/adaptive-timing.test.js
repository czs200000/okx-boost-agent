import test from "node:test";
import assert from "node:assert/strict";
import { chooseAdaptiveTiming, summarizeTradeWindow } from "../src/core/adaptive-timing.js";

const timing = { marketPollMs: 30000, decisionMs: 60000, aiAnalysisIntervalMs: 120000 };

test("summarizes volume and unit cost inside a time window", () => {
  const summary = summarizeTradeWindow([
    { at: "2026-08-04T01:30:00Z", amountUsd: 100, economics: { expectedCostUsd: 0.1 } },
    { at: "2026-08-04T00:30:00Z", amountUsd: 500, economics: { expectedCostUsd: 2 } }
  ], Date.parse("2026-08-04T01:00:00Z"), Date.parse("2026-08-04T02:00:00Z"));
  assert.deepEqual(summary, { trades: 1, volumeUsd: 100, costUsd: 0.1, costBps: 10 });
});

test("prefers realized cash loss over fee-only expected cost", () => {
  const summary = summarizeTradeWindow([
    { at: "2026-08-04T01:30:00Z", amountUsd: 100, actualLossUsd: 0.5, economics: { expectedCostUsd: 0.01 } }
  ], Date.parse("2026-08-04T01:00:00Z"), Date.parse("2026-08-04T02:00:00Z"));
  assert.equal(summary.costUsd, 0.5);
  assert.equal(summary.costBps, 50);
});

test("keeps timing when volume improves with healthy cost", () => {
  const result = chooseAdaptiveTiming({ current: { trades: 4, volumeUsd: 500, costBps: 4 }, previous: { trades: 3, volumeUsd: 400, costBps: 5 }, timing });
  assert.equal(result.action, "keep");
  assert.deepEqual(result.nextTiming, timing);
});

test("speeds up when volume stagnates and cost is healthy", () => {
  const result = chooseAdaptiveTiming({ current: { trades: 1, volumeUsd: 100, costBps: 3 }, previous: { trades: 2, volumeUsd: 200, costBps: 4 }, timing });
  assert.equal(result.action, "speed_up");
  assert.equal(result.nextTiming.marketPollMs, 22500);
  assert.equal(result.nextTiming.decisionMs, 45000);
  assert.equal(result.nextTiming.aiAnalysisIntervalMs, 120000);
});

test("slows down when unit cost becomes unhealthy", () => {
  const result = chooseAdaptiveTiming({ current: { trades: 2, volumeUsd: 200, costBps: 20 }, previous: { trades: 2, volumeUsd: 180, costBps: 5 }, timing });
  assert.equal(result.action, "slow");
  assert.equal(result.nextTiming.marketPollMs, 45000);
  assert.equal(result.nextTiming.decisionMs, 90000);
  assert.equal(result.nextTiming.aiAnalysisIntervalMs, 180000);
});
