export function evaluateRisk(plan, state, limits) {
  const reasons = [];
  const amount = Number(plan.amountUsd);
  const slippage = Number(plan.maxSlippageBps);

  if (!["BUY", "SELL", "HOLD"].includes(plan.action)) reasons.push("invalid_action");
  if (plan.action !== "HOLD" && (!Number.isFinite(amount) || amount <= 0)) reasons.push("invalid_amount");
  if (amount > limits.maxTradeUsd) reasons.push("max_trade_exceeded");
  if (slippage > limits.maxSlippageBps) reasons.push("max_slippage_exceeded");
  if (limits.dailyLossLimitPct > 0 && state.dailyPnlUsd <= -(limits.totalCapitalUsd * limits.dailyLossLimitPct / 100)) reasons.push("daily_loss_limit");
  if (limits.maxTradesPerHour > 0 && state.tradesLastHour >= limits.maxTradesPerHour) reasons.push("hourly_trade_limit");
  const broadcastCooldownMs = Math.max(0, Number(limits.minBroadcastIntervalMs || 0));
  const lastBroadcastAt = state.lastBroadcastAt ? new Date(state.lastBroadcastAt).getTime() : 0;
  const isExit = plan.action === "SELL" && /stop|Exit/i.test(plan.reason || "");
  if (plan.action !== "HOLD" && !isExit && broadcastCooldownMs > 0 && lastBroadcastAt > 0 && Date.now() - lastBroadcastAt < broadcastCooldownMs) reasons.push("broadcast_cooldown");
  if (state.rwaExposurePct >= limits.maxTotalRwaExposurePct && plan.action === "BUY") reasons.push("rwa_exposure_limit");
  if (state.tokenPositionPct >= limits.maxTokenPositionPct && plan.action === "BUY") reasons.push("token_position_limit");
  if (plan.action === "BUY" && state.tradingCostsUsd >= state.maxCampaignCostsUsd) reasons.push("campaign_cost_limit");
  if (!state.attributionVerified) reasons.push("campaign_attribution_unverified");
  if (!state.campaignActive) reasons.push("campaign_inactive");

  return {
    approved: reasons.length === 0 && plan.action !== "HOLD",
    reasons
  };
}
