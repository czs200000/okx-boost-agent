import test from "node:test";
import assert from "node:assert/strict";
import { nextStageTarget } from "../src/core/stage-target.js";

test("advances a reached stage to the next official reward tier", () => {
  assert.equal(nextStageTarget({ localVolumeUsd: 910, currentTargetUsd: 650, nextTierUsd: 100108.38 }), 100108.38);
});

test("keeps the current stage before it is reached", () => {
  assert.equal(nextStageTarget({ localVolumeUsd: 500, currentTargetUsd: 650, nextTierUsd: 100108.38 }), 650);
});

test("never moves a stage reference backwards", () => {
  assert.equal(nextStageTarget({ localVolumeUsd: 900, currentTargetUsd: 850, nextTierUsd: 798.36 }), 850);
});
