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
  const positions = state.positions || (state.position?.token ? { [state.position.token]: state.position } : {});
  const exitCandidates = Object.values(positions).map(position => {
    const exit = state.executableExitQuotes?.[position.token];
    return { position, exit, netExitBps: Number(exit?.netExitBps) };
  }).filter(item => Number.isFinite(item.netExitBps) && item.netExitBps >= Number(settings.minNetExitBps || 0))
    .sort((a, b) => b.netExitBps - a.netExitBps);
  const readyExit = exitCandidates[0];
  if (readyExit) {
    const { position, netExitBps } = readyExit;
    return {
      action: "SELL", token: position.token, quoteToken: "USDT",
      amountUsd: Number(position.entryCostUsd || settings.tradeUsd),
      maxSlippageBps: settings.maxSlippageBps, confidence: 0.9,
      expectedEdgeBps: netExitBps,
      reason: `Executable profitable exit ${position.token}: ${netExitBps.toFixed(2)} bps`
    };
  }

  const tokenCoolingDown = token => {
    const closes = (state.trades || []).filter(trade => trade.token === token && trade.action === "SELL" && Number.isFinite(Number(trade.cashPnlUsd)));
    let streak = 0;
    for (const trade of closes) {
      if (Number(trade.cashPnlUsd) < 0) streak += 1;
      else break;
    }
    if (streak < Number(settings.tokenLossStreakLimit ?? 2)) return false;
    const lastCloseAt = new Date(closes[0]?.at || 0).getTime();
    return now - lastCloseAt < Number(settings.tokenCooldownMinutes ?? 60) * 60000;
  };
  const tokenRules = [
    { token: "NVDAx", amountUsd: Number(settings.tokenTradeCapsUsd?.NVDAx || settings.tradeUsd), signalBps: Number(settings.nvdaEntrySignalBps ?? 1) },
    { token: "SNDKx", amountUsd: Number(settings.tokenTradeCapsUsd?.SNDKx || 50), signalBps: Number(settings.sndkEntrySignalBps ?? 30) }
  ].filter(rule => rule.amountUsd > 0);
  const candidates = tokenRules.map(rule => {
    const history = (state.executableQuoteHistory?.[rule.token] || []).slice(-Number(settings.executableQuoteWindowSamples || 24));
    const current = Number(history.at(-1)?.askUnitUsd);
    const baseline = history.length ? history.reduce((sum, item) => sum + Number(item.askUnitUsd), 0) / history.length : current;
    const bid = Number(history.at(-1)?.bidUnitUsd);
    const bidAnchor = Number(history[Math.max(0, history.length - 4)]?.bidUnitUsd || bid);
    const bidTrendBps = bidAnchor > 0 ? ((bid / bidAnchor) - 1) * 10000 : 0;
    return { ...rule, current, deviationBps: baseline > 0 ? ((current / baseline) - 1) * 10000 : 0, bidTrendBps, samples: history.length };
  }).filter(item => item.current > 0
      && item.samples >= Number(settings.executableQuoteMinSamples || 3)
      && item.bidTrendBps >= -Number(settings.maxEntryDowntrendBps ?? 5)
      && item.deviationBps <= -item.signalBps
      && !positions[item.token]
      && !tokenCoolingDown(item.token))
    .sort((a, b) => a.deviationBps - b.deviationBps);
  const best = candidates[0];
  if (!best) {
    return { action: "HOLD", token: null, quoteToken: "USDT", amountUsd: 0, maxSlippageBps: 0, confidence: 0.6, reason: "Waiting for a discounted executable quote" };
  }
  return {
    action: "BUY", token: best.token, quoteToken: "USDT", amountUsd: best.amountUsd,
    maxSlippageBps: settings.maxSlippageBps, confidence: Math.min(0.9, 0.6 + Math.abs(best.deviationBps) / 300),
    expectedEdgeBps: Math.abs(best.deviationBps),
    aiAgreement: aiPlan?.action === "BUY" && aiPlan?.token === best.token,
    reason: `${best.token} executable ask ${best.deviationBps.toFixed(1)} bps below rolling mean${aiPlan ? `; DeepSeek ${aiPlan.action} ${aiPlan.token || ""}` : ""}`
  };
}
