import test from "node:test";
import assert from "node:assert/strict";
import { usEquitySession } from "../src/core/us-equity-session.js";

test("classifies US regular session across daylight saving time", () => {
  assert.equal(usEquitySession(new Date("2026-08-05T14:00:00Z")).mode, "regular");
  assert.equal(usEquitySession(new Date("2026-01-05T15:00:00Z")).mode, "regular");
});

test("classifies extended and weekend sessions", () => {
  assert.equal(usEquitySession(new Date("2026-08-05T12:00:00Z")).mode, "extended");
  assert.equal(usEquitySession(new Date("2026-08-08T14:00:00Z")).mode, "closed");
});
