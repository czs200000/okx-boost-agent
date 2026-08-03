const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function deterministicPlan(market, limits) {
  const candidates = Object.entries(market.tokens || {})
    .map(([token, item]) => ({ token, ...item }))
    .filter(item => Number.isFinite(item.deviationBps) && Number.isFinite(item.slippageBps))
    .sort((a, b) => Math.abs(b.deviationBps) - Math.abs(a.deviationBps));

  const best = candidates[0];
  if (!best || Math.abs(best.deviationBps) < 25) {
    return { action: "HOLD", token: null, quoteToken: "USDT", amountUsd: 0, maxSlippageBps: 0, confidence: 0.5, reason: "No edge above threshold" };
  }

  const action = best.deviationBps < 0 ? "BUY" : "SELL";
  return {
    action,
    token: best.token,
    quoteToken: "USDT",
    amountUsd: clamp(Math.abs(best.deviationBps) / 2, 5, limits.maxTradeUsd),
    maxSlippageBps: Math.min(best.slippageBps + 3, limits.maxSlippageBps),
    confidence: clamp(0.55 + Math.abs(best.deviationBps) / 500, 0.55, 0.9),
    reason: `${best.token} deviation ${best.deviationBps.toFixed(1)} bps with estimated slippage ${best.slippageBps.toFixed(1)} bps`
  };
}

export function autonomousPlan(snapshot, state, settings, aiPlan = null) {
  const now = Date.now();
  const symbols = ["NVDAx", "SNDKx", "SPCXx"];
  const prices = snapshot.prices || {};
  const position = state.position;
  if (position && Number(prices[position.token]) > 0) {
    const price = Number(prices[position.token]);
    const moveBps = ((price / position.entryPrice) - 1) * 10000;
    const ageMinutes = (now - new Date(position.openedAt).getTime()) / 60000;
    if (moveBps >= settings.takeProfitBps || moveBps <= -settings.stopLossBps || ageMinutes >= settings.maxPositionMinutes) {
      const exitReason = moveBps >= settings.takeProfitBps
        ? "Take profit probe"
        : moveBps <= -settings.stopLossBps
          ? "Stop loss"
          : "Max hold";
      return {
        action: "SELL", token: position.token, quoteToken: "USDT",
        amountUsd: Math.min(position.amount * price, settings.tradeUsd),
        maxSlippageBps: settings.maxSlippageBps, confidence: 0.8,
        expectedEdgeBps: Math.max(0, Math.abs(moveBps)),
        reason: `${exitReason} ${position.token}: ${moveBps.toFixed(1)} bps, ${ageMinutes.toFixed(0)} min`
      };
    }
    return { action: "HOLD", token: position.token, quoteToken: "USDT", amountUsd: 0, maxSlippageBps: 0, confidence: 0.7, reason: `Position ${moveBps.toFixed(1)} bps from entry` };
  }

  const candidates = symbols.map(token => {
    const history = (state.priceHistory[token] || []).slice(-Number(settings.priceWindowSamples || 12));
    const current = Number(prices[token]);
    const average = history.length ? history.reduce((sum, item) => sum + Number(item.price), 0) / history.length : current;
    return { token, current, deviationBps: average > 0 ? ((current / average) - 1) * 10000 : 0, samples: history.length };
  }).filter(item => item.current > 0 && item.samples >= 3).sort((a, b) => a.deviationBps - b.deviationBps);
  const best = candidates[0];
  if (!best || best.deviationBps > -settings.minSignalBps) {
    return { action: "HOLD", token: null, quoteToken: "USDT", amountUsd: 0, maxSlippageBps: 0, confidence: 0.6, reason: "Waiting for a discounted RWA signal" };
  }
  return {
    action: "BUY", token: best.token, quoteToken: "USDT", amountUsd: settings.tradeUsd,
    maxSlippageBps: settings.maxSlippageBps, confidence: Math.min(0.9, 0.6 + Math.abs(best.deviationBps) / 300),
    expectedEdgeBps: Math.abs(best.deviationBps),
    aiAgreement: aiPlan?.action === "BUY" && aiPlan?.token === best.token,
    reason: `${best.token} trades ${best.deviationBps.toFixed(1)} bps below rolling mean${aiPlan ? `; DeepSeek ${aiPlan.action} ${aiPlan.token || ""}` : ""}`
  };
}
