import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const initialStateFor = (prefix = "") => {
  const env = key => process.env[`${prefix}${key}`] ?? process.env[key];
  const attributionKey = prefix ? "ATTRIBUTION_VERIFIED" : "BOOST_ATTRIBUTION_VERIFIED";
  const initialVolumeKey = prefix ? "INITIAL_VOLUME_USD" : "BOOST_INITIAL_VOLUME_USD";
  const targetVolumeKey = prefix ? "TARGET_VOLUME_USD" : "BOOST_TARGET_VOLUME_USD";
  return {
    mode: process.env.EXECUTION_MODE || "paper",
    running: false,
    campaignActive: true,
    attributionVerified: env(attributionKey) === "true",
    walletConnected: false,
    walletAddress: null,
    walletAssetsUpdatedAt: null,
    boostVolumeUsd: Number(env(initialVolumeKey) || 0),
    officialBoostVolumeUsd: Number(env(initialVolumeKey) || 0),
    officialBoostUpdatedAt: null,
    officialBoostCheckedAt: null,
    officialBoostSyncStatus: "snapshot",
    officialBoostSyncError: null,
    officialVolumeDeltaUsd: null,
    officialVolumeDeltaHistory: [],
    officialMinVolumeToRankUsd: null,
    officialNextTierVolumeUsd: null,
    officialParticipationStatus: null,
    dayWalletSnapshot: null,
    rank: null,
    estimatedRewardUsd: 0,
    estimatedRewardTokens: 0,
    dailyPnlUsd: 0,
    realizedPnlUsd: 0,
    tradingCostsUsd: 0,
    maxCampaignCostsUsd: Number(env("MAX_CAMPAIGN_COSTS_USD") || 10),
    targetVolumeUsd: Number(env(targetVolumeKey) || 650),
    rwaExposurePct: 0,
    tokenPositionPct: 0,
    tradesLastHour: 0,
    trades: [],
    position: null,
    positions: {},
    positionLots: {},
    inventorySince: 0,
    fastExitPending: false,
    priceHistory: {},
    executableQuoteHistory: {},
    marketPricesUpdatedAt: null,
    adaptiveTiming: null,
    adaptiveEvaluations: [],
    pendingConfirmation: null,
    lastVolumeUpdatedAt: null,
    lastBroadcastAt: null,
    lastDecision: null,
    leaderboard: [],
    leaderboardUpdatedAt: null,
    logs: [
      { at: new Date().toISOString(), level: "info", message: `Workflow initialized in ${process.env.EXECUTION_MODE || "paper"} mode` }
    ]
  };
};

export class MemoryStore {
  constructor(file = new URL("../data/state.json", import.meta.url), prefix = "") {
    this.file = file;
    this.state = initialStateFor(prefix);
    if (existsSync(file)) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(file, "utf8")) }; } catch {}
    }
    this.state.mode = process.env.EXECUTION_MODE || this.state.mode;
    const env = key => process.env[`${prefix}${key}`] ?? process.env[key];
    const attributionKey = prefix ? "ATTRIBUTION_VERIFIED" : "BOOST_ATTRIBUTION_VERIFIED";
    this.state.attributionVerified = env(attributionKey) === "true" || this.state.attributionVerified;
    // Risk-budget changes in .env are authoritative across restarts; otherwise
    // an older persisted state silently keeps the previous ceiling forever.
    this.state.maxCampaignCostsUsd = Number(env("MAX_CAMPAIGN_COSTS_USD") || this.state.maxCampaignCostsUsd || 10);
    this.state.tradingCostsUsd = Math.max(0, Number(this.state.tradingCostsUsd || 0));
    if (!Object.keys(this.state.positions || {}).length && this.state.position?.token) {
      this.state.positions = { [this.state.position.token]: this.state.position };
    }
    if (!Object.keys(this.state.positionLots || {}).length && Object.keys(this.state.positions || {}).length) {
      this.state.positionLots = Object.fromEntries(Object.entries(this.state.positions).map(([token, position]) => [token, [{
        id: position.id || `${token}-${position.openedAt || Date.now()}`,
        ...position
      }]]));
    }
    this.state.position = Object.values(this.state.positions || {})[0] || null;
    this.persist();
  }

  read() {
    return structuredClone(this.state);
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.persist();
    return this.read();
  }

  log(message, level = "info") {
    this.state.logs.unshift({ at: new Date().toISOString(), level, message });
    this.state.logs = this.state.logs.slice(0, 100);
    this.persist();
  }

  persist() {
    mkdirSync(dirname(this.file.pathname), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}
