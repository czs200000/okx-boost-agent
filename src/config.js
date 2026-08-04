const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const bool = (name, fallback = false) => {
  const value = process.env[name];
  if (value == null) return fallback;
  return value === "true" || value === "1";
};

export const config = Object.freeze({
  port: number("PORT", 4310),
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat"
  },
  execution: {
    mode: process.env.EXECUTION_MODE || "paper",
    autonomousEnabled: bool("AUTONOMOUS_ENABLED", false),
    attributionVerified: bool("BOOST_ATTRIBUTION_VERIFIED", false),
    cycleMs: number("AUTONOMOUS_CYCLE_MS", 300000),
    marketPollMs: number("MARKET_POLL_MS", 30000),
    positionMonitorMs: number("POSITION_MONITOR_MS", 30000),
    aiAnalysisIntervalMs: number("AI_ANALYSIS_INTERVAL_MS", 120000),
    adaptiveTimingEnabled: bool("ADAPTIVE_TIMING_ENABLED", true),
    adaptiveEvaluationMs: number("ADAPTIVE_EVALUATION_MS", 3600000),
    priceWindowSamples: number("PRICE_WINDOW_SAMPLES", 48),
    targetVolumeUsd: number("BOOST_TARGET_VOLUME_USD", 650),
    maxCampaignCostsUsd: number("MAX_CAMPAIGN_COSTS_USD", 10),
    minSignalBps: number("MIN_SIGNAL_BPS", 18),
    maxEntryDowntrendBps: number("MAX_ENTRY_DOWNTREND_BPS", 5),
    maxPositionMinutes: number("MAX_POSITION_MINUTES", 45),
    takeProfitBps: number("TAKE_PROFIT_BPS", 22),
    stopLossBps: number("STOP_LOSS_BPS", 35),
    hardStopLossBps: number("HARD_STOP_LOSS_BPS", 40),
    recoveryMaxMinutes: number("RECOVERY_MAX_MINUTES", 30),
    maxExecutionCostBps: number("MAX_EXECUTION_COST_BPS", 150),
    maxEffectiveCostBps: number("MAX_EFFECTIVE_COST_BPS", 5),
    maxRewardSubsidyBps: number("MAX_REWARD_SUBSIDY_BPS", 150),
    minNetEdgeBps: number("MIN_NET_EDGE_BPS", 1),
    maxRoundTripLossBps: number("MAX_ROUND_TRIP_LOSS_BPS", 15),
    minNetEntryBps: number("MIN_NET_ENTRY_BPS", 10),
    mediumSizeNetEntryBps: number("MEDIUM_SIZE_NET_ENTRY_BPS", 6),
    smallSizeNetEntryBps: number("SMALL_SIZE_NET_ENTRY_BPS", 3),
    minNetExitBps: number("MIN_NET_EXIT_BPS", 10),
    tokenLossStreakLimit: number("TOKEN_LOSS_STREAK_LIMIT", 2),
    tokenCooldownMinutes: number("TOKEN_COOLDOWN_MINUTES", 60),
    maxProjectedLossPerTradeUsd: number("MAX_PROJECTED_LOSS_PER_TRADE_USD", 0.75),
    minDynamicTradeUsd: number("MIN_DYNAMIC_TRADE_USD", 50),
    tokenTradeCapsUsd: Object.freeze({
      NVDAx: number("MAX_TRADE_NVDA_USD", 330),
      SNDKx: number("MAX_TRADE_SNDK_USD", 250),
      SPCXx: number("MAX_TRADE_SPCX_USD", 330)
    })
  },
  risk: {
    totalCapitalUsd: number("TOTAL_CAPITAL_USD", 1000),
    maxTradeUsd: number("MAX_TRADE_USD", 50),
    maxTotalRwaExposurePct: number("MAX_TOTAL_RWA_EXPOSURE_PCT", 30),
    maxTokenPositionPct: number("MAX_TOKEN_POSITION_PCT", 10),
    maxSlippageBps: number("MAX_SLIPPAGE_BPS", 15),
    minBroadcastIntervalMs: number("MIN_BROADCAST_INTERVAL_MS", 60000),
    dailyLossLimitPct: number("DAILY_LOSS_LIMIT_PCT", 2),
    maxTradesPerHour: number("MAX_TRADES_PER_HOUR", 6)
  }
});
