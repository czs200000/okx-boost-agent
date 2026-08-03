import test from "node:test";
import assert from "node:assert/strict";
import { parseOfficialBoostResponse } from "../src/providers/boost-official.js";

test("parses official personal volume when OKX returns it", () => {
  const result = parseOfficialBoostResponse(
    { code: 0, data: { minVolumeToRank: "100", nextTierMetric: "1000" } },
    { code: 0, data: { rankUpdateTime: 1700000000000, myPnlRankInfo: { volume: "123.45", currentRank: 42, expectedRewards: "35" } } },
    "now"
  );
  assert.equal(result.volumeUsd, 123.45);
  assert.equal(result.rank, 42);
  assert.equal(result.valueAvailable, true);
  assert.equal(result.officialUpdatedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(result.nextTierVolumeUsd, 1000);
});

test("marks unauthenticated response without personal volume", () => {
  const result = parseOfficialBoostResponse({ code: 0, data: { participationStatus: 2, minVolumeToRank: 767.9 } });
  assert.equal(result.volumeUsd, null);
  assert.equal(result.valueAvailable, false);
  assert.equal(result.participationStatus, 2);
});
