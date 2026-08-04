import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTradeAccounting } from "../src/core/trade-accounting.js";

test("partial exits allocate entry cost and do not create a false loss", () => {
  const result = reconcileTradeAccounting([
    { at: "2026-08-04T00:00:00Z", action: "BUY", token: "NVDAx", quote: { fromAmount: 150, toAmount: 1 } },
    { at: "2026-08-04T00:01:00Z", action: "SELL", token: "NVDAx", quote: { fromAmount: 0.98, toAmount: 147 } },
    { at: "2026-08-04T00:02:00Z", action: "SELL", token: "NVDAx", quote: { fromAmount: 0.02, toAmount: 3.01 } }
  ]);
  assert.ok(Math.abs(result.realizedPnlUsd - 0.01) < 1e-9);
  assert.equal(result.realizedLossUsd, 0);
});

test("matched cash losses remain counted", () => {
  const result = reconcileTradeAccounting([
    { at: "2026-08-04T00:00:00Z", action: "BUY", token: "SNDKx", quote: { fromAmount: 100, toAmount: 2 } },
    { at: "2026-08-04T00:02:00Z", action: "SELL", token: "SNDKx", quote: { fromAmount: 2, toAmount: 99.5 } }
  ]);
  assert.equal(result.realizedPnlUsd, -0.5);
  assert.equal(result.realizedLossUsd, 0.5);
});

test("net campaign loss allows winners to offset losing closes", () => {
  const result = reconcileTradeAccounting([
    { at: "2026-08-04T00:00:00Z", action: "BUY", token: "NVDAx", quote: { fromAmount: 100, toAmount: 1 } },
    { at: "2026-08-04T00:01:00Z", action: "SELL", token: "NVDAx", quote: { fromAmount: 1, toAmount: 99 } },
    { at: "2026-08-04T00:02:00Z", action: "BUY", token: "SNDKx", quote: { fromAmount: 100, toAmount: 1 } },
    { at: "2026-08-04T00:03:00Z", action: "SELL", token: "SNDKx", quote: { fromAmount: 1, toAmount: 100.4 } }
  ]);
  assert.ok(Math.abs(Math.max(0, -result.realizedPnlUsd) - 0.6) < 1e-9);
  assert.equal(result.realizedLossUsd, 1);
});
