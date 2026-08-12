import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateByVolume } from "../src/core/flow-alloc.js";

test("allocates proportionally to volume", () => {
  const r = allocateByVolume(300, 100, 80, 25, 60);
  assert.equal(r.main, 55);
  assert.equal(r.other, 25);
  assert.equal(r.main + r.other, 80);
});

test("clamps to the cap and keeps the other above the floor", () => {
  const r = allocateByVolume(1000, 10, 80, 25, 60);
  assert.equal(r.main, 55);
  assert.equal(r.other, 25);
  assert.equal(r.main + r.other, 80);
});

test("zero volume splits evenly", () => {
  const r = allocateByVolume(0, 0, 80, 25, 60);
  assert.equal(r.main + r.other, 80);
  assert.ok(r.main >= 25 && r.other >= 25);
});
