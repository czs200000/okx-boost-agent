import test from "node:test";
import assert from "node:assert/strict";
import { makerDecision, shouldCancelMakerOrder } from "../src/core/maker.js";

test("maker buys when flat and quote balance is available", () => {
  const d = makerDecision({ price: 219, inventoryUsd: 0, usdtBalanceUsd: 400, legUsd: 200 });
  assert.equal(d.action, "BUY");
  assert.ok(d.triggerPrice < 219);
  assert.equal(d.amountUsd, 200);
});

test("maker sells when holding inventory", () => {
  const d = makerDecision({ price: 219, inventoryUnits: 1.2, inventoryUsd: 262.8, usdtBalanceUsd: 400 });
  assert.equal(d.action, "SELL");
  assert.ok(d.triggerPrice > 219);
  assert.equal(d.amountToken, 1.2);
});

test("maker holds while an order is active", () => {
  const d = makerDecision({ price: 219, inventoryUsd: 0, usdtBalanceUsd: 400, activeOrder: true });
  assert.equal(d.action, "HOLD");
});

test("maker holds during the maintenance window", () => {
  const d = makerDecision({ price: 219, inventoryUsd: 0, usdtBalanceUsd: 400, pauseWindow: true });
  assert.equal(d.action, "HOLD");
});

test("maker fast-exits stale inventory below mid", () => {
  const d = makerDecision({
    price: 219, inventoryUnits: 1.2, inventoryUsd: 262.8, usdtBalanceUsd: 400,
    inventorySince: Date.now() - 180000, maxHoldMs: 120000, fastExitTriggerBps: 2
  });
  assert.equal(d.action, "SELL");
  assert.ok(d.triggerPrice < 219);
  assert.match(d.reason, /fast exit/i);
});

test("maker stop-losses when price is far below cost", () => {
  const d = makerDecision({
    price: 215, inventoryUnits: 1.2, inventoryUsd: 258, usdtBalanceUsd: 400,
    entryPrice: 219, stopLossBps: 15
  });
  assert.equal(d.action, "SELL");
  assert.ok(d.triggerPrice < 215);
  assert.match(d.reason, /stop-loss/i);
});

test("maker order is cancelled on TTL expiry", () => {
  const v = shouldCancelMakerOrder({ placedAt: Date.now() - 20000, now: Date.now(), orderTtlMs: 15000, price: 219, triggerPrice: 218.9 });
  assert.equal(v.stale, true);
  assert.equal(v.cancel, true);
});

test("maker order is cancelled on price drift", () => {
  const v = shouldCancelMakerOrder({ placedAt: Date.now(), now: Date.now(), orderTtlMs: 15000, price: 225, triggerPrice: 218.9, priceDriftGuardBps: 25 });
  assert.equal(v.drifted, true);
  assert.equal(v.cancel, true);
});
