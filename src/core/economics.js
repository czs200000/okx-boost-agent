export function assessTradeEconomics(plan, quote, state, settings) {
  const amountUsd = Number(plan.amountUsd || 0);
  const impactCostUsd = Math.max(0, amountUsd * Number(quote.priceImpactPct || 0) / 100);
  const feeUsd = Math.max(0, Number(quote.tradeFeeUsd || 0));
  const expectedCostUsd = impactCostUsd + feeUsd;
  const costBps = amountUsd > 0 ? expectedCostUsd / amountUsd * 10000 : Infinity;
  const remainingVolumeUsd = Math.max(1, Number(state.targetVolumeUsd) - Number(state.boostVolumeUsd));
  const remainingBudgetUsd = Math.max(0, Number(state.maxCampaignCostsUsd) - Number(state.tradingCostsUsd));
  const rewardSubsidyBps = Math.min(
    Number(settings.maxRewardSubsidyBps),
    remainingBudgetUsd / remainingVolumeUsd * 10000
  );
  const expectedEdgeBps = Math.max(0, Number(plan.expectedEdgeBps || 0));
  const requiredEdgeBps = Math.max(0, costBps - rewardSubsidyBps + Number(settings.minNetEdgeBps));
  const effectiveCostBps = Math.max(0, costBps - rewardSubsidyBps);
  const isRiskExit = plan.action === "SELL" && /stop loss/i.test(plan.reason || "");
  const approved = isRiskExit || (
    costBps <= Number(settings.maxExecutionCostBps)
    && effectiveCostBps <= Number(settings.maxEffectiveCostBps)
    && expectedEdgeBps >= requiredEdgeBps
    && expectedCostUsd <= remainingBudgetUsd
  );
  return {
    approved,
    expectedCostUsd,
    costBps,
    effectiveCostBps,
    expectedEdgeBps,
    rewardSubsidyBps,
    requiredEdgeBps,
    reason: approved ? "reward-adjusted economics passed" : "execution cost exceeds reward-adjusted edge"
  };
}
