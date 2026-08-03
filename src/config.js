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
    targetVolumeUsd: number("BOOST_TARGET_VOLUME_USD", 650),
    maxCampaignCostsUsd: number("MAX_CAMPAIGN_COSTS_USD", 10),
    minSignalBps: number("MIN_SIGNAL_BPS", 18),
    maxPositionMinutes: number("MAX_POSITION_MINUTES", 45),
    takeProfitBps: number("TAKE_PROFIT_BPS", 22),
    stopLossBps: number("STOP_LOSS_BPS", 35),
    maxExecutionCostBps: number("MAX_EXECUTION_COST_BPS", 150),
    maxEffectiveCostBps: number("MAX_EFFECTIVE_COST_BPS", 5),
    maxRewardSubsidyBps: number("MAX_REWARD_SUBSIDY_BPS", 150),
    minNetEdgeBps: number("MIN_NET_EDGE_BPS", 1),
    maxRoundTripLossBps: number("MAX_ROUND_TRIP_LOSS_BPS", 15),
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
    dailyLossLimitPct: number("DAILY_LOSS_LIMIT_PCT", 2),
    maxTradesPerHour: number("MAX_TRADES_PER_HOUR", 6)
  }
});
