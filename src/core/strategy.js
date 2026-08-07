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
  const equitySession = settings.usEquitySession?.mode || "regular";
  const sessionExtraEdgeBps = equitySession === "regular"
    ? 0
    : equitySession === "extended"
      ? Number(settings.extendedHoursExtraEdgeBps ?? 2)
      : Number(settings.closedHoursExtraEdgeBps ?? 4);
  const sessionAmount = amountUsd => equitySession === "regular"
    ? amountUsd
    : Math.min(amountUsd, Number(settings.offHoursMaxTradeUsd ?? 50));
  const positions = state.positions || (state.position?.token ? { [state.position.token]: state.position } : {});
  const positionLots = state.positionLots || Object.fromEntries(Object.entries(positions).map(([token, position]) => [token, [{ ...position, id: position.id || token }]]));
  const openLots = Object.values(positionLots).flat();
  const exitCandidates = openLots.map(position => {
    const exit = state.executableExitQuotes?.[position.id] || state.executableExitQuotes?.[position.token];
    return { position, exit, netExitBps: Number(exit?.netExitBps) };
  }).filter(item => Number.isFinite(item.netExitBps)
      && Number(item.position.entryCostUsd || 0) >= 1
      && item.netExitBps >= Number(settings.minNetExitBps || 0))
    .sort((a, b) => b.netExitBps - a.netExitBps);
  const readyExit = exitCandidates[0];
  if (readyExit) {
    const { position, netExitBps } = readyExit;
    return {
      action: "SELL", token: position.token, quoteToken: "USDT",
      amountUsd: Number(position.entryCostUsd || settings.tradeUsd),
      amountToken: Number(position.amount || 0),
      lotId: position.id,
      maxSlippageBps: settings.maxSlippageBps, confidence: 0.9,
      expectedEdgeBps: netExitBps,
      reason: `Executable profitable exit ${position.token} lot ${position.id}: ${netExitBps.toFixed(2)} bps`
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
    { token: "NVDAx", amountUsd: sessionAmount(Number(settings.tokenTradeCapsUsd?.NVDAx || settings.tradeUsd)), signalBps: Number(settings.nvdaEntrySignalBps ?? 1) },
    { token: "SNDKx", amountUsd: sessionAmount(Number(settings.tokenTradeCapsUsd?.SNDKx || 50)), signalBps: Number(settings.sndkEntrySignalBps ?? 15) },
    { token: "SPCXx", amountUsd: sessionAmount(Number(settings.tokenTradeCapsUsd?.SPCXx || 0)), signalBps: Number(settings.spcxEntrySignalBps ?? 10) },
    { token: "CRCLx", amountUsd: sessionAmount(Number(settings.tokenTradeCapsUsd?.CRCLx || 0)), signalBps: Number(settings.crclEntrySignalBps ?? 15) },
    { token: "SKHYx", amountUsd: sessionAmount(Number(settings.tokenTradeCapsUsd?.SKHYx || 0)), signalBps: Number(settings.skhyEntrySignalBps ?? 10) }
  ].filter(rule => rule.amountUsd > 0);
  const openLotCount = openLots.length;
  const candidates = tokenRules.map(rule => {
    const history = (state.executableQuoteHistory?.[rule.token] || []).slice(-Number(settings.executableQuoteWindowSamples || 24));
    const latest = history.at(-1);
    const current = Number(latest?.askUnitUsd);
    const baseline = history.length ? history.reduce((sum, item) => sum + Number(item.askUnitUsd), 0) / history.length : current;
    const bid = Number(latest?.bidUnitUsd);
    const bidAnchor = Number(history[Math.max(0, history.length - 4)]?.bidUnitUsd || bid);
    const bidTrendBps = bidAnchor > 0 ? ((bid / bidAnchor) - 1) * 10000 : 0;
    const lotsForToken = positionLots[rule.token] || [];
    const deviationBps = baseline > 0 ? ((current / baseline) - 1) * 10000 : 0;
    const quotedRoundTripLossBps = Number(latest?.roundTripLossBps);
    const roundTripLossBps = Number.isFinite(quotedRoundTripLossBps)
      ? quotedRoundTripLossBps
      : current > 0 && bid > 0 ? Math.max(0, (1 - bid / current) * 10000) : Infinity;
    const netOpportunityBps = Math.max(0, -deviationBps) - roundTripLossBps;
    const lowestOpenAsk = lotsForToken.reduce((lowest, lot) => {
      const ask = Number(lot.entryAskUnitUsd || (Number(lot.entryCostUsd) / Number(lot.amount)));
      return ask > 0 ? Math.min(lowest, ask) : lowest;
    }, Infinity);
    const layerSpacingBps = Number.isFinite(lowestOpenAsk) && current > 0
      ? ((lowestOpenAsk / current) - 1) * 10000
      : Infinity;
    // Legacy snapshots/tests did not carry timestamps. Live quote samples do,
    // and are still rejected when stale.
    const quoteAgeMs = latest?.at ? now - new Date(latest.at).getTime() : 0;
    return {
      ...rule, current, deviationBps, bidTrendBps, samples: history.length,
      openLotsForToken: lotsForToken.length, roundTripLossBps, netOpportunityBps,
      layerSpacingBps, quoteAgeMs
    };
  }).filter(item => item.current > 0
      && item.samples >= Number(settings.executableQuoteMinSamples || 3)
      && item.deviationBps <= -item.signalBps
      && Number.isFinite(item.roundTripLossBps)
      && item.roundTripLossBps <= Number(settings.maxEntryRoundTripLossBps ?? settings.maxRoundTripLossBps ?? 15)
      && item.netOpportunityBps >= Number(settings.minEntryEfficiencyBps ?? 0.5) + sessionExtraEdgeBps
      && item.quoteAgeMs <= Number(settings.maxExecutableQuoteAgeMs ?? 90000)
      && item.layerSpacingBps >= Number(settings.minGridLayerSpacingBps ?? 3)
      && item.openLotsForToken < Number(settings.maxGridLotsPerToken ?? 1)
      && openLotCount < Number(settings.maxOpenGridLots ?? 3)
      && !tokenCoolingDown(item.token))
    .sort((a, b) => b.netOpportunityBps - a.netOpportunityBps || a.roundTripLossBps - b.roundTripLossBps);
  const best = candidates[0];
  if (!best) {
    return { action: "HOLD", token: null, quoteToken: "USDT", amountUsd: 0, maxSlippageBps: 0, confidence: 0.6, reason: "Waiting for a discounted executable quote" };
  }
  return {
    action: "BUY", token: best.token, quoteToken: "USDT", amountUsd: best.amountUsd,
    maxSlippageBps: settings.maxSlippageBps, confidence: Math.min(0.9, 0.6 + Math.abs(best.deviationBps) / 300),
    expectedEdgeBps: Math.abs(best.deviationBps),
    aiAgreement: aiPlan?.action === "BUY" && aiPlan?.token === best.token,
    reason: `${best.token} net opportunity ${best.netOpportunityBps.toFixed(1)} bps after ${best.roundTripLossBps.toFixed(1)} bps round-trip cost during US ${equitySession} session${aiPlan ? `; DeepSeek ${aiPlan.action} ${aiPlan.token || ""}` : ""}`
  };
}

// AEON (BSC) grid market-making plan: buy dips against the rolling ask mean
// and exit each lot when the executable bid recovers by the configured gain.
// Volume farming and near-zero-loss round trips share the same path: we only
// trade when the entry is discounted and the exit target clears round-trip cost.
export function aeonPlan(snapshot, state, settings, aiPlan = null) {
  const now = Date.now();
  const token = "AEON";
  const history = (state.executableQuoteHistory?.[token] || []).slice(-Number(settings.sampleWindow || 24));
  const latest = history.at(-1);
  const askUnitUsd = Number(latest?.askUnitUsd);
  const bidUnitUsd = Number(latest?.bidUnitUsd);
  const roundTripLossBps = Number(latest?.roundTripLossBps);
  const quoteAgeMs = latest?.at ? now - new Date(latest.at).getTime() : Infinity;
  const samples = history.length;
  const lots = state.positionLots?.[token] || [];
  const openLots = Object.values(state.positionLots || {}).flat().filter(lot => Number(lot.amount) > 0);
  const baseline = history.length ? history.reduce((sum, item) => sum + Number(item.askUnitUsd), 0) / history.length : askUnitUsd;
  const bidAnchor = Number(history[Math.max(0, history.length - 4)]?.bidUnitUsd || bidUnitUsd);
  const bidTrendBps = bidAnchor > 0 ? ((bidUnitUsd / bidAnchor) - 1) * 10000 : 0;

  const validQuote = Number.isFinite(askUnitUsd) && askUnitUsd > 0
    && Number.isFinite(bidUnitUsd) && bidUnitUsd > 0
    && Number.isFinite(roundTripLossBps)
    && quoteAgeMs <= Number(settings.maxQuoteAgeMs ?? 90000)
    && samples >= Number(settings.minSamples ?? 3);

  if (!validQuote) {
    return {
      action: "HOLD", token: null, quoteToken: "USDT", amountUsd: 0, maxSlippageBps: 0,
      confidence: 0.5,
      reason: `AEON quote unavailable (samples ${samples}, age ${Math.round(quoteAgeMs / 1000)}s)`
    };
  }

  // 1) Exits: stop-loss takes priority, then the highest take-profit lot.
  const exitCandidates = lots.map(lot => {
    const entryAskUnitUsd = Number(lot.entryAskUnitUsd || (Number(lot.entryCostUsd) / Number(lot.amount)));
    const gainBps = entryAskUnitUsd > 0 ? ((bidUnitUsd / entryAskUnitUsd) - 1) * 10000 : -Infinity;
    return { lot, entryAskUnitUsd, gainBps };
  }).filter(item => Number.isFinite(item.gainBps))
    .sort((a, b) => b.gainBps - a.gainBps);
  const stopLossBps = Number(settings.stopLossBps ?? 200);
  const stopExit = exitCandidates.find(item => item.gainBps <= -stopLossBps);
  if (stopExit) {
    const { lot, gainBps } = stopExit;
    return {
      action: "SELL", token, quoteToken: "USDT",
      amountUsd: Number(lot.entryCostUsd || settings.maxTradeUsd),
      amountToken: Number(lot.amount || 0),
      lotId: lot.id,
      maxSlippageBps: settings.maxSlippageBps, confidence: 0.95,
      expectedEdgeBps: gainBps,
      reason: `AEON stop loss lot ${lot.id}: executable ${gainBps.toFixed(1)} bps ≤ -${stopLossBps} bps`
    };
  }
  const bestExit = exitCandidates[0];
  if (bestExit && bestExit.gainBps >= Number(settings.exitGainBps ?? 50)) {
    const { lot, gainBps } = bestExit;
    return {
      action: "SELL", token, quoteToken: "USDT",
      amountUsd: Number(lot.entryCostUsd || settings.maxTradeUsd),
      amountToken: Number(lot.amount || 0),
      lotId: lot.id,
      maxSlippageBps: settings.maxSlippageBps, confidence: 0.9,
      expectedEdgeBps: Math.max(0, gainBps - roundTripLossBps),
      aiAgreement: aiPlan?.action === "SELL" && aiPlan?.token === token,
      reason: `AEON lot ${lot.id} executable gain ${gainBps.toFixed(1)} bps ≥ ${settings.exitGainBps} bps target (round trip ${roundTripLossBps.toFixed(1)} bps)`
    };
  }

  // 2) Discounted entries on the AEON/USDT grid.
  const deviationBps = baseline > 0 ? ((askUnitUsd / baseline) - 1) * 10000 : 0;
  const exposureUsd = lots.reduce((sum, lot) => sum + Number(lot.entryCostUsd || 0), 0);
  const lowestEntryAsk = lots.reduce((lowest, lot) => {
    const ask = Number(lot.entryAskUnitUsd || (Number(lot.entryCostUsd) / Number(lot.amount)));
    return ask > 0 ? Math.min(lowest, ask) : lowest;
  }, Infinity);
  const layerSpacingBps = Number.isFinite(lowestEntryAsk) ? ((lowestEntryAsk / askUnitUsd) - 1) * 10000 : Infinity;
  const dipped = deviationBps <= -Number(settings.entryDipBps ?? 12);
  const spaced = lots.length === 0 || layerSpacingBps >= Number(settings.gridSpacingBps ?? 40);
  const capacity = exposureUsd + Number(settings.maxTradeUsd) <= Number(settings.maxExposureUsd ?? 300);
  const lotCapacity = lots.length < Number(settings.maxGridLots ?? 2)
    && openLots.length < Number(settings.maxOpenLots ?? 2);
  const costAcceptable = roundTripLossBps <= Number(settings.maxRoundTripLossBps ?? 40);
  const netEdge = Math.max(0, -deviationBps) - roundTripLossBps;
  const notFreefall = bidTrendBps >= Number(settings.minBidTrendBps ?? -5);
  const enoughNetEdge = netEdge >= Number(settings.minEntryNetEdgeBps ?? 15);

  if (dipped && spaced && capacity && lotCapacity && costAcceptable && notFreefall && enoughNetEdge) {
    return {
      action: "BUY", token, quoteToken: "USDT", amountUsd: Number(settings.maxTradeUsd),
      maxSlippageBps: settings.maxSlippageBps, confidence: Math.min(0.9, 0.6 + Math.abs(deviationBps) / 300),
      expectedEdgeBps: Math.abs(deviationBps),
      aiAgreement: aiPlan?.action === "BUY" && aiPlan?.token === token,
      reason: `AEON ask ${deviationBps.toFixed(1)} bps below mean, bid trend ${bidTrendBps.toFixed(1)} bps (round trip ${roundTripLossBps.toFixed(1)} bps, net ${netEdge.toFixed(1)} bps)`
    };
  }

  const blockers = [];
  if (!dipped) blockers.push(`ask ${deviationBps.toFixed(1)} bps above entry dip ${settings.entryDipBps} bps`);
  if (dipped && !spaced) blockers.push("grid spacing below threshold");
  if (dipped && !capacity) blockers.push("exposure cap reached");
  if (dipped && !lotCapacity) blockers.push("max open lots reached");
  if (dipped && !costAcceptable) blockers.push(`round trip ${roundTripLossBps.toFixed(1)} bps above ${settings.maxRoundTripLossBps} bps cap`);
  if (dipped && !notFreefall) blockers.push(`bid falling ${bidTrendBps.toFixed(1)} bps — freefall guard`);
  if (dipped && !enoughNetEdge) blockers.push(`net edge ${netEdge.toFixed(1)} bps below ${settings.minEntryNetEdgeBps} bps floor`);
  return {
    action: "HOLD", token: null, quoteToken: "USDT", amountUsd: 0, maxSlippageBps: 0,
    confidence: 0.6,
    reason: blockers.length ? `AEON waiting: ${blockers.join("; ")}` : "AEON waiting for a discounted executable quote"
  };
}
