import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const initialState = {
  mode: process.env.EXECUTION_MODE || "paper",
  running: false,
  campaignActive: true,
  attributionVerified: process.env.BOOST_ATTRIBUTION_VERIFIED === "true",
  walletConnected: false,
  walletAddress: null,
  walletAssetsUpdatedAt: null,
  boostVolumeUsd: Number(process.env.BOOST_INITIAL_VOLUME_USD || 0),
  officialBoostVolumeUsd: Number(process.env.BOOST_INITIAL_VOLUME_USD || 0),
  officialBoostUpdatedAt: null,
  officialBoostCheckedAt: null,
  officialBoostSyncStatus: "snapshot",
  officialBoostSyncError: null,
  officialMinVolumeToRankUsd: null,
  officialNextTierVolumeUsd: null,
  officialParticipationStatus: null,
  rank: null,
  estimatedRewardUsd: 0,
  dailyPnlUsd: 0,
  realizedPnlUsd: 0,
  tradingCostsUsd: 0,
  maxCampaignCostsUsd: Number(process.env.MAX_CAMPAIGN_COSTS_USD || 10),
  targetVolumeUsd: Number(process.env.BOOST_TARGET_VOLUME_USD || 650),
  rwaExposurePct: 0,
  tokenPositionPct: 0,
  tradesLastHour: 0,
  trades: [],
  position: null,
  priceHistory: {},
  marketPricesUpdatedAt: null,
  adaptiveTiming: null,
  adaptiveEvaluations: [],
  pendingConfirmation: null,
  lastVolumeUpdatedAt: null,
  lastBroadcastAt: null,
  lastDecision: null,
  logs: [
    { at: new Date().toISOString(), level: "info", message: `Workflow initialized in ${process.env.EXECUTION_MODE || "paper"} mode` }
  ]
};

export class MemoryStore {
  constructor(file = new URL("../data/state.json", import.meta.url)) {
    this.file = file;
    this.state = structuredClone(initialState);
    if (existsSync(file)) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(file, "utf8")) }; } catch {}
    }
    this.state.mode = process.env.EXECUTION_MODE || this.state.mode;
    this.state.attributionVerified = process.env.BOOST_ATTRIBUTION_VERIFIED === "true" || this.state.attributionVerified;
    this.state.tradingCostsUsd = Math.max(0, Number(this.state.tradingCostsUsd || 0));
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
