import test from "node:test";
import assert from "node:assert/strict";
import { liquidityCandidates, liquidityQuoteAcceptable, projectedWorstLossUsd } from "../src/core/liquidity-sizing.js";

test("builds descending liquidity steps within the token cap", () => {
  assert.deepEqual(liquidityCandidates({ requestedUsd: 330, tokenCapUsd: 250, minimumUsd: 50 }), [250, 200, 150, 100, 50]);
});

test("accepts only two-sided ok quotes below the round-trip loss ceiling", () => {
  assert.equal(liquidityQuoteAcceptable({ outbound: { action: "ok" }, returnQuote: { action: "ok" }, roundTripLossBps: 12.8 }, 15), true);
  assert.equal(liquidityQuoteAcceptable({ outbound: { action: "ok" }, returnQuote: { action: "ok" }, roundTripLossBps: 17.2 }, 15), false);
});

test("projects dollar stop risk from size and round-trip loss", () => {
  assert.equal(projectedWorstLossUsd(330, 13, 20), 1.089);
  assert.equal(projectedWorstLossUsd(200, 13, 20), 0.66);
});
