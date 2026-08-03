const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function summarizeTradeWindow(trades, fromMs, toMs) {
  const selected = (trades || []).filter(trade => {
    const at = new Date(trade.at).getTime();
    return Number.isFinite(at) && at >= fromMs && at < toMs;
  });
  const volumeUsd = selected.reduce((sum, trade) => sum + Number(trade.amountUsd || 0), 0);
  const costUsd = selected.reduce((sum, trade) => sum + Math.max(0, Number(trade.economics?.expectedCostUsd || 0)), 0);
  return {
    trades: selected.length,
    volumeUsd,
    costUsd,
    costBps: volumeUsd > 0 ? (costUsd / volumeUsd) * 10000 : 0
  };
}

export function chooseAdaptiveTiming({ current, previous, timing, maxHealthyCostBps = 15 }) {
  const hasActivity = current.trades > 0;
  const volumeImproved = previous.volumeUsd > 0
    ? current.volumeUsd >= previous.volumeUsd * 1.05
    : current.volumeUsd > 0;
  const costHealthy = current.costBps <= maxHealthyCostBps;
  const costNotWorse = previous.volumeUsd <= 0 || current.costBps <= Math.max(maxHealthyCostBps, previous.costBps * 1.1);

  if (volumeImproved && costHealthy && costNotWorse) {
    return { action: "keep", reason: "volume_improved_with_healthy_cost", better: true, nextTiming: { ...timing } };
  }

  if (hasActivity && (!costHealthy || (previous.volumeUsd > 0 && current.costBps > previous.costBps * 1.25))) {
    return {
      action: "slow",
      reason: "unit_cost_worsened",
      better: false,
      nextTiming: {
        marketPollMs: clamp(Math.round(timing.marketPollMs * 1.5), 15000, 60000),
        decisionMs: clamp(Math.round(timing.decisionMs * 1.5), 30000, 120000),
        aiAnalysisIntervalMs: clamp(Math.round(timing.aiAnalysisIntervalMs * 1.5), 120000, 300000)
      }
    };
  }

  return {
    action: "speed_up",
    reason: "volume_not_improving_cost_healthy",
    better: false,
    nextTiming: {
      marketPollMs: clamp(Math.round(timing.marketPollMs * 0.75), 15000, 60000),
      decisionMs: clamp(Math.round(timing.decisionMs * 0.75), 30000, 120000),
      aiAnalysisIntervalMs: clamp(Math.round(timing.aiAnalysisIntervalMs * 0.75), 120000, 300000)
    }
  };
}
